import {
  withOrganization,
  checkSubscriptionActive,
} from "../middlewares/rbac.js";
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import logger from "../utils/logger.js";
import { invoiceReferenceMatches } from "../utils/invoiceReferenceMatch.js";
// import { evaluatePaymentReporting } from "../utils/eInvoiceRoutingHelper.js"; // TODO E-REPORTING

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "1 200,50" → 1200.5 ; null si la saisie n'est pas un montant.
const parseAmountSearch = (term) => {
  const normalized = term.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = parseFloat(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

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
          // liée à une facture (linkedInvoiceIds vide), sans justificatif attaché
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
            // N↔N : "non liée" = array vide.
            $or: [
              { linkedInvoiceIds: { $exists: false } },
              { linkedInvoiceIds: { $size: 0 } },
            ],
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
            $or: [
              { linkedTransactionIds: { $exists: false } },
              { linkedTransactionIds: { $size: 0 } },
            ],
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

              // Correspondance par numéro de facture présent dans le libellé brut
              // de la transaction (référence Bridge non tronquée).
              const referenceMatch = invoiceReferenceMatches(
                transaction,
                invoice,
              );

              return amountMatch || descriptionMatch || referenceMatch;
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
                  const amtMatch =
                    Math.abs(transaction.amount - invoiceAmount) <=
                    invoiceAmount * 0.01;
                  return amtMatch || invoiceReferenceMatches(transaction, inv);
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

          const invoiceAmount = invoice.finalTotalTTC || invoice.totalTTC || 0;

          // Récupérer les transactions non rapprochées (crédits uniquement)
          const txQuery = {
            workspaceId,
            deletedAt: null,
            reconciliationStatus: { $in: ["unmatched", "suggested"] },
            amount: { $gt: 0 },
          };

          // Recherche serveur : description ou libellé brut (reference), et
          // montant à ±1 % si la saisie est numérique. Permet de retrouver une
          // transaction hors du top scoré (montant différent de la facture).
          const term = (search || "").trim();
          if (term) {
            const regex = { $regex: escapeRegex(term), $options: "i" };
            const or = [{ description: regex }, { reference: regex }];
            const searchAmount = parseAmountSearch(term);
            if (searchAmount !== null) {
              const tolerance = Math.max(searchAmount * 0.01, 0.01);
              or.push({
                amount: {
                  $gte: searchAmount - tolerance,
                  $lte: searchAmount + tolerance,
                },
              });
            }
            txQuery.$or = or;
          }

          const transactions = await Transaction.find(txQuery)
            .sort({ date: -1 })
            .limit(200);

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

          // Trier par score décroissant, puis par date décroissante à score égal
          scoredTransactions.sort(
            (a, b) => b.score - a.score || new Date(b.date) - new Date(a.date),
          );

          return {
            success: true,
            transactions: scoredTransactions.slice(0, 50),
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

          const invoiceQuery = {
            workspaceId,
            status: "PENDING",
            _id: { $nin: transaction.linkedInvoiceIds || [] },
          };

          // Recherche serveur : numéro de facture, nom du client, et montant
          // TTC à ±1 % si la saisie est numérique.
          const term = (search || "").trim();
          if (term) {
            const regex = { $regex: escapeRegex(term), $options: "i" };
            const or = [
              { number: regex },
              { "client.name": regex },
              { "client.firstName": regex },
              { "client.lastName": regex },
            ];
            const searchAmount = parseAmountSearch(term);
            if (searchAmount !== null) {
              const tolerance = Math.max(searchAmount * 0.01, 0.01);
              const range = {
                $gte: searchAmount - tolerance,
                $lte: searchAmount + tolerance,
              };
              or.push({ finalTotalTTC: range }, { totalTTC: range });
            }
            invoiceQuery.$or = or;
          }

          const invoices = await Invoice.find(invoiceQuery)
            .sort({ dueDate: 1 })
            .limit(200);

          // Même scoring que reconciliationSuggestions : montant, nom du client
          // dans le libellé, référence facture dans le libellé brut.
          const scoredInvoices = invoices.map((inv) => {
            const amount = inv.finalTotalTTC || inv.totalTTC || 0;
            let score = 0;

            if (amount > 0) {
              const tolerance = amount * 0.01;
              if (Math.abs(transaction.amount - amount) <= tolerance) {
                score += 100;
              } else if (
                Math.abs(transaction.amount - amount) <=
                amount * 0.1
              ) {
                score += 50;
              }
            }

            const clientName = inv.client?.name || inv.client?.firstName || "";
            if (
              clientName &&
              transaction.description
                ?.toLowerCase()
                .includes(clientName.toLowerCase())
            ) {
              score += 50;
            }

            if (invoiceReferenceMatches(transaction, inv)) {
              score += 100;
            }

            return {
              id: inv._id.toString(),
              number: inv.number,
              clientName:
                inv.client?.name ||
                `${inv.client?.firstName || ""} ${inv.client?.lastName || ""}`.trim(),
              totalTTC: amount,
              dueDate: inv.dueDate,
              status: inv.status,
              score,
            };
          });

          // Score décroissant, puis échéance la plus proche à score égal
          scoredInvoices.sort(
            (a, b) =>
              b.score - a.score || new Date(a.dueDate) - new Date(b.dueDate),
          );

          return {
            success: true,
            invoices: scoredInvoices.slice(0, 50),
            transactionAmount: transaction.amount,
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

          // Relation N↔N : on utilise $addToSet des deux côtés pour être
          // idempotent (rejoue la même liaison = no-op) et supporter les
          // paiements groupés (1 transaction → N factures) et échelonnements
          // (1 facture ← N transactions).
          const transaction = await Transaction.findOneAndUpdate(
            { _id: transactionId, workspaceId },
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
              // Passe la facture en COMPLETED dès qu'une transaction est liée
              // + date de paiement = celle de la transaction courante. Si
              // plusieurs transactions ultérieures sont ajoutées, la 1re
              // paymentDate est préservée (usage $setOnInsert-like via $cond).
              $set: {
                status: "COMPLETED",
                paymentDate: transaction.date,
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

          // Si plus aucune facture liée → status unmatched.
          if (
            transaction &&
            (transaction.linkedInvoiceIds || []).length === 0
          ) {
            transaction.reconciliationStatus = "unmatched";
            transaction.reconciliationDate = null;
            await transaction.save();
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
