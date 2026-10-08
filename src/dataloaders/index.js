import DataLoader from "dataloader";
import User from "../models/User.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import Client from "../models/Client.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";

/**
 * Clé composite « espace:document » des loaders scopés par espace de travail.
 * Le batch regroupe les clés par espace et fait une requête par espace (une
 * seule en pratique), filtrée sur workspaceId comme les requêtes qu'il remplace.
 */
export const workspaceKey = (workspaceId, id) => `${workspaceId}:${id}`;

const groupByWorkspace = (keys) => {
  const groups = new Map();
  for (const key of keys) {
    const [workspaceId, id] = key.split(":");
    if (!groups.has(workspaceId)) groups.set(workspaceId, []);
    groups.get(workspaceId).push(id);
  }
  return groups;
};

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

    clientById: new DataLoader(async (ids) => {
      const clients = await Client.find({ _id: { $in: ids } });
      const map = new Map(clients.map((c) => [c._id.toString(), c]));
      return ids.map((id) => map.get(id.toString()) || null);
    }),
  };
}
