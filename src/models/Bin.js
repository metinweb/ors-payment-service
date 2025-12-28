import mongoose from 'mongoose';

/**
 * BIN (Bank Identification Number) Model
 * Kartın ilk 6-8 hanesi ile banka/kart bilgisi eşleştirme
 */

const binSchema = new mongoose.Schema({
  bin: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 6,
    maxlength: 8
  },
  brand: {
    type: String,
    required: true,
    enum: ['visa', 'mastercard', 'amex', 'troy', 'discover', 'mir', 'unionpay', 'other'],
    lowercase: true
  },
  type: {
    type: String,
    required: true,
    enum: ['credit', 'debit', 'prepaid'],
    default: 'credit'
  },
  family: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
    // bonus, world, axess, maximum, cardfinans, paraf, miles&smiles, etc.
  },
  bank: {
    type: String,
    required: true,
    trim: true
  },
  bankCode: {
    type: String,
    trim: true,
    lowercase: true,
    default: ''
    // garanti, akbank, ykb, isbank, halkbank, ziraat, vakifbank, etc.
  },
  country: {
    type: String,
    default: 'TR',
    uppercase: true,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  notes: {
    type: String,
    trim: true,
    default: ''
  }
}, {
  timestamps: true
});

// Indexes for fast search
binSchema.index({ bin: 1 });
binSchema.index({ brand: 1 });
binSchema.index({ bank: 1 });
binSchema.index({ bankCode: 1 });
binSchema.index({ family: 1 });
binSchema.index({ country: 1 });
binSchema.index({ isActive: 1 });

// Text index for search
binSchema.index({ bin: 'text', bank: 'text', family: 'text' });

export default mongoose.model('Bin', binSchema);
