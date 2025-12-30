/**
 * VakifBank POS Provider (VPOS XML)
 */

import crypto from 'crypto';
import https from 'https';
import axios from 'axios';
import xml2js from 'xml2js';
import BaseProvider from './BaseProvider.js';

export default class VakifbankProvider extends BaseProvider {
  constructor(transaction, virtualPos) {
    super(transaction, virtualPos);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    this.xmlParser = new xml2js.Parser({ explicitRoot: false, explicitArray: false });
  }

  /**
   * Get order ID
   */
  getOrderId() {
    const bookingCode = this.transaction.bookingCode || '';
    const orderId = 'ORS' + bookingCode + Date.now().toString(36);
    return orderId.substring(0, 20).padEnd(20, '0');
  }

  /**
   * Map card association to brand code
   */
  getBrandCode(association) {
    const codes = {
      visa: 100,
      mastercard: 200,
      master_card: 200,
      amex: 300
    };
    return codes[String(association || '').toLowerCase()] || 100;
  }

  /**
   * Format expiry (YYMM)
   */
  formatExpiryYYMM(expiry) {
    const parts = expiry.split('/');
    const month = parts[0].padStart(2, '0');
    let year = parts[1];
    if (year.length === 4) {
      year = year.slice(2);
    }
    return year + month;
  }

  /**
   * Format expiry (YYYYMM)
   */
  formatExpiryYYYYMM(expiry) {
    const parts = expiry.split('/');
    const month = parts[0].padStart(2, '0');
    let year = parts[1];
    if (year.length === 2) {
      year = '20' + year;
    }
    return year + month;
  }

  /**
   * Initialize 3D - VerifyEnrollment
   */
  async initialize() {
    const card = this.getCard();
    const { merchantId, password } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();
    const callbackUrl = this.getCallbackUrl();

    const enrollmentData = {
      Pan: card.number.replace(/\s/g, ''),
      ExpiryDate: this.formatExpiryYYMM(card.expiry),
      PurchaseAmount: amount,
      Currency: this.getCurrencyCode(),
      BrandName: this.getBrandCode(this.transaction.cardAssociation),
      VerifyEnrollmentRequestId: orderId,
      MerchantId: merchantId,
      MerchantPassword: password,
      SuccessUrl: callbackUrl,
      FailureUrl: callbackUrl
    };

    // Add installment only if > 1
    if (this.transaction.installment > 1) {
      enrollmentData.InstallmentCount = this.transaction.installment;
    }

    try {
      const response = await axios.post(
        this.urls.gate,
        this.encodeForm(enrollmentData),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          httpsAgent: this.httpsAgent
        }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('init', enrollmentData, result);

      const status = result?.Message?.VERes?.Status;
      if (status === 'Y') {
        const PaReq = result.Message.VERes.PaReq;
        const TermUrl = result.Message.VERes.TermUrl;
        const MD = result.Message.VERes.MD;
        const ACSUrl = result.Message.VERes.ACSUrl;

        // Store 3D data and orderId
        this.transaction.secure = this.transaction.secure || {};
        this.transaction.secure.formData = {
          PaReq,
          TermUrl,
          MD,
          ACSUrl,
          orderId,
          amount
        };
        this.transaction.orderId = orderId;

        await this.saveSecure();  // Save formData (Mixed type needs markModified)
        return { success: true };
      } else {
        const code = result?.MessageErrorCode || 'UNKNOWN';
        const msg = result?.ErrorMessage || '3D dogrulama baslatilamadi';
        return { success: false, code, error: msg };
      }
    } catch (error) {
      await this.log('error', enrollmentData, { error: error.message });
      return { success: false, code: 'NETWORK_ERROR', error: error.message };
    }
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

  async getFormHtml() {
    const formData = this.transaction.secure?.formData;
    if (!formData || !formData.ACSUrl) {
      throw new Error('3D form verisi eksik');
    }

    const fields = {
      PaReq: formData.PaReq,
      TermUrl: formData.TermUrl,
      MD: formData.MD
    };

    await this.log('3d_redirect', { url: formData.ACSUrl }, fields);
    return this.generateFormHtml(formData.ACSUrl, fields);
  }

  async processCallback(postData) {
    await this.log('3d_callback', postData, {});

    const status = postData.Status;
    if (status !== 'Y') {
      this.transaction.status = 'failed';
      this.transaction.result = {
        success: false,
        code: status,
        message: postData.ErrorMessage || '3D dogrulama basarisiz'
      };
      await this.saveSecure();  // Use helper for Mixed type
      return { success: false, message: this.transaction.result.message };
    }

    // Store 3D data
    this.transaction.secure = {
      ...this.transaction.secure,
      confirm3D: {
        md: postData.VerifyEnrollmentRequestId,
        eci: postData.Eci,
        cavv: postData.Cavv
      }
    };
    await this.saveSecure();  // Use helper for Mixed type

    return this.processProvision(postData);
  }

  async processProvision(secureData) {
    const card = this.getCard();
    const { merchantId, password, terminalId } = this.credentials;
    const formData = this.transaction.secure?.formData;
    const confirm3D = this.transaction.secure?.confirm3D;

    const orderId = formData?.orderId || this.getOrderId();
    const amount = formData?.amount || this.formatAmount();

    const paymentXml = this.buildPaymentXml({
      merchantId,
      password,
      terminalId,
      orderId,
      amount,
      currency: this.getCurrencyCode(),
      card: {
        number: card.number.replace(/\s/g, ''),
        cvv: card.cvv,
        expiry: this.formatExpiryYYYYMM(card.expiry),
        holder: card.holder
      },
      eci: confirm3D?.eci,
      cavv: confirm3D?.cavv,
      installment: this.transaction.installment
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + paymentXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('provision', { orderId }, result);

      const resultCode = result?.ResultCode;
      if (resultCode === '0000') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result?.AuthCode,
          refNumber: result?.TransactionId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: resultCode,
          message: result?.ResultDetail || 'Odeme reddedildi'
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
   * Build payment XML
   */
  buildPaymentXml(params) {
    const { merchantId, password, terminalId, orderId, amount, currency, card, eci, cavv, installment } = params;

    let installmentTag = '';
    if (installment > 1) {
      installmentTag = `<NumberOfInstallments>${installment}</NumberOfInstallments>`;
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<VposRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <TransactionType>Sale</TransactionType>
  <CurrencyAmount>${amount}</CurrencyAmount>
  <CurrencyCode>${currency}</CurrencyCode>
  <Pan>${card.number}</Pan>
  <Cvv>${card.cvv}</Cvv>
  <Expiry>${card.expiry}</Expiry>
  <CardHoldersName>${card.holder || ''}</CardHoldersName>
  <ECI>${eci || ''}</ECI>
  <CAVV>${cavv || ''}</CAVV>
  <MpiTransactionId>${orderId}</MpiTransactionId>
  <OrderId>${orderId}</OrderId>
  <ClientIp>${this.transaction.customer?.ip || ''}</ClientIp>
  <TransactionDeviceSource>0</TransactionDeviceSource>
  ${installmentTag}
</VposRequest>`;
  }

  /**
   * Non-3D Payment
   */
  async directPayment() {
    const card = this.getCard();
    const { merchantId, password, terminalId } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();

    // Save orderId to transaction
    this.transaction.orderId = orderId;

    const paymentXml = this.buildDirectPaymentXml({
      merchantId,
      password,
      terminalId,
      orderId,
      amount,
      currency: this.getCurrencyCode(),
      card: {
        number: card.number.replace(/\s/g, ''),
        cvv: card.cvv,
        expiry: this.formatExpiryYYYYMM(card.expiry),
        holder: card.holder
      },
      installment: this.transaction.installment
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + paymentXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('provision', { orderId }, result);

      const resultCode = result?.ResultCode;
      if (resultCode === '0000') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          authCode: result?.AuthCode,
          refNumber: result?.TransactionId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return { success: true, message: 'Odeme basarili' };
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: resultCode,
          message: result?.ResultDetail || 'Odeme reddedildi'
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
   * Build direct payment XML
   */
  buildDirectPaymentXml(params) {
    const { merchantId, password, terminalId, orderId, amount, currency, card, installment } = params;

    let installmentTag = '';
    if (installment > 1) {
      installmentTag = `<NumberOfInstallments>${installment}</NumberOfInstallments>`;
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<VposRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <TransactionType>Sale</TransactionType>
  <CurrencyAmount>${amount}</CurrencyAmount>
  <CurrencyCode>${currency}</CurrencyCode>
  <Pan>${card.number}</Pan>
  <Cvv>${card.cvv}</Cvv>
  <Expiry>${card.expiry}</Expiry>
  <CardHoldersName>${card.holder || ''}</CardHoldersName>
  <OrderId>${orderId}</OrderId>
  <ClientIp>${this.transaction.customer?.ip || ''}</ClientIp>
  <TransactionDeviceSource>0</TransactionDeviceSource>
  ${installmentTag}
</VposRequest>`;
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
   * Build refund XML
   */
  buildRefundXml(params) {
    const { merchantId, password, terminalId, orderId, amount, currency, refTransactionId } = params;

    return `<?xml version="1.0" encoding="utf-8"?>
<VposRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <TransactionType>Refund</TransactionType>
  <ReferenceTransactionId>${refTransactionId}</ReferenceTransactionId>
  <CurrencyAmount>${amount}</CurrencyAmount>
  <CurrencyCode>${currency}</CurrencyCode>
  <OrderId>${orderId}</OrderId>
  <ClientIp>${this.transaction.customer?.ip || ''}</ClientIp>
</VposRequest>`;
  }

  /**
   * Build cancel XML
   */
  buildCancelXml(params) {
    const { merchantId, password, terminalId, orderId, refTransactionId } = params;

    return `<?xml version="1.0" encoding="utf-8"?>
<VposRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <TransactionType>Cancel</TransactionType>
  <ReferenceTransactionId>${refTransactionId}</ReferenceTransactionId>
  <OrderId>${orderId}</OrderId>
  <ClientIp>${this.transaction.customer?.ip || ''}</ClientIp>
</VposRequest>`;
  }

  /**
   * Build status query XML
   */
  buildStatusXml(params) {
    const { merchantId, password, terminalId, orderId } = params;

    return `<?xml version="1.0" encoding="utf-8"?>
<SearchRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <OrderId>${orderId}</OrderId>
</SearchRequest>`;
  }

  /**
   * Build pre-auth XML
   */
  buildPreAuthXml(params) {
    const { merchantId, password, terminalId, orderId, amount, currency, card, installment } = params;

    let installmentTag = '';
    if (installment > 1) {
      installmentTag = `<NumberOfInstallments>${installment}</NumberOfInstallments>`;
    }

    return `<?xml version="1.0" encoding="utf-8"?>
<VposRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <TransactionType>Auth</TransactionType>
  <CurrencyAmount>${amount}</CurrencyAmount>
  <CurrencyCode>${currency}</CurrencyCode>
  <Pan>${card.number}</Pan>
  <Cvv>${card.cvv}</Cvv>
  <Expiry>${card.expiry}</Expiry>
  <CardHoldersName>${card.holder || ''}</CardHoldersName>
  <OrderId>${orderId}</OrderId>
  <ClientIp>${this.transaction.customer?.ip || ''}</ClientIp>
  <TransactionDeviceSource>0</TransactionDeviceSource>
  ${installmentTag}
</VposRequest>`;
  }

  /**
   * Build post-auth XML
   */
  buildPostAuthXml(params) {
    const { merchantId, password, terminalId, orderId, amount, currency, refTransactionId } = params;

    return `<?xml version="1.0" encoding="utf-8"?>
<VposRequest>
  <MerchantId>${merchantId}</MerchantId>
  <Password>${password}</Password>
  <TerminalNo>${terminalId}</TerminalNo>
  <TransactionType>Capture</TransactionType>
  <ReferenceTransactionId>${refTransactionId}</ReferenceTransactionId>
  <CurrencyAmount>${amount}</CurrencyAmount>
  <CurrencyCode>${currency}</CurrencyCode>
  <OrderId>${orderId}</OrderId>
  <ClientIp>${this.transaction.customer?.ip || ''}</ClientIp>
</VposRequest>`;
  }

  /**
   * Refund a completed payment
   */
  async refund(originalTransaction) {
    const { merchantId, password, terminalId } = this.credentials;

    // Get original orderId with fallback
    const orgOrderId = originalTransaction.orderId || originalTransaction.secure?.formData?.orderId;

    const refundXml = this.buildRefundXml({
      merchantId,
      password,
      terminalId,
      orderId: this.getOrderId(),
      amount: originalTransaction.amount.toFixed(2),
      currency: this.getCurrencyCode(),
      refTransactionId: originalTransaction.result?.refNumber || orgOrderId
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + refundXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('refund', { orderId: originalTransaction.orderId }, result);

      const resultCode = result?.ResultCode;
      if (resultCode === '0000') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İade başarılı',
          refNumber: result?.TransactionId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        // Update original transaction
        originalTransaction.status = 'refunded';
        originalTransaction.refundedAt = new Date();
        await originalTransaction.save();

        return this.successResponse({
          message: 'İade başarılı',
          refNumber: result?.TransactionId
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: resultCode,
          message: result?.ResultDetail || 'İade başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(resultCode, result?.ResultDetail || 'İade başarısız');
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
    const { merchantId, password, terminalId } = this.credentials;

    // Get original orderId with fallback
    const orgOrderId = originalTransaction.orderId || originalTransaction.secure?.formData?.orderId;

    const cancelXml = this.buildCancelXml({
      merchantId,
      password,
      terminalId,
      orderId: orgOrderId,
      refTransactionId: originalTransaction.result?.refNumber || orgOrderId
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + cancelXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('cancel', { orderId: originalTransaction.orderId }, result);

      const resultCode = result?.ResultCode;
      if (resultCode === '0000') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'İptal başarılı',
          refNumber: result?.TransactionId
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
          code: resultCode,
          message: result?.ResultDetail || 'İptal başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(resultCode, result?.ResultDetail || 'İptal başarısız');
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
    const { merchantId, password, terminalId } = this.credentials;

    const statusXml = this.buildStatusXml({
      merchantId,
      password,
      terminalId,
      orderId
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + statusXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('status', { orderId }, result);

      return {
        success: true,
        status: result?.TransactionStatus,
        orderId: orderId,
        amount: result?.CurrencyAmount,
        authCode: result?.AuthCode,
        refNumber: result?.TransactionId,
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
    const { merchantId, password, terminalId } = this.credentials;

    const orderId = this.getOrderId();
    const amount = this.formatAmount();

    // Save orderId to transaction
    this.transaction.orderId = orderId;
    await this.transaction.save();

    const preAuthXml = this.buildPreAuthXml({
      merchantId,
      password,
      terminalId,
      orderId,
      amount,
      currency: this.getCurrencyCode(),
      card: {
        number: card.number.replace(/\s/g, ''),
        cvv: card.cvv,
        expiry: this.formatExpiryYYYYMM(card.expiry),
        holder: card.holder
      },
      installment: this.transaction.installment
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + preAuthXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('pre_auth', { orderId }, result);

      const resultCode = result?.ResultCode;
      if (resultCode === '0000') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'Ön provizyon başarılı',
          authCode: result?.AuthCode,
          refNumber: result?.TransactionId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.clearCvv();

        return this.successResponse({
          message: 'Ön provizyon başarılı',
          authCode: result?.AuthCode,
          refNumber: result?.TransactionId
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: resultCode,
          message: result?.ResultDetail || 'Ön provizyon başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(resultCode, result?.ResultDetail || 'Ön provizyon başarısız');
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
    const { merchantId, password, terminalId } = this.credentials;

    const postAuthXml = this.buildPostAuthXml({
      merchantId,
      password,
      terminalId,
      orderId: this.getOrderId(),
      amount: preAuthTransaction.amount.toFixed(2),
      currency: this.getCurrencyCode(),
      refTransactionId: preAuthTransaction.result?.refNumber || preAuthTransaction.orderId
    });

    try {

      const response = await axios.post(
        this.urls.api,
        'prmstr=' + postAuthXml,
        { httpsAgent: this.httpsAgent }
      );

      const result = await this.xmlParser.parseStringPromise(response.data);
      await this.log('post_auth', { orderId: preAuthTransaction.orderId }, result);

      const resultCode = result?.ResultCode;
      if (resultCode === '0000') {
        this.transaction.status = 'success';
        this.transaction.result = {
          success: true,
          message: 'Provizyon kapama başarılı',
          authCode: result?.AuthCode,
          refNumber: result?.TransactionId
        };
        this.transaction.completedAt = new Date();
        await this.transaction.save();

        return this.successResponse({
          message: 'Provizyon kapama başarılı',
          authCode: result?.AuthCode
        });
      } else {
        this.transaction.status = 'failed';
        this.transaction.result = {
          success: false,
          code: resultCode,
          message: result?.ResultDetail || 'Provizyon kapama başarısız'
        };
        await this.transaction.save();

        return this.errorResponse(resultCode, result?.ResultDetail || 'Provizyon kapama başarısız');
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
