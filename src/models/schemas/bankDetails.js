import mongoose from 'mongoose';
import { IBAN_REGEX, BIC_REGEX } from '../../utils/validators.js';

/**
 * Schéma pour les coordonnées bancaires
 */
const bankDetailsSchema = new mongoose.Schema({
  iban: {
    type: String,
    trim: true,
    match: [IBAN_REGEX, 'Veuillez fournir un IBAN valide'],
    validate: {
      validator: function(v) {
        // Si IBAN est fourni, BIC et bankName doivent aussi être fournis
        if (v && (!this.bic || !this.bankName)) {
          return false;
        }
        return true;
      },
      message: 'Si l\'IBAN est fourni, le BIC et le nom de la banque doivent aussi être fournis'
    }
  },
  bic: {
    type: String,
    trim: true,
    match: [BIC_REGEX, 'Veuillez fournir un BIC valide'],
    validate: {
      validator: function(v) {
        // Si BIC est fourni, IBAN et bankName doivent aussi être fournis
        if (v && (!this.iban || !this.bankName)) {
          return false;
        }
        return true;
      },
      message: 'Si le BIC est fourni, l\'IBAN et le nom de la banque doivent aussi être fournis'
    }
  },
  bankName: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        // Si bankName est fourni, IBAN et BIC doivent aussi être fournis
        if (v && (!this.iban || !this.bic)) {
          return false;
        }
        return true;
      },
      message: 'Si le nom de la banque est fourni, l\'IBAN et le BIC doivent aussi être fournis'
    }
  }
});

export default bankDetailsSchema;