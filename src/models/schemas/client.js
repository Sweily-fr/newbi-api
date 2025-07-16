import mongoose from 'mongoose';
import { EMAIL_REGEX, SIRET_REGEX, VAT_FR_REGEX, NAME_REGEX } from '../../utils/validators.js';
import addressSchema from './address.js';

/**
 * Types de client
 */
const CLIENT_TYPES = {
  INDIVIDUAL: 'INDIVIDUAL',
  COMPANY: 'COMPANY'
};

/**
 * Schéma pour les informations du client
 */
const clientSchema = new mongoose.Schema({
  // Type de client (particulier ou entreprise)
  type: {
    type: String,
    enum: Object.values(CLIENT_TYPES),
    default: CLIENT_TYPES.COMPANY,
    required: true
  },
  // Champs spécifiques aux particuliers
  firstName: {
    type: String,
    trim: true,
    // Requis uniquement pour les particuliers
    validate: {
      validator: function(v) {
        // Si c'est un particulier, le prénom est obligatoire
        return this.type !== CLIENT_TYPES.INDIVIDUAL || (v && v.trim().length > 0);
      },
      message: 'Le prénom est requis pour un client particulier'
    }
  },
  lastName: {
    type: String,
    trim: true,
    // Requis uniquement pour les particuliers
    validate: {
      validator: function(v) {
        // Si c'est un particulier, le nom est obligatoire
        return this.type !== CLIENT_TYPES.INDIVIDUAL || (v && v.trim().length > 0);
      },
      message: 'Le nom est requis pour un client particulier'
    }
  },
  // Nom (obligatoire pour les entreprises, généré pour les particuliers)
  name: {
    type: String,
    trim: true,
    match: [NAME_REGEX, 'Le nom du client est invalide'],
    // Validation conditionnelle: obligatoire pour les entreprises, généré pour les particuliers
    validate: {
      validator: function(v) {
        // Pour les entreprises, le nom est obligatoire
        if (this.type === CLIENT_TYPES.COMPANY) {
          return v && v.trim().length > 0;
        }
        // Pour les particuliers, le nom peut être généré automatiquement
        return true;
      },
      message: 'Le nom de l\'entreprise est requis'
    }
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: [EMAIL_REGEX, 'Veuillez fournir une adresse email valide']
  },
  address: {
    type: addressSchema,
    required: true
  },
  // Indique si l'adresse de livraison est différente de l'adresse de facturation
  hasDifferentShippingAddress: {
    type: Boolean,
    default: false
  },
  // Adresse de livraison (obligatoire si hasDifferentShippingAddress est true)
  shippingAddress: {
    type: addressSchema,
    // Validation conditionnelle: obligatoire uniquement si hasDifferentShippingAddress est true
    validate: {
      validator: function(v) {
        // Si hasDifferentShippingAddress est true, shippingAddress doit être défini
        return !this.hasDifferentShippingAddress || (v && Object.keys(v).length > 0);
      },
      message: 'L\'adresse de livraison est requise lorsque l\'option "Adresse de livraison différente" est activée'
    }
  },
  // Champs spécifiques aux entreprises
  siret: {
    type: String,
    trim: true,
    match: [SIRET_REGEX, 'Veuillez fournir un numéro SIRET valide (14 chiffres)'],
    // Requis uniquement pour les entreprises
    validate: {
      validator: function(v) {
        // Si ce n'est pas une entreprise, pas besoin de SIRET
        // Si c'est une entreprise, le SIRET est obligatoire
        return this.type !== CLIENT_TYPES.COMPANY || (v && v.trim().length > 0);
      },
      message: 'Le numéro SIRET est requis pour une entreprise'
    }
  },
  vatNumber: {
    type: String,
    trim: true,
    match: [VAT_FR_REGEX, 'Veuillez fournir un numéro de TVA valide (format FR)'],
    // Requis uniquement pour les entreprises
    validate: {
      validator: function(v) {
        // Si ce n'est pas une entreprise, pas besoin de numéro de TVA
        // Si c'est une entreprise, le numéro de TVA est obligatoire
        return this.type !== CLIENT_TYPES.COMPANY || (v && v.trim().length > 0);
      },
      message: 'Le numéro de TVA est requis pour une entreprise'
    }
  }
});

export default clientSchema;