import mongoose from 'mongoose';
import crypto from 'crypto';

const smtpSettingsSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
  },
  enabled: {
    type: Boolean,
    default: false,
  },
  smtpHost: {
    type: String,
    required: true,
  },
  smtpPort: {
    type: Number,
    required: true,
    default: 587,
  },
  smtpSecure: {
    type: Boolean,
    default: false, // true pour port 465, false pour 587
  },
  smtpUser: {
    type: String,
    required: true,
  },
  smtpPassword: {
    type: String,
    required: true,
  },
  fromEmail: {
    type: String,
    required: true,
  },
  fromName: {
    type: String,
    default: '',
  },
  // Pour tester la connexion
  lastTestedAt: {
    type: Date,
    default: null,
  },
  lastTestStatus: {
    type: String,
    enum: ['SUCCESS', 'FAILED', 'PENDING'],
    default: 'PENDING',
  },
  lastTestError: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Encryption key (devrait être dans .env en production)
const ENCRYPTION_KEY = process.env.SMTP_ENCRYPTION_KEY || 'your-32-character-secret-key!!';
const ALGORITHM = 'aes-256-cbc';

// Chiffrer le mot de passe avant de sauvegarder
smtpSettingsSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  
  // Chiffrer le mot de passe s'il a été modifié
  if (this.isModified('smtpPassword') && !this.smtpPassword.startsWith('encrypted:')) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.slice(0, 32)), iv);
    let encrypted = cipher.update(this.smtpPassword, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    this.smtpPassword = `encrypted:${iv.toString('hex')}:${encrypted}`;
  }
  
  next();
});

// Méthode pour déchiffrer le mot de passe
smtpSettingsSchema.methods.getDecryptedPassword = function() {
  if (!this.smtpPassword.startsWith('encrypted:')) {
    return this.smtpPassword;
  }
  
  const parts = this.smtpPassword.split(':');
  const iv = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];
  
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY.slice(0, 32)), iv);
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
};

// Index pour recherche rapide par workspace
smtpSettingsSchema.index({ workspaceId: 1 });

const SmtpSettings = mongoose.model('SmtpSettings', smtpSettingsSchema);

export default SmtpSettings;
