import express from "express";
import { bankingService } from "../services/banking/index.js";
import { betterAuthMiddleware } from "../middlewares/better-auth.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Génère l'URL de connexion bancaire pour Bridge
 * GET /banking-connect/bridge/connect
 */
router.get("/bridge/connect", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    console.log("🔍 Route /bridge/connect - workspaceId reçu:", workspaceId);
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Vérifier si un utilisateur Bridge existe déjà pour ce workspaceId
    try {
      const existingUser = await provider.getBridgeUserByExternalId(workspaceId);
      if (existingUser && existingUser.external_user_id !== 'undefined') {
        return res.status(400).json({ 
          error: "Un utilisateur Bridge existe déjà pour ce workspace",
          bridgeUserId: existingUser.uuid || existingUser.id
        });
      }
      // Si l'utilisateur existe mais avec external_user_id undefined, on continue pour le recréer
      if (existingUser && existingUser.external_user_id === 'undefined') {
        console.log("⚠️ Utilisateur Bridge trouvé avec external_user_id undefined, suppression...");
        try {
          await provider.client.delete(`/v3/aggregation/users/${existingUser.uuid}`);
          console.log("✅ Utilisateur Bridge avec external_user_id undefined supprimé");
        } catch (deleteError) {
          console.error("❌ Erreur suppression utilisateur Bridge:", deleteError.message);
        }
      }
    } catch (error) {
      // Si l'utilisateur n'existe pas (erreur 404), continuer normalement
      if (error.response?.status !== 404) {
        console.error("Erreur vérification utilisateur Bridge:", error.message);
      }
    }

    // Générer l'URL de connexion
    const connectUrl = await provider.generateConnectUrl(
      user._id.toString(),
      workspaceId
    );

    logger.info(`URL de connexion Bridge générée pour user ${user._id}`);

    res.json({
      connectUrl,
      provider: "bridge",
      environment: provider.config.environment,
    });
  } catch (error) {
    logger.error("Erreur génération URL Bridge:", error);
    res.status(500).json({
      error: "Erreur lors de la génération de l'URL de connexion",
      details: error.message,
    });
  }
});

/**
 * Callback Bridge v3 (redirection après connexion)
 * GET /banking-connect/bridge/callback
 */
router.get("/bridge/callback", async (req, res) => {
  try {
    const { session_id, error } = req.query;

    if (error) {
      logger.error("Erreur Bridge callback:", error);
      return res.redirect(
        `${
          process.env.FRONTEND_URL
        }/dashboard?banking_error=${encodeURIComponent(error)}`
      );
    }

    if (!session_id) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard?banking_error=missing_session_id`
      );
    }

    // Bridge v3 utilise des webhooks pour notifier les changements
    // Ce callback sert principalement à rediriger l'utilisateur
    logger.info(`Session Bridge terminée: ${session_id}`);

    // Rediriger vers le dashboard avec succès
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?banking_success=true&session_id=${session_id}`
    );
  } catch (error) {
    logger.error("Erreur callback Bridge:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?banking_error=${encodeURIComponent(
        error.message
      )}`
    );
  }
});

/**
 * Statut de la connexion bancaire
 * GET /banking-connect/status
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

    // Vérifier directement les comptes actifs via l'API Bridge
    let isConnected = false;
    let accountsCount = 0;
    let bridgeUserExists = false;
    
    try {
      await bankingService.initialize("bridge");
      const provider = bankingService.currentProvider;
      
      // D'abord vérifier si un utilisateur Bridge existe pour ce workspaceId
      try {
        const existingUser = await provider.getBridgeUserByExternalId(workspaceId);
        if (existingUser) {
          bridgeUserExists = true;
          isConnected = true;
          
          // Ensuite vérifier les comptes de cet utilisateur
          try {
            const accounts = await provider.client.get(`/v3/aggregation/users/${existingUser.uuid}/accounts`);
            if (accounts && accounts.data && accounts.data.resources) {
              accountsCount = accounts.data.resources.length;
            }
          } catch (accountError) {
            logger.info(`Aucun compte trouvé pour l'utilisateur Bridge ${existingUser.uuid}: ${accountError.message}`);
            accountsCount = 0;
          }
        }
      } catch (userError) {
        // Si l'utilisateur n'existe pas, pas de connexion
        logger.info(`Aucun utilisateur Bridge trouvé pour workspace ${workspaceId}: ${userError.message}`);
        bridgeUserExists = false;
        isConnected = false;
        accountsCount = 0;
      }
    } catch (error) {
      // Si erreur d'initialisation, pas de comptes actifs
      logger.error(`Erreur initialisation Bridge pour workspace ${workspaceId}: ${error.message}`);
      isConnected = false;
      accountsCount = 0;
      bridgeUserExists = false;
    }

    // Vérifier aussi les comptes en base de données locale (fallback)
    const { default: AccountBanking } = await import("../models/AccountBanking.js");
    const localAccountsCount = await AccountBanking.countDocuments({
      workspaceId,
      provider: "bridge",
      status: "active",
    });

    // Utiliser le maximum entre API Bridge et base locale
    accountsCount = Math.max(accountsCount, localAccountsCount);
    isConnected = isConnected || localAccountsCount > 0;

    // Récupérer les tokens pour lastSync
    const { default: User } = await import("../models/User.js");
    const userData = await User.findById(user._id);
    const bridgeTokens = userData?.bridgeTokens?.[workspaceId];

    res.json({
      isConnected,
      provider: isConnected ? "bridge" : null,
      accountsCount,
      bridgeUserExists,
      hasAccounts: accountsCount > 0,
      lastSync: bridgeTokens?.lastSync || null,
    });
  } catch (error) {
    logger.error("Erreur statut connexion:", error);
    res.status(500).json({
      error: "Erreur lors de la vérification du statut",
      details: error.message,
    });
  }
});

/**
 * Déconnexion bancaire
 * POST /banking-connect/disconnect
 */
router.post("/disconnect", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.body.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Supprimer les tokens Bridge
    const { default: User } = await import("../models/User.js");
    await User.findByIdAndUpdate(user._id, {
      $unset: {
        [`bridgeTokens.${workspaceId}`]: 1,
      },
    });

    // Marquer les comptes comme déconnectés
    const { default: AccountBanking } = await import(
      "../models/AccountBanking.js"
    );
    await AccountBanking.updateMany(
      { workspaceId, provider: "bridge" },
      { $set: { status: "disconnected" } }
    );

    logger.info(
      `Déconnexion Bridge pour user ${user._id}, workspace ${workspaceId}`
    );

    res.json({ success: true });
  } catch (error) {
    logger.error("Erreur déconnexion:", error);
    res.status(500).json({
      error: "Erreur lors de la déconnexion",
      details: error.message,
    });
  }
});

export default router;
