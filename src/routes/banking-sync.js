import express from "express";
import { bankingService } from "../services/banking/index.js";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { bankingCacheService } from "../services/banking/BankingCacheService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Synchronise les comptes bancaires
 */
router.post("/accounts", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Synchroniser les comptes - utiliser "webhook-sync" pour créer un token à la volée
    const accounts = await provider.syncUserAccounts(
      "webhook-sync",
      workspaceId
    );

    // Invalider le cache après synchronisation
    await bankingCacheService.invalidateAccounts(workspaceId);
    await bankingCacheService.invalidateBalances(workspaceId);

    logger.info(
      `Comptes synchronisés pour user ${user._id}: ${accounts.length} comptes (cache invalidé)`
    );

    res.json({
      success: true,
      accounts: accounts.length,
      data: accounts,
      cacheInvalidated: true,
    });
  } catch (error) {
    logger.error("Erreur synchronisation comptes:", error);
    res.status(500).json({
      error: "Erreur lors de la synchronisation des comptes",
      details: error.message,
    });
  }
});

/**
 * Synchronise les transactions
 *
 * Body params:
 * - accountId (optional): ID du compte spécifique à synchroniser
 * - since (optional): Date de début au format YYYY-MM-DD (défaut: 90 jours en arrière)
 * - until (optional): Date de fin au format YYYY-MM-DD (défaut: aujourd'hui)
 * - fullSync (optional): true pour forcer une sync complète sans limite de pages
 */
router.post("/transactions", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    const { accountId, since, until, fullSync = false } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Validation des dates si fournies
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({
        error: "Format de date 'since' invalide. Utilisez YYYY-MM-DD",
      });
    }
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({
        error: "Format de date 'until' invalide. Utilisez YYYY-MM-DD",
      });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    let result;

    if (accountId) {
      // Synchroniser les transactions pour un compte spécifique
      const transactions = await provider.getTransactions(
        accountId,
        "webhook-sync",
        workspaceId,
        { since, until, fullSync }
      );
      result = {
        accounts: 1,
        transactions: transactions.length,
        period: {
          since: since || provider._getDefaultDateRange().since,
          until: until || provider._getDefaultDateRange().until,
        },
      };
    } else {
      // Synchroniser toutes les transactions pour tous les comptes
      result = await provider.syncAllTransactions("webhook-sync", workspaceId, {
        since,
        until,
        fullSync,
      });
    }

    // Invalider le cache après synchronisation
    await bankingCacheService.invalidateTransactions(workspaceId);
    await bankingCacheService.invalidateStats(workspaceId);

    logger.info(
      `Transactions synchronisées pour user ${user._id}: ${result.transactions} transactions (cache invalidé)`
    );

    res.json({
      success: true,
      ...result,
      cacheInvalidated: true,
    });
  } catch (error) {
    logger.error("Erreur synchronisation transactions:", error);
    res.status(500).json({
      error: "Erreur lors de la synchronisation des transactions",
      details: error.message,
    });
  }
});

/**
 * Synchronisation complète (comptes + transactions)
 *
 * Body params:
 * - since (optional): Date de début au format YYYY-MM-DD (défaut: 90 jours en arrière)
 * - until (optional): Date de fin au format YYYY-MM-DD (défaut: aujourd'hui)
 * - fullSync (optional): true pour forcer une sync complète sans limite de pages
 */
router.post("/full", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    const { since, until, fullSync = false } = req.body;

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Validation des dates si fournies
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(400).json({
        error: "Format de date 'since' invalide. Utilisez YYYY-MM-DD",
      });
    }
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      return res.status(400).json({
        error: "Format de date 'until' invalide. Utilisez YYYY-MM-DD",
      });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Synchronisation complète - utiliser "webhook-sync" pour créer un token à la volée
    const result = await provider.syncAllTransactions(
      "webhook-sync",
      workspaceId,
      { since, until, fullSync }
    );

    // Invalider tout le cache après synchronisation complète
    await bankingCacheService.invalidateAll(workspaceId);

    logger.info(
      `Synchronisation complète pour user ${user._id}: ${result.accounts} comptes, ${result.transactions} transactions (cache invalidé)`
    );

    res.json({
      success: true,
      message: "Synchronisation complète terminée",
      ...result,
      cacheInvalidated: true,
    });
  } catch (error) {
    logger.error("Erreur synchronisation complète:", error);
    res.status(500).json({
      error: "Erreur lors de la synchronisation complète",
      details: error.message,
    });
  }
});

export default router;
