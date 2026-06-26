import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { requireActiveSubscriptionREST } from "../middlewares/rbac.js";
import logger from "../utils/logger.js";
import { invoiceReferenceMatches } from "../utils/invoiceReferenceMatch.js";
// import { evaluatePaymentReporting } from "../utils/eInvoiceRoutingHelper.js"; // TODO E-REPORTING

const router = express.Router();

/**
 * Routes pour le rapprochement factures/transactions bancaires
 */

// Récupérer les transactions non rapprochées avec suggestions
router.get("/suggestions", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const { default: Transaction } = await import("../models/Transaction.js");
    const { default: Invoice } = await import("../models/Invoice.js");

    // Critères "à rapprocher" : IDENTIQUES au resolver GraphQL
    // (reconciliationResolvers.js). Entrée d'argent (amount > 0), non liée à une
    // facture, sans justificatif (receiptFiles vide = déjà justifiée), statut ni
    // "matched" ni "ignored".
    const reconcileQuery = {
      workspaceId,
      deletedAt: null,
      reconciliationStatus: { $nin: ["matched", "ignored"] },
      amount: { $gt: 0 },
      linkedInvoiceId: null,
      "receiptFiles.0": { $exists: false },
    };

    // Comptage complet (countDocuments) → le compteur n'est plus tronqué à 50.
    const unmatchedCount = await Transaction.countDocuments(reconcileQuery);
    const unmatchedTransactions = await Transaction.find(reconcileQuery)
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
        // Correspondance par montant (avec tolérance de 1%)
        const invoiceAmount = invoice.finalTotalTTC || invoice.totalTTC || 0;
        const tolerance = invoiceAmount * 0.01;
        const amountMatch =
          Math.abs(transaction.amount - invoiceAmount) <= tolerance;

        // Correspondance par nom du client dans la description
        const clientName =
          invoice.client?.name || invoice.client?.firstName || "";
        const descriptionMatch =
          clientName &&
          transaction.description
            ?.toLowerCase()
            .includes(clientName.toLowerCase());

        // Correspondance par numéro de facture présent dans le libellé brut
        // de la transaction (référence Bridge non tronquée).
        const referenceMatch = invoiceReferenceMatches(transaction, invoice);

        return amountMatch || descriptionMatch || referenceMatch;
      });

      if (matchingInvoices.length > 0) {
        suggestions.push({
          transaction: {
            _id: transaction._id,
            amount: transaction.amount,
            description: transaction.description,
            date: transaction.date,
            reconciliationStatus: transaction.reconciliationStatus,
          },
          matchingInvoices: matchingInvoices.map((inv) => ({
            _id: inv._id,
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

    res.json({
      success: true,
      suggestions,
      unmatchedCount,
      pendingInvoicesCount: pendingInvoices.length,
    });
  } catch (error) {
    logger.error("Erreur récupération suggestions:", error);
    res.status(500).json({
      error: "Erreur lors de la récupération des suggestions",
      details: error.message,
    });
  }
});

// Récupérer les transactions non rapprochées pour une facture spécifique
router.get("/transactions-for-invoice/:invoiceId", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const { invoiceId } = req.params;

    const { default: Transaction } = await import("../models/Transaction.js");
    const { default: Invoice } = await import("../models/Invoice.js");

    // Récupérer la facture
    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) {
      return res.status(404).json({ error: "Facture non trouvée" });
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
        score += 100; // Correspondance exacte
      } else if (Math.abs(tx.amount - invoiceAmount) <= invoiceAmount * 0.1) {
        score += 50; // Proche
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
        _id: tx._id,
        amount: tx.amount,
        description: tx.description,
        date: tx.date,
        reconciliationStatus: tx.reconciliationStatus,
        score,
      };
    });

    // Trier par score décroissant
    scoredTransactions.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      transactions: scoredTransactions.slice(0, 20),
      invoiceAmount,
    });
  } catch (error) {
    logger.error("Erreur récupération transactions pour facture:", error);
    res.status(500).json({
      error: "Erreur lors de la récupération des transactions",
      details: error.message,
    });
  }
});

// Lier une transaction à une facture
router.post(
  "/link",
  requireActiveSubscriptionREST({ failClosed: true }),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      const workspaceId =
        req.headers["x-workspace-id"] || req.query.workspaceId;
      if (!workspaceId) {
        return res.status(400).json({ error: "WorkspaceId requis" });
      }

      const { transactionId, invoiceId } = req.body;

      if (!transactionId || !invoiceId) {
        return res
          .status(400)
          .json({ error: "transactionId et invoiceId requis" });
      }

      const { default: Transaction } = await import("../models/Transaction.js");
      const { default: Invoice } = await import("../models/Invoice.js");

      // Revendication ATOMIQUE de la transaction (condition linkedInvoiceId:null)
      // → pas de race TOCTOU entre vérification et écriture.
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
        const exists = await Transaction.exists({ _id: transactionId, workspaceId });
        return res.status(exists ? 400 : 404).json({
          error: exists
            ? "Cette transaction est déjà liée à une facture"
            : "Transaction non trouvée",
        });
      }

      // Revendication ATOMIQUE de la facture, avec rollback de la transaction
      // si elle échoue (état cohérent garanti, sans transaction Mongo).
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
        return res.status(exists ? 400 : 404).json({
          error: exists
            ? "Cette facture est déjà liée à une transaction"
            : "Facture non trouvée",
        });
      }

      // TODO E-REPORTING: Décommenter quand l'API SuperPDP e-reporting sera disponible
      // try {
      //   if (evaluatePaymentReporting(invoice, transaction.date)) {
      //     await invoice.save();
      //   }
      // } catch (eReportingError) {
      //   logger.error("Erreur e-reporting payment (rapprochement REST):", eReportingError);
      // }

      logger.info(
        `Rapprochement effectué: Transaction ${transactionId} <-> Facture ${invoiceId}`,
      );

      res.json({
        success: true,
        message: "Rapprochement effectué avec succès",
        transaction: {
          _id: transaction._id,
          reconciliationStatus: transaction.reconciliationStatus,
        },
        invoice: {
          _id: invoice._id,
          number: invoice.number,
          status: invoice.status,
        },
      });
    } catch (error) {
      logger.error("Erreur rapprochement:", error);
      res.status(500).json({
        error: "Erreur lors du rapprochement",
        details: error.message,
      });
    }
  },
);

// Délier une transaction d'une facture
router.post(
  "/unlink",
  requireActiveSubscriptionREST({ failClosed: true }),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      const workspaceId =
        req.headers["x-workspace-id"] || req.query.workspaceId;
      if (!workspaceId) {
        return res.status(400).json({ error: "WorkspaceId requis" });
      }

      const { transactionId, invoiceId } = req.body;

      if (!transactionId && !invoiceId) {
        return res
          .status(400)
          .json({ error: "transactionId ou invoiceId requis" });
      }

      const { default: Transaction } = await import("../models/Transaction.js");
      const { default: Invoice } = await import("../models/Invoice.js");

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
          transaction = await Transaction.findById(invoice.linkedTransactionId);
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
        `Déliaison effectuée: Transaction ${transactionId} <-> Facture ${invoiceId}`,
      );

      res.json({
        success: true,
        message: "Déliaison effectuée avec succès",
      });
    } catch (error) {
      logger.error("Erreur déliaison:", error);
      res.status(500).json({
        error: "Erreur lors de la déliaison",
        details: error.message,
      });
    }
  },
);

// Ignorer une transaction (ne plus la suggérer)
router.post(
  "/ignore",
  requireActiveSubscriptionREST({ failClosed: true }),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      const workspaceId =
        req.headers["x-workspace-id"] || req.query.workspaceId;
      if (!workspaceId) {
        return res.status(400).json({ error: "WorkspaceId requis" });
      }

      const { transactionId } = req.body;

      if (!transactionId) {
        return res.status(400).json({ error: "transactionId requis" });
      }

      const { default: Transaction } = await import("../models/Transaction.js");

      const transaction = await Transaction.findOneAndUpdate(
        { _id: transactionId, workspaceId },
        { reconciliationStatus: "ignored" },
        { new: true },
      );

      if (!transaction) {
        return res.status(404).json({ error: "Transaction non trouvée" });
      }

      res.json({
        success: true,
        message: "Transaction ignorée",
      });
    } catch (error) {
      logger.error("Erreur ignorer transaction:", error);
      res.status(500).json({
        error: "Erreur lors de l'ignorance de la transaction",
        details: error.message,
      });
    }
  },
);

export default router;
