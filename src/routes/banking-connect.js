import express from "express";
import { bankingService } from "../services/banking/index.js";
import { bankingCacheService } from "../services/banking/BankingCacheService.js";
import { betterAuthJWTMiddleware } from "../middlewares/better-auth-jwt.js";
import { requireActiveSubscriptionREST } from "../middlewares/rbac.js";
import { requireWorkspacePermission } from "../middlewares/require-workspace-membership.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Provider par défaut (peut être changé via variable d'environnement)
const DEFAULT_PROVIDER = process.env.BANKING_PROVIDER || "bridge";

// Cache mémoire (par instance PM2) du statut des items Bridge, pour ne pas
// appeler Bridge à chaque affichage du statut. TTL court : un statut d'item
// change après une reconnexion utilisateur.
const ITEMS_STATUS_TTL_MS = 5 * 60 * 1000;
const itemsStatusCache = new Map();

// Statuts Bridge nécessitant une action de l'utilisateur :
// 402 = identifiants invalides, 429 = action requise dans l'espace client,
// 1010 = ré-authentification forte (SCA) requise.
// Tant que l'item est dans un de ces états, la synchronisation est bloquée.
const ACTION_REQUIRED_STATUSES = new Set([402, 429, 1010]);

async function getItemsNeedingAction(
  workspaceId,
  accounts,
  { force = false } = {},
) {
  const key = workspaceId.toString();
  const cached = itemsStatusCache.get(key);
  if (!force && cached && Date.now() - cached.at < ITEMS_STATUS_TTL_MS) {
    return cached.items;
  }

  await bankingService.initialize("bridge");
  const provider = bankingService.currentProvider;
  const items = await provider.listItems(workspaceId);

  const needingAction = items
    .filter((item) => ACTION_REQUIRED_STATUSES.has(item.status))
    .map((item) => {
      const account = accounts.find(
        (a) => a.raw?.item_id?.toString() === item.itemId,
      );
      return {
        itemId: item.itemId,
        status: item.status,
        statusCodeInfo: item.statusCodeInfo,
        authenticationExpiresAt: item.authenticationExpiresAt,
        bankName: account?.institutionName || null,
      };
    });

  itemsStatusCache.set(key, { at: Date.now(), items: needingAction });
  return needingAction;
}

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
router.get(
  "/bridge/connect",
  requireWorkspacePermission("integrations", "write"),
  requireActiveSubscriptionREST({ failClosed: true }),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      // Vérifier que l'email est vérifié
      if (!user.isEmailVerified && !user.emailVerified) {
        return res.status(403).json({
          error:
            "Veuillez vérifier votre adresse email avant de connecter un compte bancaire",
          code: "EMAIL_NOT_VERIFIED",
        });
      }

      const workspaceId =
        req.headers["x-workspace-id"] || req.query.workspaceId;
      const providerId = req.query.providerId || req.query.bankId; // Provider pré-sélectionné (optionnel)
      const source = req.query.source || "web"; // "web" (default) or "mobile"

      logger.debug(
        "🔍 Route /bridge/connect - workspaceId:",
        workspaceId,
        "providerId:",
        providerId,
        "source:",
        source,
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
          logger.debug(
            "ℹ️ Utilisateur Bridge existant trouvé:",
            existingBridgeUser.uuid,
          );
          // On continue pour permettre d'ajouter un nouveau compte bancaire
        }
      } catch (error) {
        // Si l'utilisateur n'existe pas (erreur 404), continuer normalement
        if (error.response?.status !== 404) {
          console.error(
            "Erreur vérification utilisateur Bridge:",
            error.message,
          );
        }
      }

      // Determine redirect URL based on source (web or mobile)
      // Mobile uses a Universal Link that iOS intercepts to reopen the app
      // This URL must also be whitelisted in the Bridge dashboard
      const connectOptions = {};
      if (source === "mobile" && process.env.BRIDGE_MOBILE_REDIRECT_URI) {
        connectOptions.callbackUrl = process.env.BRIDGE_MOBILE_REDIRECT_URI;
      }

      // Générer l'URL de connexion (avec provider pré-sélectionné si fourni)
      const connectUrl = await provider.generateConnectUrl(
        user._id.toString(),
        workspaceId,
        providerId,
        connectOptions,
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
  },
);

/**
 * Génère l'URL de ré-authentification Bridge pour un item existant
 * (SCA expirée, identifiants à revalider, etc.)
 * GET /banking-connect/bridge/reconnect?itemId=xxx
 */
router.get(
  "/bridge/reconnect",
  requireWorkspacePermission("integrations", "write"),
  requireActiveSubscriptionREST({ failClosed: true }),
  async (req, res) => {
    try {
      const user = await betterAuthJWTMiddleware(req);
      if (!user) {
        return res.status(401).json({ error: "Non authentifié" });
      }

      const workspaceId =
        req.headers["x-workspace-id"] || req.query.workspaceId;
      const itemId = req.query.itemId;

      if (!workspaceId) {
        return res.status(400).json({ error: "WorkspaceId requis" });
      }
      if (!itemId || !/^\d+$/.test(itemId)) {
        return res.status(400).json({ error: "itemId requis" });
      }

      await bankingService.initialize("bridge");
      const provider = bankingService.currentProvider;

      // Vérifier que l'item appartient bien à ce workspace
      const items = await provider.listItems(workspaceId);
      const item = items.find((i) => i.itemId === itemId);
      if (!item) {
        return res
          .status(404)
          .json({ error: "Connexion bancaire introuvable pour ce workspace" });
      }

      const connectUrl = await provider.generateReconnectUrl(
        workspaceId,
        itemId,
      );

      // Invalider le cache de statut : au retour de l'utilisateur, le
      // statut de l'item doit être relu depuis Bridge
      itemsStatusCache.delete(workspaceId.toString());

      logger.info(
        `URL de reconnexion Bridge générée pour item ${itemId} (workspace ${workspaceId})`,
      );

      res.json({ connectUrl, provider: "bridge" });
    } catch (error) {
      logger.error("Erreur génération URL de reconnexion Bridge:", error);
      res.status(500).json({
        error: "Erreur lors de la génération de l'URL de reconnexion",
        details: error.message,
      });
    }
  },
);

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
        }/dashboard?banking_error=${encodeURIComponent(error)}`,
      );
    }

    if (!session_id) {
      return res.redirect(
        `${process.env.FRONTEND_URL}/dashboard?banking_error=missing_session_id`,
      );
    }

    // Bridge v3 utilise des webhooks pour notifier les changements
    // Ce callback sert principalement à rediriger l'utilisateur
    logger.info(`Session Bridge terminée: ${session_id}`);

    // Rediriger vers le dashboard avec succès
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?banking_success=true&session_id=${session_id}`,
    );
  } catch (error) {
    logger.error("Erreur callback Bridge:", error);
    res.redirect(
      `${process.env.FRONTEND_URL}/dashboard?banking_error=${encodeURIComponent(
        error.message,
      )}`,
    );
  }
});

/**
 * Statut de la connexion bancaire (multi-provider)
 * GET /banking-connect/status
 */
router.get(
  "/status",
  requireWorkspacePermission("banking", "read"),
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

      // Vérifier les tokens Bridge (legacy)
      const bridgeTokens = userData?.bridgeTokens?.[workspaceId];

      // Connexions Bridge nécessitant une action utilisateur (SCA expirée,
      // identifiants invalides...) : sans ça la sync s'arrête silencieusement.
      // ?refresh=true force la relecture depuis Bridge (retour de reconnexion).
      let itemsNeedingAction = [];
      if (isConnected && activeProvider === "bridge") {
        try {
          itemsNeedingAction = await getItemsNeedingAction(
            workspaceId,
            accounts,
            {
              force: req.query.refresh === "true",
            },
          );
        } catch (err) {
          logger.warn(`Statut items Bridge indisponible: ${err.message}`);
        }
      }

      res.json({
        isConnected,
        provider: activeProvider,
        accountsCount,
        hasAccounts: accountsCount > 0,
        itemsNeedingAction,
        lastSync: bridgeTokens?.lastSync || null,
        // Infos spécifiques par provider
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
  },
);

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
 *
 * La connexion est supprimée chez le prestataire et les comptes passent en
 * « déconnecté » ; les transactions et tout ce qui s'y rattache
 * (justificatifs, catégories, notes, rapprochements) sont conservés.
 */
router.post(
  "/disconnect",
  requireWorkspacePermission("integrations", "write"),
  async (req, res) => {
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
          logger.warn(
            `Impossible de supprimer l'item Bridge ${bridgeItemId}: ${err.message}`,
          );
        }
      };

      // Helper: passer des comptes en « déconnecté ». Les comptes restent en
      // base (les transactions gardent leur compte d'origine) et sortent des
      // listes, des soldes et des synchronisations. Les transactions, leurs
      // justificatifs, catégories, notes et rapprochements sont conservés :
      // rien n'est supprimé.
      const markAccountsDisconnected = async (filter) => {
        const result = await AccountBanking.updateMany(
          { ...filter, workspaceId, status: { $ne: "disconnected" } },
          { $set: { status: "disconnected", disconnectedAt: new Date() } },
        );
        return result.modifiedCount || 0;
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

          const accountsOfItem = await AccountBanking.find({
            workspaceId,
            "raw.item_id": accountItemId,
          }).select("_id");
          deletedAccountIds = accountsOfItem.map((a) => a._id.toString());

          const count = await markAccountsDisconnected({
            "raw.item_id": accountItemId,
          });

          logger.info(
            `Déconnexion de l'item ${accountItemId} (${count} comptes, transactions conservées) pour workspace ${workspaceId}`,
          );
        } else {
          // Pas d'itemId : ce compte seulement
          deletedAccountIds.push(accountId.toString());
          await markAccountsDisconnected({ _id: account._id });

          logger.info(
            `Déconnexion du compte ${accountId} (transactions conservées) pour workspace ${workspaceId}`,
          );
        }

        // Invalider le cache pour que la liste des comptes reflète la suppression
        await bankingCacheService.invalidateAll(workspaceId);

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

        const accountsOfItem = await AccountBanking.find({
          workspaceId,
          "raw.item_id": itemId,
        }).select("_id");
        deletedAccountIds = accountsOfItem.map((a) => a._id.toString());

        const count = await markAccountsDisconnected({ "raw.item_id": itemId });

        logger.info(
          `Déconnexion de l'item ${itemId} (${count} comptes, transactions conservées) pour workspace ${workspaceId}`,
        );

        // Invalider le cache pour que la liste des comptes reflète la suppression
        await bankingCacheService.invalidateAll(workspaceId);

        return res.json({
          success: true,
          deletedAccountIds,
          deletedItems: [itemId],
          mode: "item",
        });
      }

      // Cas 3: Déconnexion par provider ou tous les providers
      const providersToDisconnect = provider ? [provider] : ["bridge"];

      for (const p of providersToDisconnect) {
        if (p === "bridge") {
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
              bridgeAccounts.map((a) => a.raw?.item_id).filter(Boolean),
            ),
          ];
          for (const bridgeItemId of uniqueItemIds) {
            await deleteBridgeItemSafe(bridgeItemId);
            deletedItems.push(bridgeItemId);
          }
        }

        // Comptes du provider déconnectés, transactions conservées
        await markAccountsDisconnected({ provider: p });
      }

      // Invalider le cache pour que la liste des comptes reflète la suppression
      await bankingCacheService.invalidateAll(workspaceId);

      logger.info(
        `Déconnexion bancaire complète pour user ${user._id}, workspace ${workspaceId}, providers: ${providersToDisconnect.join(", ")}`,
      );

      res.json({
        success: true,
        disconnectedProviders: providersToDisconnect,
        deletedItems,
        mode: "provider",
        all: true,
      });
    } catch (error) {
      logger.error("Erreur déconnexion:", error);
      res.status(500).json({
        error: "Erreur lors de la déconnexion",
        details: error.message,
      });
    }
  },
);

export default router;
