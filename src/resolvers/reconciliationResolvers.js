import { withOrganization } from "../middlewares/rbac.js";
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";

const reconciliationResolvers = {
  Query: {
    reconciliationSuggestions: withOrganization(
      async (
        parent,
        { workspaceId: argsWorkspaceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        try {
          // Utiliser le workspaceId des arguments (comme les autres resolvers)
          const workspaceId = argsWorkspaceId || contextWorkspaceId;

          logger.info(
            `[RECONCILIATION-GQL] Recherche suggestions pour workspace: ${workspaceId}`
          );

          // Récupérer les transactions non rapprochées (crédit uniquement = entrées d'argent)
          const unmatchedTransactions = await Transaction.find({
            workspaceId: workspaceId.toString(),
            reconciliationStatus: { $in: ["unmatched", "suggested"] },
            amount: { $gt: 0 },
          })
            .sort({ date: -1 })
            .limit(50);

          logger.info(
            `[RECONCILIATION-GQL] Transactions non rapprochées trouvées: ${unmatchedTransactions.length}`
          );

          // Récupérer les factures en attente de paiement
          // Note: Invoice stocke workspaceId comme ObjectId, Transaction comme String
          const workspaceObjectId = mongoose.Types.ObjectId.isValid(workspaceId)
            ? new mongoose.Types.ObjectId(workspaceId)
            : workspaceId;

          const pendingInvoices = await Invoice.find({
            workspaceId: workspaceObjectId,
            status: "PENDING",
            linkedTransactionId: null,
          }).sort({ dueDate: 1 });

          logger.info(
            `[RECONCILIATION-GQL] Factures en attente trouvées: ${pendingInvoices.length}`
          );

          // Debug: afficher les montants pour vérifier la correspondance
          if (unmatchedTransactions.length > 0) {
            logger.info(
              `[RECONCILIATION-GQL] Transactions: ${unmatchedTransactions.map((t) => `${t.amount}€`).join(", ")}`
            );
          }
          if (pendingInvoices.length > 0) {
            logger.info(
              `[RECONCILIATION-GQL] Factures: ${pendingInvoices.map((i) => `${i.finalTotalTTC || i.totalTTC}€ (${i.number})`).join(", ")}`
            );
          }

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
              logger.info(
                `[RECONCILIATION-GQL] Match trouvé: Transaction ${transaction.amount}€ -> ${matchingInvoices.length} facture(s)`
              );
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
      async (
        parent,
        { invoiceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        try {
          const invoice = await Invoice.findById(invoiceId);
          if (!invoice) {
            throw new Error("Facture non trouvée");
          }

          // Utiliser le workspaceId de la facture (plus fiable)
          const workspaceId =
            invoice.workspaceId?.toString() || contextWorkspaceId;

          logger.info(
            `[RECONCILIATION-GQL] transactionsForInvoice - workspace: ${workspaceId}, invoice: ${invoiceId}`
          );

          const invoiceAmount = invoice.finalTotalTTC || invoice.totalTTC || 0;

          // Récupérer les transactions non rapprochées (crédits uniquement)
          const transactions = await Transaction.find({
            workspaceId: workspaceId.toString(),
            reconciliationStatus: { $in: ["unmatched", "suggested"] },
            amount: { $gt: 0 },
          })
            .sort({ date: -1 })
            .limit(100);

          logger.info(
            `[RECONCILIATION-GQL] Transactions trouvées: ${transactions.length}, montant facture: ${invoiceAmount}€`
          );

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
      async (parent, { input }, { user, workspaceId: contextWorkspaceId }) => {
        try {
          const { transactionId, invoiceId } = input;

          // Récupérer d'abord la facture pour avoir son workspaceId (plus fiable)
          const invoice = await Invoice.findById(invoiceId);
          if (!invoice) {
            return { success: false, message: "Facture non trouvée" };
          }

          // Utiliser le workspaceId de la facture (comme dans transactionsForInvoice)
          const wsId =
            invoice.workspaceId?.toString() || contextWorkspaceId?.toString();

          // Vérifier que la transaction existe avec le même workspaceId que la facture
          const transaction = await Transaction.findOne({
            _id: transactionId,
            workspaceId: wsId,
          });

          if (!transaction) {
            return { success: false, message: "Transaction non trouvée" };
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
