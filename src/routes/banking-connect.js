import express from "express";
import { bankingService } from "../services/banking/index.js";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
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
    const user = await betterAuthJWTMiddleware(req);
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
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    // Vérifier que l'email est vérifié
    if (!user.isEmailVerified && !user.emailVerified) {
      return res.status(403).json({
        error: "Veuillez vérifier votre adresse email avant de connecter un compte bancaire",
        code: "EMAIL_NOT_VERIFIED",
      });
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
// ROUTES BRIDGE
// ============================================

/**
 * Liste les banques disponibles via Bridge
 * GET /banking-connect/bridge/institutions
 */
router.get("/bridge/institutions", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const country = req.query.country || "FR";

    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    const institutions = await provider.listInstitutions(country);

    res.json({
      institutions,
      country,
      count: institutions.length,
      provider: "bridge",
    });
  } catch (error) {
    logger.error("Erreur liste banques Bridge:", error);
    res.status(500).json({
      error: "Erreur lors de la récupération des banques",
      details: error.message,
    });
  }
});

/**
 * Génère l'URL de connexion bancaire pour Bridge
 * GET /banking-connect/bridge/connect
 */
router.get("/bridge/connect", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    // Vérifier que l'email est vérifié
    if (!user.isEmailVerified && !user.emailVerified) {
      return res.status(403).json({
        error: "Veuillez vérifier votre adresse email avant de connecter un compte bancaire",
        code: "EMAIL_NOT_VERIFIED",
      });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId;
    const providerId = req.query.providerId || req.query.bankId; // Provider pré-sélectionné (optionnel)

    console.log(
      "🔍 Route /bridge/connect - workspaceId:",
      workspaceId,
      "providerId:",
      providerId
    );
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Vérifier si un utilisateur Bridge existe déjà pour ce workspaceId
    // Si oui, on génère quand même une URL de connexion pour ajouter un nouveau compte
    let existingBridgeUser = null;
    try {
      existingBridgeUser =
        await provider.getBridgeUserByExternalId(workspaceId);
      if (existingBridgeUser) {
        console.log(
          "ℹ️ Utilisateur Bridge existant trouvé:",
          existingBridgeUser.uuid
        );
        // On continue pour permettre d'ajouter un nouveau compte bancaire
      }
    } catch (error) {
      // Si l'utilisateur n'existe pas (erreur 404), continuer normalement
      if (error.response?.status !== 404) {
        console.error("Erreur vérification utilisateur Bridge:", error.message);
      }
    }

    // Générer l'URL de connexion (avec provider pré-sélectionné si fourni)
    const connectUrl = await provider.generateConnectUrl(
      user._id.toString(),
      workspaceId,
      providerId
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
    const user = await betterAuthJWTMiddleware(req);
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
 *
 * Paramètres body:
 * - provider: (optionnel) provider spécifique à déconnecter
 * - itemId: (optionnel) ID de l'item/connexion bancaire spécifique à déconnecter
 * - accountId: (optionnel) ID du compte spécifique à déconnecter
 *
 * Priorité: accountId > itemId > provider > tous
 */
router.post("/disconnect", async (req, res) => {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"] || req.body.workspaceId;
    const provider = req.body.provider; // Optionnel: spécifier le provider à déconnecter
    const itemId = req.body.itemId; // Optionnel: ID de l'item Bridge spécifique
    const accountId = req.body.accountId; // Optionnel: ID du compte spécifique

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    const { default: User } = await import("../models/User.js");
    const { default: AccountBanking } =
      await import("../models/AccountBanking.js");

    let deletedAccountIds = [];
    let deletedItems = [];

    // Helper: supprimer un item Bridge côté API (best-effort)
    const deleteBridgeItemSafe = async (bridgeItemId) => {
      try {
        await bankingService.initialize("bridge");
        const bridgeProvider = bankingService.currentProvider;
        await bridgeProvider.deleteBridgeItem(bridgeItemId, workspaceId);
      } catch (err) {
        logger.warn(`Impossible de supprimer l'item Bridge ${bridgeItemId}: ${err.message}`);
      }
    };

    // Cas 1: Déconnexion d'un compte spécifique par son ID
    if (accountId) {
      const account = await AccountBanking.findOne({
        _id: accountId,
        workspaceId,
      });

      if (!account) {
        return res.status(404).json({ error: "Compte non trouvé" });
      }

      // Récupérer l'itemId du compte pour déconnecter tous les comptes du même item
      const accountItemId = account.raw?.item_id;

      if (accountItemId) {
        // Supprimer l'item côté Bridge API
        await deleteBridgeItemSafe(accountItemId);
        deletedItems.push(accountItemId);

        // Récupérer les IDs avant suppression
        const accountsToDelete = await AccountBanking.find({
          workspaceId,
          "raw.item_id": accountItemId,
        }).select("_id");
        deletedAccountIds = accountsToDelete.map((a) => a._id.toString());

        // Supprimer les comptes de la DB
        const result = await AccountBanking.deleteMany({
          workspaceId,
          "raw.item_id": accountItemId,
        });

        logger.info(
          `Suppression de l'item ${accountItemId} (${result.deletedCount} comptes) pour workspace ${workspaceId}`
        );
      } else {
        // Pas d'itemId, supprimer uniquement ce compte
        deletedAccountIds.push(accountId.toString());
        await AccountBanking.findByIdAndDelete(accountId);

        logger.info(
          `Suppression du compte ${accountId} pour workspace ${workspaceId}`
        );
      }

      return res.json({
        success: true,
        deletedAccountIds,
        deletedItems,
        mode: "account",
      });
    }

    // Cas 2: Déconnexion par itemId (tous les comptes d'un même item)
    if (itemId) {
      // Supprimer l'item côté Bridge API
      await deleteBridgeItemSafe(itemId);

      // Récupérer les IDs avant suppression
      const accountsToDelete = await AccountBanking.find({
        workspaceId,
        "raw.item_id": itemId,
      }).select("_id");
      deletedAccountIds = accountsToDelete.map((a) => a._id.toString());

      // Supprimer les comptes de la DB
      const result = await AccountBanking.deleteMany({
        workspaceId,
        "raw.item_id": itemId,
      });

      logger.info(
        `Suppression de l'item ${itemId} (${result.deletedCount} comptes) pour workspace ${workspaceId}`
      );

      return res.json({
        success: true,
        deletedAccountIds,
        deletedItems: [itemId],
        mode: "item",
      });
    }

    // Cas 3: Déconnexion par provider ou tous les providers
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

        // Récupérer tous les item_id distincts pour les supprimer côté Bridge
        const bridgeAccounts = await AccountBanking.find({
          workspaceId,
          provider: "bridge",
        }).select("raw.item_id");
        const uniqueItemIds = [
          ...new Set(
            bridgeAccounts
              .map((a) => a.raw?.item_id)
              .filter(Boolean)
          ),
        ];
        for (const bridgeItemId of uniqueItemIds) {
          await deleteBridgeItemSafe(bridgeItemId);
          deletedItems.push(bridgeItemId);
        }
      }

      // Supprimer les comptes de la DB
      await AccountBanking.deleteMany({ workspaceId, provider: p });
    }

    logger.info(
      `Déconnexion bancaire complète pour user ${user._id}, workspace ${workspaceId}, providers: ${providersToDisconnect.join(", ")}`
    );

    res.json({
      success: true,
      disconnectedProviders: providersToDisconnect,
      deletedItems,
      mode: "provider",
    });
  } catch (error) {
    logger.error("Erreur déconnexion:", error);
    res.status(500).json({
      error: "Erreur lors de la déconnexion",
      details: error.message,
    });
  }
});

export default router;
