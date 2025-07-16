import mongoose from 'mongoose';
import { EMAIL_REGEX, PHONE_FR_REGEX, SIRET_REGEX, VAT_FR_REGEX, URL_REGEX, NAME_REGEX, CAPITAL_SOCIAL_REGEX, RCS_REGEX } from '../../utils/validators.js';
import addressSchema from './address.js';
import bankDetailsSchema from './bankDetails.js';

/**
 * Schéma pour les informations de l'entreprise
 */
const companyInfoSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    match: [NAME_REGEX, 'Le nom de l\'entreprise est invalide']
  },
  address: {
    type: addressSchema,
    required: true
  },
  phone: {
    type: String,
    trim: true,
    match: [PHONE_FR_REGEX, 'Veuillez fournir un numéro de téléphone français valide (ex: 06 12 34 56 78)']
  },
  email: {
    type: String,
    trim: true,
    lowercase: true,
    match: [EMAIL_REGEX, 'Veuillez fournir une adresse email valide']
  },
  website: {
    type: String,
    trim: true,
    match: [URL_REGEX, 'Veuillez fournir une URL valide']
  },
  siret: {
    type: String,
    trim: true,
    match: [SIRET_REGEX, 'Veuillez fournir un numéro SIRET valide (14 chiffres)'],
    validate: {
      validator: function(v) {
        // Validation conditionnelle basée sur le statut juridique
        const requiredForStatuses = ['SARL', 'SAS', 'EURL', 'SASU', 'SA', 'SNC', 'SCI', 'SCOP'];
        if (requiredForStatuses.includes(this.companyStatus) && !v) {
          return false;
        }
        return !v || SIRET_REGEX.test(v);
      },
      message: 'Le numéro SIRET est obligatoire pour ce statut juridique et doit être valide (14 chiffres)'
    }
  },
  vatNumber: {
    type: String,
    trim: true,
    match: [VAT_FR_REGEX, 'Veuillez fournir un numéro de TVA valide (format FR)'],
    validate: {
      validator: function(v) {
        // Validation conditionnelle basée sur le statut juridique
        const requiredForStatuses = ['SARL', 'SAS', 'EURL', 'SASU', 'SA', 'SNC', 'SCOP'];
        if (requiredForStatuses.includes(this.companyStatus) && !v) {
          return false;
        }
        return !v || VAT_FR_REGEX.test(v);
      },
      message: 'Le numéro de TVA est obligatoire pour ce statut juridique et doit être valide (format FR)'
    }
  },
  bankDetails: {
    type: bankDetailsSchema
  },
  logo: {
    type: String,
    trim: true
  },
  transactionCategory: {
    type: String,
    enum: ['GOODS', 'SERVICES', 'MIXED'],
    default: 'SERVICES'
  },
  vatPaymentCondition: {
    type: String,
    enum: ['ENCAISSEMENTS', 'DEBITS', 'EXONERATION', 'NONE'],
    default: 'NONE'
  },
  companyStatus: {
    type: String,
    enum: ['SARL', 'SAS', 'EURL', 'SASU', 'EI', 'EIRL', 'SA', 'SNC', 'SCI', 'SCOP', 'ASSOCIATION', 'AUTO_ENTREPRENEUR', 'AUTRE'],
    default: 'AUTRE'
  },
  capitalSocial: {
    type: String,
    trim: true,
    match: [CAPITAL_SOCIAL_REGEX, 'Veuillez fournir un capital social valide (ex: 10000)'],
    validate: {
      validator: function(v) {
        // Validation conditionnelle basée sur le statut juridique
        const requiredForStatuses = ['SARL', 'SAS', 'EURL', 'SASU', 'SA', 'SNC', 'SCOP'];
        if (requiredForStatuses.includes(this.companyStatus) && !v) {
          return false;
        }
        return !v || CAPITAL_SOCIAL_REGEX.test(v);
      },
      message: 'Le capital social est obligatoire pour ce statut juridique et doit être valide (ex: 10000)'
    }
  },
  rcs: {
    type: String,
    trim: true,
    match: [RCS_REGEX, 'Veuillez fournir un RCS valide (ex: Paris B 123 456 789)'],
    validate: {
      validator: function(v) {
        // Validation conditionnelle basée sur le statut juridique
        const requiredForStatuses = ['SARL', 'SAS', 'EURL', 'SASU', 'SA', 'SNC', 'SCI', 'SCOP'];
        if (requiredForStatuses.includes(this.companyStatus) && !v) {
          return false;
        }
        return !v || RCS_REGEX.test(v);
      },
      message: 'Le RCS est obligatoire pour ce statut juridique et doit être valide (ex: Paris B 123 456 789)'
    }
  }
});

export default companyInfoSchema;