/**
 * Base POS Provider
 * Tüm POS provider'ların base class'ı
 */

import axios from 'axios';
import https from 'https';
import xml2js from 'xml2js';

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
    this.urls = virtualPos.urls;

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
   * Add log to transaction
   */
  async log(type, request, response) {
    this.transaction.addLog(type, request, response);
    await this.transaction.save();
  }

  // ==========================================
  // Abstract methods - must be implemented
  // ==========================================

  /**
   * Initialize 3D Secure
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
