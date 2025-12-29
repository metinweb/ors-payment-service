/**
 * Yapi Kredi Bankasi POS Provider (POSNET)
 */

import crypto from 'crypto';
import xml2js from 'xml2js';
import BaseProvider, { CURRENCY_CODES_YKB } from './BaseProvider.js';

export default class YKBProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);

    // YKB uses ISO-8859-9 encoding
    this.xmlBuilder = new xml2js.Builder({
      xmldec: { version: '1.0', encoding: 'ISO-8859-9' }
    });
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
      history: false,
      preAuth: true,
      postAuth: true,
      paymentModels: ['3d', '3d_pay', 'regular']
    };
  }

  /**
   * Get YKB-specific currency code
   */
  getCurrencyCode() {
    return CURRENCY_CODES_YKB[this.transaction.currency] || 'TL';
  }

  /**
   * Format amount for YKB (no decimals, cents as integer)
   * 150.00 TL -> "15000"
   */
  formatAmountYKB() {
    return this.transaction.amount.toFixed(2).replace('.', '');
  }

  /**
   * Format installment for YKB (00 for single, 02-12 for installments)
   */
  formatInstallment() {
    const inst = this.transaction.installment;
    if (inst <= 1) return '00';
    return inst.toString().padStart(2, '0');
  }

  /**
   * Generate order ID (XID)
   */
  getOrderId() {
    // 20 karakter, alfanumerik
    return this.transaction._id.toString().padStart(20, '0').slice(0, 20);
  }

  /**
   * Hash string with SHA256 (Base64 output)
   */
  hashString(data) {
    return crypto.createHash('sha256').update(data, 'utf8').digest('base64');
  }

  /**
   * Decrypt MerchantPacket using Triple DES CBC
   * YKB MerchantPacket format:
   * - First 16 hex chars: IV (8 bytes binary)
   * - Rest: Encrypted data (hex encoded)
   * Key: MD5(storeKey) → uppercase → first 24 chars
   */
  decryptMerchantPacket(encryptedData, storeKey) {
    console.log('=== YKB DECRYPT DEBUG ===');
    console.log('MerchantPacket length:', encryptedData.length);
    console.log('MerchantPacket (first 50):', encryptedData.substring(0, 50));
    console.log('StoreKey length:', storeKey ? storeKey.length : 0);

    // Try multiple decryption methods
    const methods = [
      () => this.tryDecrypt(encryptedData, storeKey, 'full'),      // Full data after IV
      () => this.tryDecrypt(encryptedData, storeKey, 'minus8'),    // Old format: skip last 8 hex chars
      () => this.tryDecrypt(encryptedData, storeKey, 'minus16'),   // Skip last 16 hex chars
    ];

    for (const method of methods) {
      const result = method();
      if (result) {
        return result;
      }
    }

    console.error('All decryption methods failed');
    return null;
  }

  /**
   * Try decryption with specific data extraction method
   */
  tryDecrypt(encryptedData, storeKey, mode) {
    try {
      // EXACTLY like old utils.js:
      // var key = crypto.createHash('md5').update(key).digest('hex').toUpperCase().substr(0, 24)
      const key = crypto.createHash('md5').update(storeKey).digest('hex').toUpperCase().substr(0, 24);

      // var iv = Buffer.from(data.substr(0, 16), 'hex')
      const iv = Buffer.from(encryptedData.substr(0, 16), 'hex');

      // Extract data based on mode
      // Old code: data.substr(16, data.length - 24) which is substr(start, length)
      let dataHex;
      switch (mode) {
        case 'full':
          dataHex = encryptedData.substr(16);
          break;
        case 'minus8':
          // This matches: data.substr(16, data.length - 24) when length is 392
          // substr(16, 368) = 368 chars starting at position 16
          dataHex = encryptedData.substr(16, encryptedData.length - 24);
          break;
        case 'minus16':
          dataHex = encryptedData.substr(16, encryptedData.length - 32);
          break;
        default:
          dataHex = encryptedData.substr(16);
      }

      const dataLength = Buffer.from(dataHex, 'hex').length;
      console.log(`[${mode}] Data hex length: ${dataHex.length}, bytes: ${dataLength}, mod 8: ${dataLength % 8}`);

      // Check block alignment
      if (dataLength % 8 !== 0) {
        console.log(`[${mode}] Data not block-aligned, skipping`);
        return null;
      }

      // EXACTLY like old utils.js:
      // var decipher = crypto.createDecipheriv('des-ede3-cbc', key, iv)
      // var decrypted = decipher.update(data.substr(16, data.length - 24), 'hex', 'utf-8') + decipher.final('utf-8')
      const decipher = crypto.createDecipheriv('des-ede3-cbc', key, iv);
      let decrypted = decipher.update(dataHex, 'hex', 'utf-8') + decipher.final('utf-8');

      // Remove padding (null bytes and PKCS5/7 padding)
      decrypted = decrypted.replace(/[\x00-\x08]+$/, '');

      console.log(`[${mode}] Decrypted (first 100):`, decrypted.substring(0, 100));

      // Validate decrypted data - should contain semicolons
      if (!decrypted.includes(';')) {
        console.log(`[${mode}] Invalid format - no semicolons found`);
        return null;
      }

      // Parse the decrypted data
      // Format: mid;tid;pay;instcount;xid;totalPoint;totalPointAmount;weburl;hostip;port;tds_tx_status;tds_md_status;tds_md_errormessage;trantime;currency
      const parts = decrypted.split(';');

      if (parts.length < 12) {
        console.log(`[${mode}] Invalid format - not enough fields (${parts.length})`);
        return null;
      }

      const result = {
        mid: parts[0],
        tid: parts[1],
        pay: parts[2],
        instcount: parts[3],
        xid: parts[4],
        totalPoint: parts[5],
        totalPointAmount: parts[6],
        weburl: parts[7],
        hostip: parts[8],
        port: parts[9],
        tds_tx_status: parts[10],
        tds_md_status: parts[11],
        tds_md_errormessage: parts[12] || '',
        trantime: parts[13] || '',
        currency: parts[14] || ''
      };

      console.log(`[${mode}] SUCCESS - tds_md_status:`, result.tds_md_status);
      return result;
    } catch (error) {
      console.log(`[${mode}] Decrypt error:`, error.message);
      return null;
    }
  }

  /**
   * Initialize 3D Secure - Step 1: Get OOS Request Data
   */
  async initialize() {
    const card = this.getCard();
    const { merchantId, terminalId, posnetId, secretKey, username, password } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmountYKB();
    const currencyCode = this.getCurrencyCode();
    const installment = this.formatInstallment();

    // Build OOS Request Data request
    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        oosRequestData: {
          posnetid: posnetId,
          ccno: card.number.replace(/\s/g, ''),
          expDate: this.formatExpiry(card.expiry),
          cvc: card.cvv,
          amount: amount,
          currencyCode: currencyCode,
          installment: installment,
          XID: orderId,
          cardHolderName: card.holder || 'CARDHOLDER',
          tranType: 'Sale'
        }
      }
    };

    try {
      const xml = this.buildXml(request);
      await this.log('init', request, { status: 'sending' });

      // YKB için Content-Type header gerekli
      const response = await this.post(this.urls.api, 'xmldata=' + xml, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      const result = await this.parseXml(response.data);

      await this.log('init', request, result);

      if (result.approved === '1' || result.approved === 1) {
        // Store OOS data for form
        this.transaction.secure = this.transaction.secure || {};
        this.transaction.secure.formData = {
          posnetData: result.oosRequestDataResponse?.data1,
          posnetData2: result.oosRequestDataResponse?.data2,
          digest: result.oosRequestDataResponse?.sign,
          mid: merchantId,
          posnetId: posnetId,
          orderId: orderId,
          amount: amount,
          currencyCode: currencyCode
        };

        await this.saveSecure();  // Use helper for Mixed type

        return { success: true };
      } else {
        return {
          success: false,
          code: result.respCode || 'ERROR',
          error: result.respText || 'OOS istek hatasi'
        };
      }
    } catch (error) {
      await this.log('error', request, { error: error.message });
      return {
        success: false,
        code: 'NETWORK_ERROR',
        error: error.message
      };
    }
  }

  /**
   * Format expiry date for YKB (YYMM format)
   */
  formatExpiry(expiry) {
    // Input: "MM/YY" or "MM/YYYY"
    const parts = expiry.split('/');
    const month = parts[0].padStart(2, '0');
    let year = parts[1];
    if (year.length === 4) {
      year = year.slice(2);
    }
    return year + month; // YYMM
  }

  /**
   * Get 3D form HTML - Step 2: Redirect to bank
   */
  async getFormHtml() {
    const formData = this.transaction.secure?.formData;

    if (!formData) {
      throw new Error('Form verisi bulunamadi');
    }

    const callbackUrl = this.getCallbackUrl();

    const fields = {
      posnetData: formData.posnetData,
      posnetData2: formData.posnetData2,
      digest: formData.digest,
      mid: formData.mid,
      posnetID: formData.posnetId,
      merchantReturnURL: callbackUrl,
      lang: 'tr',
      url: '',
      openANewWindow: '0',
      type: '3d',         // Eski kodda var - 3D secure tipi
      vftCode: 'K001'     // Eski kodda var - doğrulama kodu
    };

    await this.log('3d_form', fields, { status: 'redirecting' });

    return this.generateFormHtml(this.urls.gate, fields);
  }

  /**
   * Process 3D callback - Step 3: Verify and provision
   */
  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    const { BankPacket, MerchantPacket, Sign } = postData;

    if (!MerchantPacket) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NO_MERCHANT_PACKET',
        message: 'Banka yaniti alinamadi'
      };
      await this.saveSecure();  // Use helper for Mixed type
      return { success: false, message: this.transaction.result.message };
    }

    // Decrypt merchant packet
    const { secretKey } = this.credentials;
    console.log('YKB Callback - secretKey exists:', !!secretKey, 'length:', secretKey ? secretKey.length : 0);

    if (!secretKey) {
      console.error('YKB ERROR: secretKey is empty or null!');
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NO_SECRET_KEY',
        message: 'POS storeKey/secretKey bulunamadi'
      };
      await this.saveSecure();
      return { success: false, message: this.transaction.result.message };
    }

    const decrypted = this.decryptMerchantPacket(MerchantPacket, secretKey);

    if (!decrypted) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'DECRYPT_ERROR',
        message: '3D dogrulama sifresi cozulemedi'
      };
      await this.saveSecure();  // Use helper for Mixed type
      return { success: false, message: this.transaction.result.message };
    }

    // Store decrypted data
    this.transaction.secure = {
      ...this.transaction.secure,
      decrypted: decrypted
    };

    // Check 3D status (1, 2, 4, 9 are valid)
    const mdStatus = decrypted.tds_md_status || decrypted.mdStatus;
    const validStatuses = ['1', '2', '4', '9'];

    if (!validStatuses.includes(mdStatus)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus,
        message: decrypted.tds_md_errormessage || decrypted.mdErrorMessage || '3D dogrulama basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type
      return { success: false, message: this.transaction.result.message };
    }

    // Process provision
    return this.processProvision(BankPacket, MerchantPacket, Sign, decrypted);
  }

  /**
   * Process provision - Step 4: Complete payment
   */
  async processProvision(bankPacket, merchantPacket, sign, decrypted) {
    const { merchantId, terminalId, secretKey, username, password } = this.credentials;
    const formData = this.transaction.secure?.formData;

    // ===== DETAYLI DEBUG LOGLARI =====
    console.log('========== YKB PROVISION DEBUG ==========');
    console.log('Credentials:', {
      merchantId,
      terminalId,
      username: username || '(BOŞ!)',
      password: password ? '***' : '(BOŞ!)',
      secretKey: secretKey ? secretKey.substring(0, 10) + '...' : '(BOŞ!)'
    });
    console.log('FormData:', formData);
    console.log('Decrypted:', decrypted);
    console.log('URL:', this.urls.api);
    console.log('==========================================');

    // Calculate MAC - EXACTLY like old utils.js:
    // var macData = utils.hashString(
    //   decrypted.xid + ';' +
    //   this.order.transaction.toAmount.value.toFixed(2).replace('.', '') + ';' +
    //   currencyCodes[this.order.transaction.toAmount.currency] + ';' +
    //   this.order.pos.auth.mid + ';' +
    //   utils.hashString(this.order.pos.auth.storekey + ';' + this.order.pos.auth.tid)
    // ).replace('+', '%2B')

    const xid = decrypted.xid;
    const amount = formData?.amount;
    const currencyCode = formData?.currencyCode;

    // hashString(storekey + ';' + tid)
    const hashedStoreKey = this.hashString(secretKey + ';' + terminalId);

    // MAC string'i oluştur - eski kodla AYNI FORMATTA
    const macString = xid + ';' + amount + ';' + currencyCode + ';' + merchantId + ';' + hashedStoreKey;
    console.log('MAC Input String:', macString);

    // hashString(xid + ';' + amount + ';' + currency + ';' + mid + ';' + hashedStoreKey)
    const macRaw = this.hashString(macString);

    // .replace('+', '%2B') - only replaces FIRST occurrence (not regex)
    const macData = macRaw.replace('+', '%2B');

    console.log('MAC calculation:', {
      xid,
      amount,
      currencyCode,
      merchantId,
      terminalId,
      hashedStoreKey,
      macRaw,
      macData
    });

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        oosTranData: {
          mac: macData,
          bankData: bankPacket,
          merchantData: merchantPacket,
          sign: sign,
          wpAmount: 0
        }
      }
    };

    try {
      const xml = this.buildXml(request);

      // XML'i logla
      console.log('========== PROVISION XML ==========');
      console.log(xml);
      console.log('===================================');

      await this.log('provision', request, { status: 'sending' });

      // Eski kodla AYNI şekilde gönder - Content-Type header ekle
      const response = await this.post(this.urls.api, 'xmldata=' + xml, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      // Raw response'u logla
      console.log('========== PROVISION RAW RESPONSE ==========');
      console.log(response.data);
      console.log('=============================================');

      const result = await this.parseXml(response.data);

      await this.log('provision', request, result);

      if (result.approved === '1' || result.approved === 1) {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.authCode,
          refNumber: result.hostlogkey
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.respCode,
          message: result.respText || 'Odeme reddedildi'
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
   * Non-3D Payment (Direct payment without 3D Secure)
   */
  async directPayment() {
    const card = this.getCard();
    const { merchantId, terminalId, username, password } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmountYKB();
    const currencyCode = this.getCurrencyCode();
    const installment = this.formatInstallment();

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        sale: {
          amount: amount,
          ccno: card.number.replace(/\s/g, ''),
          currencyCode: currencyCode,
          cvc: card.cvv,
          expDate: this.formatExpiry(card.expiry),
          orderID: orderId,
          installment: installment
        }
      }
    };

    try {
      const xml = this.buildXml(request);
      await this.log('provision', request, { status: 'sending' });

      const response = await this.post(this.urls.api, 'xmldata=' + xml, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      const result = await this.parseXml(response.data);

      await this.log('provision', request, result);

      if (result.approved === '1' || result.approved === 1) {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.authCode,
          refNumber: result.hostlogkey
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.respCode,
          message: result.respText || 'Odeme reddedildi'
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
   * Refund a completed payment
   */
  async refund(originalTransaction) {
    const { merchantId, terminalId, username, password } = this.credentials;

    const orderId = originalTransaction.orderId || originalTransaction.secure?.formData?.orderId || originalTransaction._id.toString().padStart(20, '0').slice(0, 20);
    const amount = this.formatAmountYKB();
    const currencyCode = this.getCurrencyCode();
    const hostLogKey = originalTransaction.result?.refNumber || '';

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        return: {
          amount: amount,
          currencyCode: currencyCode,
          orderID: orderId,
          hostlogkey: hostLogKey
        }
      }
    };

    try {
      const xml = this.buildXml(request);
      await this.log('refund', request, { status: 'sending' });

      const response = await this.post(this.urls.api, 'xmldata=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('refund', request, result);

      if (result.approved === '1' || result.approved === 1) {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.authCode,
          refNumber: result.hostlogkey,
          message: 'İade başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          authCode: result.authCode,
          refNumber: result.hostlogkey
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.respCode,
          message: result.respText || 'İade reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.respCode, result.respText || 'İade reddedildi', result);
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
   * Cancel a payment (reverse)
   */
  async cancel(originalTransaction) {
    const { merchantId, terminalId, username, password } = this.credentials;

    const hostLogKey = originalTransaction.result?.refNumber || '';
    const authCode = originalTransaction.result?.authCode || '';

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        reverse: {
          hostlogkey: hostLogKey,
          authCode: authCode,
          transaction: 'sale'
        }
      }
    };

    try {
      const xml = this.buildXml(request);
      await this.log('cancel', request, { status: 'sending' });

      const response = await this.post(this.urls.api, 'xmldata=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('cancel', request, result);

      if (result.approved === '1' || result.approved === 1) {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.authCode,
          refNumber: result.hostlogkey,
          message: 'İptal başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        originalTransaction.cancelledAt = new Date();
        originalTransaction.status = 'cancelled';
        await originalTransaction.save();

        return this.successResponse({
          message: 'İptal başarılı',
          authCode: result.authCode,
          refNumber: result.hostlogkey
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.respCode,
          message: result.respText || 'İptal reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.respCode, result.respText || 'İptal reddedildi', result);
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
    const { merchantId, terminalId, username, password } = this.credentials;

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        agreement: {
          orderID: orderId
        }
      }
    };

    try {
      const xml = this.buildXml(request);
      await this.log('status', request, { status: 'querying' });

      const response = await this.post(this.urls.api, 'xmldata=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('status', request, result);

      if (result.approved === '1' || result.approved === 1) {
        return {
          success: true,
          orderId,
          status: result.approved ? 'approved' : 'unknown',
          authCode: result.authCode,
          refNumber: result.hostlogkey,
          rawResponse: result
        };
      } else {
        return this.errorResponse(result.respCode, result.respText || 'Sorgu başarısız', result);
      }
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
    const { merchantId, terminalId, username, password } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmountYKB();
    const currencyCode = this.getCurrencyCode();
    const installment = this.formatInstallment();

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        auth: {
          amount: amount,
          ccno: card.number.replace(/\s/g, ''),
          currencyCode: currencyCode,
          cvc: card.cvv,
          expDate: this.formatExpiry(card.expiry),
          orderID: orderId,
          installment: installment
        }
      }
    };

    try {
      this.transaction.orderId = orderId;
      const xml = this.buildXml(request);
      await this.log('pre_auth', request, { status: 'sending' });

      const response = await this.post(this.urls.api, 'xmldata=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('pre_auth', request, result);

      if (result.approved === '1' || result.approved === 1) {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.authCode,
          refNumber: result.hostlogkey,
          message: 'Ön provizyon başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return this.successResponse({
          message: 'Ön provizyon başarılı',
          authCode: result.authCode,
          refNumber: result.hostlogkey
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.respCode,
          message: result.respText || 'Ön provizyon reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.respCode, result.respText || 'Ön provizyon reddedildi', result);
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
    const { merchantId, terminalId, username, password } = this.credentials;

    const orderId = preAuthTransaction.orderId || preAuthTransaction._id.toString().padStart(20, '0').slice(0, 20);
    const amount = this.formatAmountYKB();
    const currencyCode = this.getCurrencyCode();
    const hostLogKey = preAuthTransaction.result?.refNumber || '';

    const request = {
      posnetRequest: {
        mid: merchantId,
        tid: terminalId,
        username: username,
        password: password,
        capt: {
          amount: amount,
          currencyCode: currencyCode,
          hostlogkey: hostLogKey,
          orderID: orderId,
          installment: '00'
        }
      }
    };

    try {
      const xml = this.buildXml(request);
      await this.log('post_auth', request, { status: 'sending' });

      const response = await this.post(this.urls.api, 'xmldata=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('post_auth', request, result);

      if (result.approved === '1' || result.approved === 1) {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.authCode,
          refNumber: result.hostlogkey,
          message: 'Provizyon kapama başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        return this.successResponse({
          message: 'Provizyon kapama başarılı',
          authCode: result.authCode,
          refNumber: result.hostlogkey
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.respCode,
          message: result.respText || 'Provizyon kapama reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(result.respCode, result.respText || 'Provizyon kapama reddedildi', result);
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
