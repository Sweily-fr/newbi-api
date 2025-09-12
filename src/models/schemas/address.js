import mongoose from 'mongoose';
import { STREET_REGEX } from '../../utils/validators.js';

/**
 * Schéma d'adresse réutilisable
 */
const addressSchema = new mongoose.Schema({
  fullName: {
    type: String,
    trim: true,
    validate: {
      validator: function(v) {
        return !v || (v.length >= 2 && v.length <= 100 && /^[a-zA-ZÀ-ÿ\s'-]{2,100}$/.test(v));
      },
      message: 'Le nom complet doit contenir entre 2 et 100 caractères (lettres, espaces, apostrophes et tirets uniquement)'
    }
  },
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