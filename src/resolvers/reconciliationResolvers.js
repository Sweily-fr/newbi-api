import {
  withOrganization,
  checkSubscriptionActive,
  resolveWorkspaceId,
} from "../middlewares/rbac.js";
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import logger from "../utils/logger.js";
import {
  findReconciliationSuggestions,
  findTransactionsForInvoice,
  findInvoicesForTransaction,
  setReconciliationIgnored,
} from "../utils/reconciliationMatching.js";
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
          // resolveWorkspaceId privilégie le workspace validé par le RBAC :
          // un argument workspaceId arbitraire ne peut pas cibler une autre org
          const workspaceId = resolveWorkspaceId(
            argWorkspaceId,
            ctxWorkspaceId,
          );

          // Logique partagée avec la route REST /reconciliation/suggestions
          // (utils/reconciliationMatching.js) : mêmes candidats, mêmes règles.
          const { suggestions, unmatchedCount, pendingInvoicesCount } =
            await findReconciliationSuggestions(workspaceId);

          return {
            success: true,
            suggestions: suggestions.map(
              ({ transaction, matchingInvoices, confidence }) => ({
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
                confidence,
              }),
            ),
            unmatchedCount,
            pendingInvoicesCount,
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur suggestions:", error);
          throw error;
        }
      },
    ),

    transactionsForInvoice: withOrganization(
      async (parent, { invoiceId, search }, { user, workspaceId }) => {
        try {
          // IDOR fix: filtre par workspaceId pour empêcher l'accès cross-tenant
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            workspaceId,
          });
          if (!invoice) {
            throw new Error("Facture non trouvée");
          }

          // Logique partagée avec la route REST (fenêtre de dates contournée
          // par une recherche explicite, scoring montant/nom/référence).
          const { scored, invoiceAmount } = await findTransactionsForInvoice(
            invoice,
            workspaceId,
            search,
          );

          return {
            success: true,
            transactions: scored.map(({ transaction: tx, score }) => ({
              id: tx._id.toString(),
              amount: tx.amount,
              description: tx.description,
              date: tx.date,
              reconciliationStatus: tx.reconciliationStatus,
              score,
            })),
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

    invoicesForTransaction: withOrganization(
      async (parent, { transactionId, search }, { user, workspaceId }) => {
        try {
          const transaction = await Transaction.findOne({
            _id: transactionId,
            workspaceId,
            deletedAt: null,
          });
          if (!transaction) {
            throw new Error("Transaction non trouvée");
          }

          // Logique partagée avec la route REST : PENDING + COMPLETED non
          // liées (plafonds séparés), fenêtre de dates contournée par une
          // recherche explicite, scoring montant/nom/référence.
          const { scored, transactionAmount } =
            await findInvoicesForTransaction(transaction, workspaceId, search);

          const scoredInvoices = scored.map(({ invoice: inv, score }) => ({
            id: inv._id.toString(),
            number: inv.number,
            clientName:
              inv.client?.name ||
              `${inv.client?.firstName || ""} ${inv.client?.lastName || ""}`.trim(),
            totalTTC: inv.finalTotalTTC || inv.totalTTC || 0,
            dueDate: inv.dueDate,
            status: inv.status,
            score,
          }));

          return {
            success: true,
            invoices: scoredInvoices,
            transactionAmount,
          };
        } catch (error) {
          logger.error(
            "[RECONCILIATION-GQL] Erreur factures pour transaction:",
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

          // Garde-fou : on ne rapproche que des factures émises. Une DRAFT
          // contournerait la numérotation DRAFT→PENDING, une CANCELED ne doit
          // pas redevenir COMPLETED.
          const targetInvoice = await Invoice.findOne({
            _id: invoiceId,
            workspaceId,
          });
          if (!targetInvoice) {
            return { success: false, message: "Facture non trouvée" };
          }
          if (["DRAFT", "CANCELED"].includes(targetInvoice.status)) {
            return {
              success: false,
              message: `Impossible de rapprocher une facture au statut ${targetInvoice.status}`,
            };
          }

          // Relation N↔N : on utilise $addToSet des deux côtés pour être
          // idempotent (rejoue la même liaison = no-op) et supporter les
          // paiements groupés (1 transaction → N factures) et échelonnements
          // (1 facture ← N transactions).
          const transaction = await Transaction.findOneAndUpdate(
            { _id: transactionId, workspaceId, deletedAt: null },
            {
              $addToSet: { linkedInvoiceIds: invoiceId },
              $set: {
                reconciliationStatus: "matched",
                reconciliationDate: new Date(),
              },
            },
            { new: true },
          );
          if (!transaction) {
            return { success: false, message: "Transaction non trouvée" };
          }

          const invoice = await Invoice.findOneAndUpdate(
            { _id: invoiceId, workspaceId },
            {
              $addToSet: { linkedTransactionIds: transactionId },
              // Passe la facture en COMPLETED dès qu'une transaction est liée.
              // La 1re paymentDate est préservée si des transactions
              // ultérieures sont ajoutées (paiements échelonnés).
              $set: {
                status: "COMPLETED",
                paymentDate: targetInvoice.paymentDate || transaction.date,
              },
            },
            { new: true },
          );
          if (!invoice) {
            // Compensation : retirer la ref qu'on vient d'ajouter côté transaction.
            await Transaction.updateOne(
              { _id: transactionId, workspaceId },
              { $pull: { linkedInvoiceIds: invoiceId } },
            );
            return { success: false, message: "Facture non trouvée" };
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

          // Impossible de délier sans les DEUX ids en N↔N : on ne peut plus
          // se contenter d'un seul champ singular comme avant.
          if (!transactionId || !invoiceId) {
            return {
              success: false,
              message:
                "transactionId et invoiceId sont requis pour délier une liaison N↔N",
            };
          }

          // Délier côté transaction ($pull idempotent).
          const transaction = await Transaction.findOneAndUpdate(
            { _id: transactionId, workspaceId },
            { $pull: { linkedInvoiceIds: invoiceId } },
            { new: true },
          );

          // Si plus aucun lien (ni facture de vente, ni facture d'achat) →
          // status unmatched. updateOne ciblé plutôt que save() : ne revalide
          // pas tout le document (données legacy hors enum).
          if (
            transaction &&
            (transaction.linkedInvoiceIds || []).length === 0 &&
            (transaction.linkedPurchaseInvoiceIds || []).length === 0
          ) {
            await Transaction.updateOne(
              { _id: transactionId, workspaceId },
              {
                $set: {
                  reconciliationStatus: "unmatched",
                  reconciliationDate: null,
                },
              },
            );
            transaction.reconciliationStatus = "unmatched";
            transaction.reconciliationDate = null;
          }

          // Délier côté facture.
          const invoice = await Invoice.findOneAndUpdate(
            { _id: invoiceId, workspaceId },
            { $pull: { linkedTransactionIds: transactionId } },
            { new: true },
          );

          // Si plus aucune transaction liée → facture repasse PENDING sans
          // date de paiement. Sinon on garde COMPLETED (les autres transactions
          // liées la maintiennent payée).
          if (invoice && (invoice.linkedTransactionIds || []).length === 0) {
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

          const transaction = await setReconciliationIgnored(
            transactionId,
            workspaceId,
            true,
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

    unignoreTransaction: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId } = input;

          const transaction = await setReconciliationIgnored(
            transactionId,
            workspaceId,
            false,
          );

          if (!transaction) {
            return {
              success: false,
              message: "Transaction non trouvée ou non ignorée",
            };
          }

          logger.info(
            `[RECONCILIATION-GQL] Transaction réactivée pour le rapprochement: ${transactionId}`,
          );

          return {
            success: true,
            message: "Transaction réintégrée au rapprochement",
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur dé-ignorer:", error);
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
