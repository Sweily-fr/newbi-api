/**
 * Modèle pour les factures importées via OCR
 * Collection séparée des factures créées (pas de numérotation séquentielle)
 */

import mongoose from 'mongoose';

// Schéma pour les lignes de facture extraites par OCR
const importedInvoiceItemSchema = new mongoose.Schema({
  description: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  unitPrice: { type: Number, default: 0 },
  totalPrice: { type: Number, default: 0 },
  vatRate: { type: Number, default: 20 },
  productCode: { type: String, default: null },
}, { _id: false });

// Schéma pour les informations du fournisseur
const vendorInfoSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  postalCode: { type: String, default: '' },
  country: { type: String, default: 'France' },
  siret: { type: String, default: null },
  vatNumber: { type: String, default: null },
  email: { type: String, default: null },
  phone: { type: String, default: null },
}, { _id: false });

const importedInvoiceSchema = new mongoose.Schema({
  // Référence vers l'organisation/workspace
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  // Utilisateur qui a importé la facture
  importedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Statut spécifique aux factures importées
  status: {
    type: String,
    enum: [
      'PENDING_REVIEW',    // En attente de vérification
      'VALIDATED',         // Validée par l'utilisateur
      'REJECTED',          // Rejetée (erreur OCR, doublon, etc.)
      'ARCHIVED'           // Archivée
    ],
    default: 'VALIDATED',
    index: true
  },

  // Numéro de facture original (extrait par OCR)
  originalInvoiceNumber: {
    type: String,
    default: null,
    index: true
  },

  // Informations du fournisseur
  vendor: vendorInfoSchema,

  // Dates
  invoiceDate: {
    type: Date,
    default: null
  },
  dueDate: {
    type: Date,
    default: null
  },
  paymentDate: {
    type: Date,
    default: null
  },

  // Montants
  totalHT: {
    type: Number,
    default: 0
  },
  totalVAT: {
    type: Number,
    default: 0
  },
  totalTTC: {
    type: Number,
    required: true,
    default: 0
  },
  currency: {
    type: String,
    default: 'EUR'
  },

  // Lignes de facture
  items: [importedInvoiceItemSchema],

  // Catégorie de dépense
  category: {
    type: String,
    enum: [
      'OFFICE_SUPPLIES',
      'TRAVEL',
      'MEALS',
      'EQUIPMENT',
      'MARKETING',
      'TRAINING',
      'SERVICES',
      'RENT',
      'SALARIES',
      'UTILITIES',
      'INSURANCE',
      'SUBSCRIPTIONS',
      'OTHER'
    ],
    default: 'OTHER'
  },

  // Moyen de paiement
  paymentMethod: {
    type: String,
    enum: ['CARD', 'CASH', 'CHECK', 'TRANSFER', 'DIRECT_DEBIT', 'OTHER', 'UNKNOWN'],
    default: 'UNKNOWN'
  },

  // Fichier PDF original
  file: {
    url: { type: String, required: true },
    cloudflareKey: { type: String, required: true },
    originalFileName: { type: String, required: true },
    mimeType: { type: String, default: 'application/pdf' },
    fileSize: { type: Number, default: 0 }
  },

  // Données OCR
  ocrData: {
    extractedText: { type: String, default: '' },
    rawData: { type: mongoose.Schema.Types.Mixed, default: {} },
    financialAnalysis: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidence: { type: Number, default: 0 },
    processedAt: { type: Date, default: null }
  },

  // Notes utilisateur
  notes: {
    type: String,
    default: ''
  },

  // Référence à une dépense si liée
  linkedExpenseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Expense',
    default: null
  },

  // Marqueur de doublon potentiel
  isDuplicate: {
    type: Boolean,
    default: false
  },
  duplicateOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImportedInvoice',
    default: null
  }

}, {
  timestamps: true,
  collection: 'imported_invoices'
});

// Index composés pour les requêtes fréquentes
importedInvoiceSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
importedInvoiceSchema.index({ workspaceId: 1, 'vendor.name': 1 });
importedInvoiceSchema.index({ workspaceId: 1, invoiceDate: -1 });
importedInvoiceSchema.index({ workspaceId: 1, originalInvoiceNumber: 1 });

// Méthode pour valider une facture
importedInvoiceSchema.methods.validate = function() {
  this.status = 'VALIDATED';
  return this.save();
};

// Méthode pour rejeter une facture
importedInvoiceSchema.methods.reject = function(reason = '') {
  this.status = 'REJECTED';
  if (reason) {
    this.notes = `Rejetée: ${reason}`;
  }
  return this.save();
};

// Méthode pour archiver une facture
importedInvoiceSchema.methods.archive = function() {
  this.status = 'ARCHIVED';
  return this.save();
};

// Méthode statique pour trouver les doublons potentiels
importedInvoiceSchema.statics.findPotentialDuplicates = async function(workspaceId, invoiceNumber, vendorName, totalTTC) {
  const query = {
    workspaceId,
    status: { $ne: 'REJECTED' },
    $or: []
  };

  if (invoiceNumber) {
    query.$or.push({ originalInvoiceNumber: invoiceNumber });
  }

  if (vendorName && totalTTC) {
    query.$or.push({
      'vendor.name': { $regex: new RegExp(vendorName, 'i') },
      totalTTC: totalTTC
    });
  }

  if (query.$or.length === 0) {
    return [];
  }

  return this.find(query).limit(5);
};

// Méthode statique pour obtenir les statistiques
importedInvoiceSchema.statics.getStats = function(workspaceId) {
  return this.aggregate([
    { $match: { workspaceId: new mongoose.Types.ObjectId(workspaceId) } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$totalTTC' }
      }
    }
  ]);
};

const ImportedInvoice = mongoose.model('ImportedInvoice', importedInvoiceSchema);

export default ImportedInvoice;
