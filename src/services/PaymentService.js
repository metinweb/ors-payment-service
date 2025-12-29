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

/**
 * Refund a completed payment
 */
export async function refundPayment(transactionId) {
  const originalTransaction = await Transaction.findById(transactionId).populate('pos');

  if (!originalTransaction) {
    throw new Error('İşlem bulunamadı');
  }

  if (!originalTransaction.canRefund()) {
    throw new Error('Bu işlem iade edilemez');
  }

  const pos = originalTransaction.pos;
  if (!pos || !pos.status) {
    throw new Error('POS bulunamadı veya aktif değil');
  }

  // Create refund transaction
  const refundTransaction = new Transaction({
    pos: pos._id,
    type: 'refund',
    parentTransaction: originalTransaction._id,
    amount: originalTransaction.amount,
    currency: originalTransaction.currency,
    orderId: originalTransaction.orderId,
    card: {
      masked: originalTransaction.card?.masked,
      bin: originalTransaction.card?.bin
    },
    customer: originalTransaction.customer,
    status: 'processing'
  });

  await refundTransaction.save();

  try {
    const provider = getProvider(refundTransaction, pos);

    if (!provider.supports('refund')) {
      throw new Error(`${pos.provider} iade işlemini desteklemiyor`);
    }

    const result = await provider.refund(originalTransaction);

    return {
      success: result.success,
      transactionId: refundTransaction._id,
      message: result.message,
      refNumber: result.refNumber
    };
  } catch (error) {
    refundTransaction.status = 'failed';
    refundTransaction.result = {
      success: false,
      code: 'ERROR',
      message: error.message
    };
    await refundTransaction.save();
    throw error;
  }
}

/**
 * Cancel a payment (same day only)
 */
export async function cancelPayment(transactionId) {
  const originalTransaction = await Transaction.findById(transactionId).populate('pos');

  if (!originalTransaction) {
    throw new Error('İşlem bulunamadı');
  }

  if (!originalTransaction.canCancel()) {
    throw new Error('Bu işlem iptal edilemez (gün sonu geçmiş olabilir)');
  }

  const pos = originalTransaction.pos;
  if (!pos || !pos.status) {
    throw new Error('POS bulunamadı veya aktif değil');
  }

  // Create cancel transaction
  const cancelTransaction = new Transaction({
    pos: pos._id,
    type: 'cancel',
    parentTransaction: originalTransaction._id,
    amount: originalTransaction.amount,
    currency: originalTransaction.currency,
    orderId: originalTransaction.orderId,
    card: {
      masked: originalTransaction.card?.masked,
      bin: originalTransaction.card?.bin
    },
    customer: originalTransaction.customer,
    status: 'processing'
  });

  await cancelTransaction.save();

  try {
    const provider = getProvider(cancelTransaction, pos);

    if (!provider.supports('cancel')) {
      throw new Error(`${pos.provider} iptal işlemini desteklemiyor`);
    }

    const result = await provider.cancel(originalTransaction);

    return {
      success: result.success,
      transactionId: cancelTransaction._id,
      message: result.message
    };
  } catch (error) {
    cancelTransaction.status = 'failed';
    cancelTransaction.result = {
      success: false,
      code: 'ERROR',
      message: error.message
    };
    await cancelTransaction.save();
    throw error;
  }
}

/**
 * Query bank for transaction status
 */
export async function queryBankStatus(transactionId) {
  const transaction = await Transaction.findById(transactionId).populate('pos');

  if (!transaction) {
    throw new Error('İşlem bulunamadı');
  }

  if (!transaction.orderId) {
    throw new Error('İşlemin banka sipariş numarası bulunamadı');
  }

  const pos = transaction.pos;
  if (!pos || !pos.status) {
    throw new Error('POS bulunamadı veya aktif değil');
  }

  const provider = getProvider(transaction, pos);

  if (!provider.supports('status')) {
    throw new Error(`${pos.provider} durum sorgulama işlemini desteklemiyor`);
  }

  return provider.status(transaction.orderId);
}

/**
 * Create pre-authorization (block amount without capture)
 */
export async function createPreAuth(data) {
  const { posId, amount, currency, installment, card, customer, externalId } = data;

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

  // Create transaction
  const transaction = new Transaction({
    pos: pos._id,
    type: 'pre_auth',
    paymentModel: 'regular',
    amount,
    currency,
    installment: installment || 1,
    card: {
      holder: card.holder,
      number: card.number,
      expiry: card.expiry,
      cvv: card.cvv,
      bin: bin
    },
    bin: binInfo ? {
      bank: binInfo.bank || '',
      brand: binInfo.brand || '',
      type: binInfo.type || '',
      family: binInfo.family || '',
      country: binInfo.country || ''
    } : {},
    customer: customer || {},
    status: 'processing',
    externalId
  });

  await transaction.save();

  try {
    const provider = getProvider(transaction, pos);

    if (!provider.supports('preAuth')) {
      throw new Error(`${pos.provider} ön provizyon işlemini desteklemiyor`);
    }

    const result = await provider.preAuth();

    return {
      success: result.success,
      transactionId: transaction._id,
      message: result.message,
      authCode: result.authCode,
      refNumber: result.refNumber
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
 * Capture pre-authorized amount
 */
export async function createPostAuth(preAuthTransactionId) {
  const preAuthTransaction = await Transaction.findById(preAuthTransactionId).populate('pos');

  if (!preAuthTransaction) {
    throw new Error('Ön provizyon işlemi bulunamadı');
  }

  if (!preAuthTransaction.canPostAuth()) {
    throw new Error('Bu işlem için provizyon kapama yapılamaz');
  }

  const pos = preAuthTransaction.pos;
  if (!pos || !pos.status) {
    throw new Error('POS bulunamadı veya aktif değil');
  }

  // Create post-auth transaction
  const postAuthTransaction = new Transaction({
    pos: pos._id,
    type: 'post_auth',
    parentTransaction: preAuthTransaction._id,
    amount: preAuthTransaction.amount,
    currency: preAuthTransaction.currency,
    orderId: preAuthTransaction.orderId,
    card: {
      masked: preAuthTransaction.card?.masked,
      bin: preAuthTransaction.card?.bin
    },
    customer: preAuthTransaction.customer,
    status: 'processing'
  });

  await postAuthTransaction.save();

  try {
    const provider = getProvider(postAuthTransaction, pos);

    if (!provider.supports('postAuth')) {
      throw new Error(`${pos.provider} provizyon kapama işlemini desteklemiyor`);
    }

    const result = await provider.postAuth(preAuthTransaction);

    return {
      success: result.success,
      transactionId: postAuthTransaction._id,
      message: result.message,
      authCode: result.authCode
    };
  } catch (error) {
    postAuthTransaction.status = 'failed';
    postAuthTransaction.result = {
      success: false,
      code: 'ERROR',
      message: error.message
    };
    await postAuthTransaction.save();
    throw error;
  }
}

/**
 * Get POS capabilities
 */
export async function getPosCapabilities(posId) {
  const pos = await VirtualPos.findById(posId);

  if (!pos) {
    throw new Error('POS bulunamadı');
  }

  // Create a dummy transaction to get provider
  const dummyTransaction = {
    currency: 'try',
    getDecryptedCard: () => ({})
  };

  try {
    const provider = getProvider(dummyTransaction, pos);
    return {
      posId: pos._id,
      provider: pos.provider,
      capabilities: provider.getCapabilities()
    };
  } catch (error) {
    return {
      posId: pos._id,
      provider: pos.provider,
      capabilities: {
        payment3D: true,
        paymentDirect: false,
        refund: false,
        cancel: false,
        status: false,
        history: false,
        preAuth: false,
        postAuth: false
      }
    };
  }
}

export default {
  queryBin,
  createPayment,
  getPaymentForm,
  processCallback,
  getTransactionStatus,
  refundPayment,
  cancelPayment,
  queryBankStatus,
  createPreAuth,
  createPostAuth,
  getPosCapabilities
};
