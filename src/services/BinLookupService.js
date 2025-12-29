/**
 * BIN Lookup Service
 * Harici kaynaklardan BIN bilgisi çekme
 */

import axios from 'axios';
import crypto from 'crypto';
import { URLSearchParams } from 'url';

/**
 * Türk banka kodları mapping
 * Sayısal kodlar ve banka isimleri → bizim bankCode'larımız
 */
const BANK_CODE_MAP = {
  // Sayısal kodlar (PayTR, iyzico vs.)
  '46': 'akbank',
  '62': 'garanti',
  '67': 'ykb',
  '64': 'isbank',
  '12': 'halkbank',
  '10': 'ziraat',
  '15': 'vakifbank',
  '32': 'teb',
  '111': 'qnb',
  '134': 'denizbank',
  '99': 'ingbank',
  '59': 'sekerbank',
  '205': 'kuveytturk',
  // Banka isimleri (case-insensitive match için)
  'akbank': 'akbank',
  'garanti': 'garanti',
  'garanti bankası': 'garanti',
  'garanti bbva': 'garanti',
  'yapı kredi': 'ykb',
  'yapı kredi bankası': 'ykb',
  'yapi kredi': 'ykb',
  'ykb': 'ykb',
  'iş bankası': 'isbank',
  'is bankasi': 'isbank',
  'türkiye iş bankası': 'isbank',
  'isbank': 'isbank',
  'halkbank': 'halkbank',
  'halk bankası': 'halkbank',
  'ziraat': 'ziraat',
  'ziraat bankası': 'ziraat',
  'vakıfbank': 'vakifbank',
  'vakifbank': 'vakifbank',
  'teb': 'teb',
  'türk ekonomi bankası': 'teb',
  'qnb': 'qnb',
  'qnb finansbank': 'qnb',
  'finansbank': 'qnb',
  'denizbank': 'denizbank',
  'ing': 'ingbank',
  'ing bank': 'ingbank',
  'şekerbank': 'sekerbank',
  'sekerbank': 'sekerbank',
  'kuveyt türk': 'kuveytturk',
  'kuveytturk': 'kuveytturk'
};

/**
 * Banka kodunu veya ismini bizim bankCode formatına çevir
 */
function normalizeBankCode(code, bankName) {
  // Önce sayısal kodu dene
  if (code) {
    const codeStr = String(code).toLowerCase();
    if (BANK_CODE_MAP[codeStr]) {
      return BANK_CODE_MAP[codeStr];
    }
  }

  // Banka isminden çıkar
  if (bankName) {
    const nameLower = bankName.toLowerCase().trim();
    if (BANK_CODE_MAP[nameLower]) {
      return BANK_CODE_MAP[nameLower];
    }
    // Kısmi eşleşme dene
    for (const [key, value] of Object.entries(BANK_CODE_MAP)) {
      if (nameLower.includes(key) || key.includes(nameLower)) {
        return value;
      }
    }
  }

  return '';
}

/**
 * PayTR API'den BIN bilgisi al
 */
async function getPaytr(binNo) {
  const bin_number = String(binNo).slice(0, 8);
  const merchant_id = process.env.PAYTR_MERCHANT_ID || '184959';
  const merchant_key = process.env.PAYTR_MERCHANT_KEY || 'CGPD1U13EQJ8tTbM';
  const merchantSalt = process.env.PAYTR_MERCHANT_SALT || 'hry4NYSpxw4nFsUx';

  const paytr_token = crypto
    .createHmac('sha256', merchant_key)
    .update(bin_number + merchant_id + merchantSalt)
    .digest('base64');

  const data = new URLSearchParams({
    merchant_id,
    bin_number,
    paytr_token
  });

  try {
    const { data: response } = await axios.post('https://www.paytr.com/odeme/api/bin-detail', data, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 5000
    });

    console.log('[BinLookup] PayTR response:', response);

    if (response.status === 'success') {
      return {
        bin: bin_number,
        brand: response.schema?.toLowerCase() || 'unknown',
        type: response.cardType === 'credit' ? 'credit' : response.cardType === 'debit' ? 'debit' : 'prepaid',
        family: response.brand?.toLowerCase() || '',
        bank: response.bank || '',
        bankCode: normalizeBankCode(response.bankCode, response.bank),
        country: 'TR',
        source: 'paytr'
      };
    }
    return null;
  } catch (error) {
    console.error('[BinLookup] PayTR error:', error.message);
    return null;
  }
}

/**
 * iyzico API'den BIN bilgisi al
 */
async function getIyzico(binNo) {
  const bin_number = String(binNo).slice(0, 6);
  const apiKey = process.env.IYZICO_API_KEY || 'sandbox-afXhZPW0MQlE4dCUUlHcEopnMBgXnAZI';
  const secretKey = process.env.IYZICO_SECRET_KEY || 'sandbox-wbwpzKIiplZxI3hh5ALI4FJyAcZKL6kq';
  const baseUrl = process.env.IYZICO_BASE_URL || 'https://sandbox-api.iyzipay.com';

  const randomString = process.hrtime()[0] + Math.random().toString(8).slice(2);
  const hashStr = apiKey + randomString + secretKey + '[locale=tr,conversationId=123456789,binNumber=' + bin_number + ']';
  const hash = crypto.createHash('sha1').update(hashStr, 'utf8').digest('base64');

  const headers = {
    'Authorization': 'IYZWS ' + apiKey + ':' + hash,
    'x-iyzi-rnd': randomString,
    'x-iyzi-client-version': 'iyzipay-node-2.0.48',
    'Content-Type': 'application/json'
  };

  const postData = { locale: 'tr', conversationId: '123456789', binNumber: bin_number };

  try {
    const { data: result } = await axios.post(`${baseUrl}/payment/bin/check`, postData, {
      headers,
      timeout: 5000
    });

    console.log('[BinLookup] iyzico response:', result);

    if (result.status === 'success') {
      // Normalize card association
      let brand = (result.cardAssociation || '').toLowerCase().replace('_', '');
      if (brand === 'american_express' || brand === 'americanexpress') brand = 'amex';

      // Normalize card family
      let family = (result.cardFamily || '').toLowerCase()
        .replace(/ /g, '_')
        .replace(/&/g, '_')
        .replace(/ç/g, 'c')
        .replace(/ğ/g, 'g')
        .replace(/ı/g, 'i')
        .replace(/ö/g, 'o')
        .replace(/ş/g, 's')
        .replace(/ü/g, 'u');

      // Normalize card type
      let type = (result.cardType || '').toLowerCase().replace('_', '');
      if (type === 'creditcard' || type === 'credit_card') type = 'credit';
      if (type === 'debitcard' || type === 'debit_card') type = 'debit';
      if (type === 'prepaidcard' || type === 'prepaid_card') type = 'prepaid';

      return {
        bin: bin_number,
        brand,
        type,
        family,
        bank: result.bankName || '',
        bankCode: normalizeBankCode(result.bankCode, result.bankName),
        country: 'TR',
        source: 'iyzico'
      };
    }
    return null;
  } catch (error) {
    console.error('[BinLookup] iyzico error:', error.message);
    return null;
  }
}

/**
 * BinCheck (RapidAPI) API'den BIN bilgisi al
 */
async function getBinCheck(binNo) {
  const bin_number = String(binNo).slice(0, 6);
  const apiKey = process.env.RAPIDAPI_KEY || '1b65e6c5e9msh256f2c43c21ccf3p17b3b2jsnb9bb40c53806';

  try {
    const { data: response } = await axios.post(
      `https://bin-ip-checker.p.rapidapi.com/?bin=${bin_number}`,
      null,
      {
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'bin-ip-checker.p.rapidapi.com'
        },
        timeout: 5000
      }
    );

    console.log('[BinLookup] BinCheck response:', response);

    if (response.success && response.BIN?.valid) {
      const bin = response.BIN;
      const bankName = bin.issuer?.name || '';
      return {
        bin: bin_number,
        brand: (bin.scheme || '').toLowerCase(),
        type: bin.type ? bin.type.toLowerCase() : 'credit',
        family: '',
        bank: bankName,
        bankCode: normalizeBankCode(null, bankName),
        country: bin.country?.alpha2 || '',
        source: 'bincheck'
      };
    }
    return null;
  } catch (error) {
    console.error('[BinLookup] BinCheck error:', error.message);
    return null;
  }
}

/**
 * binlist.net API'den BIN bilgisi al (ücretsiz, rate limited)
 */
async function getBinList(binNo) {
  const bin_number = String(binNo).slice(0, 6);

  try {
    const { data: result } = await axios.get(`https://lookup.binlist.net/${bin_number}`, {
      timeout: 5000,
      headers: {
        'Accept-Version': '3'
      }
    });

    console.log('[BinLookup] BinList response:', result);

    const bankName = result.bank?.name || '';
    return {
      bin: bin_number,
      brand: (result.scheme || '').toLowerCase(),
      type: (result.type || 'credit').toLowerCase(),
      family: '',
      bank: bankName,
      bankCode: normalizeBankCode(null, bankName),
      country: result.country?.alpha2 || '',
      source: 'binlist'
    };
  } catch (error) {
    console.error('[BinLookup] BinList error:', error.message);
    return null;
  }
}

/**
 * Tüm kaynaklardan BIN bilgisi çekmeyi dene
 * Sırasıyla: PayTR -> iyzico -> BinCheck -> BinList
 */
export async function fetchBinData(binNo) {
  const sources = [getPaytr, getIyzico, getBinCheck, getBinList];

  for (const source of sources) {
    try {
      const data = await source(binNo);
      if (data) {
        console.log(`[BinLookup] Found BIN data from ${data.source}`);
        return data;
      }
    } catch (error) {
      console.error('[BinLookup] Source error:', error.message);
    }
  }

  console.log('[BinLookup] No data found for BIN:', binNo);
  return null;
}

export default {
  fetchBinData,
  getPaytr,
  getIyzico,
  getBinCheck,
  getBinList
};
