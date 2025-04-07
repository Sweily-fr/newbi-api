const mongoose = require('mongoose');
const { 
  POSTAL_CODE_FR_REGEX, 
  STREET_REGEX, 
  CITY_REGEX, 
  COUNTRY_REGEX 
} = require('../../utils/validators');

/**
 * Schéma d'adresse réutilisable
 */
const addressSchema = new mongoose.Schema({
  street: {
    type: String,
    trim: true,
    match: [STREET_REGEX, 'Veuillez fournir une adresse valide (3 à 100 caractères)']
  },
  city: {
    type: String,
    trim: true,
    match: [CITY_REGEX, 'Veuillez fournir un nom de ville valide (2 à 50 caractères)']
  },
  postalCode: {
    type: String,
    trim: true,
    match: [POSTAL_CODE_FR_REGEX, 'Veuillez fournir un code postal français valide (5 chiffres)']
  },
  country: {
    type: String,
    trim: true,
    match: [COUNTRY_REGEX, 'Veuillez fournir un nom de pays valide (2 à 50 caractères)']
  }
});

module.exports = addressSchema;