/**
 * BIN Service
 * Kart BIN numarasından banka/kart bilgisi alma
 */

import axios from 'axios';

const BIN_API_URL = process.env.BIN_API_URL || 'https://api.orsmod.com/bin';

// Local BIN cache (in-memory)
const binCache = new Map();

/**
 * Get BIN info from API or cache
 */
export async function getBinInfo(bin) {
  // Validate BIN (8 digits)
  const binNumber = parseInt(String(bin).replace(/\s/g, '').slice(0, 8), 10);

  if (isNaN(binNumber) || String(binNumber).length < 6) {
    return null;
  }

  // Check cache
  if (binCache.has(binNumber)) {
    return binCache.get(binNumber);
  }

  try {
    const response = await axios.get(`${BIN_API_URL}/${binNumber}`, {
      timeout: 5000
    });

    if (response.data) {
      const binInfo = normalizeBinInfo(response.data);
      binCache.set(binNumber, binInfo);
      return binInfo;
    }
  } catch (error) {
    console.error('BIN API error:', error.message);
  }

  // Fallback: detect card brand from first digit
  return detectCardBrand(binNumber);
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
 * Detect card brand from BIN
 */
function detectBrand(data) {
  const bin = String(data.id || data.bin || '');
  const firstDigit = bin.charAt(0);

  if (firstDigit === '4') return 'visa';
  if (firstDigit === '5') return 'mastercard';
  if (firstDigit === '3') return 'amex';
  if (firstDigit === '6') return 'discover';
  if (firstDigit === '2') return 'mir'; // Russian MIR cards

  return 'unknown';
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
