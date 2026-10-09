import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";
import { workspaceKey } from "../dataloaders/index.js";

/**
 * Lectures des documents liés (factures, devis, BL, BC) pour les résolveurs de
 * champ des listes de devis, bons de commande et bons de livraison. Elles
 * passent par les DataLoaders de la requête (context.loaders) : une requête
 * Mongo pour toute la liste au lieu de 2 à 3 par ligne. Le contrôle d'espace
 * de travail des anciennes requêtes scopées est conservé. Hors requête GraphQL
 * (pas de loaders), repli sur la requête directe d'origine.
 */

const refId = (value) => value?._id ?? value;
const inWorkspace = (doc, workspaceId) =>
  Boolean(doc) && String(doc.workspaceId) === String(workspaceId);

export async function loadWorkspaceInvoice(context, invoiceId, workspaceId) {
  const id = refId(invoiceId);
  if (!id) return null;
  const loader = context?.loaders?.invoiceById;
  if (!loader) return Invoice.findOne({ _id: id, workspaceId });
  const invoice = await loader.load(String(id));
  return inWorkspace(invoice, workspaceId) ? invoice : null;
}

export async function loadWorkspaceInvoices(context, invoiceIds, workspaceId) {
  const ids = (invoiceIds || []).map(refId).filter(Boolean);
  if (ids.length === 0) return [];
  const loader = context?.loaders?.invoiceById;
  if (!loader) return Invoice.find({ _id: { $in: ids }, workspaceId });
  const invoices = await loader.loadMany(ids.map(String));
  return invoices.filter(
    (invoice) =>
      !(invoice instanceof Error) && inWorkspace(invoice, workspaceId),
  );
}

export async function loadWorkspaceQuote(context, quoteId, workspaceId) {
  const id = refId(quoteId);
  if (!id) return null;
  const loader = context?.loaders?.quoteById;
  if (!loader) return Quote.findOne({ _id: id, workspaceId });
  const quote = await loader.load(String(id));
  return inWorkspace(quote, workspaceId) ? quote : null;
}

export async function loadQuoteDeliveryNotes(context, quote) {
  const loader = context?.loaders?.deliveryNotesBySourceQuote;
  if (!loader) {
    return DeliveryNote.find({
      sourceQuote: quote._id,
      workspaceId: quote.workspaceId,
    }).sort({ createdAt: -1 });
  }
  return loader.load(workspaceKey(quote.workspaceId, quote._id));
}

export async function quoteHasInvoicedPurchaseOrder(context, quote) {
  const loader = context?.loaders?.quoteHasInvoicedPurchaseOrder;
  if (!loader) {
    const count = await PurchaseOrder.countDocuments({
      sourceQuoteId: quote._id,
      workspaceId: quote.workspaceId,
      linkedInvoices: { $exists: true, $not: { $size: 0 } },
    });
    return count > 0;
  }
  return loader.load(workspaceKey(quote.workspaceId, quote._id));
}
