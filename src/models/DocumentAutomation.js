import mongoose from 'mongoose';

/**
 * Schéma pour les automatisations de documents partagés
 * Permet de définir des règles automatiques pour importer des documents
 * dans les dossiers partagés lors de changements de statut
 */
const documentAutomationSchema = new mongoose.Schema({
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
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'Organization'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: 'User'
  },
  triggerType: {
    type: String,
    required: true,
    enum: [
      'INVOICE_DRAFT',
      'INVOICE_SENT',
      'INVOICE_PAID',
      'INVOICE_OVERDUE',
      'INVOICE_CANCELED',
      'QUOTE_DRAFT',
      'QUOTE_SENT',
      'QUOTE_ACCEPTED',
      'QUOTE_CANCELED',
      'CREDIT_NOTE_CREATED',
      'INVOICE_IMPORTED',
      'QUOTE_IMPORTED',
      'PURCHASE_ORDER_DRAFT',
      'PURCHASE_ORDER_CONFIRMED',
      'PURCHASE_ORDER_IN_PROGRESS',
      'PURCHASE_ORDER_DELIVERED',
      'PURCHASE_ORDER_CANCELED',
      'PURCHASE_INVOICE_TO_PROCESS',
      'PURCHASE_INVOICE_TO_PAY',
      'PURCHASE_INVOICE_PENDING',
      'PURCHASE_INVOICE_PAID',
      'PURCHASE_INVOICE_OVERDUE',
      'PURCHASE_INVOICE_ARCHIVED',
      'TRANSACTION_RECEIPT',
    ]
  },
  actionConfig: {
    targetFolderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SharedFolder',
      required: true
    },
    createSubfolder: {
      type: Boolean,
      default: false
    },
    subfolderPattern: {
      type: String,
      default: '{year}',
      enum: ['{year}', '{month}', '{year}/{month}', '{clientName}', '{year}/{clientName}']
    },
    documentNaming: {
      type: String,
      default: '{documentType}-{number}-{clientName}'
    },
    tags: [{
      type: String,
      trim: true
    }],
    documentStatus: {
      type: String,
      enum: ['pending', 'classified', 'archived'],
      default: 'classified'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  stats: {
    totalExecutions: {
      type: Number,
      default: 0
    },
    lastExecutedAt: {
      type: Date,
      default: null
    },
    lastDocumentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SharedDocument',
      default: null
    },
    failedExecutions: {
      type: Number,
      default: 0
    }
  }
}, {
  timestamps: true
});

documentAutomationSchema.index({ workspaceId: 1 });
documentAutomationSchema.index({ workspaceId: 1, triggerType: 1, isActive: 1 });
documentAutomationSchema.index({ createdBy: 1 });

export default mongoose.model('DocumentAutomation', documentAutomationSchema);
