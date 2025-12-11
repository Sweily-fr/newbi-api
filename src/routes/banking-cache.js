import express from "express";
import { betterAuthMiddleware } from "../middlewares/better-auth.js";
import { bankingCacheService } from "../services/banking/BankingCacheService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Obtenir le statut du cache pour un workspace
 */
router.get("/status", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const cacheInfo = await bankingCacheService.getCacheInfo(workspaceId);

    res.json({
      success: true,
      cache: cacheInfo,
    });
  } catch (error) {
    logger.error("Erreur statut cache:", error);
    res.status(500).json({
      error: "Erreur lors de la récupération du statut du cache",
      details: error.message,
    });
  }
});

/**
 * Invalider tout le cache bancaire d'un workspace
 */
router.post("/invalidate", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    await bankingCacheService.invalidateAll(workspaceId);

    logger.info(`🗑️ Cache bancaire invalidé pour workspace ${workspaceId}`);

    res.json({
      success: true,
      message: "Cache bancaire invalidé avec succès",
      workspaceId,
    });
  } catch (error) {
    logger.error("Erreur invalidation cache:", error);
    res.status(500).json({
      error: "Erreur lors de l'invalidation du cache",
      details: error.message,
    });
  }
});

/**
 * Invalider un type spécifique de cache
 */
router.post("/invalidate/:type", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const { type } = req.params;
    const validTypes = ["accounts", "transactions", "balances", "stats"];

    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Type invalide. Types valides: ${validTypes.join(", ")}`,
      });
    }

    // Appeler la méthode d'invalidation appropriée
    switch (type) {
      case "accounts":
        await bankingCacheService.invalidateAccounts(workspaceId);
        break;
      case "transactions":
        await bankingCacheService.invalidateTransactions(workspaceId);
        break;
      case "balances":
        await bankingCacheService.invalidateBalances(workspaceId);
        break;
      case "stats":
        await bankingCacheService.invalidateStats(workspaceId);
        break;
    }

    logger.info(`🗑️ Cache ${type} invalidé pour workspace ${workspaceId}`);

    res.json({
      success: true,
      message: `Cache ${type} invalidé avec succès`,
      workspaceId,
      type,
    });
  } catch (error) {
    logger.error("Erreur invalidation cache type:", error);
    res.status(500).json({
      error: "Erreur lors de l'invalidation du cache",
      details: error.message,
    });
  }
});

/**
 * Forcer le rafraîchissement du cache (invalidate + fetch)
 */
router.post("/refresh", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Invalider tout le cache
    await bankingCacheService.invalidateAll(workspaceId);

    // Récupérer les données fraîches depuis la BDD
    const { default: AccountBanking } =
      await import("../models/AccountBanking.js");
    const { default: Transaction } = await import("../models/Transaction.js");

    const accounts = await AccountBanking.find({
      workspaceId,
      status: "active",
    }).sort({ createdAt: -1 });

    const transactions = await Transaction.find({ workspaceId })
      .sort({ date: -1 })
      .limit(500);

    // Calculer les soldes
    const totalBalance = accounts.reduce(
      (sum, acc) => sum + (acc.balance || 0),
      0
    );

    // Mettre en cache les nouvelles données
    await bankingCacheService.setAccounts(workspaceId, accounts);
    await bankingCacheService.setTransactions(workspaceId, {
      success: true,
      transactions,
      count: transactions.length,
      total: transactions.length,
      page: 1,
      totalPages: 1,
    });
    await bankingCacheService.setBalances(workspaceId, {
      totalBalance,
      accountsCount: accounts.length,
      updatedAt: new Date(),
    });

    logger.info(
      `🔄 Cache rafraîchi pour workspace ${workspaceId}: ${accounts.length} comptes, ${transactions.length} transactions`
    );

    res.json({
      success: true,
      message: "Cache rafraîchi avec succès",
      data: {
        accountsCount: accounts.length,
        transactionsCount: transactions.length,
        totalBalance,
      },
    });
  } catch (error) {
    logger.error("Erreur rafraîchissement cache:", error);
    res.status(500).json({
      error: "Erreur lors du rafraîchissement du cache",
      details: error.message,
    });
  }
});

export default router;
