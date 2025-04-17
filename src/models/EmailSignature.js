const mongoose = require('mongoose');
const { NAME_REGEX } = require('../utils/validators');

/**
 * Schéma principal de la signature email
 */
const emailSignatureSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    match: [NAME_REGEX, 'Veuillez fournir un nom valide']
  },
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  jobTitle: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    trim: true
  },
  mobilePhone: {
    type: String,
    trim: true
  },
  website: {
    type: String,
    trim: true
  },
  address: {
    type: String,
    trim: true
  },
  companyName: {
    type: String,
    trim: true
  },
  socialLinks: {
    linkedin: { type: String, trim: true },
    twitter: { type: String, trim: true },
    facebook: { type: String, trim: true },
    instagram: { type: String, trim: true }
  },
  template: {
    type: String,
    enum: ['simple', 'professional', 'modern', 'creative'],
    default: 'simple'
  },
  primaryColor: {
    type: String,
    default: '#0066cc'
  },
  secondaryColor: {
    type: String,
    default: '#f5f5f5'
  },
  logoUrl: {
    type: String,
    trim: true
  },
  showLogo: {
    type: Boolean,
    default: true
  },
  profilePhotoUrl: {
    type: String,
    trim: true
  },
  profilePhotoSize: {
    type: Number,
    default: 80 // Taille par défaut en pixels
  },
  socialLinksDisplayMode: {
    type: String,
    enum: ['icons', 'text'],
    default: 'text'
  },
  socialLinksIconStyle: {
    type: String,
    enum: ['plain', 'rounded', 'circle'],
    default: 'plain'
  },
  socialLinksIconBgColor: {
    type: String,
    default: ''
  },
  socialLinksIconColor: {
    type: String,
    default: ''
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
emailSignatureSchema.index({ createdBy: 1 });
emailSignatureSchema.index({ name: 'text' });

// S'assurer qu'il n'y a qu'une seule signature par défaut par utilisateur
emailSignatureSchema.pre('save', async function(next) {
  if (this.isDefault) {
    // Trouver toutes les autres signatures de cet utilisateur et les définir comme non par défaut
    await this.constructor.updateMany(
      { 
        createdBy: this.createdBy, 
        _id: { $ne: this._id },
        isDefault: true 
      },
      { isDefault: false }
    );
  }
  next();
});

const EmailSignature = mongoose.model('EmailSignature', emailSignatureSchema);

module.exports = EmailSignature;
