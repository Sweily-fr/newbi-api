import mongoose from 'mongoose';

/**
 * Schéma pour les automatisations d'envoi d'email CRM
 * Permet d'envoyer des emails automatiques basés sur des champs personnalisés de type Date
 */
const crmEmailAutomationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Le nom de l\'automatisation est requis'],
    trim: true,
    minlength: [2, 'Le nom doit contenir au moins 2 caractères'],
    maxlength: [100, 'Le nom ne peut pas dépasser 100 caractères']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, 'La description ne peut pas dépasser 500 caractères'],
    default: ''
  },
  // Référence à l'espace de travail
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Organization'
  },
  // Utilisateur qui a créé l'automatisation
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  // Champ personnalisé de type Date sur lequel se baser
  customFieldId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'ClientCustomField'
  },
  // Configuration du timing
  timing: {
    // Type de déclenchement: ON_DATE, BEFORE_DATE, AFTER_DATE
    type: {
      type: String,
      required: true,
      enum: ['ON_DATE', 'BEFORE_DATE', 'AFTER_DATE'],
      default: 'ON_DATE'
    },
    // Nombre de jours avant/après la date (0 = le jour même)
    daysOffset: {
      type: Number,
      default: 0,
      min: 0,
      max: 365
    },
    // Heure d'envoi (0-23)
    sendHour: {
      type: Number,
      default: 9,
      min: 0,
      max: 23
    }
  },
  // Configuration de l'email
  email: {
    // Nom de l'expéditeur
    fromName: {
      type: String,
      default: ''
    },
    // Email de l'expéditeur
    fromEmail: {
      type: String,
      default: ''
    },
    // Email de réponse
    replyTo: {
      type: String,
      default: ''
    },
    // Objet de l'email (supporte les variables)
    subject: {
      type: String,
      required: true,
      default: 'Rappel - {customFieldName}'
    },
    // Corps de l'email (supporte les variables)
    body: {
      type: String,
      required: true,
      default: `Bonjour {clientName},

Nous vous rappelons que la date de {customFieldName} est prévue pour le {customFieldValue}.

Cordialement,
{companyName}`
    }
  },
  // Statut de l'automatisation
  isActive: {
    type: Boolean,
    default: true
  },
  // Statistiques d'exécution
  stats: {
    totalSent: {
      type: Number,
      default: 0
    },
    lastSentAt: {
      type: Date,
      default: null
    },
    lastClientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Client',
      default: null
    }
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances
crmEmailAutomationSchema.index({ workspaceId: 1 });
crmEmailAutomationSchema.index({ workspaceId: 1, isActive: 1 });
crmEmailAutomationSchema.index({ customFieldId: 1 });
crmEmailAutomationSchema.index({ createdBy: 1 });

export default mongoose.model('CrmEmailAutomation', crmEmailAutomationSchema);
