import mongoose from 'mongoose';

/**
 * Schéma principal de la signature email - Version 2025
 * Compatible avec la nouvelle interface de configuration
 */
const emailSignatureSchema = new mongoose.Schema({
  // Informations de base
  signatureName: {
    type: String,
    required: true,
    trim: true,
    default: 'Ma signature professionnelle'
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  
  // Informations personnelles
  firstName: {
    type: String,
    required: false,
    trim: true,
    maxlength: [50, 'Le prénom ne peut pas dépasser 50 caractères']
  },
  lastName: {
    type: String,
    required: false,
    trim: true,
    maxlength: [50, 'Le nom ne peut pas dépasser 50 caractères']
  },
  position: {
    type: String,
    required: false,
    trim: true,
    maxlength: [100, 'Le poste ne peut pas dépasser 100 caractères']
  },
  
  // Informations de contact
  email: {
    type: String,
    required: false,
    trim: true,
    lowercase: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Format d\'email invalide']
  },
  phone: {
    type: String,
    trim: true
  },
  mobile: {
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
  
  // Options d'affichage des icônes
  showPhoneIcon: {
    type: Boolean,
    default: true
  },
  showMobileIcon: {
    type: Boolean,
    default: true
  },
  showEmailIcon: {
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
  
  // Couleurs des différents éléments
  primaryColor: {
    type: String,
    default: '#2563eb',
    match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Veuillez fournir une couleur hexadécimale valide']
  },
  colors: {
    name: {
      type: String,
      default: '#2563eb',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Couleur nom invalide']
    },
    position: {
      type: String,
      default: '#666666',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Couleur poste invalide']
    },
    company: {
      type: String,
      default: '#2563eb',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Couleur entreprise invalide']
    },
    contact: {
      type: String,
      default: '#666666',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Couleur contact invalide']
    },
    separatorVertical: {
      type: String,
      default: '#e0e0e0',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Couleur séparateur vertical invalide']
    },
    separatorHorizontal: {
      type: String,
      default: '#e0e0e0',
      match: [/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Couleur séparateur horizontal invalide']
    }
  },
  
  // Espacement entre prénom et nom (en pixels)
  nameSpacing: {
    type: Number,
    default: 4,
    min: [0, 'L\'espacement ne peut pas être négatif'],
    max: [20, 'L\'espacement maximum est de 20px']
  },
  
  // Alignement du nom et prénom (left, center, right)
  nameAlignment: {
    type: String,
    enum: ['left', 'center', 'right'],
    default: 'left'
  },
  
  // Layout de la signature (vertical ou horizontal)
  layout: {
    type: String,
    enum: ['horizontal', 'vertical'],
    default: 'horizontal'
  },
  
  // Largeurs des colonnes (en pourcentage)
  columnWidths: {
    photo: {
      type: Number,
      default: 25,
      min: [10, 'Largeur minimale de 10%'],
      max: [90, 'Largeur maximale de 90%']
    },
    content: {
      type: Number,
      default: 75,
      min: [10, 'Largeur minimale de 10%'],
      max: [90, 'Largeur maximale de 90%']
    }
  },
  
  // Images Cloudflare
  photo: {
    type: String,
    trim: true
  },
  photoKey: {
    type: String,
    trim: true
  },
  logo: {
    type: String,
    trim: true
  },
  logoKey: {
    type: String,
    trim: true
  },
  
  // Taille de l'image de profil (en pixels)
  imageSize: {
    type: Number,
    default: 80,
    min: [40, 'Taille minimale de 40px'],
    max: [200, 'Taille maximale de 200px']
  },
  
  // Forme de l'image de profil (round ou square)
  imageShape: {
    type: String,
    enum: ['round', 'square'],
    default: 'round'
  },
  
  // Épaisseur des séparateurs (en pixels)
  separatorVerticalWidth: {
    type: Number,
    default: 1,
    min: [0, 'Épaisseur minimale de 0px'],
    max: [10, 'Épaisseur maximale de 10px']
  },
  separatorHorizontalWidth: {
    type: Number,
    default: 1,
    min: [0, 'Épaisseur minimale de 0px'],
    max: [10, 'Épaisseur maximale de 10px']
  },
  
  // Taille du logo entreprise (en pixels)
  logoSize: {
    type: Number,
    default: 60,
    min: [20, 'Taille minimale de 20px'],
    max: [150, 'Taille maximale de 150px']
  },
  
  // Espacements entre les éléments (en pixels)
  spacings: {
    global: {
      type: Number,
      default: 8,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    photoBottom: {
      type: Number,
      default: 12,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    logoBottom: {
      type: Number,
      default: 12,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    nameBottom: {
      type: Number,
      default: 8,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    positionBottom: {
      type: Number,
      default: 8,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    companyBottom: {
      type: Number,
      default: 12,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    contactBottom: {
      type: Number,
      default: 6,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    phoneToMobile: {
      type: Number,
      default: 4,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    mobileToEmail: {
      type: Number,
      default: 4,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    emailToWebsite: {
      type: Number,
      default: 4,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    websiteToAddress: {
      type: Number,
      default: 4,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    separatorTop: {
      type: Number,
      default: 12,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    },
    separatorBottom: {
      type: Number,
      default: 12,
      min: [0, 'Espacement minimum de 0px'],
      max: [50, 'Espacement maximum de 50px']
    }
  },
  
  // Typographie générale
  fontFamily: {
    type: String,
    default: 'Arial, sans-serif'
  },
  fontSize: {
    name: {
      type: Number,
      default: 16,
      min: [8, 'Taille minimale de 8px'],
      max: [32, 'Taille maximale de 32px']
    },
    position: {
      type: Number,
      default: 14,
      min: [8, 'Taille minimale de 8px'],
      max: [32, 'Taille maximale de 32px']
    },
    contact: {
      type: Number,
      default: 12,
      min: [8, 'Taille minimale de 8px'],
      max: [32, 'Taille maximale de 32px']
    }
  },
  
  // Utilisateur propriétaire
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
emailSignatureSchema.index({ signatureName: 'text' });

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

export default EmailSignature;
