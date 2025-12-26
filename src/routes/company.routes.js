/**
 * Company Routes
 * Auth handled at server level via apiKeyAuth + gatewayAuth
 */

import { Router } from 'express';
import { Company, ApiKey } from '../models/index.js';

const router = Router();

/**
 * GET /
 * List all companies
 */
router.get('/', async (req, res) => {
  try {
    const companies = await Company.find().sort({ name: 1 });
    res.json({ status: true, companies });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /
 * Create new company
 */
router.post('/', async (req, res) => {
  try {
    const { name, code, settings } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        status: false,
        error: 'Name ve code gerekli'
      });
    }

    // Check if code exists
    const existing = await Company.findOne({ code: code.toLowerCase() });
    if (existing) {
      return res.status(400).json({
        status: false,
        error: 'Bu kod zaten kullanılıyor'
      });
    }

    const company = await Company.create({
      name,
      code: code.toLowerCase(),
      settings: settings || {}
    });

    // Auto-create API key
    const apiKeyData = await ApiKey.createKeyPair(company._id, 'Default API Key');

    res.json({
      status: true,
      company,
      apiKey: apiKeyData
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /:id
 * Get company by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);

    if (!company) {
      return res.status(404).json({ status: false, error: 'Firma bulunamadı' });
    }

    res.json({ status: true, company });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

// Update company handler
const updateCompanyHandler = async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);

    if (!company) {
      return res.status(404).json({ status: false, error: 'Firma bulunamadı' });
    }

    const { name, status, settings } = req.body;

    if (name) company.name = name;
    if (typeof status === 'boolean') company.status = status;
    if (settings) company.settings = { ...company.settings, ...settings };

    await company.save();

    res.json({ status: true, company });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
};

/**
 * PUT /:id
 * Update company
 */
router.put('/:id', updateCompanyHandler);

/**
 * PATCH /:id
 * Update company (partial)
 */
router.patch('/:id', updateCompanyHandler);

/**
 * DELETE /:id
 * Delete company
 */
router.delete('/:id', async (req, res) => {
  try {
    const company = await Company.findByIdAndDelete(req.params.id);

    if (!company) {
      return res.status(404).json({ status: false, error: 'Firma bulunamadı' });
    }

    // Also delete related API keys
    await ApiKey.deleteMany({ company: company._id });

    res.json({ status: true, message: 'Firma silindi' });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /:id/api-keys
 * Get company API keys
 */
router.get('/:id/api-keys', async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);

    if (!company) {
      return res.status(404).json({ status: false, error: 'Firma bulunamadı' });
    }

    const apiKeys = await ApiKey.find({ company: company._id });

    res.json({ status: true, apiKeys });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /:id/api-keys
 * Create new API key for company
 */
router.post('/:id/api-keys', async (req, res) => {
  try {
    const company = await Company.findById(req.params.id);

    if (!company) {
      return res.status(404).json({ status: false, error: 'Firma bulunamadı' });
    }

    const { name } = req.body;
    const apiKeyData = await ApiKey.createKeyPair(company._id, name || 'API Key');

    res.json({
      status: true,
      apiKey: apiKeyData,
      warning: 'Secret sadece bir kez gösterilir, kaydetmeyi unutmayın!'
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

export default router;
