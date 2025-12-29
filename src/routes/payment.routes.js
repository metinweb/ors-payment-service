/**
 * Payment Routes
 * Auth handled at server level via apiKeyAuth + gatewayAuth
 * Note: /form and /callback routes are mounted separately as public routes
 */

import { Router } from 'express';
import PaymentService from '../services/PaymentService.js';
import { VirtualPos, Company } from '../models/index.js';

const router = Router();

/**
 * POST /bin
 * Query BIN and get installment options
 */
router.post('/bin', async (req, res) => {
  try {
    const { bin, amount, currency, company } = req.body;

    if (!bin || !amount || !currency) {
      return res.status(400).json({
        status: false,
        error: 'bin, amount ve currency gerekli'
      });
    }

    // Get company ID from request or use first active company
    let companyId = company;
    if (!companyId) {
      const defaultCompany = await Company.findOne({ status: true });
      if (!defaultCompany) {
        return res.status(400).json({
          status: false,
          error: 'No active company found'
        });
      }
      companyId = defaultCompany._id;
    }

    const result = await PaymentService.queryBin(
      companyId,
      bin,
      parseFloat(amount),
      currency.toLowerCase()
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /pay
 * Start payment
 */
router.post('/pay', async (req, res) => {
  try {
    const { posId, amount, currency, installment, card, customer, externalId, company } = req.body;

    // Validate required fields
    if (!amount || !currency || !card) {
      return res.status(400).json({
        status: false,
        error: 'amount, currency ve card gerekli'
      });
    }

    if (!card.holder || !card.number || !card.expiry || !card.cvv) {
      return res.status(400).json({
        status: false,
        error: 'Kart bilgileri eksik (holder, number, expiry, cvv)'
      });
    }

    // Get company ID from request or use first active company
    let companyId = company;
    if (!companyId) {
      const defaultCompany = await Company.findOne({ status: true });
      if (!defaultCompany) {
        return res.status(400).json({
          status: false,
          error: 'No active company found'
        });
      }
      companyId = defaultCompany._id;
    }

    // Find POS if not specified
    let targetPosId = posId;
    if (!targetPosId) {
      // Use BIN query to find suitable POS
      const binResult = await PaymentService.queryBin(
        companyId,
        card.number.slice(0, 8),
        parseFloat(amount),
        currency.toLowerCase()
      );

      if (!binResult.success) {
        return res.status(400).json(binResult);
      }

      targetPosId = binResult.pos.id;
    }

    const result = await PaymentService.createPayment({
      posId: targetPosId,
      amount: parseFloat(amount),
      currency: currency.toLowerCase(),
      installment: parseInt(installment) || 1,
      card: {
        holder: card.holder,
        number: card.number.replace(/\s/g, ''),
        expiry: card.expiry,
        cvv: card.cvv
      },
      customer: customer || {},
      externalId
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /:id
 * Get payment status
 */
router.get('/:id', async (req, res) => {
  try {
    const status = await PaymentService.getTransactionStatus(req.params.id);

    if (!status) {
      return res.status(404).json({
        status: false,
        error: 'Transaction not found'
      });
    }

    res.json({ status: true, transaction: status });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /refund
 * Refund a completed payment
 */
router.post('/refund', async (req, res) => {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({
        status: false,
        error: 'transactionId gerekli'
      });
    }

    const result = await PaymentService.refundPayment(transactionId);
    res.json({ status: true, ...result });
  } catch (error) {
    res.status(400).json({ status: false, error: error.message });
  }
});

/**
 * POST /cancel
 * Cancel a payment (same day only)
 */
router.post('/cancel', async (req, res) => {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({
        status: false,
        error: 'transactionId gerekli'
      });
    }

    const result = await PaymentService.cancelPayment(transactionId);
    res.json({ status: true, ...result });
  } catch (error) {
    res.status(400).json({ status: false, error: error.message });
  }
});

/**
 * GET /status/:id
 * Query bank for transaction status
 */
router.get('/status/:id', async (req, res) => {
  try {
    const result = await PaymentService.queryBankStatus(req.params.id);
    res.json({ status: true, ...result });
  } catch (error) {
    res.status(400).json({ status: false, error: error.message });
  }
});

/**
 * POST /pre-auth
 * Create pre-authorization (block amount without capture)
 */
router.post('/pre-auth', async (req, res) => {
  try {
    const { posId, amount, currency, installment, card, customer, externalId } = req.body;

    if (!posId || !amount || !currency || !card) {
      return res.status(400).json({
        status: false,
        error: 'posId, amount, currency ve card gerekli'
      });
    }

    if (!card.holder || !card.number || !card.expiry || !card.cvv) {
      return res.status(400).json({
        status: false,
        error: 'Kart bilgileri eksik (holder, number, expiry, cvv)'
      });
    }

    const result = await PaymentService.createPreAuth({
      posId,
      amount: parseFloat(amount),
      currency: currency.toLowerCase(),
      installment: parseInt(installment) || 1,
      card: {
        holder: card.holder,
        number: card.number.replace(/\s/g, ''),
        expiry: card.expiry,
        cvv: card.cvv
      },
      customer: customer || {},
      externalId
    });

    res.json({ status: true, ...result });
  } catch (error) {
    res.status(400).json({ status: false, error: error.message });
  }
});

/**
 * POST /post-auth
 * Capture pre-authorized amount
 */
router.post('/post-auth', async (req, res) => {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({
        status: false,
        error: 'transactionId gerekli'
      });
    }

    const result = await PaymentService.createPostAuth(transactionId);
    res.json({ status: true, ...result });
  } catch (error) {
    res.status(400).json({ status: false, error: error.message });
  }
});

/**
 * GET /capabilities/:posId
 * Get POS capabilities
 */
router.get('/capabilities/:posId', async (req, res) => {
  try {
    const result = await PaymentService.getPosCapabilities(req.params.posId);
    res.json({ status: true, ...result });
  } catch (error) {
    res.status(400).json({ status: false, error: error.message });
  }
});

export default router;

// ============================================================================
// PUBLIC ROUTES (no auth required - called by browser/bank)
// These are exported separately and mounted at root level
// ============================================================================

export const publicPaymentRoutes = Router();

/**
 * GET /payment/:id/form
 * Get 3D form HTML (for redirect)
 * No auth - called by browser
 */
publicPaymentRoutes.get('/:id/form', async (req, res) => {
  try {
    const html = await PaymentService.getPaymentForm(req.params.id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    res.status(400).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Error</h1>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});

/**
 * OPTIONS /payment/:id/callback
 * CORS preflight for callback
 */
publicPaymentRoutes.options('/:id/callback', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.status(200).end();
});

/**
 * POST /payment/:id/callback
 * 3D callback from bank
 * No auth - called by bank
 */
publicPaymentRoutes.post('/:id/callback', async (req, res) => {
  // Allow all origins for callback (bank redirects here)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const result = await PaymentService.processCallback(req.params.id, req.body);

    // Return HTML result page
    const statusClass = result.success ? 'success' : 'error';
    const statusText = result.success ? 'Payment Successful' : 'Payment Failed';
    const message = result.message || '';

    // Get frontend URL from env or default
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${statusText}</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .result { text-align: center; padding: 40px; background: white; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; }
    .success { color: #27ae60; }
    .error { color: #e74c3c; }
    .icon { font-size: 60px; margin-bottom: 20px; }
    h1 { margin: 0 0 10px; }
    p { color: #666; margin: 0; }
  </style>
</head>
<body>
  <div class="result">
    <div class="icon ${statusClass}">${result.success ? '✓' : '✗'}</div>
    <h1 class="${statusClass}">${statusText}</h1>
    <p>${message}</p>
    <p id="status">Yönlendiriliyor...</p>
  </div>
  <script>
    var result = ${JSON.stringify(result)};
    var sent = false;

    function sendToParent() {
      if (sent) return;
      try {
        // Try multiple methods to reach parent
        if (window.top !== window) {
          window.top.postMessage({ type: 'payment_result', data: result }, '*');
          sent = true;
        } else if (window.parent !== window) {
          window.parent.postMessage({ type: 'payment_result', data: result }, '*');
          sent = true;
        } else if (window.opener) {
          window.opener.postMessage({ type: 'payment_result', data: result }, '*');
          sent = true;
        }
      } catch(e) {
        console.error('postMessage error:', e);
      }
    }

    // Try immediately
    sendToParent();

    // Retry a few times
    setTimeout(sendToParent, 100);
    setTimeout(sendToParent, 500);
    setTimeout(sendToParent, 1000);

    // Fallback: redirect to frontend with result after 3 seconds
    setTimeout(function() {
      if (!sent) {
        var redirectUrl = '${frontendUrl}/payment/result?success=' + result.success + '&message=' + encodeURIComponent(result.message || '');
        window.location.href = redirectUrl;
      }
    }, 3000);
  </script>
</body>
</html>
    `);
  } catch (error) {
    res.status(400).send(`
      <html>
        <head><title>Error</title></head>
        <body>
          <h1>Processing Error</h1>
          <p>${error.message}</p>
        </body>
      </html>
    `);
  }
});
