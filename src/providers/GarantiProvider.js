/**
 * Garanti Bankası POS Provider
 */

import crypto from 'crypto';
import BaseProvider from './BaseProvider.js';

export default class GarantiProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.provUserId = 'PROVAUT';
  }

  /**
   * Generate security hash for Garanti
   */
  generateHash(data) {
    const { terminalId, password } = this.credentials;
    const tid = terminalId.padStart(9, '0');

    // Step 1: Hash password + tid
    const hashedPassword = crypto
      .createHash('sha1')
      .update(password + tid)
      .digest('hex')
      .toUpperCase();

    // Step 2: Hash security data
    const securityData = data + hashedPassword;
    return crypto
      .createHash('sha1')
      .update(securityData)
      .digest('hex')
      .toUpperCase();
  }

  async initialize() {
    // Garanti doesn't need pre-initialization
    // Just store form data and return success
    const card = this.getCard();
    const { merchantId, terminalId, secretKey } = this.credentials;

    const orderId = this.transaction._id.toString();
    const amount = this.formatAmount(false); // No decimals
    const callbackUrl = this.getCallbackUrl();

    // Generate security hash
    const hashData = orderId + terminalId + '' + amount + callbackUrl + callbackUrl + 'sales' + secretKey;
    const hashedPassword = crypto.createHash('sha1')
      .update(this.credentials.password + terminalId.padStart(9, '0'))
      .digest('hex')
      .toUpperCase();
    const securityHash = crypto.createHash('sha1')
      .update(hashData + hashedPassword)
      .digest('hex')
      .toUpperCase();

    // Store form data
    this.transaction.secure = this.transaction.secure || {};
    this.transaction.secure.formData = {
      cardnumber: card.number,
      cardcvv2: card.cvv,
      cardexpiredateyear: card.expiry.split('/')[1],
      cardexpiredatemonth: card.expiry.split('/')[0],
      txntype: 'sales',
      secure3dsecuritylevel: '3D',
      mode: 'PROD',
      orderid: orderId,
      apiversion: 'v1.0',
      terminalprovuserid: this.provUserId,
      terminaluserid: this.provUserId,
      terminalid: terminalId,
      terminalmerchantid: merchantId,
      customeripaddress: this.transaction.customer?.ip || '',
      txnamount: amount,
      txncurrencycode: this.getCurrencyCode(),
      txninstallmentcount: this.transaction.installment > 1 ? this.transaction.installment.toString() : '',
      successurl: callbackUrl,
      errorurl: callbackUrl,
      secure3dhash: securityHash
    };

    await this.log('init', { orderId }, { status: 'prepared' });
    await this.transaction.save();

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

    // Check 3D status
    const mdStatus = postData.mdstatus;
    const validStatuses = ['1', '2', '3', '4'];

    if (!validStatuses.includes(mdStatus)) {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: mdStatus,
        message: postData.mderrormessage || '3D doğrulama başarısız'
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
    const card = this.getCard();
    const { merchantId, terminalId } = this.credentials;
    const orderId = this.transaction._id.toString();
    const amount = this.formatAmount(false);

    // Generate hash for provision
    const hashData = orderId + terminalId + (this.transaction.secure?.formData?.cardnumber ? '' : card.number) + amount;
    const securityHash = this.generateHash(hashData);

    const provisionRequest = {
      GVPSRequest: {
        Mode: 'PROD',
        Version: 'v0.00',
        Terminal: {
          ProvUserID: this.provUserId,
          HashData: securityHash,
          UserID: this.provUserId,
          ID: terminalId,
          MerchantID: merchantId
        },
        Customer: {
          IPAddress: this.transaction.customer?.ip || '',
          EmailAddress: this.transaction.customer?.email || ''
        },
        Order: {
          OrderID: orderId,
          GroupID: '',
          Description: ''
        },
        Transaction: {
          Type: 'sales',
          InstallmentCnt: this.transaction.installment > 1 ? this.transaction.installment.toString() : '',
          Amount: amount,
          CurrencyCode: this.getCurrencyCode(),
          CardholderPresentCode: 13,
          MotoInd: 'N',
          Description: '',
          Secure3D: {
            AuthenticationCode: secureData.cavv,
            SecurityLevel: secureData.eci,
            TxnID: secureData.xid,
            Md: secureData.md
          }
        }
      }
    };

    try {
      const xml = this.buildXml(provisionRequest);
      const response = await this.post(this.urls.api, 'data=' + xml);
      const result = await this.parseXml(response.data);

      await this.log('provision', provisionRequest, result);

      if (result.Transaction?.Response?.Message === 'Approved') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result.Transaction?.AuthCode,
          refNumber: result.Transaction?.RetrefNum
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Ödeme başarılı' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: result.Transaction?.Response?.ReasonCode,
          message: result.Transaction?.Response?.ErrorMsg || 'Ödeme reddedildi'
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
