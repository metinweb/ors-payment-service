/**
 * BIN Service
 * Kart BIN numarasından banka/kart bilgisi alma
 * Önce MongoDB'ye bakar, yoksa external API'lerden çeker
 */

import { Bin } from '../models/index.js';
import { fetchBinData } from './BinLookupService.js';

// Local BIN cache (in-memory) - short TTL for performance
const binCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get BIN info from MongoDB or external sources
 */
export async function getBinInfo(bin) {
  // Validate BIN (6-8 digits)
  const binStr = String(bin).replace(/\s/g, '');
  const bin8 = binStr.slice(0, 8);
  const bin6 = binStr.slice(0, 6);

  if (bin6.length < 6) {
    return null;
  }

  // Check in-memory cache first
  const cacheKey = bin8;
  const cached = binCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // 1. Check MongoDB - try 8 digit first, then 6 digit
  let binRecord = await Bin.findOne({ bin: bin8 });
  if (!binRecord && bin8.length > 6) {
    binRecord = await Bin.findOne({ bin: bin6 });
  }

  if (binRecord && binRecord.isActive) {
    const binInfo = normalizeBinRecord(binRecord);
    binCache.set(cacheKey, { data: binInfo, timestamp: Date.now() });
    return binInfo;
  }

  // 2. Not in DB or inactive - fetch from external sources
  console.log(`[BinService] BIN not in DB, fetching from external: ${bin6}`);

  try {
    const fetchedData = await fetchBinData(bin8);

    if (fetchedData) {
      // Save to MongoDB for future use
      const newBin = new Bin({
        bin: fetchedData.bin,
        brand: fetchedData.brand || detectBrandFromDigit(bin6),
        type: fetchedData.type || 'credit',
        family: fetchedData.family || '',
        bank: fetchedData.bank || 'Unknown',
        bankCode: fetchedData.bankCode || '',
        country: fetchedData.country || '',
        isActive: true,
        notes: `Auto-fetched from ${fetchedData.source}`
      });

      try {
        await newBin.save();
        console.log(`[BinService] Saved new BIN to DB: ${fetchedData.bin}`);
      } catch (saveError) {
        // Might be duplicate, try to find again
        if (saveError.code === 11000) {
          binRecord = await Bin.findOne({ bin: fetchedData.bin });
        }
      }

      const binInfo = {
        bank: fetchedData.bank || 'Unknown',
        brand: fetchedData.brand || detectBrandFromDigit(bin6),
        type: fetchedData.type || 'credit',
        family: fetchedData.family || '',
        country: fetchedData.country || 'tr'
      };

      binCache.set(cacheKey, { data: binInfo, timestamp: Date.now() });
      return binInfo;
    }
  } catch (error) {
    console.error('[BinService] External fetch error:', error.message);
  }

  // 3. Fallback: detect card brand from first digit
  const fallback = detectCardBrand(bin6);
  binCache.set(cacheKey, { data: fallback, timestamp: Date.now() });
  return fallback;
}

/**
 * Normalize MongoDB Bin record to standard format
 */
function normalizeBinRecord(record) {
  return {
    bank: record.bank || 'Unknown',
    brand: record.brand || 'unknown',
    type: record.type || 'credit',
    family: record.family || '',
    country: record.country || 'tr'
  };
}

/**
 * Normalize BIN info to standard format
 */
function normalizeBinInfo(data) {
  return {
    bank: data.bank?.name || data.bankName || 'Unknown',
    brand: data.card?.association || data.cardAssociation || detectBrand(data),
    type: normalizeCardType(data.card?.type || data.cardType),
    family: data.card?.family || data.cardFamily || '',
    country: data.bank?.country || data.country || 'tr'
  };
}

/**
 * Detect card brand from BIN string
 */
function detectBrandFromDigit(bin) {
  const firstDigit = String(bin).charAt(0);
  switch (firstDigit) {
    case '4': return 'visa';
    case '5': return 'mastercard';
    case '3': return 'amex';
    case '6': return 'discover';
    case '9': return 'troy';
    case '2': return 'mir';
    default: return 'other';
  }
}

/**
 * Detect card brand from BIN data object
 */
function detectBrand(data) {
  const bin = String(data.id || data.bin || '');
  return detectBrandFromDigit(bin);
}

/**
 * Normalize card type
 */
function normalizeCardType(type) {
  if (!type) return 'credit';
  const t = type.toLowerCase().replace(/[_\s]/g, '');
  if (t.includes('debit')) return 'debit';
  if (t.includes('prepaid')) return 'prepaid';
  return 'credit';
}

/**
 * Fallback detection
 */
function detectCardBrand(bin) {
  const firstDigit = String(bin).charAt(0);

  return {
    bank: 'Unknown',
    brand: detectBrand({ bin }),
    type: 'credit',
    family: '',
    country: firstDigit === '2' ? 'ru' : 'unknown'
  };
}

/**
 * Check if card is domestic (Turkish)
 */
export function isDomesticCard(binInfo) {
  return binInfo?.country === 'tr';
}

/**
 * Get card family for installment matching
 */
export function getCardFamily(binInfo) {
  return binInfo?.family || '';
}

export default {
  getBinInfo,
  isDomesticCard,
  getCardFamily
};
