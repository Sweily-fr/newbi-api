import mongoose from 'mongoose';

/**
 * Schéma pour les logs d'envoi d'emails CRM automatiques
 * Permet de tracker les emails envoyés et éviter les doublons
 */
const crmEmailAutomationLogSchema = new mongoose.Schema({
  // Référence à l'automatisation
  automationId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'CrmEmailAutomation'
  },
  // Référence au client
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Client'
  },
  // Référence à l'espace de travail
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Organization'
  },
  // Date du champ personnalisé qui a déclenché l'envoi
  triggerDate: {
    type: Date,
    required: true
  },
  // Email du destinataire
  recipientEmail: {
    type: String,
    required: true
  },
  // Objet de l'email envoyé
  emailSubject: {
    type: String,
    required: true
  },
  // Corps de l'email envoyé
  emailBody: {
    type: String,
    required: true
  },
  // Statut de l'envoi
  status: {
    type: String,
    enum: ['SENT', 'FAILED', 'PENDING'],
    default: 'PENDING'
  },
  // Message d'erreur si échec
  error: {
    type: String,
    default: null
  },
  // Date d'envoi
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index pour améliorer les performances et éviter les doublons
crmEmailAutomationLogSchema.index({ automationId: 1, clientId: 1, triggerDate: 1 }, { unique: true });
crmEmailAutomationLogSchema.index({ workspaceId: 1 });
crmEmailAutomationLogSchema.index({ status: 1 });
crmEmailAutomationLogSchema.index({ sentAt: -1 });

export default mongoose.model('CrmEmailAutomationLog', crmEmailAutomationLogSchema);
