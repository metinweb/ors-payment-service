/**
 * Payten (eski EST) POS Provider
 * Halkbank, İş Bankası, Ziraat, TEB için kullanılır
 */

import crypto from 'crypto';
import BaseProvider from './BaseProvider.js';

export default class PaytenProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
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

  async initialize() {
    const card = this.getCard();
    const { merchantId } = this.credentials;

    const orderId = this.transaction._id.toString();
    const callbackUrl = this.getCallbackUrl();
    const rnd = Date.now().toString();

    const formData = {
      pan: card.number,
      cv2: card.cvv,
      Ecom_Payment_Card_ExpDate_Year: card.expiry.split('/')[1],
      Ecom_Payment_Card_ExpDate_Month: card.expiry.split('/')[0],
      clientid: merchantId,
      amount: this.formatAmount(),
      oid: orderId,
      okUrl: callbackUrl,
      failUrl: callbackUrl,
      rnd: rnd,
      storetype: '3d',
      currency: this.getCurrencyCode(),
      lang: 'tr',
      islemtipi: 'Auth',
      taksit: this.transaction.installment > 1 ? this.transaction.installment.toString() : '',
      Hashalgorithm: 'ver3'
    };

    formData.hash = this.generateHash(formData);

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = formData;

    await this.saveSecure();  // Save formData FIRST (Mixed type needs markModified)
    await this.log('init', { orderId }, { status: 'prepared' });

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

    // Check mdStatus
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

    // Process provision
    return this.processProvision({ md, xid, eci, cavv });
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
}
