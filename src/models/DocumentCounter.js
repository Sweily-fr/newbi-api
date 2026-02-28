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
 * Vérifie toujours la cohérence entre le compteur et les documents existants
 * pour gérer les cas de suppression de documents.
 */
documentCounterSchema.statics.getNextNumber = async function (documentType, prefix, workspaceId, year, options = {}) {
  const session = options.session || null;
  const findOpts = session ? { session } : {};

  // Vérifier le max existant dans les documents réels
  const existingMax = await getExistingMaxNumber(documentType, prefix, workspaceId, year, findOpts);

  // Récupérer le compteur actuel (sans incrémenter encore)
  const currentCounter = await this.findOne(
    { documentType, prefix, workspaceId, year },
    null,
    findOpts
  );

  // Si le compteur est désynchronisé (en avance par rapport aux documents réels),
  // le réinitialiser au max existant avant d'incrémenter
  if (currentCounter && currentCounter.lastNumber > existingMax) {
    await this.findOneAndUpdate(
      { documentType, prefix, workspaceId, year },
      { $set: { lastNumber: existingMax } },
      findOpts
    );
  }

  // Incrémenter atomiquement le compteur
  const counter = await this.findOneAndUpdate(
    { documentType, prefix, workspaceId, year },
    { $inc: { lastNumber: 1 } },
    { new: true, upsert: true, ...findOpts }
  );

  // Si le compteur vient d'être créé par upsert et qu'il y a des documents existants,
  // ajuster au max existant + 1
  if (counter.lastNumber === 1 && existingMax > 0) {
    const adjusted = await this.findOneAndUpdate(
      { documentType, prefix, workspaceId, year, lastNumber: 1 },
      { $set: { lastNumber: existingMax + 1 } },
      { new: true, ...findOpts }
    );
    return adjusted ? adjusted.lastNumber : counter.lastNumber;
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
