/**
 * Payment Service
 * Ana ödeme işlemleri
 */

import { Transaction, VirtualPos } from '../models/index.js';
import { getProvider, isProviderSupported } from '../providers/index.js';
import { getBinInfo, isDomesticCard } from './BinService.js';

/**
 * Query BIN and get installment options
 */
export async function queryBin(companyId, bin, amount, currency) {
  const binInfo = await getBinInfo(bin);

  if (!binInfo) {
    return { success: false, error: 'Geçersiz kart numarası' };
  }

  // Find suitable POS for this card/currency
  const pos = await findSuitablePos(companyId, currency, binInfo);

  if (!pos) {
    return { success: false, error: 'Uygun sanal pos bulunamadı' };
  }

  // Generate installment options
  const installments = generateInstallmentOptions(pos, amount, currency, binInfo);

  return {
    success: true,
    bin: binInfo,
    pos: {
      id: pos._id,
      name: pos.name,
      provider: pos.provider
    },
    installments
  };
}

/**
 * Find suitable POS for the transaction
 */
async function findSuitablePos(companyId, currency, binInfo) {
  const currencyLower = currency.toLowerCase();

  // First try to find default POS for currency
  let pos = await VirtualPos.findOne({
    company: companyId,
    currencies: currencyLower,
    defaultForCurrencies: currencyLower,
    status: true
  });

  if (!pos) {
    // Find any active POS for currency
    pos = await VirtualPos.findOne({
      company: companyId,
      currencies: currencyLower,
      status: true
    });
  }

  return pos;
}

/**
 * Generate installment options
 */
function generateInstallmentOptions(pos, amount, currency, binInfo) {
  const options = [];

  // Single payment always available
  options.push({
    count: 1,
    amount: amount
  });

  // Installments only for TRY and credit cards
  if (currency === 'try' && pos.installment?.enabled && binInfo.type === 'credit') {
    const maxCount = pos.installment.maxCount || 12;
    const minAmount = pos.installment.minAmount || 100;

    if (amount >= minAmount) {
      for (let i = 2; i <= maxCount; i++) {
        // Simple calculation - can be enhanced with commission rates
        options.push({
          count: i,
          amount: amount // Same amount, just divided
        });
      }
    }
  }

  return options;
}

/**
 * Create and start payment
 */
export async function createPayment(data) {
  const { posId, amount, currency, installment, card, customer, externalId } = data;

  // Get POS
  const pos = await VirtualPos.findById(posId).populate('company');

  if (!pos || !pos.status) {
    throw new Error('Sanal pos bulunamadı veya aktif değil');
  }

  if (!isProviderSupported(pos.provider)) {
    throw new Error(`Provider henüz desteklenmiyor: ${pos.provider}`);
  }

  // Get BIN info
  const bin = parseInt(card.number.replace(/\s/g, '').slice(0, 8), 10);
  const binInfo = await getBinInfo(bin);

  // Validate domestic card for TRY
  if (currency !== 'try' && binInfo && isDomesticCard(binInfo)) {
    throw new Error('Yurtiçi kartlarla sadece TL ödeme yapabilirsiniz');
  }

  // Create transaction
  const transaction = new Transaction({
    pos: pos._id,
    amount,
    currency,
    installment: installment || 1,
    card: {
      holder: card.holder,
      number: card.number,
      expiry: card.expiry,
      cvv: card.cvv,
      bin: bin // numeric BIN (first 8 digits)
    },
    bin: binInfo ? {
      bank: binInfo.bank || '',
      brand: binInfo.brand || '',
      type: binInfo.type || '',
      family: binInfo.family || '',
      country: binInfo.country || ''
    } : {},
    customer: customer || {},
    status: 'pending',
    externalId
  });

  await transaction.save();

  // Initialize provider
  try {
    const provider = getProvider(transaction, pos);
    const result = await provider.initialize();

    if (!result.success) {
      transaction.status = 'failed';
      transaction.result = {
        success: false,
        code: result.code || 'INIT_ERROR',
        message: result.error || 'Ödeme başlatılamadı'
      };
      await transaction.save();
      throw new Error(transaction.result.message);
    }

    // Reload transaction from DB to get formData saved by provider
    // Then update status (Mongoose Mixed type doesn't auto-detect nested changes)
    await Transaction.updateOne(
      { _id: transaction._id },
      { $set: { status: 'processing' } }
    );

    return {
      success: true,
      transactionId: transaction._id,
      // formUrl for 3D Secure iframe/redirect
      formUrl: `${process.env.CALLBACK_BASE_URL}/payment/${transaction._id}/form`
    };
  } catch (error) {
    transaction.status = 'failed';
    transaction.result = {
      success: false,
      code: 'ERROR',
      message: error.message
    };
    await transaction.save();
    throw error;
  }
}

/**
 * Get 3D form HTML
 */
export async function getPaymentForm(transactionId) {
  const transaction = await Transaction.findById(transactionId).populate('pos');

  if (!transaction) {
    throw new Error('İşlem bulunamadı');
  }

  if (transaction.status !== 'processing') {
    throw new Error('İşlem durumu uygun değil');
  }

  const provider = getProvider(transaction, transaction.pos);
  return provider.getFormHtml();
}

/**
 * Process 3D callback
 */
export async function processCallback(transactionId, postData) {
  const transaction = await Transaction.findById(transactionId).populate('pos');

  if (!transaction) {
    throw new Error('İşlem bulunamadı');
  }

  const provider = getProvider(transaction, transaction.pos);
  return provider.processCallback(postData);
}

/**
 * Get transaction status
 */
export async function getTransactionStatus(transactionId) {
  const transaction = await Transaction.findById(transactionId)
    .populate('pos', 'name provider');

  if (!transaction) {
    return null;
  }

  return {
    id: transaction._id,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    installment: transaction.installment,
    card: {
      masked: transaction.card?.masked,
      bin: transaction.card?.bin
    },
    result: transaction.result,
    createdAt: transaction.createdAt,
    completedAt: transaction.completedAt
  };
}

export default {
  queryBin,
  createPayment,
  getPaymentForm,
  processCallback,
  getTransactionStatus
};
