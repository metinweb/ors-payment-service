import mongoose from 'mongoose';
import { encrypt, decrypt, maskCardNumber } from '../config/encryption.js';

const logEntrySchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['init', '3d_form', '3d_callback', 'provision', 'refund', 'cancel', 'status', 'pre_auth', 'post_auth', 'error']
  },
  request: mongoose.Schema.Types.Mixed,
  response: mongoose.Schema.Types.Mixed,
  at: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const transactionSchema = new mongoose.Schema({
  pos: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VirtualPos',
    required: true
  },
  // İşlem tipi
  type: {
    type: String,
    enum: ['payment', 'pre_auth', 'post_auth', 'refund', 'cancel'],
    default: 'payment'
  },
  // Ödeme modeli
  paymentModel: {
    type: String,
    enum: ['regular', '3d', '3d_pay', '3d_host'],
    default: '3d'
  },
  // Bağlı işlem (refund/cancel/post_auth için)
  parentTransaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },
  // Banka tarafı sipariş numarası
  orderId: String,
  // Ödeme bilgisi
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    required: true,
    enum: ['try', 'eur', 'usd', 'gbp']
  },
  installment: {
    type: Number,
    default: 1
  },
  // Kart bilgisi (şifreli)
  card: {
    holder: String,          // şifreli
    number: String,          // şifreli
    expiry: String,          // şifreli "MM/YY"
    cvv: String,             // şifreli, işlem sonrası null
    masked: String,          // "5401 34** **** 7890"
    bin: Number              // 54013412
  },
  // BIN bilgisi (bank, brand, type, family, country)
  bin: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Müşteri
  customer: {
    name: String,
    email: String,
    phone: String,
    ip: String
  },
  // Durum
  status: {
    type: String,
    enum: ['pending', 'processing', 'success', 'failed', 'cancelled', 'refunded'],
    default: 'pending'
  },
  // 3D Secure - Mixed type to allow provider-specific data (formData, confirm3D, etc.)
  secure: {
    type: mongoose.Schema.Types.Mixed,
    default: { enabled: true }
  },
  // Sonuç
  result: {
    success: Boolean,
    code: String,
    message: String,
    authCode: String,           // Onay kodu
    refNumber: String,          // Referans numarası
    provisionNumber: String,    // Provizyon numarası
    hostRefNumber: String,      // Host referans numarası
    transactionId: String,      // Banka işlem ID
    rawResponse: mongoose.Schema.Types.Mixed  // Ham banka cevabı
  },
  // Loglar (array)
  logs: [logEntrySchema],
  // Harici referans
  externalId: String,
  // Rezervasyon kodu (ORS için)
  bookingCode: String,
  // Tamamlanma zamanı
  completedAt: Date,
  // İade zamanı
  refundedAt: Date,
  // İptal zamanı
  cancelledAt: Date
}, {
  timestamps: true
});

// Indexes
transactionSchema.index({ pos: 1, createdAt: -1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ externalId: 1 });
transactionSchema.index({ orderId: 1 });
transactionSchema.index({ parentTransaction: 1 });
transactionSchema.index({ 'card.bin': 1 });
transactionSchema.index({ createdAt: -1 });

// Encrypt card data before save
transactionSchema.pre('save', function (next) {
  if (this.isModified('card.holder') && this.card.holder && !this.card.holder.includes(':')) {
    this.card.holder = encrypt(this.card.holder);
  }
  if (this.isModified('card.number') && this.card.number && !this.card.number.includes(':')) {
    // First, create masked version
    if (!this.card.masked) {
      this.card.masked = maskCardNumber(this.card.number);
    }
    // Extract BIN
    if (!this.card.bin) {
      this.card.bin = parseInt(this.card.number.replace(/\s/g, '').slice(0, 8), 10);
    }
    this.card.number = encrypt(this.card.number);
  }
  if (this.isModified('card.expiry') && this.card.expiry && !this.card.expiry.includes(':')) {
    this.card.expiry = encrypt(this.card.expiry);
  }
  if (this.isModified('card.cvv') && this.card.cvv && !this.card.cvv.includes(':')) {
    this.card.cvv = encrypt(this.card.cvv);
  }
  next();
});

// Get decrypted card
transactionSchema.methods.getDecryptedCard = function () {
  return {
    holder: decrypt(this.card.holder),
    number: decrypt(this.card.number),
    expiry: decrypt(this.card.expiry),
    cvv: decrypt(this.card.cvv),
    masked: this.card.masked,
    bin: this.card.bin
  };
};

// Clear CVV after transaction
transactionSchema.methods.clearCvv = async function () {
  this.card.cvv = null;
  await this.save();
};

// Add log entry
transactionSchema.methods.addLog = function (type, request, response) {
  this.logs.push({ type, request, response, at: new Date() });
};

// İade edilebilir mi kontrol et
transactionSchema.methods.canRefund = function () {
  return this.type === 'payment' &&
         this.status === 'success' &&
         !this.refundedAt;
};

// İptal edilebilir mi kontrol et (gün sonu öncesi)
transactionSchema.methods.canCancel = function () {
  if (this.type !== 'payment' || this.status !== 'success') return false;

  // Gün sonu kontrolü - işlem bugün mü yapılmış?
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const txDate = new Date(this.createdAt);
  txDate.setHours(0, 0, 0, 0);

  return txDate.getTime() === today.getTime();
};

// Post-auth yapılabilir mi (pre-auth için)
transactionSchema.methods.canPostAuth = function () {
  return this.type === 'pre_auth' && this.status === 'success';
};

// Safe JSON (hide encrypted card)
transactionSchema.methods.toJSON = function () {
  const obj = this.toObject();
  if (obj.card) {
    obj.card = {
      masked: obj.card.masked,
      bin: obj.card.bin
      // Don't expose encrypted fields
    };
  }
  return obj;
};

export default mongoose.model('Transaction', transactionSchema);
