import mongoose from 'mongoose';

/**
 * Schéma pour les automatisations CRM
 * Permet de définir des règles automatiques pour déplacer des clients entre listes
 */
const clientAutomationSchema = new mongoose.Schema({
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
  // Type de déclencheur
  triggerType: {
    type: String,
    required: true,
    enum: [
      'FIRST_INVOICE_PAID',      // Première facture payée
      'INVOICE_PAID',            // N'importe quelle facture payée
      'QUOTE_ACCEPTED',          // Devis accepté
      'CLIENT_CREATED',          // Client créé
      'INVOICE_OVERDUE',         // Facture en retard
    ]
  },
  // Configuration du déclencheur (optionnel, pour des conditions supplémentaires)
  triggerConfig: {
    // Pour INVOICE_PAID: montant minimum, etc.
    minAmount: {
      type: Number,
      default: null
    },
    // Nombre de jours pour INVOICE_OVERDUE
    daysOverdue: {
      type: Number,
      default: 30
    }
  },
  // Action à effectuer
  actionType: {
    type: String,
    required: true,
    enum: [
      'MOVE_TO_LIST',           // Déplacer vers une liste
      'ADD_TO_LIST',            // Ajouter à une liste (sans retirer des autres)
      'REMOVE_FROM_LIST',       // Retirer d'une liste
    ]
  },
  // Liste source (optionnel - si on veut filtrer les clients d'une liste spécifique)
  sourceListId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClientList',
    default: null
  },
  // Liste cible pour l'action
  targetListId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ClientList',
    required: true
  },
  // Statut de l'automatisation
  isActive: {
    type: Boolean,
    default: true
  },
  // Statistiques d'exécution
  stats: {
    totalExecutions: {
      type: Number,
      default: 0
    },
    lastExecutedAt: {
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
clientAutomationSchema.index({ workspaceId: 1 });
clientAutomationSchema.index({ workspaceId: 1, triggerType: 1, isActive: 1 });
clientAutomationSchema.index({ createdBy: 1 });

export default mongoose.model('ClientAutomation', clientAutomationSchema);
