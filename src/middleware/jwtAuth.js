import jwt from 'jsonwebtoken';
import { User } from '../models/index.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';

export async function jwtAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: false, error: 'Token gerekli' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = await User.findById(decoded.userId).populate('company');

    if (!user || !user.status) {
      return res.status(401).json({ status: false, error: 'Geçersiz token' });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ status: false, error: 'Geçersiz token' });
  }
}

// Only superadmin
export function superAdminOnly(req, res, next) {
  if (!req.user.isSuperAdmin()) {
    return res.status(403).json({ status: false, error: 'Yetkiniz yok' });
  }
  next();
}

// Admin or superadmin
export function adminOnly(req, res, next) {
  if (!['superadmin', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ status: false, error: 'Yetkiniz yok' });
  }
  next();
}

// Generate JWT
export function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}
