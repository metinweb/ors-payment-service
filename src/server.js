/**
 * ORS Payment Service
 * Virtual POS payment processing
 */

import { initService } from '@ors/common/config';
initService('PAYMENT');

import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connectDB } from './config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware
import { apiKeyAuth } from '@ors/common';
import { gatewayAuth, optionalGatewayAuth } from './middleware/gatewayAuth.js';

// Routes
import companyRoutes from './routes/company.routes.js';
import posRoutes from './routes/pos.routes.js';
import paymentRoutes, { publicPaymentRoutes } from './routes/payment.routes.js';
import transactionRoutes from './routes/transaction.routes.js';

const app = express();
const PORT = process.env.PORT || 7043;
const SERVICE_NAME = process.env.SERVICE_NAME || 'ors-payment-service';

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request ID middleware
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || `pay-${Date.now()}`;
  req.startTime = Date.now();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// Request logging
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  res.on('finish', () => {
    const duration = Date.now() - req.startTime;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      service: SERVICE_NAME,
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`
    }));
  });

  next();
});

// ============================================================================
// HEALTH CHECK (public)
// ============================================================================

app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    service: SERVICE_NAME,
    version: '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };

  res.json(health);
});

// ============================================================================
// PUBLIC ROUTES (no auth - called by browser/bank for 3D callbacks)
// ============================================================================

// Explicit CORS + iframe headers for payment routes (bank callbacks)
app.use('/payment', (req, res, next) => {
  // Get origin from request or allow all
  const origin = req.headers.origin || '*';

  // CORS headers - use specific origin when credentials are needed
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Origin, X-Requested-With');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Allow iframe embedding from anywhere
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.use('/payment', publicPaymentRoutes);

// ============================================================================
// API ROUTES (protected by API Key from gateway)
// ============================================================================

// API Key middleware for all /api routes
app.use('/api', apiKeyAuth());

// Gateway auth middleware - extracts user from x-user-id header
app.use('/api', gatewayAuth);

// Company management
app.use('/api/companies', companyRoutes);

// POS management
app.use('/api/pos', posRoutes);

// Transaction history (MUST be before paymentRoutes due to /:id catch-all)
app.use('/api/transactions', transactionRoutes);

// Payment processing - mounted at /api since gateway strips /payment prefix
// Gateway: /api/payment/pay → Service: /api/pay
// NOTE: This has /:id route that catches everything, so it must be LAST
app.use('/api', paymentRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    status: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Server error:', {
    message: err.message,
    stack: err.stack,
    path: req.path
  });

  res.status(err.status || 500).json({
    status: false,
    error: err.message || 'Internal Server Error'
  });
});

// ============================================================================
// STARTUP
// ============================================================================

async function start() {
  try {
    await connectDB();
    console.log('MongoDB connected');

    // Check for SSL certificates
    const certPath = path.join(__dirname, '../certs/cert.pem');
    const keyPath = path.join(__dirname, '../certs/key.pem');
    const useHttps = fs.existsSync(certPath) && fs.existsSync(keyPath);

    if (useHttps) {
      const httpsOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };

      https.createServer(httpsOptions, app).listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   ORS Payment Service (HTTPS)                     ║
║   ───────────────────────────                     ║
║                                                   ║
║   Server running on https://localhost:${PORT}      ║
║                                                   ║
║   Endpoints:                                      ║
║   • GET  /api/companies     - Company management  ║
║   • GET  /api/pos           - POS management      ║
║   • POST /api/payment/pay   - Process payment     ║
║   • GET  /api/transactions  - Transaction history ║
║   • GET  /health            - Health check        ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
        `);
      });
    } else {
      app.listen(PORT, () => {
        console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   ORS Payment Service (HTTP)                      ║
║   ──────────────────────────                      ║
║                                                   ║
║   Server running on http://localhost:${PORT}       ║
║                                                   ║
║   Endpoints:                                      ║
║   • GET  /api/companies     - Company management  ║
║   • GET  /api/pos           - POS management      ║
║   • POST /api/payment/pay   - Process payment     ║
║   • GET  /api/transactions  - Transaction history ║
║   • GET  /health            - Health check        ║
║                                                   ║
╚═══════════════════════════════════════════════════╝
        `);
      });
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
