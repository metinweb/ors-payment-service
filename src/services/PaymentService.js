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

  // Return flattened response for frontend compatibility
  return {
    success: true,
    // BIN info flattened for frontend
    bank: binInfo.bank || 'Unknown',
    bankCode: binInfo.bankCode || '',
    cardType: binInfo.type || 'credit',
    cardFamily: binInfo.family || '',
    brand: binInfo.brand || 'unknown',
    country: binInfo.country || 'tr',
    // POS info
    pos: {
      id: pos._id,
      name: pos.name,
      bankCode: pos.bankCode,
      provider: pos.provider
    },
    // Installment options
    installments
  };
}

/**
 * Find suitable POS for the transaction
 * Priority order:
 * 1. Same bank as card (onus transaction = best rates)
 * 2. POS that supports card family (world, bonus, etc.)
 * 3. Default POS for currency
 * 4. Any active POS for currency (by priority)
 */
async function findSuitablePos(companyId, currency, binInfo) {
  const currencyLower = currency.toLowerCase();
  const cardBankCode = binInfo?.bankCode?.toLowerCase() || '';
  const cardFamily = binInfo?.family?.toLowerCase() || '';

  // Get all active POS for this currency
  const allPos = await VirtualPos.find({
    company: companyId,
    currencies: currencyLower,
    status: true
  }).sort({ priority: -1 }); // Higher priority first

  if (!allPos.length) {
    return null;
  }

  // 1. Try to find POS with same bank (onus = best rates)
  if (cardBankCode) {
    const onusPos = allPos.find(p => p.bankCode === cardBankCode);
    if (onusPos) {
      console.log(`[POS] Selected onus POS: ${onusPos.name} (card bank: ${cardBankCode})`);
      return onusPos;
    }
  }

  // 2. Try to find POS that supports the card family
  if (cardFamily) {
    const familyPos = allPos.find(p =>
      p.supportedCardFamilies &&
      p.supportedCardFamilies.some(f => f.toLowerCase() === cardFamily)
    );
    if (familyPos) {
      console.log(`[POS] Selected family POS: ${familyPos.name} (card family: ${cardFamily})`);
      return familyPos;
    }
  }

  // 3. Try default POS for currency
  const defaultPos = allPos.find(p =>
    p.defaultForCurrencies && p.defaultForCurrencies.includes(currencyLower)
  );
  if (defaultPos) {
    console.log(`[POS] Selected default POS: ${defaultPos.name}`);
    return defaultPos;
  }

  // 4. Return highest priority POS
  console.log(`[POS] Selected by priority: ${allPos[0].name}`);
  return allPos[0];
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
