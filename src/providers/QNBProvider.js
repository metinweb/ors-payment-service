/**
 * QNB Finansbank POS Provider
 */

import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import BaseProvider from './BaseProvider.js';

export default class QNBProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  /**
   * Get order ID
   */
  getOrderId() {
    const bookingCode = this.transaction.bookingCode || '';
    const orderId = 'ORS_' + bookingCode + '_' + Date.now().toString(36);
    return orderId.substring(0, 20).padEnd(20, '0');
  }

  /**
   * Calculate SHA1 hash (pack + base64)
   */
  calculateHash(data) {
    const sha1 = crypto.createHash('sha1').update(data).digest('hex');
    return Buffer.from(sha1, 'hex').toString('base64');
  }

  /**
   * Format expiry (MMYY)
   */
  formatExpiry(expiry) {
    const parts = expiry.split('/');
    const month = parts[0].padStart(2, '0');
    let year = parts[1];
    if (year.length === 4) {
      year = year.slice(2);
    }
    return month + year;
  }

  /**
   * Format installment
   */
  formatInstallment() {
    return this.transaction.installment > 1 ? this.transaction.installment.toString() : '0';
  }

  /**
   * Generate microtime format like PHP's microtime()
   * PHP returns: "0.12345678 1234567890" (fractional + space + unix timestamp)
   */
  microtime() {
    const now = Date.now() / 1000;
    const sec = Math.floor(now);
    const micro = (now - sec).toFixed(8);
    return micro + ' ' + sec;
  }

  async initialize() {
    const card = this.getCard();
    // Map VirtualPos credentials to QNB field names
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const merchantPassword = this.credentials.secretKey;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const callbackUrl = this.getCallbackUrl();
    const rnd = this.microtime();  // PHP microtime() format
    const installment = this.formatInstallment();

    // Hash string: MbrId + OrderId + Amount + OkUrl + FailUrl + TxnType + InstallmentCount + Rnd + MerchantPass
    const hashStr = '5' + orderId + amount + callbackUrl + callbackUrl + 'Auth' + installment + rnd + merchantPassword;

    const formData = {
      MbrId: '5',
      Pan: card.number.replace(/\s/g, ''),
      Cvv2: card.cvv,
      Expiry: this.formatExpiry(card.expiry),
      MerchantID: merchantId,
      UserCode: userCode,
      SecureType: '3DModel',
      TxnType: 'Auth',
      InstallmentCount: installment,
      Currency: this.getCurrencyCode(),
      OkUrl: callbackUrl,
      FailUrl: callbackUrl,
      OrderId: orderId,
      OrgOrderId: '',
      PurchAmount: amount,
      Lang: 'TR',
      Rnd: rnd,
      Hash: this.calculateHash(hashStr)
    };

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, amount }, { status: 'prepared' });

    return { success: true };
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadi');
    }

    await this.log('3d_form', formData, { status: 'redirecting' });

    return this.generateFormHtml(this.urls.gate, formData);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    const status3D = postData['3DStatus'];
    if (status3D !== '1') {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: status3D,
        message: postData.ErrMsg || '3D dogrulama basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type
      return { success: false, message: this.transaction.result.message };
    }

    // Store 3D data
    this.transaction.secure = {
      ...this.transaction.secure,
      confirm3D: {
        md: postData.RequestGuid,
        xid: postData.PayerTxnId,
        eci: postData.Eci,
        cavv: postData.PayerAuthenticationCode,
        orderId: postData.OrderId
      }
    };
    await this.saveSecure();  // Use helper for Mixed type

    return this.processProvision(postData);
  }

  async processProvision(secureData) {
    // Map VirtualPos credentials to QNB field names
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;
    const confirm3D = this.transaction.secure?.confirm3D;

    const paymentData = {
      RequestGuid: confirm3D?.md,
      OrderId: confirm3D?.orderId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: '3DModelPayment'
    };

    try {
      await this.log('provision', paymentData, { status: 'sending' });

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(paymentData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('provision', paymentData, result);

      if (result.ProcReturnCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Odeme reddedildi'
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
   * Parse key=value;; response
   */
  parseResponse(data) {
    const result = {};
    data.split(';;').forEach(item => {
      const [key, value] = item.split('=');
      if (key) {
        result[key] = value || '';
      }
    });
    return result;
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

  /**
   * Non-3D Payment
   */
  async directPayment() {
    const card = this.getCard();
    // Map VirtualPos credentials to QNB field names
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const installment = this.formatInstallment();

    const paymentData = {
      MbrId: '5',
      MerchantID: merchantId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      TxnType: 'Auth',
      Currency: this.getCurrencyCode(),
      OrderId: orderId,
      PurchAmount: amount,
      InstallmentCount: installment,
      Pan: card.number.replace(/\s/g, ''),
      Cvv2: card.cvv,
      Expiry: this.formatExpiry(card.expiry),
      Lang: 'TR'
    };

    try {
      await this.log('provision', { orderId, amount }, { status: 'sending' });

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(paymentData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('provision', { orderId }, result);

      if (result.ProcReturnCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Odeme reddedildi'
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
}
