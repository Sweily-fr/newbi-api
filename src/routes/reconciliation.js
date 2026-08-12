import express from "express";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { requireActiveSubscriptionREST } from "../middlewares/rbac.js";
import logger from "../utils/logger.js";
import {
  findReconciliationSuggestions,
  findTransactionsForInvoice,
  setReconciliationIgnored,
} from "../utils/reconciliationMatching.js";
import { userBelongsToWorkspace } from "../utils/workspace-membership.js";
// import { evaluatePaymentReporting } from "../utils/eInvoiceRoutingHelper.js"; // TODO E-REPORTING

const router = express.Router();

/**
 * Routes pour le rapprochement factures/transactions bancaires
 */

/**
 * Authentifie la requête et vérifie que l'utilisateur appartient bien au
 * workspace demandé (le workspaceId vient du client : sans cette vérification
 * n'importe quel utilisateur authentifié pourrait lire/écrire les données
 * d'une autre organisation).
 *
 * Retourne { user, workspaceId } ou null (la réponse HTTP a alors déjà été
 * envoyée).
 */
async function authenticateWorkspaceRequest(req, res) {
  const user = await betterAuthJWTMiddleware(req);
  if (!user) {
    res.status(401).json({ error: "Non authentifié" });
    return null;
  }

  const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
  if (!workspaceId) {
    res.status(400).json({ error: "WorkspaceId requis" });
    return null;
  }

  const isMember = await userBelongsToWorkspace(
    user._id || user.id,
    workspaceId,
  );
  if (!isMember) {
    res.status(403).json({ error: "Accès refusé à ce workspace" });
    return null;
  }

  return { user, workspaceId };
}

// Récupérer les transactions non rapprochées avec suggestions
router.get("/suggestions", async (req, res) => {
  try {
    const auth = await authenticateWorkspaceRequest(req, res);
    if (!auth) return;
    const { workspaceId } = auth;

    // Logique partagée avec le resolver GraphQL reconciliationSuggestions
    // (utils/reconciliationMatching.js) : mêmes candidats, mêmes règles.
    const { suggestions, unmatchedCount, pendingInvoicesCount } =
      await findReconciliationSuggestions(workspaceId);

    res.json({
      success: true,
      suggestions: suggestions.map(
        ({ transaction, matchingInvoices, confidence }) => ({
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
          confidence,
        }),
      ),
      unmatchedCount,
      pendingInvoicesCount,
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
    const auth = await authenticateWorkspaceRequest(req, res);
    if (!auth) return;
    const { workspaceId } = auth;

    const { invoiceId } = req.params;

    const { default: Invoice } = await import("../models/Invoice.js");

    // Récupérer la facture (scopée workspace pour éviter toute lecture
    // cross-tenant)
    const invoice = await Invoice.findOne({ _id: invoiceId, workspaceId });
    if (!invoice) {
      return res.status(404).json({ error: "Facture non trouvée" });
    }

    // Logique partagée avec le resolver GraphQL transactionsForInvoice :
    // fenêtre de dates par défaut, contournée par ?search= (ex. acompte
    // encaissé avant l'émission de la facture).
    const { scored, invoiceAmount } = await findTransactionsForInvoice(
      invoice,
      workspaceId,
      req.query.search,
    );

    res.json({
      success: true,
      transactions: scored.map(({ transaction: tx, score }) => ({
        _id: tx._id,
        amount: tx.amount,
        description: tx.description,
        date: tx.date,
        reconciliationStatus: tx.reconciliationStatus,
        score,
      })),
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
      const auth = await authenticateWorkspaceRequest(req, res);
      if (!auth) return;
      const { workspaceId } = auth;

      const { transactionId, invoiceId } = req.body;

      if (!transactionId || !invoiceId) {
        return res
          .status(400)
          .json({ error: "transactionId et invoiceId requis" });
      }

      const { default: Transaction } = await import("../models/Transaction.js");
      const { default: Invoice } = await import("../models/Invoice.js");

      // Garde-fou : on ne rapproche que des factures émises. Une DRAFT
      // contournerait la numérotation DRAFT→PENDING, une CANCELED ne doit
      // pas redevenir COMPLETED.
      const targetInvoice = await Invoice.findOne({
        _id: invoiceId,
        workspaceId,
      });
      if (!targetInvoice) {
        return res.status(404).json({ error: "Facture non trouvée" });
      }
      if (["DRAFT", "CANCELED"].includes(targetInvoice.status)) {
        return res.status(400).json({
          error: `Impossible de rapprocher une facture au statut ${targetInvoice.status}`,
        });
      }

      // N↔N : $addToSet idempotent des deux côtés. Compensation si la
      // 2e op échoue.
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
        return res.status(404).json({ error: "Transaction non trouvée" });
      }

      const invoice = await Invoice.findOneAndUpdate(
        { _id: invoiceId, workspaceId },
        {
          $addToSet: { linkedTransactionIds: transactionId },
          $set: {
            status: "COMPLETED",
            // Première date de paiement préservée (liaisons multiples)
            paymentDate: targetInvoice.paymentDate || transaction.date,
          },
        },
        { new: true },
      );
      if (!invoice) {
        await Transaction.updateOne(
          { _id: transactionId, workspaceId },
          { $pull: { linkedInvoiceIds: invoiceId } },
        );
        return res.status(404).json({ error: "Facture non trouvée" });
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
      const auth = await authenticateWorkspaceRequest(req, res);
      if (!auth) return;
      const { workspaceId } = auth;

      const { transactionId, invoiceId } = req.body;

      // N↔N : on a besoin des DEUX ids pour cibler une liaison précise.
      if (!transactionId || !invoiceId) {
        return res.status(400).json({
          error:
            "transactionId et invoiceId sont requis pour délier une liaison N↔N",
        });
      }

      const { default: Transaction } = await import("../models/Transaction.js");
      const { default: Invoice } = await import("../models/Invoice.js");

      // Délier côté transaction ($pull idempotent). Si plus aucun lien
      // (ni facture de vente, ni facture d'achat) → status unmatched.
      const transaction = await Transaction.findOneAndUpdate(
        { _id: transactionId, workspaceId },
        { $pull: { linkedInvoiceIds: invoiceId } },
        { new: true },
      );
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
      }

      // Délier côté facture. Si plus aucune transaction liée → PENDING.
      const invoice = await Invoice.findOneAndUpdate(
        { _id: invoiceId, workspaceId },
        { $pull: { linkedTransactionIds: transactionId } },
        { new: true },
      );
      if (invoice && (invoice.linkedTransactionIds || []).length === 0) {
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
      const auth = await authenticateWorkspaceRequest(req, res);
      if (!auth) return;
      const { workspaceId } = auth;

      const { transactionId } = req.body;

      if (!transactionId) {
        return res.status(400).json({ error: "transactionId requis" });
      }

      const transaction = await setReconciliationIgnored(
        transactionId,
        workspaceId,
        true,
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

// Réintégrer au rapprochement une transaction ignorée (inverse de /ignore)
router.post(
  "/unignore",
  requireActiveSubscriptionREST({ failClosed: true }),
  async (req, res) => {
    try {
      const auth = await authenticateWorkspaceRequest(req, res);
      if (!auth) return;
      const { workspaceId } = auth;

      const { transactionId } = req.body;

      if (!transactionId) {
        return res.status(400).json({ error: "transactionId requis" });
      }

      const transaction = await setReconciliationIgnored(
        transactionId,
        workspaceId,
        false,
      );

      if (!transaction) {
        return res
          .status(404)
          .json({ error: "Transaction non trouvée ou non ignorée" });
      }

      res.json({
        success: true,
        message: "Transaction réintégrée au rapprochement",
      });
    } catch (error) {
      logger.error("Erreur dé-ignorer transaction:", error);
      res.status(500).json({
        error: "Erreur lors de la réintégration de la transaction",
        details: error.message,
      });
    }
  },
);

export default router;
