import mongoose from 'mongoose';
import addressSchema from './schemas/address.js';
import { EMAIL_REGEX, PHONE_REGEX, SIRET_REGEX, VAT_FR_REGEX, NAME_REGEX } from '../utils/validators.js';

/**
 * Schéma principal du client
 */
const clientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    match: [NAME_REGEX, 'Veuillez fournir un nom valide']
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: [EMAIL_REGEX, 'Veuillez fournir une adresse email valide']
  },
  phone: {
    type: String,
    trim: true,
    match: [PHONE_REGEX, 'Veuillez fournir un numéro de téléphone valide']
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
  // Type de client: 'INDIVIDUAL' (particulier) ou 'COMPANY' (entreprise)
  type: {
    type: String,
    enum: ['INDIVIDUAL', 'COMPANY'],
    default: 'COMPANY',
    required: true
  },
  // Champs spécifiques pour les entreprises
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
  // Pour les particuliers, on peut ajouter des champs spécifiques ici si nécessaire
  // Par exemple: firstName, lastName, etc.
  firstName: {
    type: String,
    trim: true
  },
  lastName: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
clientSchema.index({ createdBy: 1 });
clientSchema.index({ email: 1, createdBy: 1 }, { unique: true });
clientSchema.index({ name: 'text' }, { weights: { name: 10 } });

export default mongoose.model('Client', clientSchema);
