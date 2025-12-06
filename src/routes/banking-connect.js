import express from "express";
import { bankingService } from "../services/banking/index.js";
import { betterAuthMiddleware } from "../middlewares/better-auth.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Provider par défaut (peut être changé via variable d'environnement)
const DEFAULT_PROVIDER = process.env.BANKING_PROVIDER || "gocardless";

// ============================================
// ROUTES GOCARDLESS
// ============================================

/**
 * Liste les institutions bancaires disponibles
 * GET /banking-connect/gocardless/institutions
 */
router.get("/gocardless/institutions", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const country = req.query.country || "FR";

    await bankingService.initialize("gocardless");
    const provider = bankingService.currentProvider;

    const institutions = await provider.listInstitutions(country);

    res.json({
      institutions,
      country,
      count: institutions.length,
    });
  } catch (error) {
    logger.error("Erreur liste institutions:", error);
    res.status(500).json({
      error: "Erreur lors de la récupération des institutions",
      details: error.message,
    });
  }
});

/**
 * Génère l'URL de connexion bancaire pour GoCardless
 * GET /banking-connect/gocardless/connect
 */
router.get("/gocardless/connect", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    const institutionId = req.query.institutionId;

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    if (!institutionId) {
      return res
        .status(400)
        .json({ error: "InstitutionId requis (banque à connecter)" });
    }

    console.log(
      "🔍 Route /gocardless/connect - workspaceId:",
      workspaceId,
      "institutionId:",
      institutionId
    );

    await bankingService.initialize("gocardless");
    const provider = bankingService.currentProvider;

    // Générer l'URL de connexion
    const connectUrl = await provider.generateConnectUrl(
      user._id.toString(),
      workspaceId,
      institutionId
    );

    logger.info(`URL de connexion GoCardless générée pour user ${user._id}`);

    res.json({
      connectUrl,
      provider: "gocardless",
      institutionId,
    });
  } catch (error) {
    logger.error("Erreur génération URL GoCardless:", error);
    res.status(500).json({
      error: "Erreur lors de la génération de l'URL de connexion",
      details: error.message,
    });
  }
});

/**
 * Callback GoCardless (redirection après connexion)
 * GET /banking-connect/gocardless/callback
 */
router.get("/gocardless/callback", async (req, res) => {
  try {
    const { ref, error } = req.query;

    if (error) {
      logger.error("Erreur GoCardless callback:", error);
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard?banking_error=${encodeURIComponent(error)}`
      );
    }

    if (!ref) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard?banking_error=missing_reference`
      );
    }

    // Le ref correspond au workspaceId (reference de la requisition)
    logger.info(`Callback GoCardless reçu pour workspace: ${ref}`);

    // Rediriger vers le dashboard avec succès
    // La synchronisation sera déclenchée côté frontend
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?banking_success=true&provider=gocardless&ref=${ref}`
    );
  } catch (error) {
    logger.error("Erreur callback GoCardless:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?banking_error=${encodeURIComponent(error.message)}`
    );
  }
});

// ============================================
// ROUTES BRIDGE (legacy)
// ============================================

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
      const existingUser =
        await provider.getBridgeUserByExternalId(workspaceId);
      if (existingUser && existingUser.external_user_id !== "undefined") {
        return res.status(400).json({
          error: "Un utilisateur Bridge existe déjà pour ce workspace",
          bridgeUserId: existingUser.uuid || existingUser.id,
        });
      }
      // Si l'utilisateur existe mais avec external_user_id undefined, on continue pour le recréer
      if (existingUser && existingUser.external_user_id === "undefined") {
        console.log(
          "⚠️ Utilisateur Bridge trouvé avec external_user_id undefined, suppression..."
        );
        try {
          await provider.client.delete(
            `/v3/aggregation/users/${existingUser.uuid}`
          );
          console.log(
            "✅ Utilisateur Bridge avec external_user_id undefined supprimé"
          );
        } catch (deleteError) {
          console.error(
            "❌ Erreur suppression utilisateur Bridge:",
            deleteError.message
          );
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
 * Statut de la connexion bancaire (multi-provider)
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

    const { default: AccountBanking } =
      await import("../models/AccountBanking.js");
    const { default: User } = await import("../models/User.js");

    // Vérifier les comptes en base de données (tous providers confondus)
    const accounts = await AccountBanking.find({
      workspaceId,
      status: "active",
    });

    const accountsCount = accounts.length;
    const isConnected = accountsCount > 0;

    // Déterminer le provider actif
    let activeProvider = null;
    if (isConnected) {
      // Prendre le provider du premier compte actif
      activeProvider = accounts[0]?.provider || DEFAULT_PROVIDER;
    }

    // Récupérer les infos utilisateur pour lastSync
    const userData = await User.findById(user._id);

    // Vérifier les requisitions GoCardless
    const gocardlessRequisition =
      userData?.gocardlessRequisitions?.[workspaceId];

    // Vérifier les tokens Bridge (legacy)
    const bridgeTokens = userData?.bridgeTokens?.[workspaceId];

    res.json({
      isConnected,
      provider: activeProvider,
      accountsCount,
      hasAccounts: accountsCount > 0,
      lastSync:
        gocardlessRequisition?.createdAt || bridgeTokens?.lastSync || null,
      // Infos spécifiques par provider
      gocardless: gocardlessRequisition
        ? {
            requisitionId: gocardlessRequisition.requisitionId,
            institutionId: gocardlessRequisition.institutionId,
          }
        : null,
      bridge: bridgeTokens
        ? {
            hasTokens: true,
          }
        : null,
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
 * Déconnexion bancaire (multi-provider)
 * POST /banking-connect/disconnect
 */
router.post("/disconnect", async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.body.workspaceId;
    const provider = req.body.provider; // Optionnel: spécifier le provider à déconnecter

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const { default: User } = await import("../models/User.js");
    const { default: AccountBanking } =
      await import("../models/AccountBanking.js");

    // Si un provider spécifique est demandé, ne déconnecter que celui-là
    // Sinon, déconnecter tous les providers
    const providersToDisconnect = provider
      ? [provider]
      : ["gocardless", "bridge"];

    for (const p of providersToDisconnect) {
      if (p === "gocardless") {
        // Supprimer les requisitions GoCardless
        await User.findByIdAndUpdate(user._id, {
          $unset: { [`gocardlessRequisitions.${workspaceId}`]: 1 },
        });
      } else if (p === "bridge") {
        // Supprimer les tokens Bridge
        await User.findByIdAndUpdate(user._id, {
          $unset: { [`bridgeTokens.${workspaceId}`]: 1 },
        });
      }

      // Marquer les comptes comme déconnectés
      await AccountBanking.updateMany(
        { workspaceId, provider: p },
        { $set: { status: "disconnected" } }
      );
    }

    logger.info(
      `Déconnexion bancaire pour user ${user._id}, workspace ${workspaceId}, providers: ${providersToDisconnect.join(", ")}`
    );

    res.json({ success: true, disconnectedProviders: providersToDisconnect });
  } catch (error) {
    logger.error("Erreur déconnexion:", error);
    res.status(500).json({
      error: "Erreur lors de la déconnexion",
      details: error.message,
    });
  }
});

export default router;
