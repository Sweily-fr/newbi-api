const mongoose = require('mongoose');
const { EMAIL_REGEX, PHONE_FR_REGEX, SIRET_REGEX, VAT_FR_REGEX, URL_REGEX, NAME_REGEX } = require('../../utils/validators');
const addressSchema = require('./address');
const bankDetailsSchema = require('./bankDetails');

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
    match: [SIRET_REGEX, 'Veuillez fournir un numéro SIRET valide (14 chiffres)']
  },
  vatNumber: {
    type: String,
    trim: true,
    match: [VAT_FR_REGEX, 'Veuillez fournir un numéro de TVA valide (format FR)']
  },
  bankDetails: {
    type: bankDetailsSchema
  },
  logo: {
    type: String,
    trim: true
  }
});

module.exports = companyInfoSchema;