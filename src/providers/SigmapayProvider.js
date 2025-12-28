/**
 * Sigmapay Payment Gateway Provider
 */

import crypto from 'crypto';
import https from 'https';
import BaseProvider from './BaseProvider.js';

export default class SigmapayProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  /**
   * Get order ID
   */
  getOrderId() {
    const bookingCode = this.transaction.bookingCode || '';
    const orderId = 'ORS-' + bookingCode + '-' + Date.now().toString(36);
    return orderId.substring(0, 20).padEnd(20, '0');
  }

  /**
   * Get currency code
   */
  getCurrencyCodeSigma() {
    return String(this.transaction.currency || 'try').toUpperCase();
  }

  /**
   * Calculate MD5 signature
   */
  calculateSignature(data) {
    return crypto.createHash('md5').update(data).digest('hex').toUpperCase();
  }

  async initialize() {
    // Map VirtualPos credentials to Sigmapay field names
    // Sigmapay uses clientId = merchantId, secretKey1 and secretKey2 from extra field
    const clientId = this.credentials.merchantId;
    const extra = this.credentials.extra || {};
    const secretKey1 = extra.secretKey1 || this.credentials.secretKey;
    const secretKey2 = extra.secretKey2 || this.credentials.password;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const callbackUrl = this.getCallbackUrl() + 'sigma';
    const description = encodeURIComponent('booking');

    // Signature: amount:currency:MBC:orderId:description:1:clientId:backURL:secretKey1:secretKey2
    const signatureStr = amount + ':' + this.getCurrencyCodeSigma() + ':MBC:' + orderId + ':' + description + ':1:' + clientId + ':' + callbackUrl + ':' + secretKey1 + ':' + secretKey2;

    const formData = {
      amount: amount,
      currency: 'MBC',
      amountcurr: this.getCurrencyCodeSigma(),
      number: orderId,
      description: description,
      trtype: '1',
      account: clientId,
      signature: this.calculateSignature(signatureStr),
      backURL: callbackUrl,
      lang: 'en'
    };

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, amount, signatureStr }, { status: 'prepared' });

    return { success: true };
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadi');
    }

    await this.log('3d_form', formData, { status: 'redirecting' });

    // Sigmapay gate URL
    const sigmapayUrl = this.urls.gate || 'https://pay.sigmapay.com/pay';

    return this.generateFormHtml(sigmapayUrl, formData);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    // Sigmapay returns transaction directly in callback
    if (postData.transID && postData.operID) {
      this.transaction.status = 'success';
      this.transaction.result = {
        success: true,
        authCode: postData.operID,
        refNumber: postData.transID
      };

      // Store card info if provided
      if (postData.cardholder) {
        this.transaction.secure = {
          ...this.transaction.secure,
          cardInfo: {
            holder: postData.cardholder,
            maskedPan: postData.PAN
          }
        };
      }

      this.transaction.completedAt = new Date();
      await this.transaction.clearCvv();

      return { success: true, message: 'Odeme basarili' };
    } else {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: postData.rc || 'FAILED',
        message: postData.rctext || 'Odeme basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type

      return { success: false, message: this.transaction.result.message };
    }
  }

  /**
   * Sigmapay doesn't support non-3D payment through form
   */
  async directPayment() {
    return {
      success: false,
      message: 'Sigmapay sadece 3D Secure ile calismaktadir'
    };
  }
}
