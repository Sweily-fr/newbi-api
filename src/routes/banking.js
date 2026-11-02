import express from "express";
import { bankingService } from "../services/banking/BankingService.js";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { bankingCacheService } from "../services/banking/BankingCacheService.js";
import logger from "../utils/logger.js";
import {
  BANK_ACCOUNT_MODULES,
  TRANSACTION_LIST_MODULES,
} from "../config/rolePermissions.js";
import {
  requireWorkspaceMembership,
  requireWorkspacePermission,
} from "../middlewares/require-workspace-membership.js";

const router = express.Router();

/**
 * Les webhooks des prestataires bancaires sont reçus par src/routes/webhook.js
 * (montée avant express.json). Les anciennes routes de ce fichier
 * (/banking/webhook/*, toujours refusées car le corps était déjà lu),
 * /banking/admin/switch-provider (requête jamais terminée, bascule globale du
 * prestataire) et /banking/status (public) sont retirées.
 */

/**
 * Routes pour récupérer les données bancaires
 */

// 🔐 À partir d'ici, toutes les routes exposent/modifient des données bancaires
// d'un workspace : on exige l'appartenance (ferme l'IDOR cross-org). Les
// webhooks signés (au-dessus) et /status ne sont pas concernés.
router.use(requireWorkspaceMembership);

// Comptes et soldes, transactions : pages qui les affichent (voir
// BANK_ACCOUNT_MODULES et TRANSACTION_LIST_MODULES)

// Récupérer les comptes bancaires (avec cache)
router.get(
  "/accounts",
  requireWorkspacePermission(BANK_ACCOUNT_MODULES, "read"),
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

      // Vérifier le cache d'abord
      const skipCache = req.query.skipCache === "true";
      if (!skipCache) {
        const cached = await bankingCacheService.getAccounts(workspaceId);
        if (cached.fromCache && cached.data) {
          logger.debug(
            `Cache HIT: ${cached.data.length} comptes pour workspace ${workspaceId}`,
          );
          return res.json({
            success: true,
            accounts: cached.data,
            count: cached.data.length,
            fromCache: true,
            cacheInfo: { ttl: bankingCacheService.TTL.accounts },
          });
        }
      }

      // Cache miss ou skip - récupérer depuis la BDD
      const { default: AccountBanking } =
        await import("../models/AccountBanking.js");
      const accounts = await AccountBanking.find({
        workspaceId,
        status: "active",
      }).sort({ createdAt: -1 });

      // Mettre en cache
      await bankingCacheService.setAccounts(workspaceId, accounts);

      logger.debug(
        `BDD: ${accounts.length} comptes pour workspace ${workspaceId}`,
      );

      res.json({
        success: true,
        accounts,
        count: accounts.length,
        fromCache: false,
      });
    } catch (error) {
      logger.error("Erreur récupération comptes:", error);
      res.status(500).json({
        error: "Erreur lors de la récupération des comptes",
        details: error.message,
      });
    }
  },
);

// Endpoint pour récupérer les transactions (avec cache)
router.get(
  "/transactions",
  requireWorkspacePermission(TRANSACTION_LIST_MODULES, "read"),
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

      const limit = parseInt(req.query.limit) || 50;
      const page = parseInt(req.query.page) || 1;
      const skip = (page - 1) * limit;

      // Options pour la clé de cache
      const cacheOptions = { limit, page };
      if (req.query.accountId) cacheOptions.accountId = req.query.accountId;
      if (req.query.type) cacheOptions.type = req.query.type;
      if (req.query.status) cacheOptions.status = req.query.status;

      // Vérifier le cache d'abord
      const skipCache = req.query.skipCache === "true";
      if (!skipCache) {
        const cached = await bankingCacheService.getTransactions(
          workspaceId,
          cacheOptions,
        );
        if (cached.fromCache && cached.data) {
          logger.info(
            `🎯 Cache HIT: ${cached.data.transactions?.length || 0} transactions pour workspace ${workspaceId}`,
          );
          return res.json({
            ...cached.data,
            fromCache: true,
            cacheInfo: { ttl: bankingCacheService.TTL.transactions },
          });
        }
      }

      // Cache miss ou skip - récupérer depuis la BDD
      const { default: Transaction } = await import("../models/Transaction.js");

      const query = { workspaceId, deletedAt: null };

      // Filtres optionnels
      if (req.query.accountId) {
        query.fromAccount = req.query.accountId;
      }

      if (req.query.type) {
        query.type = req.query.type;
      }

      if (req.query.status) {
        query.status = req.query.status;
      }

      const transactions = await Transaction.find(query)
        .sort({ date: -1 })
        .limit(limit)
        .skip(skip);

      const total = await Transaction.countDocuments(query);

      const responseData = {
        success: true,
        transactions,
        count: transactions.length,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      };

      // Mettre en cache
      await bankingCacheService.setTransactions(
        workspaceId,
        responseData,
        cacheOptions,
      );

      logger.info(
        `📊 BDD: ${transactions.length} transactions pour workspace ${workspaceId}`,
      );

      res.json({
        ...responseData,
        fromCache: false,
      });
    } catch (error) {
      logger.error("Erreur récupération transactions:", error);
      res.status(500).json({
        error: "Erreur lors de la récupération des transactions",
        details: error.message,
      });
    }
  },
);

// Endpoint pour supprimer l'utilisateur Bridge (et toutes les données
// bancaires de l'espace) : droit de gérer les applications et banques,
// comme la déconnexion d'une banque
router.delete(
  "/user",
  requireWorkspacePermission("integrations", "write"),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      // Espace validé par requireWorkspacePermission
      const workspaceId = req.workspaceId;
      if (!workspaceId) {
        return res.status(400).json({ error: "WorkspaceId requis" });
      }

      // Initialiser le service banking avec Bridge
      await bankingService.initialize("bridge");
      const provider = bankingService.currentProvider;

      // Supprimer l'utilisateur Bridge et toutes ses données
      const result = await provider.deleteBridgeUser(workspaceId);

      logger.info(
        `Utilisateur Bridge supprimé pour workspace ${workspaceId}:`,
        result,
      );

      res.json({
        success: true,
        message: "Utilisateur Bridge supprimé avec succès",
        deletedAccounts: result.deletedAccounts,
        deletedTransactions: result.deletedTransactions,
      });
    } catch (error) {
      logger.error("Erreur suppression utilisateur Bridge:", error);
      res.status(500).json({
        error: "Erreur lors de la suppression de l'utilisateur Bridge",
        details: error.message,
      });
    }
  },
);

export default router;
