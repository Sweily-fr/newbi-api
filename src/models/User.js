const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { 
  EMAIL_REGEX, 
  SIRET_REGEX, 
  VAT_FR_REGEX, 
  PHONE_FR_REGEX,
  NAME_REGEX,
  URL_REGEX,
  STRONG_PASSWORD_REGEX
} = require('../utils/validators');
const addressSchema = require('./schemas/address');
const bankDetailsSchema = require('./schemas/bankDetails');

/**
 * Schéma utilisateur principal
 */
const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    match: [EMAIL_REGEX, 'Veuillez fournir une adresse email valide']
  },
  password: {
    type: String,
    required: true,
    minlength: [6, 'Le mot de passe doit contenir au moins 6 caractères'],
    validate: {
      validator: function(value) {
        // Validation uniquement à la création, pas à la mise à jour (car le mot de passe est hashé)
        if (this.isNew) {
          return STRONG_PASSWORD_REGEX.test(value);
        }
        return true;
      },
      message: 'Le mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial'
    }
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  isDisabled: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: String,
  subscription: {
    licence: {
      type: Boolean,
      default: false
    },
    trial: {
      type: Boolean,
      default: false
    },
    stripeCustomerId: {
      type: String,
      sparse: true
    }
  },
  emailVerificationExpires: Date,
  profile: {
    firstName: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || NAME_REGEX.test(v);
        },
        message: 'Le prénom ne doit contenir que des lettres, espaces, tirets ou apostrophes (2-50 caractères)'
      }
    },
    lastName: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || NAME_REGEX.test(v);
        },
        message: 'Le nom ne doit contenir que des lettres, espaces, tirets ou apostrophes (2-50 caractères)'
      }
    },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || PHONE_FR_REGEX.test(v);
        },
        message: 'Veuillez fournir un numéro de téléphone valide'
      }
    },
    profilePicture: {
      type: String,
      trim: true
    }
  },
  company: {
    name: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || NAME_REGEX.test(v);
        },
        message: 'Veuillez fournir un nom de entreprise valide'
      }
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || EMAIL_REGEX.test(v);
        },
        message: 'Veuillez fournir une adresse email valide'
      }
    },
    phone: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || PHONE_FR_REGEX.test(v);
        },
        message: 'Veuillez fournir un numéro de téléphone valide'
      }
    },
    website: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || URL_REGEX.test(v);
        },
        message: 'Veuillez fournir une URL valide'
      }
    },
    logo: {
      type: String,
      trim: true
    },
    siret: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || SIRET_REGEX.test(v);
        },
        message: 'Veuillez fournir un numéro SIRET valide (14 chiffres)'
      }
    },
    vatNumber: {
      type: String,
      trim: true,
      validate: {
        validator: function(v) {
          // Validation uniquement si une valeur est fournie
          return !v || VAT_FR_REGEX.test(v);
        },
        message: 'Veuillez fournir un numéro de TVA valide (format FR)'
      }
    },
    address: addressSchema,
    bankDetails: bankDetailsSchema
  },
  resetPasswordToken: String,
  resetPasswordExpires: Date
}, {
  timestamps: true
});

// Pas besoin de définir un index pour email car il est déjà indexé via unique: true

/**
 * Hash du mot de passe avant sauvegarde
 */
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Méthode pour comparer les mots de passe
 * @param {string} candidatePassword - Mot de passe à vérifier
 * @returns {Promise<boolean>} - Résultat de la comparaison
 */
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
