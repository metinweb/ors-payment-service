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

    // Store form data and orderId
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;
    this.transaction.orderId = orderId;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, amount });

    return { success: true };
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadi');
    }

    await this.log('3d_redirect', { url: this.urls.gate }, formData);
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

    // Save orderId to transaction
    this.transaction.orderId = orderId;

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

  /**
   * Get provider capabilities
   */
  getCapabilities() {
    return {
      payment3D: true,
      paymentDirect: true,
      refund: true,
      cancel: true,
      status: true,
      history: false,
      preAuth: true,
      postAuth: true,
      paymentModels: ['3d', '3d_pay', 'regular']
    };
  }

  /**
   * Refund a completed payment
   */
  async refund(originalTransaction) {
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;
    const merchantPassword = this.credentials.secretKey;

    const orderId = this.getOrderId();
    const amount = originalTransaction.amount.toFixed(2);
    const rnd = this.microtime();

    // Hash string for refund
    const hashStr = '5' + orderId + amount + '' + '' + 'Credit' + '0' + rnd + merchantPassword;

    const refundData = {
      MbrId: '5',
      MerchantID: merchantId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      TxnType: 'Credit',
      Currency: this.getCurrencyCode(),
      OrderId: orderId,
      OrgOrderId: originalTransaction.orderId,
      PurchAmount: amount,
      Lang: 'TR',
      Rnd: rnd,
      Hash: this.calculateHash(hashStr)
    };

    try {

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(refundData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('refund', { orderId: originalTransaction.orderId }, result);

      if (result.ProcReturnCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İade başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Update original transaction
        originalTransaction.status = 'refunded';
        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          refNumber: result.HostRefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'İade başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'İade başarısız');
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
   * Cancel a payment (same day only)
   */
  async cancel(originalTransaction) {
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;
    const merchantPassword = this.credentials.secretKey;

    const orderId = this.getOrderId();
    const rnd = this.microtime();

    // Hash string for cancel (Void)
    const hashStr = '5' + orderId + '' + '' + '' + 'Void' + '0' + rnd + merchantPassword;

    const cancelData = {
      MbrId: '5',
      MerchantID: merchantId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      TxnType: 'Void',
      Currency: this.getCurrencyCode(),
      OrderId: orderId,
      OrgOrderId: originalTransaction.orderId,
      Lang: 'TR',
      Rnd: rnd,
      Hash: this.calculateHash(hashStr)
    };

    try {

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(cancelData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('cancel', { orderId: originalTransaction.orderId }, result);

      if (result.ProcReturnCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İptal başarılı',
          refNumber: result.HostRefNum
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
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'İptal başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'İptal başarısız');
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
   * Query payment status
   */
  async status(orderId) {
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const statusData = {
      MbrId: '5',
      MerchantID: merchantId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'Inquiry',
      TxnType: 'StatusInquiry',
      OrderId: orderId,
      Lang: 'TR'
    };

    try {

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(statusData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('status', { orderId }, result);

      return {
        success: true,
        status: result.ProcReturnCode === '00' ? 'success' : 'failed',
        orderId: orderId,
        amount: result.PurchAmount,
        authCode: result.AuthCode,
        refNumber: result.HostRefNum,
        rawResponse: result
      };
    } catch (error) {
      await this.log('error', {}, { error: error.message });
      return this.errorResponse('NETWORK_ERROR', error.message);
    }
  }

  /**
   * Pre-authorization (block amount without capture)
   */
  async preAuth() {
    const card = this.getCard();
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const installment = this.formatInstallment();

    // Save orderId to transaction
    this.transaction.orderId = orderId;
    await this.transaction.save();

    const preAuthData = {
      MbrId: '5',
      MerchantID: merchantId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      TxnType: 'PreAuth',
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

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(preAuthData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('pre_auth', { orderId }, result);

      if (result.ProcReturnCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'Ön provizyon başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return this.successResponse({
          message: 'Ön provizyon başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Ön provizyon başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'Ön provizyon başarısız');
      }
    } catch (error) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NETWORK_ERROR',
        message: error.message
      };
      await this.log('error', {}, { error: error.message });
      await this.transaction.save();

      return this.errorResponse('NETWORK_ERROR', error.message);
    }
  }

  /**
   * Post-authorization (capture pre-authorized amount)
   */
  async postAuth(preAuthTransaction) {
    const merchantId = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const orderId = this.getOrderId();
    const amount = preAuthTransaction.amount.toFixed(2);

    const postAuthData = {
      MbrId: '5',
      MerchantID: merchantId,
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      TxnType: 'PostAuth',
      Currency: this.getCurrencyCode(),
      OrderId: orderId,
      OrgOrderId: preAuthTransaction.orderId,
      PurchAmount: amount,
      Lang: 'TR'
    };

    try {

      const response = await axios.post(
        this.urls.api,
        this.encodeForm(postAuthData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = this.parseResponse(response.data);
      await this.log('post_auth', { orderId: preAuthTransaction.orderId }, result);

      if (result.ProcReturnCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'Provizyon kapama başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        return this.successResponse({
          message: 'Provizyon kapama başarılı',
          authCode: result.AuthCode
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Provizyon kapama başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'Provizyon kapama başarısız');
      }
    } catch (error) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NETWORK_ERROR',
        message: error.message
      };
      await this.log('error', {}, { error: error.message });
      await this.transaction.save();

      return this.errorResponse('NETWORK_ERROR', error.message);
    }
  }
}
