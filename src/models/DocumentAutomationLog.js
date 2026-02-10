import mongoose from 'mongoose';

/**
 * Schéma pour les logs d'exécution des automatisations de documents
 * Permet de tracker les imports et éviter les doublons
 */
const documentAutomationLogSchema = new mongoose.Schema({
  automationId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'DocumentAutomation'
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Organization'
  },
  sourceDocumentType: {
    type: String,
    required: true,
    enum: ['invoice', 'quote', 'creditNote', 'expense']
  },
  sourceDocumentId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  sourceDocumentNumber: {
    type: String,
    default: ''
  },
  sharedDocumentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SharedDocument',
    default: null
  },
  targetFolderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SharedFolder',
    default: null
  },
  targetFolderName: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['SUCCESS', 'FAILED', 'DUPLICATE_SKIPPED'],
    default: 'SUCCESS'
  },
  error: {
    type: String,
    default: null
  },
  fileName: {
    type: String,
    default: ''
  },
  fileSize: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index unique pour empêcher le double import du même document pour la même automatisation
documentAutomationLogSchema.index(
  { sourceDocumentType: 1, sourceDocumentId: 1, automationId: 1 },
  { unique: true }
);
documentAutomationLogSchema.index({ workspaceId: 1 });
documentAutomationLogSchema.index({ automationId: 1 });
documentAutomationLogSchema.index({ status: 1 });
documentAutomationLogSchema.index({ createdAt: -1 });

export default mongoose.model('DocumentAutomationLog', documentAutomationLogSchema);
