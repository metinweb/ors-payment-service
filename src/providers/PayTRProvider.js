/**
 * PayTR Payment Gateway Provider
 */

import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import BaseProvider from './BaseProvider.js';

export default class PayTRProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  /**
   * Get order ID
   */
  getOrderId() {
    const bookingCode = this.transaction.bookingCode || '';
    const orderId = 'ORS' + bookingCode + Date.now().toString(36);
    return orderId.substring(0, 20).padEnd(20, '0');
  }

  /**
   * Get currency code
   */
  getCurrencyCodePayTR() {
    const codes = {
      try: 'TL',
      usd: 'USD',
      eur: 'EUR',
      gbp: 'GBP'
    };
    return codes[this.transaction.currency] || 'TL';
  }

  /**
   * Calculate PayTR token (HMAC-SHA256)
   */
  calculateToken(data) {
    const { merchantId, merchantSalt, merchantKey } = this.credentials;
    const hashStr = data + merchantSalt;
    return crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');
  }

  async initialize() {
    const card = this.getCard();
    const { merchantId } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const callbackUrl = this.getCallbackUrl();
    const installment = this.transaction.installment > 1 ? this.transaction.installment : 0;

    // User basket (required by PayTR)
    const userBasket = JSON.stringify([
      ['Hotel Booking', String(this.transaction.amount), 1]
    ]);

    // Hash string for token
    const hashStr = merchantId +
      (this.transaction.customer?.ip || '') +
      orderId +
      (this.transaction.customer?.email || '') +
      amount +
      'card' +
      installment +
      this.getCurrencyCodePayTR() +
      '0' + // test_mode
      '0';  // non_3d

    const paytrToken = this.calculateToken(hashStr);

    const formData = {
      cc_owner: card.holder || '',
      card_number: card.number.replace(/\s/g, ''),
      expiry_month: this.formatExpiryMonth(card.expiry),
      expiry_year: this.formatExpiryYear(card.expiry),
      cvv: card.cvv,
      merchant_id: merchantId,
      user_ip: this.transaction.customer?.ip || '',
      merchant_oid: orderId,
      email: this.transaction.customer?.email || '',
      payment_type: 'card',
      payment_amount: amount,
      currency: this.getCurrencyCodePayTR(),
      test_mode: this.pos.testMode ? '1' : '0',
      non_3d: '0',
      merchant_ok_url: callbackUrl + 'ok',
      merchant_fail_url: callbackUrl + 'fail',
      user_name: this.transaction.customer?.name || '',
      user_address: this.transaction.customer?.address || '',
      user_phone: this.transaction.customer?.phone || '',
      user_basket: Buffer.from(userBasket).toString('base64'),
      debug_on: '1',
      client_lang: 'tr',
      paytr_token: paytrToken,
      non3d_test_failed: '0',
      installment_count: installment,
      card_type: this.getCardType()
    };

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, amount });

    return { success: true };
  }

  /**
   * Format expiry month
   */
  formatExpiryMonth(expiry) {
    return expiry.split('/')[0].padStart(2, '0');
  }

  /**
   * Format expiry year
   */
  formatExpiryYear(expiry) {
    let year = expiry.split('/')[1];
    if (year.length === 4) {
      year = year.slice(2);
    }
    return year;
  }

  /**
   * Get card type for PayTR
   */
  getCardType() {
    const cardFamily = this.transaction.cardFamily || '';
    const validTypes = ['advantage', 'axess', 'combo', 'bonus', 'cardfinans', 'maximum', 'paraf', 'world'];
    return validTypes.includes(cardFamily.toLowerCase()) ? cardFamily.toLowerCase() : 'none';
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadi');
    }

    // PayTR uses POST to their endpoint
    const paytrUrl = this.pos.testMode
      ? 'https://www.paytr.com/odeme/guvenli/test'
      : 'https://www.paytr.com/odeme/guvenli';

    const targetUrl = this.urls.gate || paytrUrl;
    await this.log('3d_redirect', { url: targetUrl }, formData);
    return this.generateFormHtml(targetUrl, formData);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    if (postData.status === 'success') {
      this.transaction.status = 'success';
      this.transaction.result = {
        success: true,
        authCode: postData.paytr_token || '',
        refNumber: postData.merchant_oid || ''
      };
      this.transaction.completedAt = new Date();
      await this.transaction.clearCvv();

      return { success: true, message: 'Odeme basarili' };
    } else {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: postData.failed_reason_code || 'FAILED',
        message: postData.failed_reason_msg || 'Odeme basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type

      return { success: false, message: this.transaction.result.message };
    }
  }

  /**
   * PayTR doesn't support non-3D payment through form
   * This would require their API which is different
   */
  async directPayment() {
    return {
      success: false,
      message: 'PayTR sadece 3D Secure ile calismaktadir'
    };
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      payment3D: true,
      paymentDirect: false,
      refund: true,
      cancel: false,  // PayTR doesn't support cancel, only refund
      status: false,
      history: false,
      preAuth: false,
      postAuth: false,
      paymentModels: ['3d']  // PayTR sadece 3D destekler
    };
  }

  /**
   * Refund a completed payment via PayTR API
   */
  async refund(originalTransaction) {
    const { merchantId, merchantSalt, merchantKey } = this.credentials;

    // PayTR refund hash: merchant_id + merchant_oid + return_amount + merchant_salt
    const returnAmount = Math.round(originalTransaction.amount * 100); // Kuruş cinsinden
    const hashStr = merchantId + originalTransaction.orderId + returnAmount + merchantSalt;
    const paytrToken = crypto.createHmac('sha256', merchantKey).update(hashStr).digest('base64');

    const refundData = {
      merchant_id: merchantId,
      merchant_oid: originalTransaction.orderId,
      return_amount: returnAmount,
      paytr_token: paytrToken,
      reference_no: '' // Opsiyonel
    };

    try {

      const response = await axios.post(
        'https://www.paytr.com/odeme/iade',
        this.encodeForm(refundData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = response.data;
      await this.log('refund', { orderId: originalTransaction.orderId }, result);

      if (result.status === 'success') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İade başarılı',
          refNumber: result.return_id
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Update original transaction
        originalTransaction.status = 'refunded';
        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          refNumber: result.return_id
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.err_no || 'ERROR',
          message: result.err_msg || 'İade başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.err_no, result.err_msg || 'İade başarısız');
      }
    } catch (error) {
      await this.log('error', {}, { error: error.message });
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NETWORK_ERROR',
        message: error.message
      };
      await this.transaction.save();

      return this.errorResponse('NETWORK_ERROR', error.message);
    }
  }

  /**
   * Encode form data
   */
  encodeForm(obj) {
    const params = new URLSearchParams();
    Object.entries(obj).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    });
    return params.toString();
  }
}
