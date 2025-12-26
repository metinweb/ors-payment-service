import mongoose from 'mongoose';
import { generateApiKey, generateApiSecret, hashSecret } from '../config/encryption.js';

const apiKeySchema = new mongoose.Schema({
  company: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  key: {
    type: String,
    required: true,
    unique: true
  },
  secretHash: {
    type: String,
    required: true
  },
  name: {
    type: String,
    default: 'Default Key'
  },
  status: {
    type: Boolean,
    default: true
  },
  permissions: [{
    type: String,
    enum: ['payment:create', 'payment:read', 'transaction:read']
  }],
  lastUsedAt: Date
}, {
  timestamps: true
});

// Indexes
apiKeySchema.index({ company: 1 });
apiKeySchema.index({ key: 1 });

// Static method to create new key pair
apiKeySchema.statics.createKeyPair = async function (companyId, name = 'Default Key') {
  const key = generateApiKey('pk');
  const secret = generateApiSecret();
  const secretHash = hashSecret(secret);

  const apiKey = await this.create({
    company: companyId,
    key,
    secretHash,
    name,
    permissions: ['payment:create', 'payment:read', 'transaction:read']
  });

  // Return with plain secret (only shown once!)
  return {
    _id: apiKey._id,
    key,
    secret,  // Plain text - only returned on creation!
    name: apiKey.name
  };
};

// Verify secret
apiKeySchema.methods.verifySecret = function (secret) {
  return hashSecret(secret) === this.secretHash;
};

// Update last used
apiKeySchema.methods.touch = async function () {
  this.lastUsedAt = new Date();
  await this.save();
};

export default mongoose.model('ApiKey', apiKeySchema);
