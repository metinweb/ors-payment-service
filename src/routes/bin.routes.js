/**
 * BIN Routes
 * BIN listesi yönetimi ve arama
 */

import { Router } from 'express';
import { Bin } from '../models/index.js';

const router = Router();

/**
 * GET /
 * List BINs with filters and pagination
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      brand,
      type,
      bank,
      bankCode,
      family,
      country,
      isActive
    } = req.query;

    // Build query
    const query = {};

    // Search filter (bin, bank, family)
    if (search) {
      const searchRegex = { $regex: search, $options: 'i' };
      query.$or = [
        { bin: searchRegex },
        { bank: searchRegex },
        { family: searchRegex }
      ];
    }

    // Brand filter
    if (brand) {
      query.brand = brand.toLowerCase();
    }

    // Type filter
    if (type) {
      query.type = type.toLowerCase();
    }

    // Bank filter
    if (bank) {
      query.bank = { $regex: bank, $options: 'i' };
    }

    // Bank code filter
    if (bankCode) {
      query.bankCode = bankCode.toLowerCase();
    }

    // Family filter
    if (family) {
      query.family = { $regex: family, $options: 'i' };
    }

    // Country filter
    if (country) {
      query.country = country.toUpperCase();
    }

    // Active filter
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Bin.countDocuments(query);

    const bins = await Bin.find(query)
      .sort({ bin: 1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      status: true,
      bins,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /stats
 * Get BIN statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const [
      totalCount,
      brandStats,
      typeStats,
      bankStats,
      countryStats
    ] = await Promise.all([
      Bin.countDocuments({}),
      Bin.aggregate([
        { $group: { _id: '$brand', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Bin.aggregate([
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Bin.aggregate([
        { $group: { _id: '$bank', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 }
      ]),
      Bin.aggregate([
        { $group: { _id: '$country', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    res.json({
      status: true,
      stats: {
        total: totalCount,
        byBrand: brandStats,
        byType: typeStats,
        byBank: bankStats,
        byCountry: countryStats
      }
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /search/:bin
 * Quick BIN lookup (real-time search)
 */
router.get('/search/:bin', async (req, res) => {
  try {
    const binNumber = req.params.bin.replace(/\s/g, '');

    if (binNumber.length < 4) {
      return res.json({ status: true, bins: [] });
    }

    // Search by prefix
    const bins = await Bin.find({
      bin: { $regex: `^${binNumber}`, $options: 'i' }
    })
    .limit(10)
    .sort({ bin: 1 });

    res.json({ status: true, bins });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /lookup/:bin
 * Get exact BIN info
 */
router.get('/lookup/:bin', async (req, res) => {
  try {
    const binNumber = req.params.bin.replace(/\s/g, '').slice(0, 8);

    // Try exact match first (8 digits, then 6 digits)
    let bin = await Bin.findOne({ bin: binNumber });

    if (!bin && binNumber.length > 6) {
      bin = await Bin.findOne({ bin: binNumber.slice(0, 6) });
    }

    if (!bin) {
      return res.status(404).json({ status: false, error: 'BIN not found' });
    }

    res.json({ status: true, bin });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /banks
 * Get unique bank list
 */
router.get('/banks', async (req, res) => {
  try {
    const banks = await Bin.distinct('bank');
    res.json({ status: true, banks: banks.sort() });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /families
 * Get unique card family list
 */
router.get('/families', async (req, res) => {
  try {
    const families = await Bin.distinct('family');
    res.json({ status: true, families: families.filter(f => f).sort() });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /:id
 * Get single BIN by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const bin = await Bin.findById(req.params.id);

    if (!bin) {
      return res.status(404).json({ status: false, error: 'BIN not found' });
    }

    res.json({ status: true, bin });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /
 * Create new BIN
 */
router.post('/', async (req, res) => {
  try {
    const { bin, brand, type, family, bank, bankCode, country, notes } = req.body;

    // Validate BIN
    if (!bin || bin.length < 6 || bin.length > 8) {
      return res.status(400).json({ status: false, error: 'BIN must be 6-8 digits' });
    }

    // Check duplicate
    const existing = await Bin.findOne({ bin });
    if (existing) {
      return res.status(400).json({ status: false, error: 'BIN already exists' });
    }

    const newBin = new Bin({
      bin,
      brand: brand?.toLowerCase(),
      type: type?.toLowerCase() || 'credit',
      family: family?.toLowerCase() || '',
      bank,
      bankCode: bankCode?.toLowerCase() || '',
      country: country?.toUpperCase() || 'TR',
      notes: notes || ''
    });

    await newBin.save();

    res.status(201).json({ status: true, bin: newBin });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * POST /bulk
 * Bulk import BINs
 */
router.post('/bulk', async (req, res) => {
  try {
    const { bins } = req.body;

    if (!Array.isArray(bins) || bins.length === 0) {
      return res.status(400).json({ status: false, error: 'bins array is required' });
    }

    const results = {
      created: 0,
      updated: 0,
      errors: []
    };

    for (const binData of bins) {
      try {
        const existing = await Bin.findOne({ bin: binData.bin });

        if (existing) {
          // Update existing
          Object.assign(existing, {
            brand: binData.brand?.toLowerCase() || existing.brand,
            type: binData.type?.toLowerCase() || existing.type,
            family: binData.family?.toLowerCase() || existing.family,
            bank: binData.bank || existing.bank,
            bankCode: binData.bankCode?.toLowerCase() || existing.bankCode,
            country: binData.country?.toUpperCase() || existing.country
          });
          await existing.save();
          results.updated++;
        } else {
          // Create new
          const newBin = new Bin({
            bin: binData.bin,
            brand: binData.brand?.toLowerCase(),
            type: binData.type?.toLowerCase() || 'credit',
            family: binData.family?.toLowerCase() || '',
            bank: binData.bank,
            bankCode: binData.bankCode?.toLowerCase() || '',
            country: binData.country?.toUpperCase() || 'TR'
          });
          await newBin.save();
          results.created++;
        }
      } catch (err) {
        results.errors.push({ bin: binData.bin, error: err.message });
      }
    }

    res.json({ status: true, results });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * PUT /:id
 * Update BIN
 */
router.put('/:id', async (req, res) => {
  try {
    const { brand, type, family, bank, bankCode, country, isActive, notes } = req.body;

    const bin = await Bin.findById(req.params.id);

    if (!bin) {
      return res.status(404).json({ status: false, error: 'BIN not found' });
    }

    // Update fields
    if (brand !== undefined) bin.brand = brand.toLowerCase();
    if (type !== undefined) bin.type = type.toLowerCase();
    if (family !== undefined) bin.family = family.toLowerCase();
    if (bank !== undefined) bin.bank = bank;
    if (bankCode !== undefined) bin.bankCode = bankCode.toLowerCase();
    if (country !== undefined) bin.country = country.toUpperCase();
    if (isActive !== undefined) bin.isActive = isActive;
    if (notes !== undefined) bin.notes = notes;

    await bin.save();

    res.json({ status: true, bin });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * DELETE /:id
 * Delete BIN
 */
router.delete('/:id', async (req, res) => {
  try {
    const bin = await Bin.findByIdAndDelete(req.params.id);

    if (!bin) {
      return res.status(404).json({ status: false, error: 'BIN not found' });
    }

    res.json({ status: true, message: 'BIN deleted' });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

export default router;
