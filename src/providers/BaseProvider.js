/**
 * Base POS Provider
 * Tüm POS provider'ların base class'ı
 */

import axios from 'axios';
import https from 'https';
import xml2js from 'xml2js';
import { getBankUrls } from '../constants/bankUrls.js';

export const CURRENCY_CODES = {
  try: 949,
  usd: 840,
  eur: 978,
  gbp: 826
};

export const CURRENCY_CODES_YKB = {
  try: 'TL',
  usd: 'US',
  eur: 'EU',
  gbp: 'PU'
};

export default class BaseProvider {
  constructor(transaction, virtualPos) {
    this.transaction = transaction;
    this.pos = virtualPos;
    this.credentials = virtualPos.getDecryptedCredentials();

    // Use VirtualPos URLs or fallback to default bank URLs
    const defaultUrls = getBankUrls(virtualPos.bankCode, virtualPos.testMode);
    this.urls = {
      api: virtualPos.urls?.api || defaultUrls?.api,
      gate: virtualPos.urls?.gate || defaultUrls?.gate
    };

    // XML builder/parser
    this.xmlBuilder = new xml2js.Builder({
      xmldec: { version: '1.0', encoding: 'UTF-8' }
    });
    this.xmlParser = new xml2js.Parser({
      explicitRoot: false,
      explicitArray: false
    });

    // HTTPS agent (skip SSL verify for some banks)
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  /**
   * Get callback URL for 3D Secure
   */
  getCallbackUrl() {
    const baseUrl = process.env.CALLBACK_BASE_URL || 'http://localhost:7043';
    return `${baseUrl}/payment/${this.transaction._id}/callback`;
  }

  /**
   * Get currency code
   */
  getCurrencyCode(format = 'numeric') {
    if (format === 'ykb') {
      return CURRENCY_CODES_YKB[this.transaction.currency] || 'TL';
    }
    return CURRENCY_CODES[this.transaction.currency] || 949;
  }

  /**
   * Format amount (150000 for 1500.00)
   */
  formatAmount(decimals = true) {
    if (decimals) {
      return this.transaction.amount.toFixed(2);
    }
    return Math.round(this.transaction.amount * 100).toString();
  }

  /**
   * Get card data (decrypted)
   */
  getCard() {
    return this.transaction.getDecryptedCard();
  }

  /**
   * POST request helper
   */
  async post(url, data, options = {}) {
    const config = {
      httpsAgent: this.httpsAgent,
      timeout: 30000,
      ...options
    };

    return axios.post(url, data, config);
  }

  /**
   * Parse XML response
   */
  async parseXml(xml) {
    return this.xmlParser.parseStringPromise(xml);
  }

  /**
   * Build XML
   */
  buildXml(obj) {
    return this.xmlBuilder.buildObject(obj);
  }

  /**
   * Sanitize object for MongoDB (remove $ prefixed keys from xml2js)
   */
  sanitizeForMongo(obj) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeForMongo(item));
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      // Replace $ with underscore for MongoDB compatibility
      const safeKey = key.startsWith('$') ? '_' + key.slice(1) : key;
      sanitized[safeKey] = this.sanitizeForMongo(value);
    }
    return sanitized;
  }

  /**
   * Add log to transaction
   */
  async log(type, request, response) {
    // Sanitize objects for MongoDB (xml2js creates $ prefixed keys)
    const safeRequest = this.sanitizeForMongo(request);
    const safeResponse = this.sanitizeForMongo(response);

    this.transaction.addLog(type, safeRequest, safeResponse);
    // Mark logs as modified (array in Mixed-like behavior)
    this.transaction.markModified('logs');
    await this.transaction.save();
  }

  /**
   * Save secure data (formData, etc.)
   * Must use markModified for Mixed type fields
   */
  async saveSecure() {
    this.transaction.markModified('secure');
    await this.transaction.save();
  }

  // ==========================================
  // Abstract methods - must be implemented
  // ==========================================

  /**
   * Initialize 3D Secure payment
   * @returns {Promise<{success: boolean, formData?: object, url?: string, error?: string}>}
   */
  async initialize() {
    throw new Error('initialize() must be implemented');
  }

  /**
   * Get 3D form HTML
   * @returns {Promise<string>} HTML form
   */
  async getFormHtml() {
    throw new Error('getFormHtml() must be implemented');
  }

  /**
   * Process 3D callback from bank
   * @param {object} postData - POST data from bank
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async processCallback(postData) {
    throw new Error('processCallback() must be implemented');
  }

  // ==========================================
  // Optional methods - override if supported
  // ==========================================

  /**
   * Direct payment (Non-3D Secure)
   * @returns {Promise<{success: boolean, message?: string, error?: string}>}
   */
  async directPayment() {
    throw new Error(`directPayment() is not supported by ${this.constructor.name}`);
  }

  /**
   * Refund a completed payment
   * @param {Transaction} originalTransaction - Original payment transaction
   * @returns {Promise<{success: boolean, message?: string, refNumber?: string}>}
   */
  async refund(originalTransaction) {
    throw new Error(`refund() is not supported by ${this.constructor.name}`);
  }

  /**
   * Cancel a payment (same day only - before batch close)
   * @param {Transaction} originalTransaction - Original payment transaction
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async cancel(originalTransaction) {
    throw new Error(`cancel() is not supported by ${this.constructor.name}`);
  }

  /**
   * Query payment status
   * @param {string} orderId - Bank order ID
   * @returns {Promise<{success: boolean, status?: string, message?: string}>}
   */
  async status(orderId) {
    throw new Error(`status() is not supported by ${this.constructor.name}`);
  }

  /**
   * Get order history
   * @param {string} orderId - Bank order ID
   * @returns {Promise<{success: boolean, history?: array}>}
   */
  async history(orderId) {
    throw new Error(`history() is not supported by ${this.constructor.name}`);
  }

  /**
   * Pre-authorization (block amount without capture)
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async preAuth() {
    throw new Error(`preAuth() is not supported by ${this.constructor.name}`);
  }

  /**
   * Post-authorization (capture pre-authorized amount)
   * @param {Transaction} preAuthTransaction - Pre-auth transaction
   * @returns {Promise<{success: boolean, message?: string}>}
   */
  async postAuth(preAuthTransaction) {
    throw new Error(`postAuth() is not supported by ${this.constructor.name}`);
  }

  // ==========================================
  // Capability check methods
  // ==========================================

  /**
   * Get provider capabilities
   * Override in subclass to declare supported operations
   */
  getCapabilities() {
    return {
      payment3D: true,        // 3D Secure payment
      paymentDirect: false,   // Non-3D payment
      refund: false,          // Refund operation
      cancel: false,          // Cancel operation
      status: false,          // Status query
      history: false,         // Order history
      preAuth: false,         // Pre-authorization
      postAuth: false         // Post-authorization
    };
  }

  /**
   * Check if operation is supported
   */
  supports(operation) {
    return this.getCapabilities()[operation] === true;
  }

  // ==========================================
  // Response normalization helpers
  // ==========================================

  /**
   * Normalize success response
   */
  successResponse(data = {}) {
    return {
      success: true,
      message: data.message || 'İşlem başarılı',
      authCode: data.authCode || null,
      refNumber: data.refNumber || null,
      provisionNumber: data.provisionNumber || null,
      transactionId: data.transactionId || null
    };
  }

  /**
   * Normalize error response
   */
  errorResponse(code, message, rawResponse = null) {
    return {
      success: false,
      code: code || 'ERROR',
      message: message || 'İşlem başarısız',
      rawResponse
    };
  }

  /**
   * Generate HTML form for auto-submit to bank
   */
  generateFormHtml(url, fields) {
    const inputs = Object.entries(fields)
      .map(([key, value]) => `<input type="hidden" name="${key}" value="${value || ''}">`)
      .join('\n');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>3D Secure Yönlendirme</title>
  <style>
    body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    .loading { text-align: center; }
    .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner"></div>
    <p>Banka sayfasına yönlendiriliyorsunuz...</p>
  </div>
  <form id="paymentForm" method="POST" action="${url}">
    ${inputs}
  </form>
  <script>document.getElementById('paymentForm').submit();</script>
</body>
</html>`;
  }
}
