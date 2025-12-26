/**
 * ORS Payment Service
 * Virtual POS payment processing
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDB } from './config/database.js';

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

// Payment processing
app.use('/api/payment', paymentRoutes);

// Transaction history
app.use('/api/transactions', transactionRoutes);

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

    app.listen(PORT, () => {
      console.log(`
╔═══════════════════════════════════════════════════╗
║                                                   ║
║   ORS Payment Service                             ║
║   ───────────────────                             ║
║                                                   ║
║   Server running on port ${PORT}                   ║
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
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
