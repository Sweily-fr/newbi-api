/**
 * Modèle pour les devis importés via OCR
 * Collection séparée des devis créés (pas de numérotation séquentielle)
 */

import mongoose from 'mongoose';

const importedQuoteItemSchema = new mongoose.Schema({
  description: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  unitPrice: { type: Number, default: 0 },
  totalPrice: { type: Number, default: 0 },
  vatRate: { type: Number, default: 20 },
  productCode: { type: String, default: null },
}, { _id: false });

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

const clientInfoSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  postalCode: { type: String, default: '' },
  siret: { type: String, default: null },
  clientNumber: { type: String, default: null },
}, { _id: false });

const importedQuoteSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },

  importedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  status: {
    type: String,
    enum: [
      'PENDING_REVIEW',
      'VALIDATED',
      'REJECTED',
      'ARCHIVED'
    ],
    default: 'VALIDATED',
    index: true
  },

  originalQuoteNumber: {
    type: String,
    default: null,
    index: true
  },

  vendor: vendorInfoSchema,
  client: clientInfoSchema,

  quoteDate: {
    type: Date,
    default: null
  },
  validUntil: {
    type: Date,
    default: null
  },
  dueDate: {
    type: Date,
    default: null
  },

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

  items: [importedQuoteItemSchema],

  category: {
    type: String,
    enum: [
      'OFFICE_SUPPLIES', 'TRAVEL', 'MEALS', 'EQUIPMENT',
      'MARKETING', 'TRAINING', 'SERVICES', 'RENT',
      'SALARIES', 'UTILITIES', 'INSURANCE', 'SUBSCRIPTIONS', 'OTHER'
    ],
    default: 'OTHER'
  },

  paymentMethod: {
    type: String,
    enum: ['CARD', 'CASH', 'CHECK', 'TRANSFER', 'DIRECT_DEBIT', 'OTHER', 'UNKNOWN'],
    default: 'UNKNOWN'
  },

  file: {
    url: { type: String, required: true },
    cloudflareKey: { type: String, required: true },
    originalFileName: { type: String, required: true },
    mimeType: { type: String, default: 'application/pdf' },
    fileSize: { type: Number, default: 0 }
  },

  ocrData: {
    extractedText: { type: String, default: '' },
    rawData: { type: mongoose.Schema.Types.Mixed, default: {} },
    financialAnalysis: { type: mongoose.Schema.Types.Mixed, default: {} },
    confidence: { type: Number, default: 0 },
    processedAt: { type: Date, default: null }
  },

  notes: {
    type: String,
    default: ''
  },

  linkedExpenseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Expense',
    default: null
  },

  isDuplicate: {
    type: Boolean,
    default: false
  },
  duplicateOf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ImportedQuote',
    default: null
  }

}, {
  timestamps: true,
  collection: 'imported_quotes'
});

importedQuoteSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
importedQuoteSchema.index({ workspaceId: 1, 'vendor.name': 1 });
importedQuoteSchema.index({ workspaceId: 1, quoteDate: -1 });
importedQuoteSchema.index({ workspaceId: 1, originalQuoteNumber: 1 });

importedQuoteSchema.methods.validate = function() {
  this.status = 'VALIDATED';
  return this.save();
};

importedQuoteSchema.methods.reject = function(reason = '') {
  this.status = 'REJECTED';
  if (reason) {
    this.notes = `Rejeté: ${reason}`;
  }
  return this.save();
};

importedQuoteSchema.methods.archive = function() {
  this.status = 'ARCHIVED';
  return this.save();
};

importedQuoteSchema.statics.findPotentialDuplicates = async function(workspaceId, quoteNumber, vendorName, totalTTC) {
  const query = {
    workspaceId,
    status: { $ne: 'REJECTED' },
    $or: []
  };

  if (quoteNumber) {
    query.$or.push({ originalQuoteNumber: quoteNumber });
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

importedQuoteSchema.statics.getStats = function(workspaceId) {
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

const ImportedQuote = mongoose.model('ImportedQuote', importedQuoteSchema);

export default ImportedQuote;
