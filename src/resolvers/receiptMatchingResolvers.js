import Transaction from "../models/Transaction.js";
import { requireWorkspaceLevel } from "../middlewares/rbac.js";
import { matchReceiptToTransactions } from "../utils/receipt-matching.js";

// Suggestions de transactions : lecture du module banking
const readBanking = requireWorkspaceLevel("banking", "read");

const receiptMatchingResolvers = {
  Query: {
    matchTransactionsForReceipt: readBanking(
      async (parent, { workspaceId, amount, date, vendor }, { user }) => {
        // Récupérer les 500 dernières transactions du workspace (même borne
        // que le web), en excluant celles déjà rapprochées ou volontairement
        // ignorées : suggérer une transaction déjà "matched" pousserait au
        // double rapprochement
        const transactions = await Transaction.find({
          workspaceId,
          deletedAt: null,
          reconciliationStatus: { $nin: ["matched", "ignored"] },
          $or: [
            { linkedPurchaseInvoiceIds: { $exists: false } },
            { linkedPurchaseInvoiceIds: { $size: 0 } },
          ],
        })
          .sort({ date: -1, createdAt: -1 })
          .limit(500)
          .lean();

        const candidates = matchReceiptToTransactions(
          { amount, date, vendor },
          transactions,
          { limit: 3, minScore: 50 },
        );

        return {
          candidates,
          count: candidates.length,
        };
      },
    ),
  },
};

export default receiptMatchingResolvers;
