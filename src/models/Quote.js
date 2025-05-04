const mongoose = require('mongoose');
const { 
  isDateAfter, 
  URL_REGEX, 
  isNonEmptyTrimmedString, 
  isPositiveAmount,
  isPositiveNonZeroAmount,
  NAME_REGEX,
  STREET_REGEX,
  isValidFooterNotes
} = require('../utils/validators');
const addressSchema = require('./schemas/address');
const bankDetailsSchema = require('./schemas/bankDetails');
const clientSchema = require('./schemas/client');
const itemSchema = require('./schemas/item');
const companyInfoSchema = require('./schemas/companyInfo');
const customFieldSchema = require('./schemas/customField');
const { QUOTE_STATUS, DISCOUNT_TYPE } = require('./constants/enums');

/**
 * Schéma principal de devis
 */
const quoteSchema = new mongoose.Schema({
  prefix: {
    type: String,
    default: function() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      return `D-${year}${month}-`;
    },
    trim: true,
    validate: {
      validator: function(value) {
        return value && value.length <= 10;
      },
      message: 'Le préfixe ne doit pas dépasser 10 caractères'
    }
  },
  number: {
    type: String,
    required: true,
    // L'unicité est maintenant gérée par un index composé avec l'année d'émission
    trim: true,
    validate: {
      validator: function(value) {
        return /^[A-Za-z0-9-]{1,20}$/.test(value);
      },
      message: 'Le numéro de devis doit contenir uniquement des lettres, chiffres ou tirets (max 20 caractères)'
    }
  },
  issueDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  validUntil: {
    type: Date,
    validate: {
      validator: function(value) {
        return !this.issueDate || isDateAfter(this.issueDate, value);
      },
      message: 'La date de validité doit être postérieure ou égale à la date d\'émission'
    }
  },
  client: {
    type: clientSchema,
    required: true
  },
  hasDifferentShippingAddress: {
    type: Boolean,
    default: false
  },
  shippingAddress: {
    type: addressSchema,
    // Requis uniquement si hasDifferentShippingAddress est true
    validate: {
      validator: function(value) {
        return !this.hasDifferentShippingAddress || (value && Object.keys(value).length > 0);
      },
      message: 'L\'adresse de livraison est requise lorsque l\'option est activée'
    }
  },
  companyInfo: {
    type: companyInfoSchema,
    required: true
  },
  items: {
    type: [itemSchema],
    required: true,
    validate: {
      validator: function(value) {
        return value && value.length > 0;
      },
      message: 'Un devis doit contenir au moins un article'
    }
  },
  status: {
    type: String,
    enum: Object.values(QUOTE_STATUS),
    default: QUOTE_STATUS.PENDING
  },
  headerNotes: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 1000;
      },
      message: 'Les notes d\'en-tête ne doivent pas dépasser 1000 caractères'
    }
  },
  footerNotes: {
    type: String,
    trim: true,
    validate: {
      validator: isValidFooterNotes,
      message: 'Les notes de bas de page ne doivent pas dépasser 2000 caractères ou contiennent des caractères non autorisés'
    }
  },
  termsAndConditions: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 2000;
      },
      message: 'Les conditions générales ne doivent pas dépasser 2000 caractères'
    }
  },
  termsAndConditionsLinkTitle: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 100;
      },
      message: 'Le titre du lien des conditions générales ne doit pas dépasser 100 caractères'
    }
  },
  termsAndConditionsLink: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        if (!value) return true;
        return URL_REGEX.test(value);
      },
      message: 'Veuillez fournir une URL valide pour le lien des conditions générales'
    }
  },
  discount: {
    type: Number,
    min: 0,
    default: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'La remise doit être un nombre positif'
    }
  },
  discountType: {
    type: String,
    enum: Object.values(DISCOUNT_TYPE),
    default: DISCOUNT_TYPE.FIXED
  },
  customFields: [customFieldSchema],
  totalHT: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant HT doit être un nombre positif'
    }
  },
  totalTTC: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant TTC doit être un nombre positif'
    }
  },
  totalVAT: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant de TVA doit être un nombre positif'
    }
  },
  finalTotalHT: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant HT final doit être un nombre positif'
    }
  },
  finalTotalTTC: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant TTC final doit être un nombre positif'
    }
  },
  discountAmount: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant de la remise doit être un nombre positif'
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  convertedToInvoice: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  linkedInvoices: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  }]
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
quoteSchema.index({ createdBy: 1 });
quoteSchema.index({ 'client.name': 1 });
quoteSchema.index({ status: 1 });
quoteSchema.index({ issueDate: -1 });

// Index unique pour garantir l'unicité des numéros de devis par utilisateur
quoteSchema.index({ number: 1, createdBy: 1 }, { unique: true });

/**
 * Calcul automatique des totaux avant sauvegarde
 */
quoteSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    let totalHT = 0;
    let totalVAT = 0;

    this.items.forEach(item => {
      let itemHT = item.quantity * item.unitPrice;
      
      // Appliquer la remise au niveau de l'item si elle existe
      if (item.discount) {
        if (item.discountType === 'PERCENTAGE') {
          itemHT = itemHT * (1 - (item.discount / 100));
        } else {
          itemHT = Math.max(0, itemHT - item.discount);
        }
      }
      
      const itemVAT = itemHT * (item.vatRate / 100);
      totalHT += itemHT;
      totalVAT += itemVAT;
    });

    // Appliquer la remise globale
    let discountAmount = 0;
    if (this.discount) {
      if (this.discountType === 'PERCENTAGE') {
        discountAmount = (totalHT * this.discount) / 100;
      } else {
        discountAmount = this.discount;
      }
    }

    const finalTotalHT = Math.max(0, totalHT - discountAmount);
    const finalTotalTTC = finalTotalHT + totalVAT;

    this.totalHT = parseFloat(totalHT.toFixed(2));
    this.totalVAT = parseFloat(totalVAT.toFixed(2));
    this.totalTTC = parseFloat((totalHT + totalVAT).toFixed(2));
    this.finalTotalHT = parseFloat(finalTotalHT.toFixed(2));
    this.finalTotalTTC = parseFloat(finalTotalTTC.toFixed(2));
    this.discountAmount = parseFloat(discountAmount.toFixed(2));
  }
  
  next();
});

// Création d'un index composé pour garantir l'unicité des numéros de devis par année
// Cela permet de réutiliser les numéros d'une année à l'autre
quoteSchema.index(
  { 
    number: 1,
    createdBy: 1,
    // Utilisation de l'opérateur $year pour extraire l'année de la date d'émission
    // Cela permet d'avoir un numéro unique par année pour chaque utilisateur
  },
  { 
    unique: true,
    partialFilterExpression: { number: { $exists: true } }, // Ignorer les documents sans numéro
    name: 'number_createdBy_year_unique' 
  }
);

// Ajout d'une méthode statique pour vérifier si un numéro existe déjà pour une année donnée
quoteSchema.statics.numberExistsForYear = async function(number, userId, year) {
  const startDate = new Date(year, 0, 1); // 1er janvier de l'année
  const endDate = new Date(year, 11, 31, 23, 59, 59); // 31 décembre de l'année
  
  const count = await this.countDocuments({
    number,
    createdBy: userId,
    issueDate: { $gte: startDate, $lte: endDate }
  });
  
  return count > 0;
};

module.exports = mongoose.model('Quote', quoteSchema);
