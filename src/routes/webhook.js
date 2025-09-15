import express from "express";
import crypto from "crypto";
import { bankingService } from "../services/banking/index.js";
import logger from "../utils/logger.js";

const router = express.Router();

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

    // Comparaison simple pour éviter l'erreur de longueur
    return actualSignature.toUpperCase() === expectedSignature;
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
        webhookSecret
      );
      if (!isValidSignature) {
        console.error("❌ Signature webhook invalide");
        return res.status(401).json({ error: "Invalid webhook signature" });
      }
      console.log("✅ Signature webhook valide");
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
    //   console.log(`🎯 Type d'événement: ${payload.type}`);
    // }

    // if (payload.data) {
    //   console.log("📊 Données:", JSON.stringify(payload.data, null, 2));
    // }

    // if (payload.account) {
    //   console.log(`🏦 Compte: ${payload.account.name} (${payload.account.id})`);
    // }

    // if (payload.item) {
    //   console.log(`💳 Item: ${payload.item.id} - ${payload.item.status}`);
    // }

    // Traitement selon le type d'événement
    switch (payload.type) {
      case "TEST_EVENT":
        break;
      case "account.connected":
        await handleAccountConnected(payload);
        break;
      case "account.disconnected":
        break;
      case "item.refreshed":
      case "item.account.updated":
      case "item.account.created":
      case "account.connected":
      case "transaction.created":
      case "transaction.updated":
        await handleTransactionEvent(payload);
        break;
      default:
        console.log(`❓ Type d'événement non géré: ${payload.type}`);
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

// Fonctions de gestion des événements webhook
async function handleAccountConnected(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    if (!userUuid) return;

    await triggerSyncForUser(userUuid);
  } catch (error) {
    console.error("❌ Erreur handleAccountConnected:", error.message);
  }
}

async function handleItemRefreshed(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    if (!userUuid) return;

    await triggerSyncForUser(userUuid);
  } catch (error) {
    console.error("❌ Erreur handleItemRefreshed:", error.message);
  }
}

async function handleAccountUpdated(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const accountId = payload.content?.account_id;
    const nbNewTransactions = payload.content?.nb_new_transactions || 0;
    const nbUpdatedTransactions = payload.content?.nb_updated_transactions || 0;

    if (!userUuid) return;

    await triggerSyncForUser(userUuid, accountId);
  } catch (error) {
    console.error("❌ Erreur handleAccountUpdated:", error.message);
  }
}

async function handleTransactionEvent(payload) {
  try {
    const userUuid = payload.content?.user_uuid;
    const accountId = payload.content?.account_id;

    if (!userUuid) return;

    await triggerSyncForUser(userUuid, accountId);
  } catch (error) {
    console.error("❌ Erreur handleTransactionEvent:", error.message);
  }
}

async function triggerSyncForUser(userUuid, specificAccountId = null) {
  try {
    // Initialiser le service banking
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Trouver le workspace correspondant au user_uuid Bridge
    const workspaceId = await findWorkspaceByBridgeUuid(userUuid);
    if (!workspaceId) {
      console.error("❌ Workspace non trouvé pour user_uuid:", userUuid);
      return;
    }

    // Utiliser un userId fictif pour la synchronisation (sera amélioré)
    const userId = "webhook-sync";

    if (specificAccountId) {
      // Synchroniser un compte spécifique

      await provider.getTransactions(specificAccountId, userId, workspaceId, {
        limit: 100,
      });
    } else {
      // Synchronisation complète
      const result = await provider.syncAllTransactions(userId, workspaceId, {
        limit: 100,
      });
    }
  } catch (error) {
    console.error("❌ Erreur synchronisation webhook:", error.message);
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
