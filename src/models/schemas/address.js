import mongoose from "mongoose";
import {
  STREET_REGEX,
  CITY_REGEX,
  COUNTRY_REGEX,
  FULL_NAME_REGEX,
} from "../../utils/validators.js";

/**
 * Schéma d'adresse réutilisable
 *
 * Les règles acceptent les vraies adresses (« n° », « 12/14 », « Cedex »,
 * apostrophe typographique, nom d'entreprise comme destinataire) et refusent
 * les balises (< et >). Elles sont plus larges que les anciennes, jamais plus
 * strictes : une adresse déjà enregistrée reste valide.
 */
const addressSchema = new mongoose.Schema({
  fullName: {
    type: String,
    trim: true,
    validate: {
      validator: function (v) {
        return !v || FULL_NAME_REGEX.test(v);
      },
      message:
        "Le nom complet doit contenir entre 2 et 100 caractères (< et > interdits)",
    },
  },
  street: {
    type: String,
    trim: true,
    validate: {
      validator: function (v) {
        return !v || STREET_REGEX.test(v);
      },
      message:
        "L'adresse doit contenir entre 3 et 100 caractères (< et > interdits)",
    },
  },
  city: {
    type: String,
    trim: true,
    validate: {
      validator: function (v) {
        return !v || CITY_REGEX.test(v);
      },
      message:
        "La ville doit contenir entre 2 et 50 caractères (< et > interdits)",
    },
  },
  postalCode: {
    type: String,
    trim: true,
    validate: {
      validator: function (v) {
        // Format libre pour les adresses internationales (2-20 caractères alphanumériques avec espaces/tirets)
        return !v || /^[a-zA-Z0-9\s-]{2,20}$/.test(v);
      },
      message:
        "Le code postal doit contenir entre 2 et 20 caractères alphanumériques",
    },
  },
  country: {
    type: String,
    trim: true,
    validate: {
      validator: function (v) {
        return !v || COUNTRY_REGEX.test(v);
      },
      message:
        "Le pays doit contenir entre 2 et 50 caractères (lettres, espaces, apostrophes, tirets, points, virgules et parenthèses uniquement)",
    },
  },
});

export default addressSchema;
