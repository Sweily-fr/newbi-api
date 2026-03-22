import DataLoader from "dataloader";
import User from "../models/User.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import Client from "../models/Client.js";

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

    clientById: new DataLoader(async (ids) => {
      const clients = await Client.find({ _id: { $in: ids } });
      const map = new Map(clients.map((c) => [c._id.toString(), c]));
      return ids.map((id) => map.get(id.toString()) || null);
    }),
  };
}
