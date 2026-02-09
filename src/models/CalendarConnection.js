import mongoose from 'mongoose';
import crypto from 'crypto';

const RAW_KEY = process.env.CALENDAR_ENCRYPTION_KEY || process.env.SMTP_ENCRYPTION_KEY;
if (!RAW_KEY) {
  throw new Error('CALENDAR_ENCRYPTION_KEY (ou SMTP_ENCRYPTION_KEY) doit être défini dans les variables d\'environnement');
}
const ALGORITHM = 'aes-256-cbc';
// Toujours dériver une clé de 32 octets via SHA-256
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

const calendarConnectionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  provider: {
    type: String,
    enum: ['google', 'microsoft', 'apple'],
    required: true
  },
  // OAuth tokens (encrypted)
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
  // Apple CalDAV credentials (encrypted)
  calDavUsername: {
    type: String,
    default: null
  },
  calDavPassword: {
    type: String,
    default: null
  },
  calDavUrl: {
    type: String,
    default: null
  },
  // Selected calendars to sync
  selectedCalendars: [{
    calendarId: String,
    name: String,
    color: String,
    enabled: {
      type: Boolean,
      default: true
    }
  }],
  // Sync state
  status: {
    type: String,
    enum: ['active', 'expired', 'error', 'disconnected'],
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
  syncToken: {
    type: String,
    default: null
  },
  // Auto-sync: push new Newbi events to this connection automatically
  autoSync: {
    type: Boolean,
    default: false
  },
  // Account info (display)
  accountEmail: {
    type: String,
    default: null
  },
  accountName: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Encrypt sensitive fields before saving
calendarConnectionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();

  if (this.isModified('accessToken') && this.accessToken && !this.accessToken.startsWith('encrypted:')) {
    this.accessToken = encrypt(this.accessToken);
  }
  if (this.isModified('refreshToken') && this.refreshToken && !this.refreshToken.startsWith('encrypted:')) {
    this.refreshToken = encrypt(this.refreshToken);
  }
  if (this.isModified('calDavPassword') && this.calDavPassword && !this.calDavPassword.startsWith('encrypted:')) {
    this.calDavPassword = encrypt(this.calDavPassword);
  }

  next();
});

// Decryption methods
calendarConnectionSchema.methods.getDecryptedAccessToken = function() {
  return decrypt(this.accessToken);
};

calendarConnectionSchema.methods.getDecryptedRefreshToken = function() {
  return decrypt(this.refreshToken);
};

calendarConnectionSchema.methods.getDecryptedCalDavPassword = function() {
  return decrypt(this.calDavPassword);
};

// Update tokens helper
calendarConnectionSchema.methods.updateTokens = async function(accessToken, refreshToken, expiresAt) {
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
calendarConnectionSchema.methods.isTokenExpired = function() {
  if (!this.tokenExpiresAt) return false;
  // Consider expired 5 minutes before actual expiry
  return new Date() >= new Date(this.tokenExpiresAt.getTime() - 5 * 60 * 1000);
};

// Indexes
calendarConnectionSchema.index({ userId: 1, provider: 1 });
calendarConnectionSchema.index({ status: 1, lastSyncAt: 1 });

const CalendarConnection = mongoose.model('CalendarConnection', calendarConnectionSchema);

export default CalendarConnection;
