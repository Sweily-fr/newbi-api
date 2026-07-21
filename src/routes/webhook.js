import express from "express";
import crypto from "crypto";
import { bankingService } from "../services/banking/index.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Configuration de la synchronisation des transactions
 * Comportement "à la Pennylane":
 * - Après connexion (account.connected) → sync de tout l'historique disponible
 * - item.refreshed avec full_refresh: true → re-sync complète
 * - item.account.updated → sync incrémentale (seulement les nouvelles transactions)
 */
const SYNC_CONFIG = {
  // Pour la première sync / full_refresh, on récupère tout l'historique disponible
  // Bridge retourne généralement 3-6 mois selon la banque (jusqu'à 36 mois max)
  fullSyncDaysBack: 365 * 2, // 2 ans max (Bridge limitera selon la banque)
  // Pour la sync incrémentale, on récupère les 7 derniers jours par sécurité
  incrementalSyncDaysBack: 7,
};

// Middleware pour capturer le body brut pour la vérification de signature
const rawBodyParser = express.raw({ type: "application/json" });

// Fonction pour vérifier la signature du webhook Bridge
const verifyBridgeSignature = (payload, signature, secret) => {
  try {
    // Bridge utilise le format "v1=SIGNATURE"
    const actualSignature = signature.startsWith("v1=")
      ? signature.slice(3)
      : signature;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex")
      .toUpperCase(); // Bridge utilise des majuscules

    // Timing-safe comparison to prevent timing attacks
    const expectedBuf = Buffer.from(expectedSignature);
    const providedBuf = Buffer.from(actualSignature.toUpperCase());

    return (
      expectedBuf.length === providedBuf.length &&
      crypto.timingSafeEqual(expectedBuf, providedBuf)
    );
  } catch (error) {
    console.error("❌ Erreur lors de la vérification de signature:", error);
    return false;
  }
};

// Endpoint webhook Bridge
router.post("/bridge", rawBodyParser, async (req, res) => {
  try {
    const signature = req.headers["bridgeapi-signature"];
    const webhookSecret = process.env.BRIDGE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("❌ BRIDGE_WEBHOOK_SECRET non configuré");
      return res.status(500).json({ error: "Webhook secret not configured" });
    }

    // Vérifier la signature si elle est présente
    if (signature && webhookSecret) {
      const isValidSignature = verifyBridgeSignature(
        req.body,
        signature,
        webhookSecret,
      );
      if (!isValidSignature) {
        console.error("❌ Signature webhook invalide");
        return res.status(401).json({ error: "Invalid webhook signature" });
      }
      logger.debug("✅ Signature webhook valide");
    }

    // Parser le JSON selon le type de body
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString());
    } else if (typeof req.body === "string") {
      payload = JSON.parse(req.body);
    } else {
      // Si c'est déjà un objet, l'utiliser directement
      payload = req.body;
    }

    // Log des informations importantes
    // if (payload.type) {
    //   logger.debug(`🎯 Type d'événement: ${payload.type}`);
    // }

    // if (payload.data) {
    //   logger.debug("📊 Données:", JSON.stringify(payload.data, null, 2));
    // }

    // if (payload.account) {
    //   logger.debug(`🏦 Compte: ${payload.account.name} (${payload.account.id})`);
    // }

    // if (payload.item) {
    //   logger.debug(`💳 Item: ${payload.item.id} - ${payload.item.status}`);
    // }

    // Traitement selon le type d'événement
    // Documentation Bridge: https://docs.bridgeapi.io/docs/webhooks
    switch (payload.type) {
      case "TEST_EVENT":
        logger.info("🧪 Webhook test reçu");
        break;

      // Connexion initiale d'un compte → Sync complète de tout l'historique
      case "account.connected":
        logger.info(
          "🔗 Événement: account.connected - Déclenchement sync initiale",
        );
        await handleAccountConnected(payload);
        break;

      // Item rafraîchi → Vérifier si full_refresh pour re-sync complète
      case "item.refreshed":
        logger.info("🔄 Événement: item.refreshed");
        await handleItemRefreshed(payload);
        break;

      // Compte mis à jour avec nouvelles transactions → Sync incrémentale
      case "item.account.updated":
        logger.info("📊 Événement: item.account.updated - Sync incrémentale");
        await handleAccountUpdated(payload);
        break;

      // Nouveau compte créé → Sync complète pour ce compte
      case "item.account.created":
        logger.info("➕ Événement: item.account.created - Sync nouveau compte");
        await handleAccountCreated(payload);
        break;

      // Transactions créées/mises à jour → Sync incrémentale
      case "transaction.created":
      case "transaction.updated":
        logger.info(`💳 Événement: ${payload.type} - Sync transactions`);
        await handleTransactionEvent(payload);
        break;

      case "account.disconnected":
        logger.info("🔌 Événement: account.disconnected");
        await handleAccountDisconnected(payload);
        break;

      default:
        logger.warn(`❓ Type d'événement non géré: ${payload.type}`);
    }

    // Répondre avec succès
    res.status(200).json({
      success: true,
      message: "Webhook reçu et traité",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("❌ Erreur lors du traitement du webhook:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
});

// Endpoint de test pour vérifier que le webhook fonctionne
router.get("/bridge/test", (req, res) => {
  res.json({
    message: "Webhook endpoint is working",
    timestamp: new Date().toISOString(),
    webhookUrl: process.env.BRIDGE_WEBHOOK_URL,
    hasSecret: !!process.env.BRIDGE_WEBHOOK_SECRET,
  });
});

// ============================================
// FONCTIONS DE GESTION DES ÉVÉNEMENTS WEBHOOK
// ============================================

/**
 * Gère l'événement account.connected
 * Déclenche une synchronisation COMPLÈTE de tout l'historique disponible
 * C'est la première sync après connexion bancaire
 */
async function handleAccountConnected(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    if (!userUuid) {
      logger.warn("⚠️ handleAccountConnected: user_uuid manquant");
      return;
    }

    logger.info(`🔗 Nouvelle connexion bancaire pour user_uuid: ${userUuid}`);

    // Sync complète de tout l'historique disponible
    await triggerFullSync(userUuid);
  } catch (error) {
    logger.error("❌ Erreur handleAccountConnected:", error.message);
  }
}

/**
 * Gère l'événement item.refreshed
 * Si full_refresh: true → Re-synchronisation complète (l'historique complet est disponible)
 * Sinon → Sync incrémentale
 */
async function handleItemRefreshed(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const fullRefresh = payload.content?.full_refresh === true;

    if (!userUuid) {
      logger.warn("⚠️ handleItemRefreshed: user_uuid manquant");
      return;
    }

    if (fullRefresh) {
      // L'historique complet est maintenant disponible (après la sync initiale)
      logger.info(
        `🔄 Full refresh détecté pour user_uuid: ${userUuid} - Sync complète`,
      );
      await triggerFullSync(userUuid);
    } else {
      // Refresh partiel → sync incrémentale
      logger.info(
        `🔄 Refresh partiel pour user_uuid: ${userUuid} - Sync incrémentale`,
      );
      await triggerIncrementalSync(userUuid);
    }
  } catch (error) {
    logger.error("❌ Erreur handleItemRefreshed:", error.message);
  }
}

/**
 * Gère l'événement item.account.updated
 * Contient le nombre de nouvelles transactions → Sync incrémentale
 */
async function handleAccountUpdated(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const accountId = payload.content?.account_id;
    const nbNewTransactions = payload.content?.nb_new_transactions || 0;
    const nbUpdatedTransactions = payload.content?.nb_updated_transactions || 0;

    if (!userUuid) {
      logger.warn("⚠️ handleAccountUpdated: user_uuid manquant");
      return;
    }

    logger.info(
      `📊 Account updated: ${nbNewTransactions} nouvelles, ${nbUpdatedTransactions} mises à jour`,
    );

    // Sync incrémentale pour ce compte spécifique
    if (nbNewTransactions > 0 || nbUpdatedTransactions > 0) {
      await triggerIncrementalSync(userUuid, accountId);
    }
  } catch (error) {
    logger.error("❌ Erreur handleAccountUpdated:", error.message);
  }
}

/**
 * Gère l'événement item.account.created
 * Nouveau compte ajouté → Sync complète pour ce compte
 */
async function handleAccountCreated(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const accountId = payload.content?.account_id;

    if (!userUuid) {
      logger.warn("⚠️ handleAccountCreated: user_uuid manquant");
      return;
    }

    logger.info(
      `➕ Nouveau compte créé: ${accountId} pour user_uuid: ${userUuid}`,
    );

    // D'abord synchroniser les comptes pour avoir le nouveau compte en base
    const workspaceId = await findWorkspaceByBridgeUuid(userUuid);
    if (!workspaceId) return;

    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Sync des comptes
    await provider.syncUserAccounts("webhook-sync", workspaceId);

    // Puis sync complète des transactions pour ce nouveau compte
    if (accountId) {
      await triggerFullSyncForAccount(userUuid, accountId);
    }
  } catch (error) {
    logger.error("❌ Erreur handleAccountCreated:", error.message);
  }
}

/**
 * Gère les événements transaction.created et transaction.updated
 * Sync incrémentale ciblée
 */
async function handleTransactionEvent(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const accountId = payload.content?.account_id;

    if (!userUuid) {
      logger.warn("⚠️ handleTransactionEvent: user_uuid manquant");
      return;
    }

    // Sync incrémentale pour ce compte
    await triggerIncrementalSync(userUuid, accountId);
  } catch (error) {
    logger.error("❌ Erreur handleTransactionEvent:", error.message);
  }
}

/**
 * Gère l'événement account.disconnected
 * Marque le compte comme déconnecté en DB (ou le supprime)
 */
async function handleAccountDisconnected(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const accountId = payload.content?.account_id;

    if (!userUuid) {
      logger.warn("⚠️ handleAccountDisconnected: user_uuid manquant");
      return;
    }

    const workspaceId = await findWorkspaceByBridgeUuid(userUuid);
    if (!workspaceId) {
      logger.error("❌ Workspace non trouvé pour user_uuid:", userUuid);
      return;
    }

    const { default: AccountBanking } =
      await import("../models/AccountBanking.js");

    if (accountId) {
      // Supprimer le compte spécifique
      const result = await AccountBanking.deleteMany({
        externalId: accountId.toString(),
        workspaceId,
        provider: "bridge",
      });
      logger.info(
        `🔌 Compte ${accountId} supprimé de la DB (${result.deletedCount} docs) suite à account.disconnected`,
      );
    } else {
      logger.warn(
        "⚠️ handleAccountDisconnected: account_id manquant, aucune action",
      );
    }
  } catch (error) {
    logger.error("❌ Erreur handleAccountDisconnected:", error.message);
  }
}

// ============================================
// FONCTIONS DE SYNCHRONISATION
// ============================================

/**
 * Déclenche une synchronisation COMPLÈTE de tout l'historique disponible
 * Utilisé après connexion initiale ou full_refresh
 */
async function triggerFullSync(userUuid) {
  try {
    const workspaceId = await findWorkspaceByBridgeUuid(userUuid);
    if (!workspaceId) {
      logger.error("❌ Workspace non trouvé pour user_uuid:", userUuid);
      return;
    }

    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Calculer la date de début pour récupérer tout l'historique disponible
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - SYNC_CONFIG.fullSyncDaysBack);
    const since = sinceDate.toISOString().split("T")[0];

    logger.info(
      `🚀 Démarrage sync complète pour workspace ${workspaceId} depuis ${since}`,
    );

    const result = await provider.syncAllTransactions(
      "webhook-sync",
      workspaceId,
      {
        since,
        fullSync: true, // Pas de limite de pages
      },
    );

    logger.info(
      `✅ Sync complète terminée: ${result.transactions} transactions pour ${result.accounts} comptes`,
    );

    return result;
  } catch (error) {
    logger.error("❌ Erreur triggerFullSync:", error.message);
  }
}

/**
 * Déclenche une synchronisation INCRÉMENTALE
 * Récupère uniquement les transactions récentes (basé sur lastSyncAt ou 7 derniers jours)
 */
async function triggerIncrementalSync(userUuid, specificAccountId = null) {
  try {
    const workspaceId = await findWorkspaceByBridgeUuid(userUuid);
    if (!workspaceId) {
      logger.error("❌ Workspace non trouvé pour user_uuid:", userUuid);
      return;
    }

    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Récupérer la date de dernière sync depuis le compte
    let since;
    if (specificAccountId) {
      const { default: AccountBanking } =
        await import("../models/AccountBanking.js");
      const account = await AccountBanking.findOne({
        externalId: specificAccountId.toString(),
        workspaceId,
      });

      if (account?.transactionSync?.lastSyncAt) {
        // Utiliser la date de dernière sync - 1 jour (pour sécurité)
        const lastSync = new Date(account.transactionSync.lastSyncAt);
        lastSync.setDate(lastSync.getDate() - 1);
        since = lastSync.toISOString().split("T")[0];
      }
    }

    // Si pas de lastSyncAt, utiliser les X derniers jours par défaut
    if (!since) {
      const sinceDate = new Date();
      sinceDate.setDate(
        sinceDate.getDate() - SYNC_CONFIG.incrementalSyncDaysBack,
      );
      since = sinceDate.toISOString().split("T")[0];
    }

    logger.info(
      `📥 Sync incrémentale pour workspace ${workspaceId}${
        specificAccountId ? ` (compte ${specificAccountId})` : ""
      } depuis ${since}`,
    );

    if (specificAccountId) {
      // Sync d'un compte spécifique
      const transactions = await provider.getTransactions(
        specificAccountId,
        "webhook-sync",
        workspaceId,
        { since },
      );
      logger.info(
        `✅ Sync incrémentale terminée: ${transactions.length} transactions`,
      );
      return { transactions: transactions.length };
    } else {
      // Sync de tous les comptes
      const result = await provider.syncAllTransactions(
        "webhook-sync",
        workspaceId,
        {
          since,
        },
      );
      logger.info(
        `✅ Sync incrémentale terminée: ${result.transactions} transactions pour ${result.accounts} comptes`,
      );
      return result;
    }
  } catch (error) {
    logger.error("❌ Erreur triggerIncrementalSync:", error.message);
  }
}

/**
 * Déclenche une synchronisation complète pour un compte spécifique
 * Utilisé après création d'un nouveau compte
 */
async function triggerFullSyncForAccount(userUuid, accountId) {
  try {
    const workspaceId = await findWorkspaceByBridgeUuid(userUuid);
    if (!workspaceId) {
      logger.error("❌ Workspace non trouvé pour user_uuid:", userUuid);
      return;
    }

    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Calculer la date pour récupérer tout l'historique
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - SYNC_CONFIG.fullSyncDaysBack);
    const since = sinceDate.toISOString().split("T")[0];

    logger.info(`🚀 Sync complète compte ${accountId} depuis ${since}`);

    const transactions = await provider.getTransactions(
      accountId,
      "webhook-sync",
      workspaceId,
      { since, fullSync: true },
    );

    logger.info(`✅ Sync compte terminée: ${transactions.length} transactions`);
    return { transactions: transactions.length };
  } catch (error) {
    logger.error("❌ Erreur triggerFullSyncForAccount:", error.message);
  }
}

async function findWorkspaceByBridgeUuid(userUuid) {
  try {
    // Initialiser le service banking pour récupérer l'utilisateur
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Récupérer l'utilisateur Bridge par UUID pour obtenir son external_user_id
    const bridgeUser = await provider.getBridgeUserByUuid(userUuid);

    if (bridgeUser && bridgeUser.external_user_id) {
      return bridgeUser.external_user_id;
    } else {
      console.error("❌ external_user_id non trouvé pour user_uuid:", userUuid);
      return null;
    }
  } catch (error) {
    console.error("❌ Erreur recherche workspace:", error.message);
    return null;
  }
}

export default router;
