/**
 * iyzico Payment Gateway Provider
 */

import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import BaseProvider from './BaseProvider.js';

export default class IyzicoProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    this.baseUrl = this.pos.testMode
      ? 'https://sandbox-api.iyzipay.com'
      : 'https://api.iyzipay.com';
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
  getCurrencyCodeIyzico() {
    const codes = {
      try: 'TRY',
      usd: 'USD',
      eur: 'EUR',
      gbp: 'GBP'
    };
    return codes[this.transaction.currency] || 'TRY';
  }

  /**
   * Generate random string
   */
  generateRandomString(length = 16) {
    const characters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
  }

  /**
   * Generate PKI string from object
   */
  generatePkiString(obj) {
    const generateString = (data) => {
      const isArray = Array.isArray(data);
      let result = '[';

      Object.entries(data).forEach(([key, val], index, arr) => {
        if (!isArray) {
          result += key + '=';
        }

        if (val && typeof val === 'object') {
          result += generateString(val);
        } else {
          result += val;
        }

        result += isArray ? ', ' : ',';
      });

      if (result.length > 1) {
        result = result.slice(0, isArray ? -2 : -1);
      }

      result += ']';
      return result;
    };

    return generateString(obj);
  }

  /**
   * Format price for iyzico
   */
  formatPrice(value) {
    if (Number.isInteger(value) || Math.floor(value) === value) {
      return value.toFixed(1);
    }
    return String(value);
  }

  /**
   * Split name into first/last
   */
  splitName(fullName) {
    const parts = String(fullName || '').trim().split(' ');
    if (parts.length > 1) {
      const surname = parts.pop();
      const name = parts.join(' ');
      return { name, surname };
    }
    return { name: fullName || 'Customer', surname: 'X' };
  }

  async initialize() {
    const card = this.getCard();
    const { apiKey, apiSecret } = this.credentials;

    const orderId = this.getOrderId();
    const price = this.formatPrice(this.transaction.amount);
    const callbackUrl = this.getCallbackUrl();
    const nameParts = this.splitName(card.holder || this.transaction.customer?.name);

    const paymentRequest = {
      locale: 'tr',
      conversationId: orderId,
      price: price,
      paidPrice: price,
      installment: this.transaction.installment || 1,
      paymentCard: {
        cardHolderName: card.holder || '',
        cardNumber: card.number.replace(/\s/g, ''),
        expireYear: this.formatExpiryYear(card.expiry),
        expireMonth: this.formatExpiryMonth(card.expiry),
        cvc: card.cvv
      },
      buyer: {
        id: 'BY' + orderId,
        name: nameParts.name,
        surname: nameParts.surname,
        identityNumber: this.transaction.customer?.identityNumber || '11111111111',
        email: this.transaction.customer?.email || 'customer@example.com',
        registrationAddress: this.transaction.customer?.address || 'Address',
        city: 'Istanbul',
        country: 'Turkey',
        zipCode: '34732',
        ip: this.transaction.customer?.ip || ''
      },
      shippingAddress: {
        address: this.transaction.customer?.address || 'Address',
        zipCode: '34742',
        contactName: this.transaction.customer?.name || 'Customer',
        city: 'Istanbul',
        country: 'Turkey'
      },
      billingAddress: {
        address: this.transaction.customer?.address || 'Address',
        zipCode: '34742',
        contactName: this.transaction.customer?.name || 'Customer',
        city: 'Istanbul',
        country: 'Turkey'
      },
      basketItems: [
        {
          id: 'BOOK1',
          price: price,
          name: 'Hotel Booking',
          category1: 'Room',
          itemType: 'VIRTUAL'
        }
      ],
      currency: this.getCurrencyCodeIyzico(),
      callbackUrl: callbackUrl
    };

    try {

      const response = await this.sendRequest('/payment/3dsecure/initialize', paymentRequest);
      await this.log('init', { orderId }, response);

      if (response.status === 'success') {
        // Store HTML content for form
        const htmlContent = Buffer.from(response.threeDSHtmlContent, 'base64').toString('utf-8');

        this.transaction.secure = this.transaction.secure || {};
        this.transaction.secure.formData = {
          orderId,
          htmlContent
        };

        await this.saveSecure();  // Use helper for Mixed type
        return { success: true, html: htmlContent };
      } else {
        return {
          success: false,
          code: response.errorCode,
          error: response.errorMessage || 'iyzico hatasi'
        };
      }
    } catch (error) {
      await this.log('error', { orderId }, { error: error.message });
      return { success: false, code: 'NETWORK_ERROR', error: error.message };
    }
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
    if (year.length === 2) {
      year = '20' + year;
    }
    return year;
  }

  /**
   * Send request to iyzico API
   */
  async sendRequest(path, data) {
    const { apiKey, apiSecret } = this.credentials;

    const randomString = this.generateRandomString();
    const pki = this.generatePkiString(data);
    const requestString = JSON.stringify(data);
    const hash = crypto.createHash('sha1')
      .update(apiKey + randomString + apiSecret + pki)
      .digest('base64');

    const response = await axios.post(this.baseUrl + path, requestString, {
      headers: {
        'Authorization': 'IYZWS ' + apiKey + ':' + hash,
        'x-iyzi-rnd': randomString,
        'Content-Type': 'application/json'
      },
      httpsAgent: this.httpsAgent
    });

    return response.data;
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData || !formData.htmlContent) {
      throw new Error('Form verisi bulunamadi');
    }

    // iyzico returns ready HTML, no redirect URL to log (HTML contains the form/redirect)
    await this.log('3d_redirect', { orderId: formData.orderId }, { type: 'html_content' });
    return formData.htmlContent;
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    if (postData.status === 'success') {
      // Complete the 3D authentication
      const authRequest = {
        locale: 'tr',
        conversationId: this.transaction.secure?.formData?.orderId || '',
        paymentId: postData.paymentId,
        conversationData: postData.conversationData
      };

      try {
        const response = await this.sendRequest('/payment/3dsecure/auth', authRequest);
        await this.log('provision', authRequest, response);

        if (response.status === 'success') {
          this.transaction.status = 'success';
          this.transaction.result = {
            success: true,
            authCode: response.authCode,
            refNumber: response.hostReference
          };
          this.transaction.completedAt = new Date();
          await this.transaction.clearCvv();

          return { success: true, message: 'Odeme basarili' };
        } else {
          this.transaction.status = 'failed';
          this.transaction.result = {
            success: false,
            code: response.errorCode,
            message: response.errorMessage || 'Odeme reddedildi'
          };
          await this.saveSecure();  // Use helper for Mixed type

          return { success: false, message: this.transaction.result.message };
        }
      } catch (error) {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: 'NETWORK_ERROR',
          message: error.message
        };
        await this.log('error', {}, { error: error.message });
        await this.saveSecure();  // Use helper for Mixed type

        return { success: false, message: 'Baglanti hatasi' };
      }
    } else {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: postData.errorCode || 'FAILED',
        message: postData.errorMessage || 'Odeme basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type

      return { success: false, message: this.transaction.result.message };
    }
  }

  /**
   * Non-3D Payment
   */
  async directPayment() {
    const card = this.getCard();
    const { apiKey, apiSecret } = this.credentials;

    const orderId = this.getOrderId();
    const price = this.formatPrice(this.transaction.amount);
    const nameParts = this.splitName(card.holder || this.transaction.customer?.name);

    const paymentRequest = {
      locale: 'tr',
      conversationId: orderId,
      price: price,
      paidPrice: price,
      installment: this.transaction.installment || 1,
      paymentCard: {
        cardHolderName: card.holder || '',
        cardNumber: card.number.replace(/\s/g, ''),
        expireYear: this.formatExpiryYear(card.expiry),
        expireMonth: this.formatExpiryMonth(card.expiry),
        cvc: card.cvv
      },
      buyer: {
        id: 'BY' + orderId,
        name: nameParts.name,
        surname: nameParts.surname,
        identityNumber: this.transaction.customer?.identityNumber || '11111111111',
        email: this.transaction.customer?.email || 'customer@example.com',
        registrationAddress: this.transaction.customer?.address || 'Address',
        city: 'Istanbul',
        country: 'Turkey',
        zipCode: '34732',
        ip: this.transaction.customer?.ip || ''
      },
      shippingAddress: {
        address: this.transaction.customer?.address || 'Address',
        zipCode: '34742',
        contactName: this.transaction.customer?.name || 'Customer',
        city: 'Istanbul',
        country: 'Turkey'
      },
      billingAddress: {
        address: this.transaction.customer?.address || 'Address',
        zipCode: '34742',
        contactName: this.transaction.customer?.name || 'Customer',
        city: 'Istanbul',
        country: 'Turkey'
      },
      basketItems: [
        {
          id: 'BOOK1',
          price: price,
          name: 'Hotel Booking',
          category1: 'Room',
          itemType: 'VIRTUAL'
        }
      ],
      currency: this.getCurrencyCodeIyzico()
    };

    try {

      const response = await this.sendRequest('/payment/auth', paymentRequest);
      await this.log('provision', { orderId }, response);

      if (response.status === 'success') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: response.authCode,
          refNumber: response.hostReference
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: response.errorCode,
          message: response.errorMessage || 'Odeme reddedildi'
        };
        await this.saveSecure();  // Use helper for Mixed type

        return { success: false, message: this.transaction.result.message };
      }
    } catch (error) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NETWORK_ERROR',
        message: error.message
      };
      await this.log('error', {}, { error: error.message });
      await this.saveSecure();  // Use helper for Mixed type

      return { success: false, message: 'Baglanti hatasi' };
    }
  }

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      payment3D: true,
      paymentDirect: true,
      refund: true,
      cancel: true,
      status: false,  // iyzico doesn't have a simple status query
      history: false,
      preAuth: false,  // iyzico supports but different flow
      postAuth: false,
      paymentModels: ['3d', 'regular']
    };
  }

  /**
   * Refund a completed payment via iyzico API
   */
  async refund(originalTransaction) {
    const price = this.formatPrice(originalTransaction.amount);
    const ip = this.transaction.customer?.ip || '127.0.0.1';

    const refundRequest = {
      locale: 'tr',
      conversationId: this.getOrderId(),
      paymentTransactionId: originalTransaction.result?.transactionId || originalTransaction.orderId,
      price: price,
      currency: this.getCurrencyCodeIyzico(),
      ip: ip
    };

    try {

      const response = await this.sendRequest('/payment/refund', refundRequest);
      await this.log('refund', { orderId: originalTransaction.orderId }, response);

      if (response.status === 'success') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İade başarılı',
          refNumber: response.hostReference || response.paymentId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Update original transaction
        originalTransaction.status = 'refunded';
        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          refNumber: response.hostReference
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: response.errorCode,
          message: response.errorMessage || 'İade başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(response.errorCode, response.errorMessage || 'İade başarısız');
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
   * Cancel a payment (same day only) via iyzico API
   */
  async cancel(originalTransaction) {
    const ip = this.transaction.customer?.ip || '127.0.0.1';

    const cancelRequest = {
      locale: 'tr',
      conversationId: this.getOrderId(),
      paymentId: originalTransaction.result?.transactionId || originalTransaction.orderId,
      ip: ip
    };

    try {

      const response = await this.sendRequest('/payment/cancel', cancelRequest);
      await this.log('cancel', { orderId: originalTransaction.orderId }, response);

      if (response.status === 'success') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İptal başarılı',
          refNumber: response.hostReference
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Update original transaction
        originalTransaction.status = 'cancelled';
        originalTransaction.cancelledAt = new Date();
        await originalTransaction.save();

        return this.successResponse({ message: 'İptal başarılı' });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: response.errorCode,
          message: response.errorMessage || 'İptal başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(response.errorCode, response.errorMessage || 'İptal başarısız');
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
}
