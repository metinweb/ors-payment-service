/**
 * POS Routes
 * Auth handled at server level via apiKeyAuth + gatewayAuth
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import { VirtualPos, Company } from '../models/index.js';
import { BANKS } from '../models/VirtualPos.js';
import { getSupportedProviders, isProviderSupported } from '../providers/index.js';

const router = Router();

/**
 * GET /
 * List POS terminals
 */
router.get('/', async (req, res) => {
  try {
    let query = {};

    // Filter by company if specified
    if (req.query.company) {
      query.company = req.query.company;
    }

    const posList = await VirtualPos.find(query)
      .populate('company', 'name code')
      .sort({ priority: -1, currency: 1, name: 1 });

    // Enrich with bank info
    const enrichedList = posList.map(pos => {
      const posObj = pos.toJSON();
      posObj.bank = BANKS[pos.bankCode] || null;
      return posObj;
    });

    res.json({ status: true, posList: enrichedList });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /banks
 * Get all available banks with their providers
 */
router.get('/banks', (req, res) => {
  const banks = Object.values(BANKS).map(bank => ({
    ...bank,
    providerSupported: isProviderSupported(bank.provider)
  }));

  res.json({
    status: true,
    banks
  });
});

/**
 * GET /providers
 * Get supported providers
 */
router.get('/providers', (req, res) => {
  res.json({
    status: true,
    providers: getSupportedProviders()
  });
});

/**
 * POST /
 * Create new POS terminal
 */
router.post('/', async (req, res) => {
  try {
    const {
      company,
      name,
      bankCode,
      provider,
      currencies,
      testMode,
      credentials,
      threeDSecure,
      installment,
      commissionRates,
      urls,
      limits,
      supportedCards,
      priority,
      paymentModel,
      allowDirectPayment,
      supportedCardFamilies
    } = req.body;

    if (!company) {
      return res.status(400).json({
        status: false,
        error: 'Firma belirtilmeli'
      });
    }

    const companyDoc = await Company.findById(company);
    if (!companyDoc) {
      return res.status(404).json({
        status: false,
        error: 'Firma bulunamadı'
      });
    }

    if (!name || !bankCode) {
      return res.status(400).json({
        status: false,
        error: 'Name ve bankCode gerekli'
      });
    }

    if (!currencies || !Array.isArray(currencies) || currencies.length === 0) {
      return res.status(400).json({
        status: false,
        error: 'En az bir para birimi seçilmeli'
      });
    }

    // Get bank info
    const bank = BANKS[bankCode];
    if (!bank) {
      return res.status(400).json({
        status: false,
        error: 'Geçersiz banka kodu'
      });
    }

    // Use bank's default provider if not specified
    const finalProvider = provider || bank.provider;

    // Check for duplicate (company + bankCode must be unique)
    const existingPos = await VirtualPos.findOne({
      company,
      bankCode
    });

    if (existingPos) {
      return res.status(400).json({
        status: false,
        error: `Bu firmada ${bank.name} için zaten bir POS tanımlı`
      });
    }

    // Check which currencies don't have a default POS yet for this company
    const existingDefaults = await VirtualPos.find({
      company,
      defaultForCurrencies: { $in: currencies }
    }).select('defaultForCurrencies');

    // Collect currencies that already have defaults
    const currenciesWithDefaults = new Set();
    existingDefaults.forEach(p => {
      (p.defaultForCurrencies || []).forEach(c => currenciesWithDefaults.add(c));
    });

    // Auto-set default for currencies that don't have one
    const autoDefaultCurrencies = currencies.filter(c => !currenciesWithDefaults.has(c));

    const pos = await VirtualPos.create({
      company,
      name,
      bankCode,
      provider: finalProvider,
      currencies,
      defaultForCurrencies: autoDefaultCurrencies, // Auto-set defaults
      testMode: testMode || false,
      credentials: credentials || {},
      threeDSecure: threeDSecure || {},
      installment: installment || {},
      commissionRates: commissionRates || [],
      urls: urls || {},
      limits: limits || {},
      supportedCards: supportedCards || {},
      priority: priority || 0,
      paymentModel: paymentModel || '3d',
      allowDirectPayment: allowDirectPayment || false,
      supportedCardFamilies: supportedCardFamilies || []
    });

    // Return with bank info
    const posObj = pos.toJSON();
    posObj.bank = bank;

    res.json({ status: true, pos: posObj });
  } catch (error) {
    // Handle MongoDB duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        status: false,
        error: 'Bu firma ve banka kombinasyonu zaten mevcut'
      });
    }
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /:id
 * Get POS details
 */
router.get('/:id', async (req, res) => {
  try {
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ status: false, error: 'Geçersiz POS ID formatı' });
    }

    const pos = await VirtualPos.findById(req.params.id)
      .populate('company', 'name code');

    if (!pos) {
      return res.status(404).json({ status: false, error: 'POS bulunamadı' });
    }

    res.json({ status: true, pos });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * PUT /:id
 * Update POS
 */
router.put('/:id', async (req, res) => {
  try {
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ status: false, error: 'Geçersiz POS ID formatı' });
    }

    const pos = await VirtualPos.findById(req.params.id);

    if (!pos) {
      return res.status(404).json({ status: false, error: 'POS bulunamadı' });
    }

    const {
      name,
      status,
      testMode,
      currencies,
      credentials,
      threeDSecure,
      installment,
      commissionRates,
      urls,
      limits,
      supportedCards,
      priority,
      paymentModel,
      allowDirectPayment,
      supportedCardFamilies
    } = req.body;

    if (name) pos.name = name;
    if (typeof status === 'boolean') pos.status = status;
    if (typeof testMode === 'boolean') pos.testMode = testMode;
    if (typeof priority === 'number') pos.priority = priority;
    if (paymentModel) pos.paymentModel = paymentModel;
    if (typeof allowDirectPayment === 'boolean') pos.allowDirectPayment = allowDirectPayment;
    if (supportedCardFamilies && Array.isArray(supportedCardFamilies)) {
      pos.supportedCardFamilies = supportedCardFamilies;
    }

    if (currencies && Array.isArray(currencies) && currencies.length > 0) {
      pos.currencies = currencies;
      pos.markModified('currencies');
    }

    if (credentials) {
      // Merge credentials (don't overwrite with empty values)
      Object.keys(credentials).forEach(key => {
        if (credentials[key] !== undefined && credentials[key] !== '') {
          pos.credentials[key] = credentials[key];
        }
      });
      pos.markModified('credentials');
    }

    if (threeDSecure) {
      pos.threeDSecure = { ...pos.threeDSecure?.toObject?.() || {}, ...threeDSecure };
      pos.markModified('threeDSecure');
    }

    if (installment) {
      // Deep merge for installment settings
      const currentInstallment = pos.installment?.toObject?.() || pos.installment || {};
      pos.installment = {
        ...currentInstallment,
        ...installment,
        // Preserve rates and campaigns arrays if provided
        rates: installment.rates !== undefined ? installment.rates : currentInstallment.rates,
        campaigns: installment.campaigns !== undefined ? installment.campaigns : currentInstallment.campaigns
      };
      pos.markModified('installment');
    }

    if (commissionRates !== undefined) {
      pos.commissionRates = commissionRates;
      pos.markModified('commissionRates');
    }

    if (urls) {
      pos.urls = { ...pos.urls?.toObject?.() || {}, ...urls };
      pos.markModified('urls');
    }

    if (limits) {
      pos.limits = { ...pos.limits?.toObject?.() || {}, ...limits };
      pos.markModified('limits');
    }

    if (supportedCards) {
      pos.supportedCards = { ...pos.supportedCards?.toObject?.() || {}, ...supportedCards };
      pos.markModified('supportedCards');
    }

    await pos.save();

    // Return with bank info
    const posObj = pos.toJSON();
    posObj.bank = BANKS[pos.bankCode] || null;

    res.json({ status: true, pos: posObj });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /:id/set-default/:currency
 * Set POS as default for a specific currency
 */
router.post('/:id/set-default/:currency', async (req, res) => {
  try {
    const { id, currency } = req.params;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ status: false, error: 'Geçersiz POS ID formatı' });
    }

    // Validate currency
    const validCurrencies = ['try', 'eur', 'usd', 'gbp'];
    if (!validCurrencies.includes(currency.toLowerCase())) {
      return res.status(400).json({ status: false, error: 'Geçersiz para birimi' });
    }

    const pos = await VirtualPos.findById(id);
    if (!pos) {
      return res.status(404).json({ status: false, error: 'POS bulunamadı' });
    }

    // Check if this POS supports this currency
    if (!pos.currencies.includes(currency.toLowerCase())) {
      return res.status(400).json({
        status: false,
        error: `Bu POS ${currency.toUpperCase()} para birimini desteklemiyor`
      });
    }

    // Remove this currency from all other POS defaults in the same company
    await VirtualPos.updateMany(
      { company: pos.company, _id: { $ne: pos._id } },
      { $pull: { defaultForCurrencies: currency.toLowerCase() } }
    );

    // Add this currency to this POS's defaults (if not already)
    if (!pos.defaultForCurrencies.includes(currency.toLowerCase())) {
      pos.defaultForCurrencies.push(currency.toLowerCase());
      await pos.save();
    }

    // Return updated POS with bank info
    const posObj = pos.toJSON();
    posObj.bank = BANKS[pos.bankCode] || null;

    res.json({ status: true, pos: posObj, message: `${currency.toUpperCase()} için varsayılan POS ayarlandı` });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * DELETE /:id/unset-default/:currency
 * Remove POS as default for a specific currency
 */
router.delete('/:id/unset-default/:currency', async (req, res) => {
  try {
    const { id, currency } = req.params;

    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ status: false, error: 'Geçersiz POS ID formatı' });
    }

    const pos = await VirtualPos.findById(id);
    if (!pos) {
      return res.status(404).json({ status: false, error: 'POS bulunamadı' });
    }

    // Remove this currency from defaults
    pos.defaultForCurrencies = pos.defaultForCurrencies.filter(c => c !== currency.toLowerCase());
    await pos.save();

    // Return updated POS with bank info
    const posObj = pos.toJSON();
    posObj.bank = BANKS[pos.bankCode] || null;

    res.json({ status: true, pos: posObj, message: `${currency.toUpperCase()} için varsayılan kaldırıldı` });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * DELETE /:id
 * Delete POS
 */
router.delete('/:id', async (req, res) => {
  try {
    // Validate ObjectId format
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ status: false, error: 'Geçersiz POS ID formatı' });
    }

    const pos = await VirtualPos.findById(req.params.id);

    if (!pos) {
      return res.status(404).json({ status: false, error: 'POS bulunamadı' });
    }

    await pos.deleteOne();

    res.json({ status: true, message: 'POS silindi' });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

export default router;
