import mongoose from 'mongoose';
import {
  isDateAfter,
  URL_REGEX,
  isPositiveAmount,
  isValidFooterNotes
} from '../utils/validators.js';
import clientSchema from './schemas/client.js';
import itemSchema from './schemas/item.js';
import companyInfoSchema from './schemas/companyInfo.js';
import customFieldSchema from './schemas/customField.js';
import shippingSchema from './schemas/shipping.js';
import { PURCHASE_ORDER_STATUS, DISCOUNT_TYPE } from './constants/enums.js';

/**
 * Schéma principal de bon de commande
 */
const purchaseOrderSchema = new mongoose.Schema({
  prefix: {
    type: String,
    default: function() {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      return `BC-${year}${month}`;
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
    trim: true,
    validate: {
      validator: function(value) {
        return /^[A-Za-z0-9-]{1,20}$/.test(value);
      },
      message: 'Le numéro de bon de commande doit contenir uniquement des lettres, chiffres ou tirets (max 20 caractères)'
    }
  },
  purchaseOrderNumber: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || /^[A-Za-z0-9-/]{1,50}$/.test(value);
      },
      message: 'La référence doit contenir uniquement des lettres, chiffres, tirets ou slashs (max 50 caractères)'
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
  deliveryDate: {
    type: Date,
  },
  client: {
    type: clientSchema,
    required: true
  },
  companyInfo: {
    type: companyInfoSchema,
    required: false
  },
  items: {
    type: [itemSchema],
    required: true,
    validate: {
      validator: function(value) {
        return value && value.length > 0;
      },
      message: 'Un bon de commande doit contenir au moins un article'
    }
  },
  status: {
    type: String,
    enum: Object.values(PURCHASE_ORDER_STATUS),
    default: PURCHASE_ORDER_STATUS.DRAFT
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
  showBankDetails: {
    type: Boolean,
    default: false,
  },
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
  finalTotalVAT: {
    type: Number,
    min: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'Le montant de TVA final doit être un nombre positif'
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
  // Référence vers le devis d'origine
  sourceQuoteId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Quote'
  },
  // Factures générées depuis ce bon de commande
  linkedInvoices: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  }],
  // Référence vers l'organisation/workspace (Better Auth)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  appearance: {
    textColor: {
      type: String,
      default: '#000000',
      trim: true,
    },
    headerTextColor: {
      type: String,
      default: '#ffffff',
      trim: true,
    },
    headerBgColor: {
      type: String,
      default: '#1d1d1b',
      trim: true,
    },
  },
  shipping: {
    type: shippingSchema,
    default: () => ({
      billShipping: false,
      shippingAmountHT: 0,
      shippingVatRate: 20
    })
  },
  isReverseCharge: {
    type: Boolean,
    default: false,
  },
  clientPositionRight: {
    type: Boolean,
    default: false,
  },
  retenueGarantie: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  },
  escompte: {
    type: Number,
    default: 0,
    min: 0,
    max: 100,
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
purchaseOrderSchema.index({ workspaceId: 1, 'client.name': 1 });
purchaseOrderSchema.index({ workspaceId: 1, status: 1 });
purchaseOrderSchema.index({ workspaceId: 1, issueDate: -1 });
purchaseOrderSchema.index({ createdBy: 1 });

/**
 * Calcul automatique des totaux avant sauvegarde
 */
purchaseOrderSchema.pre('save', function(next) {
  if (this.items && this.items.length > 0) {
    let totalHT = 0;
    let totalVAT = 0;

    this.items.forEach(item => {
      let itemHT = item.quantity * item.unitPrice;

      if (item.discount) {
        if (item.discountType === 'PERCENTAGE') {
          itemHT = itemHT * (1 - (item.discount / 100));
        } else {
          itemHT = Math.max(0, itemHT - item.discount);
        }
      }

      const itemVAT = this.isReverseCharge ? 0 : itemHT * (item.vatRate / 100);
      totalHT += itemHT;
      totalVAT += itemVAT;
    });

    let discountAmount = 0;
    if (this.discount) {
      if (this.discountType === 'PERCENTAGE') {
        discountAmount = (totalHT * this.discount) / 100;
      } else {
        discountAmount = this.discount;
      }
    }

    const finalTotalHT = Math.max(0, totalHT - discountAmount);

    let finalTotalVAT = 0;
    if (!this.isReverseCharge && finalTotalHT > 0 && totalHT > 0) {
      finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
    }

    const finalTotalTTC = finalTotalHT + finalTotalVAT;

    this.totalHT = parseFloat(totalHT.toFixed(2));
    this.totalVAT = parseFloat(totalVAT.toFixed(2));
    this.totalTTC = parseFloat((totalHT + totalVAT).toFixed(2));
    this.finalTotalHT = parseFloat(finalTotalHT.toFixed(2));
    this.finalTotalVAT = parseFloat(finalTotalVAT.toFixed(2));
    this.finalTotalTTC = parseFloat(finalTotalTTC.toFixed(2));
    this.discountAmount = parseFloat(discountAmount.toFixed(2));
  }

  next();
});

// Virtual pour l'année d'émission
purchaseOrderSchema.virtual('issueYear').get(function() {
  return this.issueDate ? this.issueDate.getFullYear() : new Date().getFullYear();
});

// Middleware pre-save pour définir l'année d'émission
purchaseOrderSchema.pre('save', function(next) {
  if (this.issueDate) {
    this.issueYear = this.issueDate.getFullYear();
  } else {
    this.issueYear = new Date().getFullYear();
  }
  next();
});

// Ajout du champ issueYear au schéma pour l'index
purchaseOrderSchema.add({
  issueYear: {
    type: Number,
    default: function() {
      return this.issueDate ? this.issueDate.getFullYear() : new Date().getFullYear();
    },
    index: true
  }
});

// Index composé pour garantir l'unicité des numéros par préfixe, année et organisation
purchaseOrderSchema.index(
  {
    prefix: 1,
    number: 1,
    workspaceId: 1,
    issueYear: 1
  },
  {
    unique: true,
    partialFilterExpression: { number: { $exists: true } },
    name: 'po_prefix_number_workspaceId_year_unique'
  }
);

// Méthode statique pour vérifier si un numéro existe déjà
purchaseOrderSchema.statics.numberExistsForYear = async function(number, workspaceId, year) {
  const count = await this.countDocuments({
    number,
    workspaceId,
    issueYear: year
  });

  return count > 0;
};

export default mongoose.model('PurchaseOrder', purchaseOrderSchema);
