/**
 * Flexible Auth Middleware
 * Accepts EITHER JWT (admin panel) OR API Key (external integrations)
 */

import jwt from 'jsonwebtoken';
import { User, ApiKey, Company } from '../models/index.js';

export async function flexAuth(req, res, next) {
  try {
    // Check for JWT first
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId).populate('company');

        if (user && user.status) {
          req.user = user;
          req.authType = 'jwt';

          // For superadmin, use first company or query param
          if (user.isSuperAdmin()) {
            if (req.query.company || req.body.company) {
              const companyId = req.query.company || req.body.company;
              req.company = await Company.findById(companyId);
            } else {
              // Get default company
              req.company = await Company.findOne({ status: true });
            }
          } else {
            req.company = user.company;
          }

          return next();
        }
      } catch (jwtError) {
        // JWT invalid, try API key
      }
    }

    // Check for API Key
    const apiKey = req.headers['x-api-key'];
    const apiSecret = req.headers['x-api-secret'];

    if (apiKey && apiSecret) {
      const keyDoc = await ApiKey.findOne({ key: apiKey, status: true })
        .populate('company');

      if (keyDoc && keyDoc.verifySecret(apiSecret)) {
        if (keyDoc.company && keyDoc.company.status) {
          req.apiKey = keyDoc;
          req.company = keyDoc.company;
          req.authType = 'apikey';

          // Update last used
          keyDoc.touch().catch(() => {});

          return next();
        }
      }
    }

    // No valid auth found
    return res.status(401).json({
      status: false,
      error: 'Authentication gerekli (JWT veya API Key)'
    });

  } catch (error) {
    return res.status(401).json({
      status: false,
      error: 'Authentication hatası'
    });
  }
}

// Check permission (for API key auth)
export function hasPermission(permission) {
  return (req, res, next) => {
    // JWT auth (admin) has all permissions
    if (req.authType === 'jwt') {
      return next();
    }

    // API key needs specific permission
    if (req.apiKey && req.apiKey.permissions.includes(permission)) {
      return next();
    }

    return res.status(403).json({
      status: false,
      error: 'Bu işlem için yetkiniz yok'
    });
  };
}
