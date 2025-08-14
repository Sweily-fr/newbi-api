/**
 * Modèle pour les documents OCR traités
 */

import mongoose from 'mongoose';

const ocrDocumentSchema = new mongoose.Schema({
  // Référence vers l'organisation/workspace (Better Auth)
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  // Référence utilisateur (pour audit trail)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Informations du fichier original
  originalFileName: {
    type: String,
    required: true
  },
  
  mimeType: {
    type: String,
    required: true
  },
  
  fileSize: {
    type: Number,
    required: true
  },

  // URL Cloudflare R2
  documentUrl: {
    type: String,
    required: true
  },
  
  cloudflareKey: {
    type: String,
    required: true
  },

  // Résultats OCR
  extractedText: {
    type: String,
    required: true,
    default: 'Aucun texte extrait' // Valeur par défaut si l'OCR ne retourne rien
  },

  // Données brutes de Mistral
  rawOcrData: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },

  // Données structurées extraites (format flexible)
  structuredData: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Analyse financière automatique
  financialAnalysis: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Données structurées legacy (pour compatibilité)
  legacyStructuredData: {
    // Montant extrait
    amount: {
      type: Number,
      default: null
    },
    
    // Date extraite
    date: {
      type: String,
      default: null
    },
    
    // Commerçant/Magasin
    merchant: {
      type: String,
      default: null
    },
    
    // Description des articles
    description: {
      type: String,
      default: null
    },
    
    // Catégorie devinée
    category: {
      type: String,
      default: 'divers'
    },
    
    // Moyen de paiement
    paymentMethod: {
      type: String,
      enum: ['CARD', 'CASH', 'CHECK', 'TRANSFER'],
      default: 'CARD'
    },
    
    // Niveau de confiance
    confidence: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium'
    }
  },

  // Type de document
  documentType: {
    type: String,
    enum: ['receipt', 'invoice', 'other'],
    default: 'receipt'
  },

  // Statut du traitement
  status: {
    type: String,
    enum: ['processing', 'completed', 'failed'],
    default: 'completed'
  },

  // Métadonnées de traitement
  processingMetadata: {
    processedAt: {
      type: Date,
      default: Date.now
    },
    
    ocrProvider: {
      type: String,
      default: 'mistral'
    },
    
    processingDuration: {
      type: Number, // en millisecondes
      default: null
    }
  },

  // Utilisation du document
  usage: {
    // Si le document a été utilisé pour créer une dépense
    usedForExpense: {
      type: Boolean,
      default: false
    },
    
    // Référence à la dépense créée
    expenseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Expense',
      default: null
    },
    
    // Date d'utilisation
    usedAt: {
      type: Date,
      default: null
    }
  }

}, {
  timestamps: true, // Ajoute createdAt et updatedAt automatiquement
  collection: 'ocr_documents'
});

// Index pour les requêtes fréquentes
// Index composés workspace + autres champs
ocrDocumentSchema.index({ workspaceId: 1, createdAt: -1 });
ocrDocumentSchema.index({ workspaceId: 1, documentType: 1 });
ocrDocumentSchema.index({ workspaceId: 1, 'usage.usedForExpense': 1 });
// Index legacy pour la migration
ocrDocumentSchema.index({ userId: 1, createdAt: -1 });

// Méthodes d'instance
ocrDocumentSchema.methods.markAsUsedForExpense = function(expenseId) {
  this.usage.usedForExpense = true;
  this.usage.expenseId = expenseId;
  this.usage.usedAt = new Date();
  return this.save();
};

// Méthodes statiques
ocrDocumentSchema.statics.findByUser = function(userId, options = {}) {
  const query = { userId };
  
  if (options.documentType) {
    query.documentType = options.documentType;
  }
  
  if (options.unused) {
    query['usage.usedForExpense'] = false;
  }
  
  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50);
};

ocrDocumentSchema.statics.getProcessingStats = function(userId) {
  return this.aggregate([
    { $match: { userId: mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        avgProcessingTime: { $avg: '$processingMetadata.processingDuration' }
      }
    }
  ]);
};

const OcrDocument = mongoose.model('OcrDocument', ocrDocumentSchema);

export default OcrDocument;
