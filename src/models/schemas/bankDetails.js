import mongoose from 'mongoose';

/**
 * Schéma pour les coordonnées bancaires
 *
 * NOTE: IBAN and BIC fields are encrypted at rest using AES-256-GCM.
 * Regex validation (IBAN_REGEX, BIC_REGEX) has been removed from the schema
 * because encrypted values do not match plaintext patterns.
 * Validation of plaintext values should be performed BEFORE encryption,
 * in the resolvers/business logic layer using isValidIBAN/isValidBIC from validators.js.
 */
const bankDetailsSchema = new mongoose.Schema({
  iban: {
    type: String,
    trim: false, // Disabled: trimming would corrupt encrypted data
  },
  bic: {
    type: String,
    trim: false, // Disabled: trimming would corrupt encrypted data
  },
  bankName: {
    type: String,
    trim: true,
  }
});

export default bankDetailsSchema;