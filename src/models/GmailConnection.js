import mongoose from 'mongoose';
import crypto from 'crypto';

const RAW_KEY = process.env.CALENDAR_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY;
if (!RAW_KEY) {
  throw new Error('CALENDAR_ENCRYPTION_KEY (ou SMTP_ENCRYPTION_KEY) doit être défini dans les variables d\'environnement');
}
const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(RAW_KEY).digest();

function encrypt(text) {
  if (!text) return text;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `encrypted:${iv.toString('hex')}:${encrypted}`;
}

function decrypt(text) {
  if (!text || !text.startsWith('encrypted:')) return text;
  const parts = text.split(':');
  const iv = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

const gmailConnectionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  accessToken: {
    type: String,
    default: null
  },
  refreshToken: {
    type: String,
    default: null
  },
  tokenExpiresAt: {
    type: Date,
    default: null
  },
  accountEmail: {
    type: String,
    required: true
  },
  accountName: {
    type: String,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  scanPeriodMonths: {
    type: Number,
    default: 3,
    min: 1,
    max: 12
  },
  status: {
    type: String,
    enum: ['active', 'syncing', 'expired', 'error', 'disconnected'],
    default: 'active'
  },
  lastSyncAt: {
    type: Date,
    default: null
  },
  lastSyncError: {
    type: String,
    default: null
  },
  totalEmailsScanned: {
    type: Number,
    default: 0
  },
  totalInvoicesFound: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Encrypt sensitive fields before saving
gmailConnectionSchema.pre('save', function(next) {
  if (this.isModified('accessToken') && this.accessToken && !this.accessToken.startsWith('encrypted:')) {
    this.accessToken = encrypt(this.accessToken);
  }
  if (this.isModified('refreshToken') && this.refreshToken && !this.refreshToken.startsWith('encrypted:')) {
    this.refreshToken = encrypt(this.refreshToken);
  }
  next();
});

// Decryption methods
gmailConnectionSchema.methods.getDecryptedAccessToken = function() {
  return decrypt(this.accessToken);
};

gmailConnectionSchema.methods.getDecryptedRefreshToken = function() {
  return decrypt(this.refreshToken);
};

// Update tokens helper
gmailConnectionSchema.methods.updateTokens = async function(accessToken, refreshToken, expiresAt) {
  this.accessToken = accessToken;
  if (refreshToken) {
    this.refreshToken = refreshToken;
  }
  if (expiresAt) {
    this.tokenExpiresAt = expiresAt;
  }
  this.status = 'active';
  this.lastSyncError = null;
  return this.save();
};

// Check if tokens are expired
gmailConnectionSchema.methods.isTokenExpired = function() {
  if (!this.tokenExpiresAt) return false;
  return new Date() >= new Date(this.tokenExpiresAt.getTime() - 5 * 60 * 1000);
};

// Indexes
gmailConnectionSchema.index({ userId: 1, workspaceId: 1 });
gmailConnectionSchema.index({ status: 1, lastSyncAt: 1 });

const GmailConnection = mongoose.model('GmailConnection', gmailConnectionSchema);

export default GmailConnection;
