/**
 * Transaction Routes
 * Auth handled at server level via apiKeyAuth + gatewayAuth
 */

import { Router } from 'express';
import { Transaction, VirtualPos } from '../models/index.js';

const router = Router();

/**
 * GET /
 * List transactions
 */
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, status, currency, from, to, startDate, endDate, orderId, company } = req.query;

    // Build query
    const query = {};

    // Filter by company (via POS)
    if (company) {
      const posList = await VirtualPos.find({ company }).select('_id');
      const posIds = posList.map(p => p._id);
      if (posIds.length > 0) {
        query.pos = { $in: posIds };
      } else {
        // No POS for this company = no transactions
        return res.json({
          status: true,
          transactions: [],
          pagination: { page: 1, limit: 20, total: 0, pages: 0 }
        });
      }
    }

    // Status filter
    if (status) {
      query.status = status;
    }

    // Currency filter
    if (currency) {
      query.currency = currency.toLowerCase();
    }

    // Date range filter (support both from/to and startDate/endDate)
    const dateFrom = startDate || from;
    const dateTo = endDate || to;
    if (dateFrom || dateTo) {
      query.createdAt = {};
      if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        // End of day for endDate
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        query.createdAt.$lte = endOfDay;
      }
    }

    // Order ID filter (search in logs)
    if (orderId) {
      query.$or = [
        { 'logs.request.OrderId': { $regex: orderId, $options: 'i' } },
        { 'logs.request.orderId': { $regex: orderId, $options: 'i' } }
      ];
    }

    // Pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Transaction.countDocuments(query);

    const transactions = await Transaction.find(query)
      .populate('pos', 'name provider currency')
      .select('-card.holder -card.number -card.expiry -card.cvv')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      status: true,
      transactions,
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
 * Get transaction statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const { company } = req.query;

    // Filter by company
    let posIds = [];
    if (company) {
      const posList = await VirtualPos.find({ company }).select('_id');
      posIds = posList.map(p => p._id);
    }

    const matchQuery = posIds.length > 0 ? { pos: { $in: posIds } } : {};

    // Aggregation for stats
    const stats = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            status: '$status',
            currency: '$currency'
          },
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      },
      {
        $group: {
          _id: '$_id.currency',
          statuses: {
            $push: {
              status: '$_id.status',
              count: '$count',
              total: '$total'
            }
          },
          totalCount: { $sum: '$count' },
          totalAmount: { $sum: '$total' }
        }
      }
    ]);

    // Today's stats
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayStats = await Transaction.aggregate([
      {
        $match: {
          ...matchQuery,
          createdAt: { $gte: today }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          total: { $sum: '$amount' }
        }
      }
    ]);

    res.json({
      status: true,
      stats: {
        byCurrency: stats,
        today: todayStats
      }
    });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

/**
 * GET /:id
 * Get transaction details
 */
router.get('/:id', async (req, res) => {
  try {
    const transaction = await Transaction.findById(req.params.id)
      .populate('pos', 'name provider currency company');

    if (!transaction) {
      return res.status(404).json({ status: false, error: 'Transaction not found' });
    }

    res.json({ status: true, transaction });
  } catch (error) {
    res.status(500).json({ status: false, error: error.message });
  }
});

export default router;
