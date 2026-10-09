import DataLoader from "dataloader";
import mongoose from "mongoose";
import User from "../models/User.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import Client from "../models/Client.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import Transaction from "../models/Transaction.js";

/**
 * Clé composite « espace:document » des loaders scopés par espace de travail.
 * Le batch regroupe les clés par espace et fait une requête par espace (une
 * seule en pratique), filtrée sur workspaceId comme les requêtes qu'il remplace.
 */
export const workspaceKey = (workspaceId, id) => `${workspaceId}:${id}`;

// Les clés dont l'espace n'est pas un ObjectId valide (document ancien sans
// workspaceId) sont écartées : leur résultat reste vide, au lieu d'une erreur
// de conversion qui ferait échouer le lot entier.
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const groupByWorkspace = (keys) => {
  const groups = new Map();
  for (const key of keys) {
    const [workspaceId, id] = key.split(":");
    if (!OBJECT_ID_RE.test(workspaceId)) continue;
    if (!groups.has(workspaceId)) groups.set(workspaceId, []);
    groups.get(workspaceId).push(id);
  }
  return groups;
};

// Champs lus par les résolveurs Transaction.linked* (banking.js) : projection
// partagée entre les loaders et leur repli hors contexte GraphQL.
export const LINKED_INVOICE_FIELDS =
  "number prefix status client.name client.firstName client.lastName finalTotalTTC totalTTC issueDate dueDate";
export const LINKED_PURCHASE_INVOICE_FIELDS =
  "invoiceNumber supplierName status amountTTC issueDate ocrMetadata.extractionQuality files";
export const LINKED_IMPORTED_INVOICE_FIELDS =
  "originalInvoiceNumber status client.name vendor.name totalTTC invoiceDate dueDate source file";
export const LINK_USER_FIELDS = "profile.firstName profile.lastName email";

// Loader « par identifiant » en lecture légère (lean + projection).
const leanByIdLoader = (Model, fields) =>
  new DataLoader(async (ids) => {
    const docs = await Model.find({ _id: { $in: ids } })
      .select(fields)
      .lean();
    const map = new Map(docs.map((d) => [d._id.toString(), d]));
    return ids.map((id) => map.get(String(id)) || null);
  });

/**
 * Crée les DataLoaders pour une requête GraphQL.
 * Chaque requête HTTP doit avoir ses propres instances (cache par requête).
 * Note : pas de .lean() pour que Mongoose gère la conversion _id → id automatiquement.
 */
export function createDataLoaders() {
  return {
    userById: new DataLoader(async (ids) => {
      const users = await User.find({ _id: { $in: ids } });
      const map = new Map(users.map((u) => [u._id.toString(), u]));
      return ids.map((id) => map.get(id.toString()) || null);
    }),

    invoiceById: new DataLoader(async (ids) => {
      const invoices = await Invoice.find({ _id: { $in: ids } });
      const map = new Map(invoices.map((i) => [i._id.toString(), i]));
      return ids.map((id) => map.get(id.toString()) || null);
    }),

    invoicesByIds: new DataLoader(
      async (idArrays) => {
        const allIds = [...new Set(idArrays.flat().map((id) => id.toString()))];
        const invoices = await Invoice.find({ _id: { $in: allIds } });
        const map = new Map(invoices.map((i) => [i._id.toString(), i]));

        return idArrays.map((ids) =>
          (ids || []).map((id) => map.get(id.toString())).filter(Boolean),
        );
      },
      { cacheKeyFn: (ids) => JSON.stringify(ids.map(String).sort()) },
    ),

    quoteById: new DataLoader(async (ids) => {
      const quotes = await Quote.find({ _id: { $in: ids } });
      const map = new Map(quotes.map((q) => [q._id.toString(), q]));
      return ids.map((id) => map.get(id.toString()) || null);
    }),

    // Bons de livraison issus de chaque devis (Quote.linkedDeliveryNotes) :
    // une requête pour toute une liste de devis au lieu d'une par ligne.
    deliveryNotesBySourceQuote: new DataLoader(async (keys) => {
      const byKey = new Map();
      for (const [workspaceId, quoteIds] of groupByWorkspace(keys)) {
        const notes = await DeliveryNote.find({
          workspaceId,
          sourceQuote: { $in: quoteIds },
        }).sort({ createdAt: -1 });
        for (const note of notes) {
          const key = workspaceKey(workspaceId, note.sourceQuote);
          if (!byKey.has(key)) byKey.set(key, []);
          byKey.get(key).push(note);
        }
      }
      return keys.map((key) => byKey.get(key) || []);
    }),

    // Devis dont un bon de commande dérivé a déjà été facturé
    // (Quote.hasPurchaseOrderInvoices), même regroupement.
    quoteHasInvoicedPurchaseOrder: new DataLoader(async (keys) => {
      const invoiced = new Set();
      for (const [workspaceId, quoteIds] of groupByWorkspace(keys)) {
        const orders = await PurchaseOrder.find({
          workspaceId,
          sourceQuoteId: { $in: quoteIds },
          linkedInvoices: { $exists: true, $not: { $size: 0 } },
        })
          .select("sourceQuoteId")
          .lean();
        for (const order of orders) {
          invoiced.add(workspaceKey(workspaceId, order.sourceQuoteId));
        }
      }
      return keys.map((key) => invoiced.has(key));
    }),

    // Documents liés des transactions (Transaction.linked*, reconciliationLinks) :
    // une requête par type pour toute la liste au lieu d'une par transaction.
    linkedInvoiceSummaryById: leanByIdLoader(Invoice, LINKED_INVOICE_FIELDS),
    linkedPurchaseInvoiceSummaryById: leanByIdLoader(
      PurchaseInvoice,
      LINKED_PURCHASE_INVOICE_FIELDS,
    ),
    linkedImportedInvoiceSummaryById: leanByIdLoader(
      ImportedInvoice,
      LINKED_IMPORTED_INVOICE_FIELDS,
    ),
    linkUserById: leanByIdLoader(User, LINK_USER_FIELDS),

    // Transactions par identifiant (documents Mongoose complets, comme les
    // find qu'il remplace) : ImportedInvoice.linkedTransactions.
    transactionById: new DataLoader(async (ids) => {
      const transactions = await Transaction.find({ _id: { $in: ids } });
      const map = new Map(transactions.map((t) => [t._id.toString(), t]));
      return ids.map((id) => map.get(String(id)) || null);
    }),

    // Client.hasDocuments (une facture, un devis ou un BC référence le
    // client) : trois lectures pour toute la page de clients au lieu de trois
    // comptages par client. Clés workspaceKey(espace, clientId).
    clientHasDocuments: new DataLoader(async (keys) => {
      const withDocs = new Set();
      for (const [workspaceId, clientIds] of groupByWorkspace(keys)) {
        const filter = { workspaceId, "client.id": { $in: clientIds } };
        const found = await Promise.all([
          Invoice.distinct("client.id", filter),
          Quote.distinct("client.id", filter),
          PurchaseOrder.distinct("client.id", filter),
        ]);
        for (const id of found.flat()) {
          withDocs.add(workspaceKey(workspaceId, id));
        }
      }
      return keys.map((key) => withDocs.has(key));
    }),

    // Client.invoiceCount : une agrégation pour toute la page de clients.
    clientInvoiceCount: new DataLoader(async (keys) => {
      const counts = new Map();
      for (const [workspaceId, clientIds] of groupByWorkspace(keys)) {
        const rows = await Invoice.aggregate([
          {
            $match: {
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
              "client.id": { $in: clientIds },
            },
          },
          { $group: { _id: "$client.id", count: { $sum: 1 } } },
        ]);
        for (const row of rows) {
          counts.set(workspaceKey(workspaceId, row._id), row.count);
        }
      }
      return keys.map((key) => counts.get(key) || 0);
    }),

    clientById: new DataLoader(async (ids) => {
      const clients = await Client.find({ _id: { $in: ids } });
      const map = new Map(clients.map((c) => [c._id.toString(), c]));
      return ids.map((id) => map.get(id.toString()) || null);
    }),
  };
}
