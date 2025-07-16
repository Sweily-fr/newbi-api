import mongoose from 'mongoose';
import { isValidFooterNotes } from '../utils/validators.js';

/**
 * Schéma pour les paramètres globaux des documents (factures et devis)
 */
const documentSettingsSchema = new mongoose.Schema({
  // Type de document (INVOICE ou QUOTE)
  documentType: {
    type: String,
    enum: ['INVOICE', 'QUOTE'],
    required: true
  },
  
  // Notes d'en-tête par défaut
  defaultHeaderNotes: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 1000;
      },
      message: 'Les notes d\'en-tête ne doivent pas dépasser 1000 caractères'
    }
  },
  
  // Notes de bas de page par défaut
  defaultFooterNotes: {
    type: String,
    trim: true,
    validate: {
      validator: isValidFooterNotes,
      message: 'Les notes de bas de page ne doivent pas dépasser 2000 caractères ou contiennent des caractères non autorisés'
    }
  },
  
  // Conditions générales par défaut
  defaultTermsAndConditions: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 2000;
      },
      message: 'Les conditions générales ne doivent pas dépasser 2000 caractères'
    }
  },
  
  // Titre du lien des conditions générales par défaut
  defaultTermsAndConditionsLinkTitle: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        return !value || value.length <= 100;
      },
      message: 'Le titre du lien des conditions générales ne doit pas dépasser 100 caractères'
    }
  },
  
  // Lien des conditions générales par défaut
  defaultTermsAndConditionsLink: {
    type: String,
    trim: true,
    validate: {
      validator: function(value) {
        if (!value) return true;
        return /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/.test(value);
      },
      message: 'Veuillez fournir une URL valide pour le lien des conditions générales'
    }
  },
  
  // Utilisateur propriétaire des paramètres
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances des recherches
documentSettingsSchema.index({ createdBy: 1, documentType: 1 }, { unique: true });

export default mongoose.model('DocumentSettings', documentSettingsSchema);
