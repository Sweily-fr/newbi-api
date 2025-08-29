import mongoose from 'mongoose';
import { 
  POSTAL_CODE_FR_REGEX, 
  STREET_REGEX, 
  CITY_REGEX, 
  COUNTRY_REGEX,
  isValidCity,
  isValidCountry
} from '../../utils/validators.js';

/**
 * Schéma d'adresse réutilisable
 */
const addressSchema = new mongoose.Schema({
  street: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        return !v || STREET_REGEX.test(v);
      },
      message: 'Veuillez fournir une adresse valide (3 à 100 caractères)'
    }
  },
  city: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        return !v || (v.length >= 2 && v.length <= 50 && /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/.test(v));
      },
      message: 'La ville doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes et tirets uniquement)'
    }
  },
  postalCode: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        return !v || /^[0-9]{5}$/.test(v);
      },
      message: 'Le code postal doit contenir exactement 5 chiffres'
    }
  },
  country: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        return !v || (v.length >= 2 && v.length <= 50 && /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/.test(v));
      },
      message: 'Le pays doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes et tirets uniquement)'
    }
  }
});

export default addressSchema;