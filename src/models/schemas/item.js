import mongoose from 'mongoose';
import { DISCOUNT_TYPE } from '../constants/enums.js';
import { 
  isValidItemDescription, 
  isValidUnit, 
  isPositiveAmount, 
  isPositiveNonZeroAmount, 
  isValidPercentage 
} from '../../utils/validators.js';

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
  vatExemptionText: {
    type: String,
    trim: true,
    required: function() {
      // Le champ est obligatoire uniquement lorsque vatRate est à 0
      return this.vatRate === 0;
    },
    validate: {
      validator: function(value) {
        // La mention d'exonération n'est utilisée que lorsque vatRate est à 0
        if (this.vatRate !== 0) {
          return !value; // Si vatRate n'est pas 0, vatExemptionText doit être vide
        }
        // Si vatRate est 0, vatExemptionText doit être présent et ne pas dépasser 500 caractères
        return value && value.length > 0 && value.length <= 500;
      },
      message: 'La mention d\'exonération de TVA est obligatoire lorsque le taux de TVA est à 0, ne doit pas dépasser 500 caractères, et ne peut être utilisée que lorsque le taux de TVA est à 0'
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
  },
  progressPercentage: {
    type: Number,
    default: 100,
    min: 0,
    max: 100,
    validate: {
      validator: function(value) {
        return value >= 0 && value <= 100;
      },
      message: 'Le pourcentage d\'avancement doit être entre 0 et 100'
    }
  }
});

export default itemSchema;