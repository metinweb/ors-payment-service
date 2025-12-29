/**
 * Payten (eski EST) POS Provider
 * Halkbank, İş Bankası, Ziraat, TEB için kullanılır
 */

import crypto from 'crypto';
import BaseProvider, { CURRENCY_CODES } from './BaseProvider.js';

export default class PaytenProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
  }

  /**
   * Provider capabilities
   */
  getCapabilities() {
    return {
      payment3D: true,
      paymentDirect: true,
      refund: true,
      cancel: true,
      status: true,
      history: true,
      preAuth: true,
      postAuth: true,
      // Desteklenen ödeme modelleri
      paymentModels: ['3d', '3d_pay', '3d_host', 'regular']
    };
  }

  /**
   * Generate hash for Payten (SHA512)
   */
  generateHash(formData) {
    const { secretKey } = this.credentials;

    // Sort keys alphabetically
    const sortedKeys = Object.keys(formData).sort((a, b) =>
      a.localeCompare(b, 'en', { sensitivity: 'base' })
    );

    let hashVal = '';
    for (const key of sortedKeys) {
      const value = String(formData[key] || '');
      const escapedValue = value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
      const lowerKey = key.toLowerCase();

      if (lowerKey !== 'hash' && lowerKey !== 'encoding') {
        hashVal += `${escapedValue}|`;
      }
    }

    const escapedKey = String(secretKey).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    hashVal += escapedKey;

    const hash = crypto.createHash('sha512').update(hashVal).digest('hex');
    return Buffer.from(hash, 'hex').toString('base64');
  }

  /**
   * Get storetype for Payten based on payment model
   * İşbank'ta "Bolum" olarak adlandırılan değişken bu
   */
  getStoreType() {
    const model = this.pos.paymentModel || '3d';
    const storeTypeMap = {
      '3d': '3d',           // 3D Secure - Kart bilgileri bizde, 3D bankada
      '3d_pay': '3d_pay',   // 3D Pay - Tüm işlem bankada
      '3d_host': '3d_host', // 3D Host - Kart bilgileri de bankada
      'regular': ''         // Non-3D - storetype gönderilmez
    };
    return storeTypeMap[model] || '3d';
  }

  async initialize() {
    const { merchantId } = this.credentials;
    const paymentModel = this.pos.paymentModel || '3d';

    // Non-3D ödeme için direkt payment kullan
    if (paymentModel === 'regular') {
      return this.directPayment();
    }

    const orderId = this.transaction._id.toString();
    const callbackUrl = this.getCallbackUrl();
    const rnd = Date.now().toString();
    const storeType = this.getStoreType();

    // Base form data
    const formData = {
      clientid: merchantId,
      amount: this.formatAmount(),
      oid: orderId,
      okUrl: callbackUrl,
      failUrl: callbackUrl,
      rnd: rnd,
      storetype: storeType,
      currency: this.getCurrencyCode(),
      lang: 'tr',
      islemtipi: 'Auth',
      taksit: this.transaction.installment > 1 ? this.transaction.installment.toString() : '',
      Hashalgorithm: 'ver3'
    };

    // İşbank BOLUM alanı (Payten bankaları için bölüm/şube kodu)
    if (this.credentials.section) {
      formData.BOLUM = this.credentials.section;
    }

    // 3D_HOST modunda kart bilgileri gönderilmez - banka alır
    if (paymentModel !== '3d_host') {
      const card = this.getCard();
      formData.pan = card.number;
      formData.cv2 = card.cvv;
      formData.Ecom_Payment_Card_ExpDate_Year = card.expiry.split('/')[1];
      formData.Ecom_Payment_Card_ExpDate_Month = card.expiry.split('/')[0];
    }

    formData.hash = this.generateHash(formData);

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;
    this.transaction.secure.paymentModel = paymentModel;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, paymentModel, storeType }, { status: 'prepared' });

    return { success: true };
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadı');
    }

    await this.log('3d_form', formData, { status: 'redirecting' });

    return this.generateFormHtml(this.urls.gate, formData);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    const paymentModel = this.transaction.secure?.paymentModel || '3d';

    // 3D_PAY modunda banka tüm işlemi yapar, direkt sonuç döner
    if (paymentModel === '3d_pay') {
      return this.handle3DPayCallback(postData);
    }

    // 3D ve 3D_HOST için mdStatus kontrolü
    const mdStatus = postData.mdStatus;
    const validStatuses = ['1', '2', '3', '4'];

    if (!validStatuses.includes(mdStatus)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus,
        message: postData.mdErrorMsg || '3D doğrulama başarısız'
      };
      await this.transaction.save();
      return { success: false, message: this.transaction.result.message };
    }

    // Extract 3D data
    const { md, xid, eci, cavv } = postData;
    this.transaction.secure = {
      ...this.transaction.secure,
      enabled: true,
      eci,
      cavv,
      md
    };

    // Process provision for 3D and 3D_HOST
    return this.processProvision({ md, xid, eci, cavv });
  }

  /**
   * Handle 3D Pay callback - banka tüm işlemi yaptı, sadece sonuç kontrol et
   */
  async handle3DPayCallback(postData) {
    // 3D Pay'de Response direkt gelir
    const response = postData.Response;
    const authCode = postData.AuthCode;
    const hostRefNum = postData.HostRefNum;
    const procReturnCode = postData.ProcReturnCode;
    const errMsg = postData.ErrMsg;

    // 3D doğrulama kontrolü
    const mdStatus = postData.mdStatus;
    if (mdStatus && !['1', '2', '3', '4'].includes(mdStatus)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus,
        message: postData.mdErrorMsg || '3D doğrulama başarısız'
      };
      await this.transaction.save();
      return { success: false, message: this.transaction.result.message };
    }

    // Ödeme sonucu kontrolü
    if (response === 'Approved') {
      this.transaction.status = 'success';
      this.transaction.result = {
        success: true,
        authCode: authCode,
        refNumber: hostRefNum,
        message: 'Ödeme başarılı'
      };
      this.transaction.completedAt = new Date();
      await this.transaction.clearCvv();

      return { success: true, message: 'Ödeme başarılı' };
    } else {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: procReturnCode,
        message: errMsg || 'Ödeme reddedildi'
      };
      await this.transaction.save();

      return { success: false, message: this.transaction.result.message };
    }
  }

  async processProvision(secureData) {
    const { merchantId, username, password } = this.credentials;
    const orderId = this.transaction._id.toString();

    const provisionRequest = {
      CC5Request: {
        Name: username,
        Password: password,
        ClientId: merchantId,
        IPAddress: this.transaction.customer?.ip || '',
        Email: this.transaction.customer?.email || '',
        Mode: 'P',
        OrderId: orderId,
        GroupId: '',
        TransId: '',
        UserId: '',
        Type: 'Auth',
        Number: secureData.md,
        Expires: '',
        Cvv2Val: '',
        Total: this.formatAmount(),
        Currency: this.getCurrencyCode(),
        Taksit: this.transaction.installment > 1 ? this.transaction.installment.toString() : '',
        PayerTxnId: secureData.xid,
        PayerSecurityLevel: secureData.eci,
        PayerAuthenticationCode: secureData.cavv,
        CardholderPresentCode: 13
      }
    };

    try {
      const xml = this.buildXml(provisionRequest);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('provision', provisionRequest, result);

      if (result.Response === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Ödeme başarılı' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Ödeme reddedildi'
        };
        await this.transaction.save();

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
      await this.transaction.save();

      return { success: false, message: 'Bağlantı hatası' };
    }
  }

  /**
   * Build CC5Request XML for various operations
   */
  buildCC5Request(type, params = {}) {
    const { merchantId, username, password } = this.credentials;

    return {
      CC5Request: {
        Name: username,
        Password: password,
        ClientId: merchantId,
        IPAddress: this.transaction?.customer?.ip || '',
        Email: this.transaction?.customer?.email || '',
        Mode: this.pos.testMode ? 'T' : 'P',
        Type: type,
        ...params
      }
    };
  }

  /**
   * Direct payment (Non-3D)
   */
  async directPayment() {
    const card = this.getCard();
    const orderId = this.transaction._id.toString();

    const request = this.buildCC5Request('Auth', {
      OrderId: orderId,
      Total: this.formatAmount(),
      Currency: this.getCurrencyCode(),
      Number: card.number.replace(/\s/g, ''),
      Expires: this.formatExpiry(card.expiry),
      Cvv2Val: card.cvv,
      Taksit: this.transaction.installment > 1 ? this.transaction.installment.toString() : ''
    });

    try {
      this.transaction.orderId = orderId;
      await this.log('provision', request, { status: 'sending' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('provision', request, result);

      if (result.Response === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum,
          transactionId: result.TransId,
          message: 'Ödeme başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return this.successResponse({
          message: 'Ödeme başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Ödeme reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'Ödeme reddedildi', result);
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

      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Format expiry for NestPay (MMYY)
   */
  formatExpiry(expiry) {
    const [month, year] = expiry.split('/');
    return month.padStart(2, '0') + year.slice(-2);
  }

  /**
   * Refund a completed payment
   */
  async refund(originalTransaction) {
    const orderId = originalTransaction.orderId || originalTransaction._id.toString();

    const request = this.buildCC5Request('Credit', {
      OrderId: orderId,
      Total: this.transaction.amount.toFixed(2),
      Currency: CURRENCY_CODES[originalTransaction.currency] || 949
    });

    try {
      await this.log('refund', request, { status: 'sending' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('refund', request, result);

      if (result.Response === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum,
          message: 'İade başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'İade reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'İade reddedildi', result);
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

      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Cancel a payment (same day void)
   */
  async cancel(originalTransaction) {
    const orderId = originalTransaction.orderId || originalTransaction._id.toString();

    const request = this.buildCC5Request('Void', {
      OrderId: orderId,
      Total: originalTransaction.amount.toFixed(2),
      Currency: CURRENCY_CODES[originalTransaction.currency] || 949
    });

    try {
      await this.log('cancel', request, { status: 'sending' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('cancel', request, result);

      if (result.Response === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum,
          message: 'İptal başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        originalTransaction.cancelledAt = new Date();
        originalTransaction.status = 'cancelled';
        await originalTransaction.save();

        return this.successResponse({
          message: 'İptal başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'İptal reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'İptal reddedildi', result);
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

      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Query payment status
   */
  async status(orderId) {
    const request = this.buildCC5Request('OrderInquiry', {
      OrderId: orderId
    });

    try {
      await this.log('status', request, { status: 'querying' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('status', request, result);

      if (result.Response === 'Approved' || result.ORDERSTATUS) {
        return {
          success: true,
          orderId,
          status: result.ORDERSTATUS || 'unknown',
          amount: result.AMOUNT,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum,
          rawResponse: result
        };
      } else {
        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'Sorgu başarısız', result);
      }
    } catch (error) {
      await this.log('error', {}, { error: error.message });
      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Get order history
   */
  async history(orderId) {
    const request = this.buildCC5Request('OrderHistory', {
      OrderId: orderId
    });

    try {
      await this.log('history', request, { status: 'querying' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('history', request, result);

      return {
        success: true,
        orderId,
        history: result.ORDERHISTORY || [],
        rawResponse: result
      };
    } catch (error) {
      await this.log('error', {}, { error: error.message });
      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Pre-authorization
   */
  async preAuth() {
    const card = this.getCard();
    const orderId = this.transaction._id.toString();

    const request = this.buildCC5Request('PreAuth', {
      OrderId: orderId,
      Total: this.formatAmount(),
      Currency: this.getCurrencyCode(),
      Number: card.number.replace(/\s/g, ''),
      Expires: this.formatExpiry(card.expiry),
      Cvv2Val: card.cvv,
      Taksit: this.transaction.installment > 1 ? this.transaction.installment.toString() : ''
    });

    try {
      this.transaction.orderId = orderId;
      await this.log('pre_auth', request, { status: 'sending' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('pre_auth', request, result);

      if (result.Response === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum,
          message: 'Ön provizyon başarılı'
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
          message: result.ErrMsg || 'Ön provizyon reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'Ön provizyon reddedildi', result);
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

      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Post-authorization (capture pre-auth)
   */
  async postAuth(preAuthTransaction) {
    const orderId = preAuthTransaction.orderId || preAuthTransaction._id.toString();

    const request = this.buildCC5Request('PostAuth', {
      OrderId: orderId,
      Total: this.transaction.amount.toFixed(2),
      Currency: this.getCurrencyCode()
    });

    try {
      await this.log('post_auth', request, { status: 'sending' });

      const xml = this.buildXml(request);
      const response = await this.post(this.urls.api, 'DATA=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('post_auth', request, result);

      if (result.Response === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.AuthCode,
          refNumber: result.HostRefNum,
          message: 'Provizyon kapama başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        return this.successResponse({
          message: 'Provizyon kapama başarılı',
          authCode: result.AuthCode,
          refNumber: result.HostRefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.ProcReturnCode,
          message: result.ErrMsg || 'Provizyon kapama reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.ProcReturnCode, result.ErrMsg || 'Provizyon kapama reddedildi', result);
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

      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }
}
