/**
 * Garanti Bankası POS Provider (Version 512 - SHA512)
 */

import crypto from 'crypto';
import BaseProvider from './BaseProvider.js';

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
    const card = this.getCard();
    const { merchantId, terminalId, secretKey } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount(false); // No decimals (cents)
    const currency = this.getCurrencyCode();
    const callbackUrl = this.getCallbackUrl();
    const installment = this.transaction.installment > 1 ? this.transaction.installment.toString() : '';

    // Generate security hash (SHA512)
    const securityHash = this.generate3DHash(orderId, amount, currency, callbackUrl, callbackUrl, installment);

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = {
      cardnumber: card.number.replace(/\s/g, ''),
      cardcvv2: card.cvv,
      cardexpiredateyear: this.formatExpiryYear(card.expiry),
      cardexpiredatemonth: this.formatExpiryMonth(card.expiry),
      txntype: 'sales',
      secure3dsecuritylevel: '3D',
      mode: this.getMode(),
      orderid: orderId,
      apiversion: this.apiVersion,
      terminalprovuserid: this.provUserId,
      terminaluserid: this.provUserId,
      terminalid: terminalId,
      terminalmerchantid: merchantId,
      customeripaddress: this.transaction.customer?.ip || '',
      customeremailaddress: this.transaction.customer?.email || '',
      txntype: 'sales',
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
      storetype: '3d',
      type: '3d'
    };

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId, amount, currency }, { status: 'prepared' });

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

    await this.log('3d_form', formData, { status: 'redirecting' });

    return this.generateFormHtml(this.urls.gate, formData);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

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
      await this.log('provision', { orderId, amount }, { status: 'sending' });

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
      await this.log('provision', { orderId, amount }, { status: 'sending' });

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
