import mongoose from 'mongoose';

const companySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  status: {
    type: Boolean,
    default: true
  },
  settings: {
    defaultCurrency: {
      type: String,
      enum: ['try', 'eur', 'usd', 'gbp'],
      default: 'try'
    },
    callbackUrl: {
      type: String,
      default: null
    }
  }
}, {
  timestamps: true
});

// Index
companySchema.index({ code: 1 });
companySchema.index({ status: 1 });

export default mongoose.model('Company', companySchema);
