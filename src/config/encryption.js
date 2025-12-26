import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    // Development mode: generate a key from a seed
    return crypto.scryptSync('dev-secret-key', 'salt', 32);
  }
  return Buffer.from(key.slice(0, 32));
}

export function encrypt(text) {
  if (!text) return null;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Format: iv:tag:encrypted
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

export function decrypt(encryptedText) {
  if (!encryptedText) return null;

  try {
    const [ivHex, tagHex, encrypted] = encryptedText.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    return null;
  }
}

// Mask card number: 5401341234567890 → 5401 34** **** 7890
export function maskCardNumber(cardNumber) {
  if (!cardNumber || cardNumber.length < 16) return cardNumber;
  const clean = cardNumber.replace(/\s/g, '');
  return `${clean.slice(0, 6)}******${clean.slice(-4)}`;
}

// Hash for API secrets
export function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

// Generate API key
export function generateApiKey(prefix = 'pk') {
  const random = crypto.randomBytes(24).toString('base64url');
  return `${prefix}_${random}`;
}

// Generate API secret
export function generateApiSecret() {
  return crypto.randomBytes(32).toString('base64url');
}
