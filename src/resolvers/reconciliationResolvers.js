import { withOrganization } from "../middlewares/rbac.js";
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import logger from "../utils/logger.js";

const reconciliationResolvers = {
  Query: {
    reconciliationSuggestions: withOrganization(
      async (parent, args, { user, workspaceId }) => {
        try {
          // Récupérer les transactions non rapprochées (crédit uniquement = entrées d'argent)
          const unmatchedTransactions = await Transaction.find({
            workspaceId,
            reconciliationStatus: { $in: ["unmatched", "suggested"] },
            amount: { $gt: 0 },
          })
            .sort({ date: -1 })
            .limit(50);

          // Récupérer les factures en attente de paiement
          const pendingInvoices = await Invoice.find({
            workspaceId,
            status: "PENDING",
            linkedTransactionId: null,
          }).sort({ dueDate: 1 });

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
            unmatchedCount: unmatchedTransactions.length,
            pendingInvoicesCount: pendingInvoices.length,
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur suggestions:", error);
          throw error;
        }
      }
    ),

    transactionsForInvoice: withOrganization(
      async (parent, { invoiceId }, { user, workspaceId }) => {
        try {
          const invoice = await Invoice.findById(invoiceId);
          if (!invoice) {
            throw new Error("Facture non trouvée");
          }

          const invoiceAmount = invoice.finalTotalTTC || invoice.totalTTC || 0;

          // Récupérer les transactions non rapprochées (crédits uniquement)
          const transactions = await Transaction.find({
            workspaceId,
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
            error
          );
          throw error;
        }
      }
    ),
  },

  Mutation: {
    linkTransactionToInvoice: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId, invoiceId } = input;

          // Vérifier que la transaction existe
          const transaction = await Transaction.findOne({
            _id: transactionId,
            workspaceId,
          });
          if (!transaction) {
            return { success: false, message: "Transaction non trouvée" };
          }

          // Vérifier que la facture existe
          const invoice = await Invoice.findOne({
            _id: invoiceId,
            workspaceId,
          });
          if (!invoice) {
            return { success: false, message: "Facture non trouvée" };
          }

          // Vérifier que la transaction n'est pas déjà liée
          if (transaction.linkedInvoiceId) {
            return {
              success: false,
              message: "Cette transaction est déjà liée à une facture",
            };
          }

          // Vérifier que la facture n'est pas déjà liée
          if (invoice.linkedTransactionId) {
            return {
              success: false,
              message: "Cette facture est déjà liée à une transaction",
            };
          }

          // Mettre à jour la transaction
          transaction.linkedInvoiceId = invoiceId;
          transaction.reconciliationStatus = "matched";
          transaction.reconciliationDate = new Date();
          await transaction.save();

          // Mettre à jour la facture (passer en COMPLETED)
          invoice.linkedTransactionId = transactionId;
          invoice.status = "COMPLETED";
          invoice.paymentDate = transaction.date;
          await invoice.save();

          logger.info(
            `[RECONCILIATION-GQL] Rapprochement: Transaction ${transactionId} <-> Facture ${invoiceId}`
          );

          return {
            success: true,
            message: "Rapprochement effectué avec succès",
            transaction: {
              id: transaction._id.toString(),
              amount: transaction.amount,
              description: transaction.description,
              date: transaction.date,
              reconciliationStatus: transaction.reconciliationStatus,
            },
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
      }
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
                invoice.linkedTransactionId
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
            `[RECONCILIATION-GQL] Déliaison: Transaction ${transactionId} <-> Facture ${invoiceId}`
          );

          return {
            success: true,
            message: "Déliaison effectuée avec succès",
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur déliaison:", error);
          return { success: false, message: error.message };
        }
      }
    ),

    ignoreTransaction: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId } = input;

          const transaction = await Transaction.findOneAndUpdate(
            { _id: transactionId, workspaceId },
            { reconciliationStatus: "ignored" },
            { new: true }
          );

          if (!transaction) {
            return { success: false, message: "Transaction non trouvée" };
          }

          logger.info(
            `[RECONCILIATION-GQL] Transaction ignorée: ${transactionId}`
          );

          return {
            success: true,
            message: "Transaction ignorée",
          };
        } catch (error) {
          logger.error("[RECONCILIATION-GQL] Erreur ignorer:", error);
          return { success: false, message: error.message };
        }
      }
    ),
  },
};

export default reconciliationResolvers;
