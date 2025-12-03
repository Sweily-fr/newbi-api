import mongoose from 'mongoose';

const emailSettingsSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
  },
  fromEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
  },
  fromName: {
    type: String,
    default: '',
    trim: true,
  },
  replyTo: {
    type: String,
    default: '',
    trim: true,
    lowercase: true,
  },
  // Templates d'email par type de document
  invoiceEmailTemplate: {
    type: String,
    default: '',
    trim: true,
  },
  quoteEmailTemplate: {
    type: String,
    default: '',
    trim: true,
  },
  creditNoteEmailTemplate: {
    type: String,
    default: '',
    trim: true,
  },
  // Pour vérification future (optionnel)
  verified: {
    type: Boolean,
    default: false,
  },
  verificationToken: {
    type: String,
    default: null,
  },
  verifiedAt: {
    type: Date,
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

// Mettre à jour updatedAt avant chaque sauvegarde
emailSettingsSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Index pour recherche rapide par workspace
emailSettingsSchema.index({ workspaceId: 1 });

const EmailSettings = mongoose.model('EmailSettings', emailSettingsSchema);

export default EmailSettings;
