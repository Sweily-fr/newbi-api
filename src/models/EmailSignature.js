const mongoose = require('mongoose');
const { 
  NAME_REGEX, 
  EMAIL_REGEX, 
  PHONE_REGEX, 
  PHONE_FR_REGEX, 
  URL_REGEX, 
  STREET_REGEX
} = require('../utils/validators');

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
    trim: true,
    match: [EMAIL_REGEX, 'Veuillez fournir une adresse email valide']
  },
  phone: {
    type: String,
    trim: true,
    match: [PHONE_REGEX, 'Veuillez fournir un numéro de téléphone valide (format international)']
  },
  mobilePhone: {
    type: String,
    trim: true,
    match: [PHONE_FR_REGEX, 'Veuillez fournir un numéro de mobile valide (format français)']
  },
  website: {
    type: String,
    trim: true,
    match: [URL_REGEX, 'Veuillez fournir une URL valide']
  },
  address: {
    type: String,
    trim: true,
    match: [STREET_REGEX, 'Veuillez fournir une adresse valide']
  },
  companyName: {
    type: String,
    trim: true,
    match: [NAME_REGEX, 'Veuillez fournir un nom d\'entreprise valide']
  },
  socialLinks: {
    linkedin: { 
      type: String, 
      trim: true,
      match: [URL_REGEX, 'Veuillez fournir une URL LinkedIn valide']
    },
    twitter: { 
      type: String, 
      trim: true,
      match: [URL_REGEX, 'Veuillez fournir une URL Twitter valide']
    },
    facebook: { 
      type: String, 
      trim: true,
      match: [URL_REGEX, 'Veuillez fournir une URL Facebook valide']
    },
    instagram: { 
      type: String, 
      trim: true,
      match: [URL_REGEX, 'Veuillez fournir une URL Instagram valide']
    }
  },
  template: {
    type: String,
    enum: ['simple', 'professional', 'modern', 'creative'],
    default: 'simple'
  },
  primaryColor: {
    type: String,
    default: '#5b50ff',
    match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Veuillez fournir une couleur hexadécimale valide']
  },
  secondaryColor: {
    type: String,
    default: '#f5f5f5',
    match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Veuillez fournir une couleur hexadécimale valide']
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
    default: 80, // Taille par défaut en pixels
    min: [40, 'La taille minimale est de 40px'],
    max: [120, 'La taille maximale est de 120px']
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
    default: '#5b50ff',
    match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Veuillez fournir une couleur hexadécimale valide']
  },
  socialLinksIconColor: {
    type: String,
    default: '#FFFFFF',
    match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Veuillez fournir une couleur hexadécimale valide']
  },
  socialLinksPosition: {
    type: String,
    enum: ['bottom', 'right'],
    default: 'bottom'
  },
  layout: {
    type: String,
    enum: ['horizontal', 'vertical'],
    default: 'vertical'
  },
  horizontalSpacing: {
    type: Number,
    default: 20,
    min: [0, 'L\'espacement horizontal ne peut pas être négatif'],
    max: [60, 'L\'espacement horizontal maximum est de 60px']
  },
  verticalSpacing: {
    type: Number,
    default: 10,
    min: [0, 'L\'espacement vertical ne peut pas être négatif'],
    max: [40, 'L\'espacement vertical maximum est de 40px']
  },
  verticalAlignment: {
    type: String,
    enum: ['left', 'center', 'right'],
    default: 'left'
  },
  imagesLayout: {
    type: String,
    enum: ['horizontal', 'vertical'],
    default: 'vertical'
  },
  fontFamily: {
    type: String,
    default: 'Arial, sans-serif'
  },
  fontSize: {
    type: Number,
    default: 14,
    min: [8, 'La taille de police minimale est de 8px'],
    max: [24, 'La taille de police maximale est de 24px']
  },
  textStyle: {
    type: String,
    enum: ['normal', 'overline', 'underline', 'strikethrough'],
    default: 'normal'
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  socialLinksIconSize: {
    type: Number,
    default: 24,
    min: [16, 'La taille d\'icône minimale est de 16px'],
    max: [48, 'La taille d\'icône maximale est de 48px']
  },
  // Options d'affichage des icônes
  showEmailIcon: {
    type: Boolean,
    default: true
  },
  showPhoneIcon: {
    type: Boolean,
    default: true
  },
  showAddressIcon: {
    type: Boolean,
    default: true
  },
  showWebsiteIcon: {
    type: Boolean,
    default: true
  },
  iconTextSpacing: {
    type: Number,
    default: 5,
    min: [0, 'L\'espacement minimum est de 0px'],
    max: [20, 'L\'espacement maximum est de 20px']
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
