import Transaction from "../models/Transaction.js";
import { withWorkspace } from "../middlewares/better-auth-jwt.js";
import { matchReceiptToTransactions } from "../utils/receipt-matching.js";

const receiptMatchingResolvers = {
  Query: {
    matchTransactionsForReceipt: withWorkspace(
      async (parent, { workspaceId, amount, date, vendor }, { user }) => {
        // Récupérer les 500 dernières transactions du workspace (même borne que le web)
        const transactions = await Transaction.find({
          workspaceId,
          deletedAt: null,
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
