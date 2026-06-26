import {
  withOrganization,
  checkSubscriptionActive,
} from "../middlewares/rbac.js";
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import logger from "../utils/logger.js";
// import { evaluatePaymentReporting } from "../utils/eInvoiceRoutingHelper.js"; // TODO E-REPORTING

const reconciliationResolvers = {
  Query: {
    reconciliationSuggestions: withOrganization(
      async (
        parent,
        { workspaceId: argWorkspaceId },
        { user, workspaceId: ctxWorkspaceId },
      ) => {
        try {
          // Utiliser le workspaceId passé en argument ou celui du contexte
          const workspaceId = argWorkspaceId || ctxWorkspaceId;

          // Critères "à rapprocher" : une entrée d'argent (amount > 0) pas encore
          // liée à une facture (linkedInvoiceId null), sans justificatif attaché
          // (receiptFiles vide → un justificatif/ticket vaut justification, donc
          // plus rien à rapprocher) et dont le statut n'est ni "matched" ni
          // "ignored" (donc unmatched/suggested, ou vide pour données legacy).
          // Doit rester identique au filtre "toReconcile" de la page Transactions
          // (TransactionTable.jsx) et à la route REST /reconciliation/suggestions.
          const reconcileQuery = {
            workspaceId,
            deletedAt: null,
            reconciliationStatus: { $nin: ["matched", "ignored"] },
            amount: { $gt: 0 },
            linkedInvoiceId: null,
            "receiptFiles.0": { $exists: false },
          };

          // Comptage complet, sans plafond (countDocuments) → le badge reflète le
          // vrai total. La génération de suggestions ci-dessous reste plafonnée
          // (perf), mais ne sert plus à calculer unmatchedCount.
          const unmatchedCount =
            await Transaction.countDocuments(reconcileQuery);

          const unmatchedTransactions = await Transaction.find(reconcileQuery)
            .sort({ date: -1 })
            .limit(50);

          // Récupérer les factures en attente de paiement (cap à 500 pour éviter surcharge mémoire)
          const pendingInvoices = await Invoice.find({
            workspaceId,
            status: "PENDING",
            linkedTransactionId: null,
          })
            .sort({ dueDate: 1 })
            .limit(500);

          // Générer des suggestions de correspondance
          const suggestions = [];

          for (const transaction of unmatchedTransactions) {
            const matchingInvoices = pendingInvoices.filter((invoice) => {
              const invoiceAmount =
                invoice.finalTotalTTC || invoice.totalTTC || 0;
              const tolerance = invoiceAmount * 0.01;
              const amountMatch =
                Math.abs(transaction.amount - invoiceAmount) <= tolerance;

              const clientName =
                invoice.client?.name || invoice.client?.firstName || "";
              const descriptionMatch =
                clientName &&
                transaction.description
                  ?.toLowerCase()
                  .includes(clientName.toLowerCase());

              return amountMatch || descriptionMatch;
            });

            if (matchingInvoices.length > 0) {
              suggestions.push({
                transaction: {
                  id: transaction._id.toString(),
                  amount: transaction.amount,
                  description: transaction.description,
                  date: transaction.date,
                  reconciliationStatus: transaction.reconciliationStatus,
                },
                matchingInvoices: matchingInvoices.map((inv) => ({
                  id: inv._id.toString(),
                  number: inv.number,
                  clientName:
                    inv.client?.name ||
                    `${inv.client?.firstName || ""} ${inv.client?.lastName || ""}`.trim(),
                  totalTTC: inv.finalTotalTTC || inv.totalTTC,
                  dueDate: inv.dueDate,
                  status: inv.status,
                })),
                confidence: matchingInvoices.some((inv) => {
                  const invoiceAmount = inv.finalTotalTTC || inv.totalTTC || 0;
                  return (
                    Math.abs(transaction.amount - invoiceAmount) <=
                    invoiceAmount * 0.01
                  );
                })
                  ? "high"
                  : "medium",
              });
            }
          }

          return {
            success: true,
            suggestions,
            unmatchedCount,
            pendingInvoicesCount: pendingInvoices.length,
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur suggestions:", error);
          throw error;
        }
      },
    ),

    transactionsForInvoice: withOrganization(
      async (parent, { invoiceId }, { user, workspaceId }) => {
        try {
          // IDOR fix: filtre par workspaceId pour empêcher l'accès cross-tenant
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            workspaceId,
          });
          if (!invoice) {
            throw new Error("Facture non trouvée");
          }

          const invoiceAmount = invoice.finalTotalTTC || invoice.totalTTC || 0;

          // Récupérer les transactions non rapprochées (crédits uniquement)
          const transactions = await Transaction.find({
            workspaceId,
            deletedAt: null,
            reconciliationStatus: { $in: ["unmatched", "suggested"] },
            amount: { $gt: 0 },
          })
            .sort({ date: -1 })
            .limit(100);

          // Trier par pertinence
          const scoredTransactions = transactions.map((tx) => {
            let score = 0;

            // Score par montant
            const tolerance = invoiceAmount * 0.01;
            if (Math.abs(tx.amount - invoiceAmount) <= tolerance) {
              score += 100;
            } else if (
              Math.abs(tx.amount - invoiceAmount) <=
              invoiceAmount * 0.1
            ) {
              score += 50;
            }

            // Score par nom du client
            const clientName =
              invoice.client?.name || invoice.client?.firstName || "";
            if (
              clientName &&
              tx.description?.toLowerCase().includes(clientName.toLowerCase())
            ) {
              score += 50;
            }

            return {
              id: tx._id.toString(),
              amount: tx.amount,
              description: tx.description,
              date: tx.date,
              reconciliationStatus: tx.reconciliationStatus,
              score,
            };
          });

          // Trier par score décroissant
          scoredTransactions.sort((a, b) => b.score - a.score);

          return {
            success: true,
            transactions: scoredTransactions.slice(0, 20),
            invoiceAmount,
          };
        } catch (error) {
          logger.error(
            "[RECONCILIATION-GQL] Erreur transactions pour facture:",
            error,
          );
          throw error;
        }
      },
    ),
  },

  Mutation: {
    linkTransactionToInvoice: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId, invoiceId } = input;

          // Revendication ATOMIQUE de la transaction : la condition
          // linkedInvoiceId:null dans le filtre garantit qu'on ne lie pas une
          // transaction déjà liée, même si une autre requête arrive en parallèle
          // (élimine la race TOCTOU entre la vérification et l'écriture).
          const transaction = await Transaction.findOneAndUpdate(
            { _id: transactionId, workspaceId, linkedInvoiceId: null },
            {
              linkedInvoiceId: invoiceId,
              reconciliationStatus: "matched",
              reconciliationDate: new Date(),
            },
            { new: true },
          );
          if (!transaction) {
            const exists = await Transaction.exists({
              _id: transactionId,
              workspaceId,
            });
            return {
              success: false,
              message: exists
                ? "Cette transaction est déjà liée à une facture"
                : "Transaction non trouvée",
            };
          }

          // Revendication ATOMIQUE de la facture. Si elle échoue (facture
          // introuvable ou déjà liée), on annule la liaison de la transaction
          // pour éviter un état incohérent (pas de transaction Mongo requise,
          // compatible avec un MongoDB standalone).
          const invoice = await Invoice.findOneAndUpdate(
            { _id: invoiceId, workspaceId, linkedTransactionId: null },
            {
              linkedTransactionId: transactionId,
              status: "COMPLETED",
              paymentDate: transaction.date,
            },
            { new: true },
          );
          if (!invoice) {
            transaction.linkedInvoiceId = null;
            transaction.reconciliationStatus = "unmatched";
            transaction.reconciliationDate = null;
            await transaction.save();
            const exists = await Invoice.exists({ _id: invoiceId, workspaceId });
            return {
              success: false,
              message: exists
                ? "Cette facture est déjà liée à une transaction"
                : "Facture non trouvée",
            };
          }

          // TODO E-REPORTING: Décommenter quand l'API SuperPDP e-reporting sera disponible
          // try {
          //   if (evaluatePaymentReporting(invoice, transaction.date)) {
          //     await invoice.save();
          //     logger.info(`[E-INVOICE-ROUTING] E-reporting payment (rapprochement GQL) pour ${invoice._id}`);
          //   }
          // } catch (eReportingError) {
          //   logger.error("Erreur e-reporting payment (rapprochement):", eReportingError);
          // }

          logger.info(
            `[RECONCILIATION-GQL] Rapprochement: Transaction ${transactionId} <-> Facture ${invoiceId}`,
          );

          return {
            success: true,
            message: "Rapprochement effectué avec succès",
            // Document Mongoose complet : les résolveurs de champ Transaction
            // (id, linkedInvoice, reconciliationStatus…) s'exécutent dessus et
            // permettent à Apollo de normaliser l'entité côté front sans refetch.
            transaction,
            invoice: {
              id: invoice._id.toString(),
              number: invoice.number,
              clientName: invoice.client?.name || "",
              totalTTC: invoice.finalTotalTTC || invoice.totalTTC,
              dueDate: invoice.dueDate,
              status: invoice.status,
            },
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur rapprochement:", error);
          return { success: false, message: error.message };
        }
      },
    ),

    unlinkTransactionFromInvoice: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId, invoiceId } = input;

          let transaction, invoice;

          if (transactionId) {
            transaction = await Transaction.findOne({
              _id: transactionId,
              workspaceId,
            });
            if (transaction?.linkedInvoiceId) {
              invoice = await Invoice.findById(transaction.linkedInvoiceId);
            }
          } else if (invoiceId) {
            invoice = await Invoice.findOne({ _id: invoiceId, workspaceId });
            if (invoice?.linkedTransactionId) {
              transaction = await Transaction.findById(
                invoice.linkedTransactionId,
              );
            }
          }

          // Délier la transaction
          if (transaction) {
            transaction.linkedInvoiceId = null;
            transaction.reconciliationStatus = "unmatched";
            transaction.reconciliationDate = null;
            await transaction.save();
          }

          // Délier la facture (repasser en PENDING)
          if (invoice) {
            invoice.linkedTransactionId = null;
            invoice.status = "PENDING";
            invoice.paymentDate = null;
            await invoice.save();
          }

          logger.info(
            `[RECONCILIATION-GQL] Déliaison: Transaction ${transactionId} <-> Facture ${invoiceId}`,
          );

          return {
            success: true,
            message: "Déliaison effectuée avec succès",
            // Transaction mise à jour (linkedInvoiceId null, statut unmatched) :
            // Apollo efface linkedInvoice de l'entité en cache sans refetch.
            transaction: transaction || null,
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur déliaison:", error);
          return { success: false, message: error.message };
        }
      },
    ),

    ignoreTransaction: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId } = input;

          const transaction = await Transaction.findOneAndUpdate(
            { _id: transactionId, workspaceId },
            { reconciliationStatus: "ignored" },
            { new: true },
          );

          if (!transaction) {
            return { success: false, message: "Transaction non trouvée" };
          }

          logger.info(
            `[RECONCILIATION-GQL] Transaction ignorée: ${transactionId}`,
          );

          return {
            success: true,
            message: "Transaction ignorée",
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur ignorer:", error);
          return { success: false, message: error.message };
        }
      },
    ),
  },
};

// ✅ Phase A.1 — Subscription check sur toutes les mutations reconciliation (fail-closed: modifie statut facture)
const originalReconciliationMutations = reconciliationResolvers.Mutation;
reconciliationResolvers.Mutation = Object.fromEntries(
  Object.entries(originalReconciliationMutations).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context, { failClosed: true });
      return fn(parent, args, context, info);
    },
  ]),
);

export default reconciliationResolvers;
