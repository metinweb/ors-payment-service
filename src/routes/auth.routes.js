import { Router } from 'express';
import { User, Company, ApiKey } from '../models/index.js';
import { jwtAuth, generateToken, superAdminOnly } from '../middleware/jwtAuth.js';

const router = Router();

/**
 * POST /auth/login
 * Login and get JWT token
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        status: false,
        error: 'Email ve şifre gerekli'
      });
    }

    const user = await User.findOne({ email, status: true })
      .select('+password')
      .populate('company');

    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({
        status: false,
        error: 'Geçersiz email veya şifre'
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = generateToken(user._id);

    res.json({
      status: true,
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        company: user.company ? {
          id: user.company._id,
          name: user.company.name,
          code: user.company.code
        } : null
      }
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /auth/me
 * Get current user
 */
router.get('/me', jwtAuth, async (req, res) => {
  res.json({
    status: true,
    user: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
      company: req.user.company ? {
        id: req.user.company._id,
        name: req.user.company.name,
        code: req.user.company.code
      } : null
    }
  });
});

/**
 * POST /auth/setup
 * Initial setup - create first superadmin (only works if no users exist)
 */
router.post('/setup', async (req, res) => {
  try {
    const userCount = await User.countDocuments();

    if (userCount > 0) {
      return res.status(400).json({
        status: false,
        error: 'Setup zaten tamamlanmış'
      });
    }

    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({
        status: false,
        error: 'Email, şifre ve isim gerekli'
      });
    }

    // Create default company
    const company = await Company.create({
      name: 'Default Company',
      code: 'default',
      status: true
    });

    // Create superadmin
    const user = await User.create({
      email,
      password,
      name,
      role: 'superadmin',
      company: null
    });

    // Create API key for default company
    const apiKeyData = await ApiKey.createKeyPair(company._id, 'Default API Key');

    const token = generateToken(user._id);

    res.json({
      status: true,
      message: 'Setup tamamlandı',
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      company: {
        id: company._id,
        name: company.name,
        code: company.code
      },
      apiKey: apiKeyData
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

export default router;
