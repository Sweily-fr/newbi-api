import mongoose from 'mongoose';
import Invoice from './Invoice.js';
import Quote from './Quote.js';
import CreditNote from './CreditNote.js';
import PurchaseOrder from './PurchaseOrder.js';

const documentCounterSchema = new mongoose.Schema({
  documentType: {
    type: String,
    required: true,
    enum: ['invoice', 'quote', 'creditNote', 'purchaseOrder'],
  },
  prefix: { type: String, required: true },
  workspaceId: { type: String, required: true },
  year: { type: Number, required: true },
  lastNumber: { type: Number, default: 0 },
}, { timestamps: true });

documentCounterSchema.index(
  { documentType: 1, prefix: 1, workspaceId: 1, year: 1 },
  { unique: true }
);

/**
 * Obtient le prochain numéro séquentiel de manière atomique.
 * Utilise findOneAndUpdate avec $inc pour garantir l'atomicité.
 * Initialisation paresseuse : si le compteur vient d'être créé (upsert),
 * on initialise lastNumber à partir du max existant dans les documents.
 */
documentCounterSchema.statics.getNextNumber = async function (documentType, prefix, workspaceId, year, options = {}) {
  const session = options.session || null;
  const findOpts = session ? { session } : {};

  // Tenter d'incrémenter atomiquement le compteur
  const counter = await this.findOneAndUpdate(
    { documentType, prefix, workspaceId, year },
    { $inc: { lastNumber: 1 } },
    { new: true, upsert: true, ...findOpts }
  );

  // Si le compteur vient d'être créé (lastNumber === 1 après le $inc),
  // vérifier s'il y a des documents existants et ajuster
  if (counter.lastNumber === 1) {
    const existingMax = await getExistingMaxNumber(documentType, prefix, workspaceId, year, findOpts);

    if (existingMax > 0) {
      // Ajuster le compteur au max existant + 1
      const adjusted = await DocumentCounter.findOneAndUpdate(
        { documentType, prefix, workspaceId, year, lastNumber: 1 },
        { $set: { lastNumber: existingMax + 1 } },
        { new: true, ...findOpts }
      );
      // Si un autre processus a déjà ajusté entre-temps, utiliser la valeur actuelle
      return adjusted ? adjusted.lastNumber : counter.lastNumber;
    }
  }

  return counter.lastNumber;
};

/**
 * Cherche le numéro maximum existant parmi les documents finalisés
 * pour un type de document / préfixe / workspace / année donnés.
 */
async function getExistingMaxNumber(documentType, prefix, workspaceId, year, findOpts = {}) {
  const modelMap = {
    invoice: { model: Invoice, statuses: ['PENDING', 'COMPLETED', 'CANCELED'] },
    quote: { model: Quote, statuses: ['PENDING', 'COMPLETED', 'CANCELED'] },
    creditNote: { model: CreditNote, statuses: ['PENDING', 'COMPLETED', 'CANCELED'] },
    purchaseOrder: { model: PurchaseOrder, statuses: ['CONFIRMED', 'IN_PROGRESS', 'DELIVERED', 'CANCELED'] },
  };

  const { model, statuses } = modelMap[documentType];
  if (!model) return 0;

  const query = {
    status: { $in: statuses },
    workspaceId,
    $expr: { $eq: [{ $year: '$issueDate' }, year] },
  };

  if (prefix) {
    query.prefix = prefix;
  }

  const docs = await model.find(query, { number: 1 }, findOpts).lean();

  const numericNumbers = docs
    .map(doc => {
      if (doc.number && /^\d+$/.test(doc.number)) {
        return parseInt(doc.number, 10);
      }
      return null;
    })
    .filter(num => num !== null);

  return numericNumbers.length > 0 ? Math.max(...numericNumbers) : 0;
}

const DocumentCounter = mongoose.model('DocumentCounter', documentCounterSchema);

export default DocumentCounter;
