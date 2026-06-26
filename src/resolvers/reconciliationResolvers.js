import {
  withOrganization,
  checkSubscriptionActive,
} from "../middlewares/rbac.js";
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import logger from "../utils/logger.js";
import {
  buildReconciliationMatches,
  isTransactionBeforeInvoice,
} from "../utils/reconciliationMatch.js";
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

          // Factures de CA importées éligibles au rapprochement (validées, non
          // encore liées). On les normalise dans la forme attendue par le matcher
          // (number/prefix, issueDate, totalTTC…) tout en gardant un tag
          // documentType, pour que le front appelle la bonne mutation de liaison.
          const importedInvoices = await ImportedInvoice.find({
            workspaceId,
            status: "VALIDATED",
            linkedTransactionId: null,
          })
            .sort({ dueDate: 1 })
            .limit(500);

          const importedCandidates = importedInvoices.map((imp) => ({
            _id: imp._id,
            number: imp.originalInvoiceNumber,
            prefix: null,
            client: imp.client,
            totalTTC: imp.totalTTC,
            finalTotalTTC: imp.totalTTC,
            dueDate: imp.dueDate,
            issueDate: imp.invoiceDate,
            status: imp.status,
            documentType: "IMPORTED_INVOICE",
          }));

          // Générer des suggestions de correspondance, dédupliquées par facture
          // (une facture ne peut être liée qu'à une seule transaction).
          const matchesByTransaction = buildReconciliationMatches(
            unmatchedTransactions,
            [...pendingInvoices, ...importedCandidates],
          );

          const suggestions = [];
          // On conserve l'ordre de tri des transactions (date décroissante).
          for (const transaction of unmatchedTransactions) {
            const entry = matchesByTransaction.get(transaction._id.toString());
            if (!entry || entry.matches.length === 0) continue;

            suggestions.push({
              transaction: {
                id: transaction._id.toString(),
                amount: transaction.amount,
                description: transaction.description,
                date: transaction.date,
                reconciliationStatus: transaction.reconciliationStatus,
              },
              matchingInvoices: entry.matches.map(({ invoice: inv }) => ({
                id: inv._id.toString(),
                number: inv.number,
                clientName:
                  inv.client?.name ||
                  `${inv.client?.firstName || ""} ${inv.client?.lastName || ""}`.trim(),
                totalTTC: inv.finalTotalTTC || inv.totalTTC,
                dueDate: inv.dueDate,
                status: inv.status,
                documentType: inv.documentType || "INVOICE",
              })),
              confidence: entry.matches.some((m) => m.match.high)
                ? "high"
                : "medium",
            });
          }

          return {
            success: true,
            suggestions,
            unmatchedCount,
            pendingInvoicesCount:
              pendingInvoices.length + importedInvoices.length,
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

          // Trier par pertinence (en excluant les paiements antérieurs à
          // l'émission de la facture : ils ne peuvent pas la régler).
          const scoredTransactions = transactions
            .filter((tx) => !isTransactionBeforeInvoice(tx, invoice))
            .map((tx) => {
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

    // Transactions candidates pour une facture de CA importée (ImportedInvoice).
    // Miroir de transactionsForInvoice : entrées d'argent uniquement (amount > 0).
    transactionsForImportedInvoice: withOrganization(
      async (parent, { importedInvoiceId }, { user, workspaceId }) => {
        try {
          // IDOR fix: filtre par workspaceId pour empêcher l'accès cross-tenant
          const importedInvoice = await ImportedInvoice.findOne({
            _id: importedInvoiceId,
            workspaceId,
          });
          if (!importedInvoice) {
            throw new Error("Facture importée non trouvée");
          }

          const invoiceAmount = importedInvoice.totalTTC || 0;

          const transactions = await Transaction.find({
            workspaceId,
            deletedAt: null,
            reconciliationStatus: { $in: ["unmatched", "suggested"] },
            amount: { $gt: 0 },
          })
            .sort({ date: -1 })
            .limit(100);

          const scoredTransactions = transactions.map((tx) => {
            let score = 0;

            const tolerance = invoiceAmount * 0.01;
            if (Math.abs(tx.amount - invoiceAmount) <= tolerance) {
              score += 100;
            } else if (
              Math.abs(tx.amount - invoiceAmount) <=
              invoiceAmount * 0.1
            ) {
              score += 50;
            }

            const clientName =
              importedInvoice.client?.name || importedInvoice.vendor?.name || "";
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

          scoredTransactions.sort((a, b) => b.score - a.score);

          return {
            success: true,
            transactions: scoredTransactions.slice(0, 20),
            invoiceAmount,
          };
        } catch (error) {
          logger.error(
            "[RECONCILIATION-GQL] Erreur transactions pour facture importée:",
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

    // Lier une transaction à une facture de CA importée (miroir de
    // linkTransactionToInvoice : entrée d'argent, liaison 1:1 atomique).
    linkTransactionToImportedInvoice: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId, importedInvoiceId } = input;

          // Revendication ATOMIQUE de la transaction : on refuse de lier une
          // transaction déjà rattachée à une facture (normale ou importée).
          const transaction = await Transaction.findOneAndUpdate(
            {
              _id: transactionId,
              workspaceId,
              linkedInvoiceId: null,
              linkedImportedInvoiceId: null,
            },
            {
              linkedImportedInvoiceId: importedInvoiceId,
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

          // Revendication ATOMIQUE de la facture importée. En cas d'échec, on
          // annule la liaison de la transaction (état cohérent, sans transaction Mongo).
          const importedInvoice = await ImportedInvoice.findOneAndUpdate(
            { _id: importedInvoiceId, workspaceId, linkedTransactionId: null },
            {
              linkedTransactionId: transactionId,
              status: "COMPLETED",
              paymentDate: transaction.date,
            },
            { new: true },
          );
          if (!importedInvoice) {
            transaction.linkedImportedInvoiceId = null;
            transaction.reconciliationStatus = "unmatched";
            transaction.reconciliationDate = null;
            await transaction.save();
            const exists = await ImportedInvoice.exists({
              _id: importedInvoiceId,
              workspaceId,
            });
            return {
              success: false,
              message: exists
                ? "Cette facture est déjà liée à une transaction"
                : "Facture importée non trouvée",
            };
          }

          logger.info(
            `[RECONCILIATION-GQL] Rapprochement: Transaction ${transactionId} <-> Facture importée ${importedInvoiceId}`,
          );

          return {
            success: true,
            message: "Rapprochement effectué avec succès",
            transaction,
            invoice: {
              id: importedInvoice._id.toString(),
              number: importedInvoice.originalInvoiceNumber,
              clientName:
                importedInvoice.client?.name ||
                importedInvoice.vendor?.name ||
                "",
              totalTTC: importedInvoice.totalTTC,
              dueDate: importedInvoice.dueDate,
              status: importedInvoice.status,
            },
          };
        } catch (error) {
          logger.error(
            "[RECONCILIATION-GQL] Erreur rapprochement facture importée:",
            error,
          );
          return { success: false, message: error.message };
        }
      },
    ),

    // Délier une transaction d'une facture de CA importée (repasse en VALIDATED).
    unlinkTransactionFromImportedInvoice: withOrganization(
      async (parent, { input }, { user, workspaceId }) => {
        try {
          const { transactionId, importedInvoiceId } = input;

          let transaction, importedInvoice;

          if (transactionId) {
            transaction = await Transaction.findOne({
              _id: transactionId,
              workspaceId,
            });
            if (transaction?.linkedImportedInvoiceId) {
              importedInvoice = await ImportedInvoice.findById(
                transaction.linkedImportedInvoiceId,
              );
            }
          } else if (importedInvoiceId) {
            importedInvoice = await ImportedInvoice.findOne({
              _id: importedInvoiceId,
              workspaceId,
            });
            if (importedInvoice?.linkedTransactionId) {
              transaction = await Transaction.findById(
                importedInvoice.linkedTransactionId,
              );
            }
          }

          if (transaction) {
            transaction.linkedImportedInvoiceId = null;
            transaction.reconciliationStatus = "unmatched";
            transaction.reconciliationDate = null;
            await transaction.save();
          }

          if (importedInvoice) {
            importedInvoice.linkedTransactionId = null;
            importedInvoice.status = "VALIDATED";
            importedInvoice.paymentDate = null;
            await importedInvoice.save();
          }

          logger.info(
            `[RECONCILIATION-GQL] Déliaison: Transaction ${transactionId} <-> Facture importée ${importedInvoiceId}`,
          );

          return {
            success: true,
            message: "Déliaison effectuée avec succès",
            transaction: transaction || null,
          };
        } catch (error) {
          logger.error(
            "[RECONCILIATION-GQL] Erreur déliaison facture importée:",
            error,
          );
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
