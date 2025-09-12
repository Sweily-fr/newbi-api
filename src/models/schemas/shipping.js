import mongoose from 'mongoose';
import addressSchema from './address.js';
import { isPositiveAmount } from '../../utils/validators.js';

/**
 * Schéma de livraison pour les factures et devis
 */
const shippingSchema = new mongoose.Schema({
  // Indique si la livraison doit être facturée
  billShipping: {
    type: Boolean,
    default: false
  },
  // Adresse de livraison (utilise le schéma d'adresse existant)
  shippingAddress: {
    type: addressSchema,
    required: function() {
      return this.billShipping;
    }
  },
  // Montant HT de la livraison
  shippingAmountHT: {
    type: Number,
    min: 0,
    default: 0,
    required: function() {
      return this.billShipping;
    },
    validate: {
      validator: function(value) {
        if (!this.billShipping) return true;
        return isPositiveAmount(value);
      },
      message: 'Le montant HT de la livraison doit être un nombre positif'
    }
  },
  // Taux de TVA pour la livraison
  shippingVatRate: {
    type: Number,
    min: 0,
    max: 100,
    default: 20,
    required: function() {
      return this.billShipping;
    },
    validate: {
      validator: function(value) {
        if (!this.billShipping) return true;
        return value >= 0 && value <= 100;
      },
      message: 'Le taux de TVA doit être compris entre 0 et 100'
    }
  }
});

export default shippingSchema;
