import express from "express";
import crypto from "crypto";
import Stripe from "stripe";
import { bankingService } from "../services/banking/BankingService.js";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { bankingCacheService } from "../services/banking/BankingCacheService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Timing-safe HMAC-SHA256 signature verification (shared by Bridge and PayPal).
 */
function verifyHmacSignature(
  payload,
  signature,
  secret,
  { uppercase = false, prefix = "" } = {},
) {
  try {
    const actualSig =
      prefix && signature.startsWith(prefix)
        ? signature.slice(prefix.length)
        : signature;

    let expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    let provided = actualSig;

    if (uppercase) {
      expected = expected.toUpperCase();
      provided = provided.toUpperCase();
    }

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);

    return (
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf)
    );
  } catch {
    return false;
  }
}

/**
 * Routes pour les webhooks des providers bancaires
 * Each route validates the provider-specific signature before processing.
 */

// Webhook Bridge — HMAC-SHA256 with bridgeapi-signature header
router.post(
  "/webhook/bridge",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.BRIDGE_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("BRIDGE_WEBHOOK_SECRET not configured");
        return res.status(500).json({ error: "Webhook not configured" });
      }

      const signature = req.headers["bridgeapi-signature"];
      if (
        !signature ||
        !verifyHmacSignature(req.body, signature, secret, {
          uppercase: true,
          prefix: "v1=",
        })
      ) {
        logger.warn("Bridge webhook signature rejected", { ip: req.ip });
        return res.status(401).json({ error: "Invalid signature" });
      }

      const payload = JSON.parse(req.body.toString());
      const result = await bankingService.handleWebhook("bridge", payload);
      res.status(200).json({ received: true, processed: result });
    } catch (error) {
      logger.error("Bridge webhook processing error:", error.message);
      res.status(400).json({ error: "Processing error" });
    }
  },
);

// Webhook Stripe Banking — stripe.webhooks.constructEvent
router.post(
  "/webhook/stripe-banking",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.STRIPE_BANKING_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("STRIPE_BANKING_WEBHOOK_SECRET not configured");
        return res.status(500).json({ error: "Webhook not configured" });
      }

      const signature = req.headers["stripe-signature"];
      if (!signature) {
        logger.warn("Stripe Banking webhook missing signature", { ip: req.ip });
        return res.status(401).json({ error: "Missing signature" });
      }

      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, signature, secret);
      } catch {
        logger.warn("Stripe Banking webhook signature rejected", {
          ip: req.ip,
        });
        return res.status(401).json({ error: "Invalid signature" });
      }

      const result = await bankingService.handleWebhook("stripe", event);
      res.status(200).json({ received: true, processed: result });
    } catch (error) {
      logger.error("Stripe Banking webhook processing error:", error.message);
      res.status(400).json({ error: "Processing error" });
    }
  },
);

// Webhook PayPal — HMAC-SHA256 with paypal-transmission-sig header
router.post(
  "/webhook/paypal",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const secret = process.env.PAYPAL_WEBHOOK_SECRET;
      if (!secret) {
        logger.error("PAYPAL_WEBHOOK_SECRET not configured");
        return res.status(500).json({ error: "Webhook not configured" });
      }

      const signature = req.headers["paypal-transmission-sig"];
      if (!signature || !verifyHmacSignature(req.body, signature, secret)) {
        logger.warn("PayPal webhook signature rejected", { ip: req.ip });
        return res.status(401).json({ error: "Invalid signature" });
      }

      const payload = JSON.parse(req.body.toString());
      const result = await bankingService.handleWebhook("paypal", payload);
      res.status(200).json({ received: true, processed: result });
    } catch (error) {
      logger.error("PayPal webhook processing error:", error.message);
      res.status(400).json({ error: "Processing error" });
    }
  },
);

/**
 * Routes d'administration banking (protégées)
 */

// Switch de provider (admin only)
router.post(
  "/admin/switch-provider",
  betterAuthJWTMiddleware,
  async (req, res) => {
    try {
      const user = req.user;

      // Vérifier les permissions admin
      if (!user.role || !user.role.includes("admin")) {
        return res.status(403).json({ error: "Accès non autorisé" });
      }

      const { provider } = req.body;
      if (!provider) {
        return res.status(400).json({ error: "Provider requis" });
      }

      await bankingService.switchProvider(provider);
      res.json({ success: true, message: `Provider switché vers ${provider}` });
    } catch (error) {
      console.error("Erreur switch provider:", error);
      res.status(500).json({ error: error.message });
    }
  },
);

// Statut du service banking
router.get("/status", async (req, res) => {
  try {
    const status = {
      initialized: bankingService.initialized,
      currentProvider: bankingService.currentProvider?.providerName || "none",
      availableProviders: ["bridge", "stripe", "paypal", "mock"],
    };

    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Routes pour récupérer les données bancaires
 */

// Récupérer les comptes bancaires (avec cache)
router.get("/accounts", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Vérifier le cache d'abord
    const skipCache = req.query.skipCache === "true";
    if (!skipCache) {
      const cached = await bankingCacheService.getAccounts(workspaceId);
      if (cached.fromCache && cached.data) {
        logger.info(
          ` Cache HIT: ${cached.data.length} comptes pour workspace ${workspaceId}`,
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

    logger.info(
      ` BDD: ${accounts.length} comptes pour workspace ${workspaceId}`,
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
});

// Endpoint pour récupérer les transactions (avec cache)
router.get("/transactions", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
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
});

// Endpoint pour supprimer l'utilisateur Bridge
router.delete("/user", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"];
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
});

export default router;
