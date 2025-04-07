const mongoose = require('mongoose');
const { DISCOUNT_TYPE } = require('../constants/enums');
const { 
  isValidItemDescription, 
  isValidUnit, 
  isPositiveAmount, 
  isPositiveNonZeroAmount, 
  isValidPercentage 
} = require('../../utils/validators');

/**
 * Schéma pour les éléments de facture/devis
 */
const itemSchema = new mongoose.Schema({
  description: {
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: isValidItemDescription,
      message: 'La description de l\'article contient des caractères non autorisés ou dépasse 200 caractères'
    }
  },
  quantity: {
    type: Number,
    required: true,
    validate: {
      validator: isPositiveAmount,
      message: 'La quantité doit être un nombre positif ou nul'
    }
  },
  unitPrice: {
    type: Number,
    required: true,
    validate: {
      validator: isPositiveNonZeroAmount,
      message: 'Le prix unitaire doit être un nombre strictement positif'
    }
  },
  vatRate: {
    type: Number,
    required: true,
    validate: {
      validator: isValidPercentage,
      message: 'Le taux de TVA doit être un pourcentage valide (entre 0 et 100)'
    }
  },
  unit: {
    type: String,
    trim: true,
    default: 'unité',
    validate: {
      validator: isValidUnit,
      message: 'L\'unité contient des caractères non autorisés ou dépasse 20 caractères'
    }
  },
  discount: {
    type: Number,
    default: 0,
    validate: {
      validator: isPositiveAmount,
      message: 'La remise doit être un nombre positif ou nul'
    }
  },
  discountType: {
    type: String,
    enum: Object.values(DISCOUNT_TYPE),
    default: DISCOUNT_TYPE.PERCENTAGE
  },
  details: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 500;
      },
      message: 'Les détails ne doivent pas dépasser 500 caractères'
    }
  }
});

module.exports = itemSchema;