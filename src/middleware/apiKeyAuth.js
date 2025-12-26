import { ApiKey } from '../models/index.js';

export async function apiKeyAuth(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    const apiSecret = req.headers['x-api-secret'];

    if (!apiKey || !apiSecret) {
      return res.status(401).json({
        status: false,
        error: 'API Key ve Secret gerekli'
      });
    }

    const keyDoc = await ApiKey.findOne({ key: apiKey, status: true })
      .populate('company');

    if (!keyDoc) {
      return res.status(401).json({
        status: false,
        error: 'Geçersiz API Key'
      });
    }

    if (!keyDoc.verifySecret(apiSecret)) {
      return res.status(401).json({
        status: false,
        error: 'Geçersiz API Secret'
      });
    }

    if (!keyDoc.company || !keyDoc.company.status) {
      return res.status(401).json({
        status: false,
        error: 'Firma aktif değil'
      });
    }

    // Update last used (async, don't wait)
    keyDoc.touch().catch(() => {});

    req.apiKey = keyDoc;
    req.company = keyDoc.company;
    next();
  } catch (error) {
    return res.status(401).json({
      status: false,
      error: 'Authentication hatası'
    });
  }
}

// Check permission
export function hasPermission(permission) {
  return (req, res, next) => {
    if (!req.apiKey.permissions.includes(permission)) {
      return res.status(403).json({
        status: false,
        error: 'Bu işlem için yetkiniz yok'
      });
    }
    next();
  };
}
