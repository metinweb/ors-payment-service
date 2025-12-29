import mongoose from 'mongoose';
import { encrypt, decrypt } from '../config/encryption.js';

// ============================================================================
// PAYMENT MODEL DEFINITIONS
// ============================================================================
export const PAYMENT_MODELS = {
  '3d': {
    code: '3d',
    name: '3D Secure',
    description: 'Kart bilgileri sizde, 3D doğrulama bankada'
  },
  '3d_pay': {
    code: '3d_pay',
    name: '3D Pay',
    description: 'Kart bilgileri ve 3D doğrulama bankada'
  },
  '3d_host': {
    code: '3d_host',
    name: '3D Host',
    description: 'Tüm işlem bankada yapılır'
  },
  'regular': {
    code: 'regular',
    name: 'Non-Secure',
    description: '3D olmadan direkt ödeme'
  }
};

// ============================================================================
// BANK DEFINITIONS
// ============================================================================
export const BANKS = {
  garanti: {
    code: 'garanti',
    name: 'Garanti BBVA',
    provider: 'garanti',
    color: '#00854a',
    logo: 'garanti',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  akbank: {
    code: 'akbank',
    name: 'Akbank',
    provider: 'akbank',
    color: '#e31e24',
    logo: 'akbank',
    supportedPaymentModels: ['3d', 'regular']
  },
  ykb: {
    code: 'ykb',
    name: 'Yapı Kredi',
    provider: 'ykb',
    color: '#004b93',
    logo: 'ykb',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  isbank: {
    code: 'isbank',
    name: 'İş Bankası',
    provider: 'payten',
    color: '#004990',
    logo: 'isbank',
    supportedPaymentModels: ['3d', '3d_pay', '3d_host', 'regular']
  },
  halkbank: {
    code: 'halkbank',
    name: 'Halkbank',
    provider: 'payten',
    color: '#00528e',
    logo: 'halkbank',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  ziraat: {
    code: 'ziraat',
    name: 'Ziraat Bankası',
    provider: 'payten',
    color: '#e30613',
    logo: 'ziraat',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  vakifbank: {
    code: 'vakifbank',
    name: 'VakıfBank',
    provider: 'vakifbank',
    color: '#fdc600',
    logo: 'vakifbank',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  teb: {
    code: 'teb',
    name: 'TEB',
    provider: 'payten',
    color: '#00529b',
    logo: 'teb',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  qnb: {
    code: 'qnb',
    name: 'QNB Finansbank',
    provider: 'qnb',
    color: '#5c068c',
    logo: 'qnb',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  denizbank: {
    code: 'denizbank',
    name: 'Denizbank',
    provider: 'denizbank',
    color: '#003b73',
    logo: 'denizbank',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  ingbank: {
    code: 'ingbank',
    name: 'ING Bank',
    provider: 'payten',
    color: '#ff6200',
    logo: 'ingbank',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  sekerbank: {
    code: 'sekerbank',
    name: 'Şekerbank',
    provider: 'payten',
    color: '#ed1c24',
    logo: 'sekerbank',
    supportedPaymentModels: ['3d', '3d_pay', 'regular']
  },
  kuveytturk: {
    code: 'kuveytturk',
    name: 'Kuveyt Türk',
    provider: 'kuveytturk',
    color: '#00a651',
    logo: 'kuveytturk',
    supportedPaymentModels: ['3d', 'regular']
  },
  // ============================================================================
  // AGGREGATORS (Entegratörler) - Ayrı bölümde gösterilecek
  // ============================================================================
  paytr: {
    code: 'paytr',
    name: 'PayTR',
    provider: 'paytr',
    color: '#2c3e50',
    logo: 'paytr',
    isAggregator: true,
    supportedPaymentModels: ['3d']  // PayTR sadece 3D
  },
  iyzico: {
    code: 'iyzico',
    name: 'iyzico',
    provider: 'iyzico',
    color: '#1e64ff',
    logo: 'iyzico',
    isAggregator: true,
    supportedPaymentModels: ['3d', 'regular']
  },
  sigmapay: {
    code: 'sigmapay',
    name: 'SigmaPay',
    provider: 'sigmapay',
    color: '#6366f1',
    logo: 'sigmapay',
    isAggregator: true,
    supportedPaymentModels: ['regular']  // Crypto = non-3D
  }
};

// Installment rate schema
const installmentRateSchema = new mongoose.Schema({
  count: { type: Number, required: true },       // 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  enabled: { type: Boolean, default: true },
  bankRate: { type: Number, default: 0 },        // Bankaya verilen komisyon %
  customerRate: { type: Number, default: 0 },    // Müşteriye yansıtılan oran %
  plusInstallment: { type: Number, default: 0 }  // Ekstra taksit (kampanya)
}, { _id: false });

// Commission rate schema for a specific installment count
const commissionRateItemSchema = new mongoose.Schema({
  count: { type: Number, required: true },       // Taksit sayısı: 1 (peşin), 2, 3, ... 12
  rate: { type: Number, default: 0 }             // Komisyon oranı %
}, { _id: false });

// Commission period schema - tarih bazlı komisyon dönemleri
const commissionPeriodSchema = new mongoose.Schema({
  startDate: { type: Date, required: true },     // Bu tarihten itibaren geçerli
  foreignCardRate: { type: Number, default: 0 }, // Yurtdışı kartlar için tek oran %
  foreignBankRate: { type: Number, default: 0 }, // Yabancı bankalar için tek oran %
  rates: [commissionRateItemSchema]              // Taksit bazlı oranlar (peşin + 2-12 taksit)
}, { _id: true, timestamps: true });

// Installment campaign schema
const installmentCampaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  cardFamily: { type: String },                  // bonus, world, axess, maximum, cardfinans, paraf
  binPrefix: [{ type: String }],                 // BIN prefix listesi (ör: ['453281', '540667'])
  startDate: { type: Date },
  endDate: { type: Date },
  plusInstallment: { type: Number, default: 0 }, // +3 taksit gibi
  discountRate: { type: Number, default: 0 },    // % indirim
  enabled: { type: Boolean, default: true }
}, { _id: true, timestamps: true });

const virtualPosSchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  // Banka kodu (garanti, akbank, ykb, isbank, halkbank, ziraat vs.)
  bankCode: {
    type: String,
    required: true,
    enum: Object.keys(BANKS)
  },
  // Provider otomatik bank'tan alınır ama override edilebilir
  provider: {
    type: String,
    required: true,
    enum: ['garanti', 'akbank', 'ykb', 'vakifbank', 'payten', 'qnb', 'denizbank', 'kuveytturk', 'paytr', 'iyzico', 'sigmapay']
  },
  status: {
    type: Boolean,
    default: true
  },
  testMode: {
    type: Boolean,
    default: false
  },
  currencies: {
    type: [String],
    required: true,
    enum: ['try', 'eur', 'usd', 'gbp'],
    validate: {
      validator: function(v) {
        return v && v.length > 0;
      },
      message: 'En az bir para birimi seçilmeli'
    }
  },
  // Bu POS hangi para birimleri için default
  defaultForCurrencies: {
    type: [String],
    enum: ['try', 'eur', 'usd', 'gbp'],
    default: []
  },
  priority: {
    type: Number,
    default: 0  // Yüksek = öncelikli
  },
  // Ortak credentials (şifreli saklanır)
  credentials: {
    merchantId: String,      // mid
    terminalId: String,      // tid
    username: String,
    password: String,        // şifreli
    secretKey: String,       // şifreli (storeKey, encKey vs.)
    posnetId: String,        // YKB için
    extra: String            // Diğer provider-specific alanlar (JSON string, şifreli)
  },
  // 3D Secure modeli (her zaman aktif, sadece model seçilir)
  paymentModel: {
    type: String,
    enum: ['3d', '3d_pay', '3d_host'],
    default: '3d'
  },
  // 3D'siz ödeme izni (ödeme linki vb. durumlar için)
  allowDirectPayment: {
    type: Boolean,
    default: false
  },
  // 3D Secure ayarları
  threeDSecure: {
    enabled: { type: Boolean, default: true },
    required: { type: Boolean, default: false },  // Zorunlu mu?
    successUrl: String,
    failUrl: String,
    storeKey: String  // 3D için ayrı key (şifreli)
  },
  // Taksit ayarları
  installment: {
    enabled: {
      type: Boolean,
      default: true
    },
    minCount: {
      type: Number,
      default: 2
    },
    maxCount: {
      type: Number,
      default: 12
    },
    minAmount: {
      type: Number,
      default: 100
    },
    // Her taksit için ayrı komisyon oranları
    rates: [installmentRateSchema],
    // Taksit kampanyaları
    campaigns: [installmentCampaignSchema]
  },
  // Banka komisyon oranları (tarih bazlı dönemler)
  commissionRates: [commissionPeriodSchema],
  urls: {
    api: String,
    gate: String,
    test: String,       // Test ortam URL
    production: String  // Production URL
  },
  // İşlem limitleri
  limits: {
    minAmount: { type: Number, default: 1 },
    maxAmount: { type: Number, default: 100000 },
    dailyLimit: { type: Number, default: 500000 },
    monthlyLimit: { type: Number, default: 5000000 }
  },
  // Desteklenen kartlar
  supportedCards: {
    visa: { type: Boolean, default: true },
    mastercard: { type: Boolean, default: true },
    amex: { type: Boolean, default: false },
    troy: { type: Boolean, default: true }
  },
  // Desteklenen kart aileleri (avantajlı oranlar için)
  // Bu POS hangi kart aileleri için avantajlı oran sunuyor
  supportedCardFamilies: {
    type: [String],
    enum: ['world', 'bonus', 'maximum', 'axess', 'cardfinans', 'paraf', 'miles', 'bankkart', 'advantage', 'combo', 'shop&miles'],
    default: []
  }
}, {
  timestamps: true
});

// Indexes
virtualPosSchema.index({ provider: 1 });
// Unique constraint: Aynı firma için aynı banka tekrar eklenemez
virtualPosSchema.index({ company: 1, bankCode: 1 }, { unique: true });

// Encrypt sensitive fields before save
virtualPosSchema.pre('save', function (next) {
  if (this.isModified('credentials.password') && this.credentials.password) {
    // Don't re-encrypt if already encrypted (contains ':')
    if (!this.credentials.password.includes(':')) {
      this.credentials.password = encrypt(this.credentials.password);
    }
  }
  if (this.isModified('credentials.secretKey') && this.credentials.secretKey) {
    if (!this.credentials.secretKey.includes(':')) {
      this.credentials.secretKey = encrypt(this.credentials.secretKey);
    }
  }
  if (this.isModified('credentials.extra') && this.credentials.extra) {
    if (!this.credentials.extra.includes(':')) {
      this.credentials.extra = encrypt(this.credentials.extra);
    }
  }
  next();
});

// Method to get decrypted credentials
virtualPosSchema.methods.getDecryptedCredentials = function () {
  return {
    merchantId: this.credentials.merchantId,
    terminalId: this.credentials.terminalId,
    username: this.credentials.username,
    password: decrypt(this.credentials.password),
    secretKey: decrypt(this.credentials.secretKey),
    posnetId: this.credentials.posnetId,
    extra: this.credentials.extra ? JSON.parse(decrypt(this.credentials.extra) || '{}') : {}
  };
};

// Don't return encrypted fields in JSON
virtualPosSchema.methods.toJSON = function () {
  const obj = this.toObject();
  if (obj.credentials) {
    obj.credentials = {
      merchantId: obj.credentials.merchantId,
      terminalId: obj.credentials.terminalId,
      username: obj.credentials.username,
      posnetId: obj.credentials.posnetId,
      // Hide sensitive
      password: obj.credentials.password ? '••••••••' : null,
      secretKey: obj.credentials.secretKey ? '••••••••' : null,
      extra: obj.credentials.extra ? '••••••••' : null
    };
  }
  return obj;
};

export default mongoose.model('VirtualPos', virtualPosSchema);
