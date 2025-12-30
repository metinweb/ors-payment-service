/**
 * Garanti Bankası POS Provider (Version 512 - SHA512)
 */

import crypto from 'crypto';
import BaseProvider, { CURRENCY_CODES } from './BaseProvider.js';

export default class GarantiProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.provUserId = 'PROVAUT';
    this.apiVersion = '512';
  }

  /**
   * Generate hashed password (SHA1)
   * Format: SHA1(password + '0' + terminalId).toUpperCase()
   */
  getHashedPassword() {
    const { terminalId, password } = this.credentials;
    return crypto
      .createHash('sha1')
      .update(password + '0' + terminalId)
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Generate security hash for 3D form (SHA512)
   * Format: SHA512(terminalId + orderId + amount + currency + successUrl + errorUrl + 'sales' + installment + storeKey + hashedPassword)
   */
  generate3DHash(orderId, amount, currency, successUrl, errorUrl, installment) {
    const { terminalId, secretKey } = this.credentials;
    const hashedPassword = this.getHashedPassword();

    const securityData = terminalId + orderId + amount + currency + successUrl + errorUrl + 'sales' + installment + secretKey + hashedPassword;

    return crypto
      .createHash('sha512')
      .update(securityData)
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Generate security hash for provision (SHA512)
   * Format: SHA512(orderId + terminalId + cardNumber + amount + currency + hashedPassword)
   */
  generateProvisionHash(orderId, cardNumber, amount, currency) {
    const { terminalId } = this.credentials;
    const hashedPassword = this.getHashedPassword();

    const securityData = orderId + terminalId + cardNumber + amount + currency + hashedPassword;

    return crypto
      .createHash('sha512')
      .update(securityData)
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Get mode (test or PROD)
   */
  getMode() {
    return this.pos.testMode ? 'test' : 'PROD';
  }

  /**
   * Generate order ID
   */
  getOrderId() {
    const bookingCode = this.transaction.bookingCode || '';
    const orderId = 'ORS_' + bookingCode + '_' + Date.now().toString(36);
    return orderId.substring(0, 20).padEnd(20, '0');
  }

  async initialize() {
    const { merchantId, terminalId, secretKey } = this.credentials;
    const paymentModel = this.pos.paymentModel || '3d';

    // Non-3D ödeme için direkt payment kullan
    if (paymentModel === 'regular') {
      return this.directPayment();
    }

    const card = this.getCard();
    const orderId = this.getOrderId();
    const amount = this.formatAmount(false); // No decimals (cents)
    const currency = this.getCurrencyCode();
    const callbackUrl = this.getCallbackUrl();
    const installment = this.transaction.installment > 1 ? this.transaction.installment.toString() : '';

    // Determine security level based on payment model
    const securityLevel = paymentModel === '3d_pay' ? '3D_PAY' : '3D';

    // Generate security hash (SHA512)
    const securityHash = this.generate3DHash(orderId, amount, currency, callbackUrl, callbackUrl, installment);

    // Base form data
    const formData = {
      txntype: 'sales',
      secure3dsecuritylevel: securityLevel,
      mode: this.getMode(),
      orderid: orderId,
      apiversion: this.apiVersion,
      terminalprovuserid: this.provUserId,
      terminaluserid: this.provUserId,
      terminalid: terminalId,
      terminalmerchantid: merchantId,
      customeripaddress: this.transaction.customer?.ip || '',
      customeremailaddress: this.transaction.customer?.email || '',
      txnamount: amount,
      txncurrencycode: currency,
      companyname: this.pos.companyName || '',
      txninstallmentcount: installment,
      successurl: callbackUrl,
      errorurl: callbackUrl,
      secure3dhash: securityHash,
      txntimestamp: this.getTimestamp(),
      lang: this.transaction.language || 'tr',
      refreshtime: '0',
      storetype: paymentModel === '3d_pay' ? '3d_pay' : '3d'
    };

    // Kart bilgilerini ekle
    formData.cardnumber = card.number.replace(/\s/g, '');
    formData.cardcvv2 = card.cvv;
    formData.cardexpiredateyear = this.formatExpiryYear(card.expiry);
    formData.cardexpiredatemonth = this.formatExpiryMonth(card.expiry);

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;
    this.transaction.secure.paymentModel = paymentModel;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, amount, currency, paymentModel, securityLevel });

    return { success: true };
  }

  /**
   * Format expiry month (MM)
   */
  formatExpiryMonth(expiry) {
    return expiry.split('/')[0].padStart(2, '0');
  }

  /**
   * Format expiry year (YY)
   */
  formatExpiryYear(expiry) {
    const year = expiry.split('/')[1];
    return year.length === 4 ? year.slice(-2) : year;
  }

  /**
   * Get timestamp (ddMMYYYYHHmmss)
   */
  getTimestamp() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const MM = String(now.getMonth() + 1).padStart(2, '0');
    const YYYY = now.getFullYear();
    const HH = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return dd + MM + YYYY + HH + mm + ss;
  }

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData) {
      throw new Error('Form verisi bulunamadı');
    }

    await this.log('3d_redirect', { url: this.urls.gate }, formData);
    return this.generateFormHtml(this.urls.gate, formData);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    const paymentModel = this.transaction.secure?.paymentModel || '3d';

    // 3D_PAY modunda banka tüm işlemi yapar, direkt sonuç döner
    if (paymentModel === '3d_pay') {
      return this.handle3DPayCallback(postData);
    }

    // Check 3D status (only '1' is valid for Garanti)
    const mdStatus = postData.mdstatus;
    const validStatuses = ['1'];

    if (!validStatuses.includes(mdStatus)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus,
        message: postData.mderrormessage || '3D dogrulama basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type
      return { success: false, message: this.transaction.result.message };
    }

    // Extract 3D data
    const { md, xid, eci, cavv } = postData;
    this.transaction.secure = {
      ...this.transaction.secure,
      confirm3D: { md, xid, eci, cavv }
    };
    await this.saveSecure();  // Use helper for Mixed type

    // Process provision (3D payment)
    return this.processProvision({ md, xid, eci, cavv });
  }

  /**
   * Handle 3D Pay callback - banka tüm işlemi yaptı
   */
  async handle3DPayCallback(postData) {
    // 3D doğrulama kontrolü
    const mdStatus = postData.mdstatus;
    if (mdStatus !== '1') {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus,
        message: postData.mderrormessage || '3D doğrulama başarısız'
      };
      await this.saveSecure();
      return { success: false, message: this.transaction.result.message };
    }

    // 3D Pay'de işlem sonucu direkt gelir
    const procreturncode = postData.procreturncode;
    const authcode = postData.authcode;
    const hostrefnum = postData.hostrefnum;
    const errmsg = postData.errmsg;

    if (procreturncode === '00') {
      this.transaction.status = 'success';
      this.transaction.result = {
        success: true,
        authCode: authcode,
        refNumber: hostrefnum,
        message: 'Ödeme başarılı'
      };
      this.transaction.completedAt = new Date();
      await this.transaction.clearCvv();

      return { success: true, message: 'Ödeme başarılı' };
    } else {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: procreturncode,
        message: errmsg || 'Ödeme reddedildi'
      };
      await this.saveSecure();

      return { success: false, message: this.transaction.result.message };
    }
  }

  /**
   * Process 3D provision - after 3D verification
   */
  async processProvision(secureData) {
    const { merchantId, terminalId } = this.credentials;
    const formData = this.transaction.secure?.formData;
    const orderId = formData?.orderid;
    const amount = formData?.txnamount;
    const currency = formData?.txncurrencycode;
    const installment = formData?.txninstallmentcount || '';

    // For 3D payment, cardNumber is empty in hash
    const securityHash = this.generateProvisionHash(orderId, '', amount, currency);

    const provisionXml = this.build3DProvisionXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId,
      amount,
      currency,
      installment,
      secureData
    });

    try {

      const response = await this.post(this.urls.api, 'data=' + provisionXml);
      const result = await this.parseXml(response.data);

      await this.log('provision', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'Odeme reddedildi'
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
   * Build 3D provision XML (after 3D callback)
   */
  build3DProvisionXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId, amount, currency, installment, secureData } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>${this.provUserId}</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>${this.provUserId}</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress>${this.transaction.customer?.ip || ''}</IPAddress>
  <EmailAddress>${this.transaction.customer?.email || ''}</EmailAddress>
</Customer>
<Order>
  <OrderID>${orderId}</OrderID>
  <GroupID></GroupID>
  <Description></Description>
</Order>
<Transaction>
  <Type>sales</Type>
  <InstallmentCnt>${installment}</InstallmentCnt>
  <Amount>${amount}</Amount>
  <CurrencyCode>${currency}</CurrencyCode>
  <CardholderPresentCode>13</CardholderPresentCode>
  <MotoInd>N</MotoInd>
  <Description></Description>
  <Secure3D>
    <AuthenticationCode>${secureData.cavv || ''}</AuthenticationCode>
    <SecurityLevel>${secureData.eci || ''}</SecurityLevel>
    <TxnID>${secureData.xid || ''}</TxnID>
    <Md>${secureData.md || ''}</Md>
  </Secure3D>
</Transaction>
</GVPSRequest>`;
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
      // Desteklenen ödeme modelleri
      paymentModels: ['3d', '3d_pay', 'regular']
    };
  }

  /**
   * Refund a completed payment
   */
  async refund(originalTransaction) {
    const { merchantId, terminalId } = this.credentials;

    const orderId = originalTransaction.orderId || originalTransaction.secure?.formData?.orderid;
    const amount = this.formatAmount(false);
    const currency = this.getCurrencyCode();

    // For refund, generate hash with empty card number
    const securityHash = this.generateProvisionHash(orderId, '', amount, currency);

    const refundXml = this.buildRefundXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId,
      amount,
      currency,
      refNumber: originalTransaction.result?.refNumber || ''
    });

    try {

      const response = await this.post(this.urls.api, 'data=' + refundXml);
      const result = await this.parseXml(response.data);

      await this.log('refund', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum,
          message: 'İade başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Mark original transaction as refunded
        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'İade reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(
          result.Transaction?.Response?.ReasonCode,
          result.Transaction?.Response?.ErrorMsg || 'İade reddedildi',
          result
        );
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
   * Build refund XML
   */
  buildRefundXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId, amount, currency, refNumber } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>PROVRFN</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>PROVRFN</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress>${this.transaction.customer?.ip || ''}</IPAddress>
  <EmailAddress>${this.transaction.customer?.email || ''}</EmailAddress>
</Customer>
<Order>
  <OrderID>${orderId}</OrderID>
</Order>
<Transaction>
  <Type>refund</Type>
  <Amount>${amount}</Amount>
  <CurrencyCode>${currency}</CurrencyCode>
  <OriginalRetrefNum>${refNumber}</OriginalRetrefNum>
</Transaction>
</GVPSRequest>`;
  }

  /**
   * Cancel a payment (same day void)
   */
  async cancel(originalTransaction) {
    const { merchantId, terminalId } = this.credentials;

    const orderId = originalTransaction.orderId || originalTransaction.secure?.formData?.orderid;
    const amount = Math.round(originalTransaction.amount * 100).toString();
    const currency = CURRENCY_CODES[originalTransaction.currency] || 949;

    // For cancel, generate hash with empty card number
    const securityHash = this.generateProvisionHash(orderId, '', amount, currency);

    const cancelXml = this.buildCancelXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId,
      amount,
      currency,
      refNumber: originalTransaction.result?.refNumber || ''
    });

    try {

      const response = await this.post(this.urls.api, 'data=' + cancelXml);
      const result = await this.parseXml(response.data);

      await this.log('cancel', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum,
          message: 'İptal başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Mark original transaction as cancelled
        originalTransaction.cancelledAt = new Date();
        originalTransaction.status = 'cancelled';
        await originalTransaction.save();

        return this.successResponse({
          message: 'İptal başarılı',
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'İptal reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(
          result.Transaction?.Response?.ReasonCode,
          result.Transaction?.Response?.ErrorMsg || 'İptal reddedildi',
          result
        );
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
   * Build cancel XML
   */
  buildCancelXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId, amount, currency, refNumber } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>PROVRFN</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>PROVRFN</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress>${this.transaction.customer?.ip || ''}</IPAddress>
  <EmailAddress>${this.transaction.customer?.email || ''}</EmailAddress>
</Customer>
<Order>
  <OrderID>${orderId}</OrderID>
</Order>
<Transaction>
  <Type>void</Type>
  <Amount>${amount}</Amount>
  <CurrencyCode>${currency}</CurrencyCode>
  <OriginalRetrefNum>${refNumber}</OriginalRetrefNum>
</Transaction>
</GVPSRequest>`;
  }

  /**
   * Query payment status
   */
  async status(orderId) {
    const { merchantId, terminalId } = this.credentials;

    // For status query, generate hash with empty amount/currency
    const securityHash = this.generateProvisionHash(orderId, '', '1', '949');

    const statusXml = this.buildStatusXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId
    });

    try {

      const response = await this.post(this.urls.api, 'data=' + statusXml);
      const result = await this.parseXml(response.data);

      await this.log('status', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved' || result.Order) {
        return {
          success: true,
          orderId,
          status: result.Order?.OrderStatus || 'unknown',
          amount: result.Order?.TotalAmount,
          authCode: result.Order?.AuthCode,
          refNumber: result.Order?.RetrefNum,
          rawResponse: result
        };
      } else {
        return this.errorResponse(
          result.Transaction?.Response?.ReasonCode,
          result.Transaction?.Response?.ErrorMsg || 'Sorgu başarısız',
          result
        );
      }
    } catch (error) {
      await this.log('error', {}, { error: error.message });
      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Build status query XML
   */
  buildStatusXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>${this.provUserId}</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>${this.provUserId}</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress></IPAddress>
  <EmailAddress></EmailAddress>
</Customer>
<Order>
  <OrderID>${orderId}</OrderID>
</Order>
<Transaction>
  <Type>orderinq</Type>
  <Amount>1</Amount>
  <CurrencyCode>949</CurrencyCode>
</Transaction>
</GVPSRequest>`;
  }

  /**
   * Pre-authorization (block amount)
   */
  async preAuth() {
    // Similar to directPayment but with Type=preauth
    const card = this.getCard();
    const { merchantId, terminalId } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount(false);
    const currency = this.getCurrencyCode();
    const installment = this.transaction.installment > 1 ? this.transaction.installment.toString() : '';
    const cardNumber = card.number.replace(/\s/g, '');

    const securityHash = this.generateProvisionHash(orderId, cardNumber, amount, currency);

    const preAuthXml = this.buildPreAuthXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId,
      amount,
      currency,
      installment,
      card: {
        number: cardNumber,
        expiry: this.formatExpiryMonth(card.expiry) + this.formatExpiryYear(card.expiry),
        cvv: card.cvv
      }
    });

    try {
      // Store orderId for later postAuth
      this.transaction.orderId = orderId;

      const response = await this.post(this.urls.api, 'data=' + preAuthXml);
      const result = await this.parseXml(response.data);

      await this.log('pre_auth', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum,
          message: 'Ön provizyon başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return this.successResponse({
          message: 'Ön provizyon başarılı',
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'Ön provizyon reddedildi'
        };
        await this.saveSecure();

        return this.errorResponse(
          result.Transaction?.Response?.ReasonCode,
          result.Transaction?.Response?.ErrorMsg || 'Ön provizyon reddedildi',
          result
        );
      }
    } catch (error) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: 'NETWORK_ERROR',
        message: error.message
      };
      await this.log('error', {}, { error: error.message });
      await this.saveSecure();

      return this.errorResponse('NETWORK_ERROR', 'Bağlantı hatası');
    }
  }

  /**
   * Build pre-auth XML
   */
  buildPreAuthXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId, amount, currency, installment, card } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>${this.provUserId}</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>${this.provUserId}</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress>${this.transaction.customer?.ip || ''}</IPAddress>
  <EmailAddress>${this.transaction.customer?.email || ''}</EmailAddress>
</Customer>
<Card>
  <Number>${card.number}</Number>
  <ExpireDate>${card.expiry}</ExpireDate>
  <CVV2>${card.cvv}</CVV2>
</Card>
<Order>
  <OrderID>${orderId}</OrderID>
  <GroupID></GroupID>
  <Description></Description>
</Order>
<Transaction>
  <Type>preauth</Type>
  <InstallmentCnt>${installment}</InstallmentCnt>
  <Amount>${amount}</Amount>
  <CurrencyCode>${currency}</CurrencyCode>
  <CardholderPresentCode>0</CardholderPresentCode>
  <MotoInd>H</MotoInd>
  <Description></Description>
</Transaction>
</GVPSRequest>`;
  }

  /**
   * Post-authorization (capture pre-auth)
   */
  async postAuth(preAuthTransaction) {
    const { merchantId, terminalId } = this.credentials;

    const orderId = preAuthTransaction.orderId || preAuthTransaction.secure?.formData?.orderid;
    const amount = this.formatAmount(false);
    const currency = this.getCurrencyCode();

    const securityHash = this.generateProvisionHash(orderId, '', amount, currency);

    const postAuthXml = this.buildPostAuthXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId,
      amount,
      currency,
      refNumber: preAuthTransaction.result?.refNumber || ''
    });

    try {

      const response = await this.post(this.urls.api, 'data=' + postAuthXml);
      const result = await this.parseXml(response.data);

      await this.log('post_auth', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum,
          message: 'Provizyon kapama başarılı'
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        return this.successResponse({
          message: 'Provizyon kapama başarılı',
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'Provizyon kapama reddedildi'
        };
        await this.transaction.save();

        return this.errorResponse(
          result.Transaction?.Response?.ReasonCode,
          result.Transaction?.Response?.ErrorMsg || 'Provizyon kapama reddedildi',
          result
        );
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
   * Build post-auth XML
   */
  buildPostAuthXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId, amount, currency, refNumber } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>${this.provUserId}</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>${this.provUserId}</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress>${this.transaction.customer?.ip || ''}</IPAddress>
  <EmailAddress>${this.transaction.customer?.email || ''}</EmailAddress>
</Customer>
<Order>
  <OrderID>${orderId}</OrderID>
</Order>
<Transaction>
  <Type>postauth</Type>
  <Amount>${amount}</Amount>
  <CurrencyCode>${currency}</CurrencyCode>
  <OriginalRetrefNum>${refNumber}</OriginalRetrefNum>
</Transaction>
</GVPSRequest>`;
  }

  /**
   * Non-3D Payment (Direct payment without 3D Secure)
   */
  async directPayment() {
    const card = this.getCard();
    const { merchantId, terminalId } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount(false);
    const currency = this.getCurrencyCode();
    const installment = this.transaction.installment > 1 ? this.transaction.installment.toString() : '';
    const cardNumber = card.number.replace(/\s/g, '');

    // For non-3D, include card number in hash
    const securityHash = this.generateProvisionHash(orderId, cardNumber, amount, currency);

    const paymentXml = this.buildDirectPaymentXml({
      mode: this.getMode(),
      terminalId,
      merchantId,
      securityHash,
      orderId,
      amount,
      currency,
      installment,
      card: {
        number: cardNumber,
        expiry: this.formatExpiryMonth(card.expiry) + this.formatExpiryYear(card.expiry),
        cvv: card.cvv
      }
    });

    try {

      const response = await this.post(this.urls.api, 'data=' + paymentXml);
      const result = await this.parseXml(response.data);

      await this.log('provision', { orderId }, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'Odeme reddedildi'
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
   * Build direct payment XML (non-3D)
   */
  buildDirectPaymentXml(params) {
    const { mode, terminalId, merchantId, securityHash, orderId, amount, currency, installment, card } = params;

    return `<?xml version="1.0" encoding="ISO-8859-9"?>
<GVPSRequest>
<Mode>${mode}</Mode>
<Version>512</Version>
<Terminal>
  <ProvUserID>${this.provUserId}</ProvUserID>
  <HashData>${securityHash}</HashData>
  <UserID>${this.provUserId}</UserID>
  <ID>${terminalId}</ID>
  <MerchantID>${merchantId}</MerchantID>
</Terminal>
<Customer>
  <IPAddress>${this.transaction.customer?.ip || ''}</IPAddress>
  <EmailAddress>${this.transaction.customer?.email || ''}</EmailAddress>
</Customer>
<Card>
  <Number>${card.number}</Number>
  <ExpireDate>${card.expiry}</ExpireDate>
  <CVV2>${card.cvv}</CVV2>
</Card>
<Order>
  <OrderID>${orderId}</OrderID>
  <GroupID></GroupID>
  <Description></Description>
</Order>
<Transaction>
  <Type>sales</Type>
  <InstallmentCnt>${installment}</InstallmentCnt>
  <Amount>${amount}</Amount>
  <CurrencyCode>${currency}</CurrencyCode>
  <CardholderPresentCode>0</CardholderPresentCode>
  <MotoInd>H</MotoInd>
  <Description></Description>
</Transaction>
</GVPSRequest>`;
  }
}
