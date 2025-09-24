import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import {
  EMAIL_REGEX,
  SIRET_REGEX,
  VAT_FR_REGEX,
  PHONE_FR_REGEX,
  NAME_REGEX,
  URL_REGEX,
  STRONG_PASSWORD_REGEX,
  CAPITAL_SOCIAL_REGEX,
  RCS_REGEX,
  isFieldRequiredForCompanyStatus,
} from "../utils/validators.js";
import addressSchema from "./schemas/address.js";
import bankDetailsSchema from "./schemas/bankDetails.js";

/**
 * Schéma utilisateur principal
 */
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [EMAIL_REGEX, "Veuillez fournir une adresse email valide"],
    },
    password: {
      type: String,
      required: true,
      minlength: [6, "Le mot de passe doit contenir au moins 6 caractères"],
      validate: {
        validator: function (value) {
          // Validation uniquement à la création, pas à la mise à jour (car le mot de passe est hashé)
          if (this.isNew) {
            return STRONG_PASSWORD_REGEX.test(value);
          }
          return true;
        },
        message:
          "Le mot de passe doit contenir au moins 8 caractères, une majuscule, une minuscule, un chiffre et un caractère spécial",
      },
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    isDisabled: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: String,
    subscription: {
      licence: {
        type: Boolean,
        default: true,
      },
      trial: {
        type: Boolean,
        default: false,
      },
      stripeCustomerId: {
        type: String,
        sparse: true,
      },
      // Nouveaux champs pour la période d'essai de 14 jours
      trialStartDate: {
        type: Date,
        default: null,
      },
      trialEndDate: {
        type: Date,
        default: null,
      },
      isTrialActive: {
        type: Boolean,
        default: false,
      },
      hasUsedTrial: {
        type: Boolean,
        default: false,
      },
    },
    emailVerificationExpires: Date,
    profile: {
      firstName: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || NAME_REGEX.test(v);
          },
          message:
            "Le prénom ne doit contenir que des lettres, espaces, tirets ou apostrophes (2-50 caractères)",
        },
      },
      lastName: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || NAME_REGEX.test(v);
          },
          message:
            "Le nom ne doit contenir que des lettres, espaces, tirets ou apostrophes (2-50 caractères)",
        },
      },
      phone: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || PHONE_FR_REGEX.test(v);
          },
          message: "Veuillez fournir un numéro de téléphone valide",
        },
      },
      profilePicture: {
        type: String,
        trim: true,
      },
      profilePictureUrl: {
        type: String,
        trim: true,
      },
      profilePictureKey: {
        type: String,
        trim: true,
      },
    },
    company: {
      name: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || NAME_REGEX.test(v);
          },
          message: "Veuillez fournir un nom de entreprise valide",
        },
      },
      email: {
        type: String,
        trim: true,
        lowercase: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || EMAIL_REGEX.test(v);
          },
          message: "Veuillez fournir une adresse email valide",
        },
      },
      phone: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || PHONE_FR_REGEX.test(v);
          },
          message: "Veuillez fournir un numéro de téléphone valide",
        },
      },
      website: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Validation uniquement si une valeur est fournie
            return !v || URL_REGEX.test(v);
          },
          message: "Veuillez fournir une URL valide",
        },
      },
      logo: {
        type: String,
        trim: true,
      },
      siret: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Si aucune valeur n'est fournie, vérifier si elle est obligatoire selon le statut
            if (!v) {
              // Vérifier si le champ est obligatoire pour ce statut juridique
              if (
                this.company &&
                this.company.companyStatus &&
                isFieldRequiredForCompanyStatus(
                  "siret",
                  this.company.companyStatus
                )
              ) {
                return false;
              }
              // Sinon c'est valide (champ optionnel)
              return true;
            }

            // Si une valeur est fournie, vérifier qu'elle est au bon format
            return SIRET_REGEX.test(v);
          },
          message:
            "Le numéro SIRET est obligatoire pour ce statut juridique et doit être valide (14 chiffres)",
        },
      },
      vatNumber: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Si aucune valeur n'est fournie, vérifier si elle est obligatoire selon le statut
            if (!v) {
              // Vérifier si le champ est obligatoire pour ce statut juridique
              if (
                this.company &&
                this.company.companyStatus &&
                isFieldRequiredForCompanyStatus(
                  "vatNumber",
                  this.company.companyStatus
                )
              ) {
                return false;
              }
              // Sinon c'est valide (champ optionnel)
              return true;
            }

            // Si une valeur est fournie, vérifier qu'elle est au bon format
            return VAT_FR_REGEX.test(v);
          },
          message:
            "Le numéro de TVA est obligatoire pour ce statut juridique et doit être valide (format FR)",
        },
      },
      transactionCategory: {
        type: String,
        enum: ["GOODS", "SERVICES", "MIXED"],
        default: "SERVICES",
      },
      vatPaymentCondition: {
        type: String,
        enum: ["ENCAISSEMENTS", "DEBITS", "EXONERATION", "NONE"],
        default: "NONE",
      },
      companyStatus: {
        type: String,
        enum: [
          "SARL",
          "SAS",
          "EURL",
          "SASU",
          "EI",
          "EIRL",
          "SA",
          "SNC",
          "SCI",
          "SCOP",
          "ASSOCIATION",
          "AUTO_ENTREPRENEUR",
          "AUTRE",
        ],
        default: "AUTRE",
      },
      capitalSocial: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Si aucune valeur n'est fournie, vérifier si elle est obligatoire selon le statut
            if (!v) {
              // Vérifier si le champ est obligatoire pour ce statut juridique
              if (
                this.company &&
                this.company.companyStatus &&
                isFieldRequiredForCompanyStatus(
                  "capitalSocial",
                  this.company.companyStatus
                )
              ) {
                return false;
              }
              // Sinon c'est valide (champ optionnel)
              return true;
            }

            // Si une valeur est fournie, vérifier qu'elle est au bon format
            return CAPITAL_SOCIAL_REGEX.test(v);
          },
          message:
            "Le capital social est obligatoire pour ce statut juridique et doit être valide (ex: 10000)",
        },
      },
      rcs: {
        type: String,
        trim: true,
        validate: {
          validator: function (v) {
            // Si aucune valeur n'est fournie, vérifier si elle est obligatoire selon le statut
            if (!v) {
              // Vérifier si le champ est obligatoire pour ce statut juridique
              if (
                this.company &&
                this.company.companyStatus &&
                isFieldRequiredForCompanyStatus(
                  "rcs",
                  this.company.companyStatus
                )
              ) {
                return false;
              }
              // Sinon c'est valide (champ optionnel)
              return true;
            }

            // Si une valeur est fournie, vérifier qu'elle est au bon format
            return RCS_REGEX.test(v);
          },
          message:
            "Le RCS est obligatoire pour ce statut juridique et doit être valide (ex: Paris B 123 456 789)",
        },
      },
      address: addressSchema,
      bankDetails: bankDetailsSchema,
    },
    // Champs pour l'intégration Bridge API
    bridgeWorkspaceId: {
      type: String,
      sparse: true, // Index sparse pour éviter les conflits avec les valeurs null
      index: true,
    },
    bridgeCreatedAt: {
      type: Date,
    },
    resetPasswordToken: String,
    resetPasswordExpires: Date,
    
    // Champs pour le système de parrainage
    referralCode: {
      type: String,
      unique: true,
      sparse: true, // Index sparse pour éviter les conflits avec les valeurs null
      index: true,
    },
    referredBy: {
      type: String,
      index: true, // Index pour optimiser les recherches de filleuls
    },
    referralEarnings: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

// Pas besoin de définir un index pour email car il est déjà indexé via unique: true

/**
 * Hash du mot de passe avant sauvegarde
 */
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * Middleware pour démarrer automatiquement la période d'essai lors de la création d'un utilisateur
 */
userSchema.pre("save", async function (next) {
  // Démarrer la période d'essai seulement lors de la création d'un nouvel utilisateur
  if (this.isNew && !this.subscription.hasUsedTrial) {
    try {
      const now = new Date();
      const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 jours

      this.subscription.trialStartDate = now;
      this.subscription.trialEndDate = trialEnd;
      this.subscription.isTrialActive = true;
      this.subscription.hasUsedTrial = true;
      this.subscription.licence = true; // Accès complet pendant l'essai
    } catch (error) {
      return next(error);
    }
  }
  next();
});

/**
 * Méthode pour comparer les mots de passe
 * @param {string} candidatePassword - Mot de passe à vérifier
 * @returns {Promise<boolean>} - Résultat de la comparaison
 */
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

/**
 * Méthode pour démarrer la période d'essai de 14 jours
 * @returns {Promise<void>}
 */
userSchema.methods.startTrial = async function () {
  if (this.subscription.hasUsedTrial) {
    throw new Error("L'utilisateur a déjà utilisé sa période d'essai");
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 jours

  this.subscription.trialStartDate = now;
  this.subscription.trialEndDate = trialEnd;
  this.subscription.isTrialActive = true;
  this.subscription.hasUsedTrial = true;
  this.subscription.licence = true; // Accès complet pendant l'essai

  await this.save();
};

/**
 * Méthode pour vérifier si la période d'essai est encore valide
 * @returns {boolean}
 */
userSchema.methods.isTrialValid = function () {
  if (!this.subscription.isTrialActive || !this.subscription.trialEndDate) {
    return false;
  }

  const now = new Date();
  return now < this.subscription.trialEndDate;
};

/**
 * Méthode pour terminer la période d'essai
 * @returns {Promise<void>}
 */
userSchema.methods.endTrial = async function () {
  this.subscription.isTrialActive = false;
  this.subscription.licence = false; // Retirer l'accès après l'essai
  await this.save();
};

/**
 * Méthode pour obtenir les jours restants de la période d'essai
 * @returns {number} - Nombre de jours restants (0 si expiré)
 */
userSchema.methods.getTrialDaysRemaining = function () {
  if (!this.subscription.isTrialActive || !this.subscription.trialEndDate) {
    return 0;
  }

  const now = new Date();
  const diffTime = this.subscription.trialEndDate - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return Math.max(0, diffDays);
};

/**
 * Méthode pour vérifier si l'utilisateur a accès aux fonctionnalités premium
 * @returns {boolean}
 */
userSchema.methods.hasPremiumAccess = function () {
  // Accès si abonnement payant actif OU période d'essai valide
  const hasLicence = Boolean(this.subscription?.licence);
  const hasStripeSubscription = Boolean(this.subscription?.stripeCustomerId);
  const hasValidTrial = this.isTrialValid();
  
  return hasLicence && (hasValidTrial || hasStripeSubscription);
};

export default mongoose.model("User", userSchema, "user");
