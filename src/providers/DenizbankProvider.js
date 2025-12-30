/**
 * Denizbank POS Provider (InterVPOS)
 */

import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import BaseProvider from './BaseProvider.js';

export default class DenizbankProvider extends BaseProvider {
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
   * Map card association
   */
  getCardType(association) {
    const codes = {
      visa: 0,
      mastercard: 1,
      master_card: 1,
      amex: 100
    };
    return codes[String(association || '').toLowerCase()] ?? 0;
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
    return this.transaction.installment > 1 ? this.transaction.installment.toString() : '';
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
    // Map VirtualPos credentials to Denizbank field names
    const shopCode = this.credentials.merchantId;
    const merchantPassword = this.credentials.secretKey;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const callbackUrl = this.getCallbackUrl();
    const rnd = this.microtime();  // PHP microtime() format: "0.12345678 1234567890"
    const installment = this.formatInstallment();

    // Hash string: ShopCode + OrderId + Amount + OkUrl + FailUrl + TxnType + InstallmentCount + Rnd + MerchantPass
    const hashStr = shopCode + orderId + amount + callbackUrl + callbackUrl + 'Auth' + installment + rnd + merchantPassword;

    const formData = {
      Pan: card.number.replace(/\s/g, ''),
      Cvv2: card.cvv,
      Expiry: this.formatExpiry(card.expiry),
      CardType: this.getCardType(this.transaction.cardAssociation),
      ShopCode: shopCode,
      PurchAmount: amount,
      Currency: this.getCurrencyCode(),
      OrderId: orderId,
      OkUrl: callbackUrl,
      FailUrl: callbackUrl,
      Rnd: rnd,
      Hash: this.calculateHash(hashStr),
      TxnType: 'Auth',
      InstallmentCount: installment,
      SecureType: '3DModel',
      Lang: 'tr'
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

    // Verify hash
    const hashVerification = this.verifyHash(postData);
    if (!hashVerification.valid) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'HASH_ERROR',
        message: 'Sayisal imza gecerli degil'
      };
      await this.transaction.save();
      return { success: false, message: this.transaction.result.message };
    }

    // Check 3D status
    const status3D = postData['3DStatus'];
    const validStatuses = ['1', '2', '3', '4'];
    if (!validStatuses.includes(status3D)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: postData.ErrorCode,
        message: postData.ErrorMessage || '3D dogrulama basarisiz'
      };
      await this.transaction.save();
      return { success: false, message: this.transaction.result.message };
    }

    // Store 3D data
    this.transaction.secure = {
      ...this.transaction.secure,
      confirm3D: {
        md: postData.MD,
        code: postData.PayerAuthenticationCode,
        eci: postData.Eci,
        txn: postData.PayerTxnId
      }
    };
    await this.transaction.save();

    return this.processProvision(postData);
  }

  /**
   * Verify hash from callback
   */
  verifyHash(postData) {
    const merchantPassword = this.credentials.secretKey;

    const hashParams = postData.HASHPARAMS;
    const hashParamsVal = postData.HASHPARAMSVAL;
    const hashParam = postData.HASH;

    if (!hashParams || !hashParamsVal || !hashParam) {
      return { valid: false };
    }

    let paramsVal = '';
    const hashParamsArray = hashParams.split(':');
    for (const param of hashParamsArray) {
      if (postData[param] !== null && postData[param] !== undefined) {
        paramsVal += postData[param];
      }
    }

    const hash = this.calculateHash(paramsVal + merchantPassword);

    return {
      valid: paramsVal === hashParamsVal && hashParam === hash
    };
  }

  async processProvision(secureData) {
    // Map VirtualPos credentials to Denizbank field names
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;
    const formData = this.transaction.secure?.formData;
    const confirm3D = this.transaction.secure?.confirm3D;

    const paymentData = {
      ShopCode: shopCode,
      PurchAmount: formData?.PurchAmount || this.formatAmount(),
      Currency: this.getCurrencyCode(),
      OrderId: formData?.OrderId,
      TxnType: 'Auth',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      InstallmentCount: this.formatInstallment(),
      Lang: 'TR',
      MD: confirm3D?.md,
      PayerAuthenticationCode: confirm3D?.code,
      Eci: confirm3D?.eci,
      PayerTxnId: confirm3D?.txn,
      MOTO: '0'
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
        const errorMessage = this.getErrorMessage(result.ProcReturnCode) || result.ErrMsg || 'Odeme reddedildi';
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: errorMessage
        };
        await this.transaction.save();

        return { success: false, message: errorMessage };
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
   * Get error message from code
   */
  getErrorMessage(code) {
    const codes = {
      '01': 'Bankanizi Arayin',
      '02': 'Bankanizi Arayin (Ozel)',
      '03': 'Gecersiz Uye Isyeri',
      '04': 'Karta El Koy',
      '05': 'Onaylanmadi',
      '12': 'Gecersiz Islem',
      '13': 'Gecersiz Tutar',
      '14': 'Gecersiz Hesap Numarasi',
      '33': 'Suresi Dolmus Kart',
      '41': 'Kayip Kart',
      '43': 'Calinti Kart',
      '51': 'Limit Yetersiz',
      '54': 'Suresi Dolmus Kart',
      '55': 'Yanlis PIN',
      '57': 'Karta Izin Verilmeyen Islem',
      '91': 'Issuer calismiyor',
      '96': 'Sistem Hatasi'
    };
    return codes[code];
  }

  /**
   * Non-3D Payment
   */
  async directPayment() {
    const card = this.getCard();
    // Map VirtualPos credentials to Denizbank field names
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const installment = this.formatInstallment();

    // Save orderId to transaction
    this.transaction.orderId = orderId;
    await this.transaction.save();

    const paymentData = {
      ShopCode: shopCode,
      PurchAmount: amount,
      Currency: this.getCurrencyCode(),
      OrderId: orderId,
      InstallmentCount: installment,
      TxnType: 'Auth',
      orgOrderId: '',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      Pan: card.number.replace(/\s/g, ''),
      Expiry: this.formatExpiry(card.expiry),
      Cvv2: card.cvv,
      BonusAmount: '',
      CardType: this.getCardType(this.transaction.cardAssociation),
      Lang: 'TR',
      MOTO: '0'
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
        const errorMessage = this.getErrorMessage(result.ProcReturnCode) || 'Odeme reddedildi';
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: errorMessage
        };
        await this.transaction.save();

        return { success: false, message: errorMessage };
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
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;
    const merchantPassword = this.credentials.secretKey;

    const orderId = this.getOrderId();
    const amount = originalTransaction.amount.toFixed(2);
    const rnd = this.microtime();

    // Hash string for refund
    const hashStr = shopCode + orderId + amount + '' + '' + 'Credit' + '' + rnd + merchantPassword;

    const refundData = {
      ShopCode: shopCode,
      OrderId: orderId,
      OrgOrderId: originalTransaction.orderId,
      PurchAmount: amount,
      Currency: this.getCurrencyCode(),
      TxnType: 'Credit',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      Lang: 'TR',
      Rnd: rnd,
      Hash: this.calculateHash(hashStr)
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
        const errorMessage = this.getErrorMessage(result.ProcReturnCode) || result.ErrMsg || 'İade başarısız';
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: errorMessage
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, errorMessage);
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
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;
    const merchantPassword = this.credentials.secretKey;

    const orderId = this.getOrderId();
    const rnd = this.microtime();

    // Hash string for cancel (Void)
    const hashStr = shopCode + orderId + '' + '' + '' + 'Void' + '' + rnd + merchantPassword;

    const cancelData = {
      ShopCode: shopCode,
      OrderId: orderId,
      OrgOrderId: originalTransaction.orderId,
      Currency: this.getCurrencyCode(),
      TxnType: 'Void',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      Lang: 'TR',
      Rnd: rnd,
      Hash: this.calculateHash(hashStr)
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
        const errorMessage = this.getErrorMessage(result.ProcReturnCode) || result.ErrMsg || 'İptal başarısız';
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: errorMessage
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, errorMessage);
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
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const statusData = {
      ShopCode: shopCode,
      OrderId: orderId,
      TxnType: 'StatusInquiry',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'Inquiry',
      Lang: 'TR'
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const installment = this.formatInstallment();

    // Save orderId to transaction
    this.transaction.orderId = orderId;
    await this.transaction.save();

    const preAuthData = {
      ShopCode: shopCode,
      OrderId: orderId,
      PurchAmount: amount,
      Currency: this.getCurrencyCode(),
      InstallmentCount: installment,
      TxnType: 'PreAuth',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      Pan: card.number.replace(/\s/g, ''),
      Expiry: this.formatExpiry(card.expiry),
      Cvv2: card.cvv,
      CardType: this.getCardType(this.transaction.cardAssociation),
      Lang: 'TR',
      MOTO: '0'
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
        const errorMessage = this.getErrorMessage(result.ProcReturnCode) || result.ErrMsg || 'Ön provizyon başarısız';
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: errorMessage
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, errorMessage);
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
    const shopCode = this.credentials.merchantId;
    const userCode = this.credentials.username;
    const userPassword = this.credentials.password;

    const orderId = this.getOrderId();
    const amount = preAuthTransaction.amount.toFixed(2);

    const postAuthData = {
      ShopCode: shopCode,
      OrderId: orderId,
      OrgOrderId: preAuthTransaction.orderId,
      PurchAmount: amount,
      Currency: this.getCurrencyCode(),
      TxnType: 'PostAuth',
      UserCode: userCode,
      UserPass: userPassword,
      SecureType: 'NonSecure',
      Lang: 'TR'
    };

    try {

      const response = await axios.post(
        this.urls.api || this.urls.gate,
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
        const errorMessage = this.getErrorMessage(result.ProcReturnCode) || result.ErrMsg || 'Provizyon kapama başarısız';
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: errorMessage
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, errorMessage);
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
