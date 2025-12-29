/**
 * Akbank POS Provider (JSON API with HMAC-SHA512)
 */

import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import BaseProvider from './BaseProvider.js';

export default class AkbankProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  /**
   * Calculate HMAC-SHA512 hash
   */
  calculateHash(data) {
    const { secretKey } = this.credentials;
    if (!secretKey) {
      throw new Error('Akbank secretKey (HMAC anahtarı) bulunamadı. POS ayarlarını kontrol edin.');
    }
    const hmac = crypto.createHmac('sha512', secretKey);
    hmac.update(data, 'utf8');
    return hmac.digest('base64');
  }

  /**
   * Generate random number (128 hex characters)
   */
  generateRandomNumber() {
    return crypto.randomBytes(64).toString('hex');
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
   * Get request datetime
   */
  getRequestDateTime() {
    const now = new Date();
    return now.toISOString().split('.')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
  }

  /**
   * Calculate form hash for 3D
   */
  calculateFormHash(formData) {
    const { secretKey } = this.credentials;

    // Hash calculation matches old working project - NO b2bIdentityNumber
    const hashItems =
      formData.paymentModel +
      formData.txnCode +
      formData.merchantSafeId +
      formData.terminalSafeId +
      formData.orderId +
      formData.lang +
      formData.amount +
      (formData.ccbRewardAmount || '') +
      (formData.pcbRewardAmount || '') +
      (formData.xcbRewardAmount || '') +
      formData.currencyCode +
      formData.installCount +
      formData.okUrl +
      formData.failUrl +
      formData.emailAddress +
      (formData.subMerchantId || '') +
      formData.creditCard +
      formData.expiredDate +
      formData.cvv +
      formData.randomNumber +
      formData.requestDateTime;

    return this.calculateHash(hashItems);
  }

  async initialize() {
    // Validate required credentials
    const { merchantId, terminalId, secretKey } = this.credentials;
    if (!merchantId) {
      throw new Error('Akbank POS: merchantId (Merchant Safe ID) eksik');
    }
    if (!terminalId) {
      throw new Error('Akbank POS: terminalId (Terminal Safe ID) eksik');
    }
    if (!secretKey) {
      throw new Error('Akbank POS: secretKey (HMAC Secret Key) eksik');
    }

    const card = this.getCard();
    // Akbank uses merchantSafeId/terminalSafeId but we store as merchantId/terminalId
    const merchantSafeId = merchantId;
    const terminalSafeId = terminalId;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const callbackUrl = this.getCallbackUrl();
    const randomNumber = this.generateRandomNumber();
    const requestDateTime = this.getRequestDateTime();

    const formData = {
      paymentModel: '3D',
      txnCode: '3000',
      merchantSafeId: merchantSafeId,
      terminalSafeId: terminalSafeId,
      orderId: orderId,
      lang: 'TR',
      amount: amount,
      currencyCode: this.getCurrencyCode(),
      installCount: this.transaction.installment || 1,
      okUrl: callbackUrl,
      failUrl: callbackUrl,
      emailAddress: this.transaction.customer?.email || '',
      creditCard: card.number.replace(/\s/g, ''),
      expiredDate: this.formatExpiry(card.expiry),
      cvv: card.cvv,
      randomNumber: randomNumber,
      requestDateTime: requestDateTime
    };

    formData.hash = this.calculateFormHash(formData);

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)

    // Log full request data (mask sensitive fields for security)
    const logData = {
      ...formData,
      creditCard: formData.creditCard.slice(0, 6) + '******' + formData.creditCard.slice(-4),
      cvv: '***'
    };
    await this.log('init', logData, { status: 'prepared', url: this.urls.gate });

    return { success: true };
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

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadi');
    }

    // Mask sensitive data for logging
    const logData = {
      ...formData,
      creditCard: formData.creditCard.slice(0, 6) + '******' + formData.creditCard.slice(-4),
      cvv: '***'
    };
    await this.log('3d_form', logData, { status: 'redirecting', url: this.urls.gate });

    return this.generateFormHtml(this.urls.gate, formData);
  }

  async processCallback(postData) {
    // Log full callback data from bank
    await this.log('3d_callback', postData, {
      mdStatus: postData.mdStatus,
      responseCode: postData.responseCode,
      responseMessage: postData.responseMessage
    });

    const mdStatus = postData.mdStatus;
    const responseCode = postData.responseCode;
    const validStatuses = ['1'];

    // Check for bank errors (responseCode starting with VPS-)
    if (responseCode && responseCode.startsWith('VPS-')) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: responseCode,
        message: postData.responseMessage || 'Banka hatası'
      };
      await this.transaction.save();
      return { success: false, message: this.transaction.result.message };
    }

    if (!validStatuses.includes(mdStatus)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus || responseCode,
        message: postData.responseMessage || '3D dogrulama basarisiz'
      };
      await this.transaction.save();
      return { success: false, message: this.transaction.result.message };
    }

    // Store 3D data (markModified required for Mixed type)
    this.transaction.secure = {
      ...this.transaction.secure,
      confirm3D: {
        secureId: postData.secureId,
        secureData: postData.secureData,
        secureMd: postData.secureMd,
        secureEcomInd: postData.secureEcomInd
      }
    };
    this.transaction.markModified('secure');
    await this.transaction.save();

    return this.processProvision(postData);
  }

  async processProvision(secureData) {
    // Akbank uses merchantSafeId/terminalSafeId but we store as merchantId/terminalId
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;
    const formData = this.transaction.secure?.formData;
    const confirm3D = this.transaction.secure?.confirm3D;

    const requestData = {
      version: '1.00',
      txnCode: '1000',
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      order: {
        orderId: formData?.orderId
      },
      transaction: {
        amount: parseFloat(formData?.amount || this.formatAmount()),
        currencyCode: formData?.currencyCode || this.getCurrencyCode(),
        motoInd: 0,
        installCount: this.transaction.installment || 1
      },
      secureTransaction: {
        secureId: confirm3D?.secureId,
        secureEcomInd: confirm3D?.secureEcomInd,
        secureData: confirm3D?.secureData,
        secureMd: confirm3D?.secureMd
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('provision', requestData, { status: 'sending' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('provision', requestData, result);

      if (result.hostResponseCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.transaction?.authCode,
          refNumber: result.transaction?.rrn || result.hostLogKey
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.responseCode,
          message: result.responseMessage || 'Odeme reddedildi'
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

      return { success: false, message: 'Baglanti hatasi' };
    }
  }

  /**
   * Non-3D Payment
   */
  async directPayment() {
    const card = this.getCard();
    // Akbank uses merchantSafeId/terminalSafeId but we store as merchantId/terminalId
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();

    const requestData = {
      version: '1.00',
      txnCode: '1000',
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      card: {
        cardNumber: card.number.replace(/\s/g, ''),
        cvv2: card.cvv,
        expireDate: this.formatExpiry(card.expiry)
      },
      reward: {
        ccbRewardAmount: 0.0,
        pcbRewardAmount: 0.0,
        xcbRewardAmount: 0.0
      },
      transaction: {
        amount: parseFloat(amount),
        currencyCode: this.getCurrencyCode(),
        motoInd: 0,
        installCount: this.transaction.installment || 1
      },
      customer: {
        emailAddress: this.transaction.customer?.email || '',
        ipAddress: this.transaction.customer?.ip || ''
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('provision', { orderId, amount }, { status: 'sending' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('provision', { orderId }, result);

      if (result.hostResponseCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.transaction?.authCode,
          refNumber: result.transaction?.rrn || result.hostLogKey
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.responseCode,
          message: result.responseMessage || 'Odeme reddedildi'
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
      paymentModels: ['3d', 'regular']
    };
  }

  /**
   * Refund a completed payment
   */
  async refund(originalTransaction) {
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;

    const requestData = {
      version: '1.00',
      txnCode: '1003',  // Credit/Refund
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      order: {
        orderId: originalTransaction.orderId
      },
      transaction: {
        amount: originalTransaction.amount,
        currencyCode: this.getCurrencyCode()
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('refund', { orderId: originalTransaction.orderId }, { status: 'sending' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('refund', requestData, result);

      if (result.hostResponseCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İade başarılı',
          refNumber: result.transaction?.rrn || result.hostLogKey,
          transactionId: result.txnId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Update original transaction
        originalTransaction.status = 'refunded';
        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          refNumber: result.transaction?.rrn
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.responseCode,
          message: result.responseMessage || 'İade başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.responseCode, result.responseMessage || 'İade başarısız');
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
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;

    const requestData = {
      version: '1.00',
      txnCode: '1004',  // Void/Cancel
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      order: {
        orderId: originalTransaction.orderId
      },
      transaction: {
        amount: originalTransaction.amount,
        currencyCode: this.getCurrencyCode()
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('cancel', { orderId: originalTransaction.orderId }, { status: 'sending' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('cancel', requestData, result);

      if (result.hostResponseCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İptal başarılı',
          refNumber: result.transaction?.rrn || result.hostLogKey
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
          code: result.responseCode,
          message: result.responseMessage || 'İptal başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.responseCode, result.responseMessage || 'İptal başarısız');
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
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;

    const requestData = {
      version: '1.00',
      txnCode: '1010',  // OrderInquiry
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      order: {
        orderId: orderId
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('status', { orderId }, { status: 'querying' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('status', { orderId }, result);

      return {
        success: true,
        status: result.txnStatus,
        orderId: orderId,
        amount: result.transaction?.amount,
        authCode: result.transaction?.authCode,
        refNumber: result.transaction?.rrn,
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
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();

    // Save orderId to transaction
    this.transaction.orderId = orderId;
    await this.transaction.save();

    const requestData = {
      version: '1.00',
      txnCode: '1005',  // PreAuth
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      card: {
        cardNumber: card.number.replace(/\s/g, ''),
        cvv2: card.cvv,
        expireDate: this.formatExpiry(card.expiry)
      },
      order: {
        orderId: orderId
      },
      transaction: {
        amount: parseFloat(amount),
        currencyCode: this.getCurrencyCode(),
        motoInd: 0,
        installCount: this.transaction.installment || 1
      },
      customer: {
        emailAddress: this.transaction.customer?.email || '',
        ipAddress: this.transaction.customer?.ip || ''
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('pre_auth', { orderId, amount }, { status: 'sending' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('pre_auth', { orderId }, result);

      if (result.hostResponseCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'Ön provizyon başarılı',
          authCode: result.transaction?.authCode,
          refNumber: result.transaction?.rrn || result.hostLogKey
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return this.successResponse({
          message: 'Ön provizyon başarılı',
          authCode: result.transaction?.authCode,
          refNumber: result.transaction?.rrn
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.responseCode,
          message: result.responseMessage || 'Ön provizyon başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.responseCode, result.responseMessage || 'Ön provizyon başarısız');
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
    const merchantSafeId = this.credentials.merchantId;
    const terminalSafeId = this.credentials.terminalId;

    const requestData = {
      version: '1.00',
      txnCode: '1006',  // PostAuth
      requestDateTime: this.getRequestDateTime(),
      randomNumber: this.generateRandomNumber(),
      terminal: {
        merchantSafeId: merchantSafeId,
        terminalSafeId: terminalSafeId
      },
      order: {
        orderId: preAuthTransaction.orderId
      },
      transaction: {
        amount: preAuthTransaction.amount,
        currencyCode: this.getCurrencyCode()
      }
    };

    try {
      const jsonString = JSON.stringify(requestData);
      const hash = this.calculateHash(jsonString);

      await this.log('post_auth', { orderId: preAuthTransaction.orderId }, { status: 'sending' });

      const response = await axios.post(this.urls.api, jsonString, {
        headers: {
          'auth-hash': hash,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        httpsAgent: this.httpsAgent
      });

      const result = response.data;
      await this.log('post_auth', { orderId: preAuthTransaction.orderId }, result);

      if (result.hostResponseCode === '00') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'Provizyon kapama başarılı',
          authCode: result.transaction?.authCode,
          refNumber: result.transaction?.rrn || result.hostLogKey
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        return this.successResponse({
          message: 'Provizyon kapama başarılı',
          authCode: result.transaction?.authCode
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.responseCode,
          message: result.responseMessage || 'Provizyon kapama başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(result.responseCode, result.responseMessage || 'Provizyon kapama başarısız');
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
