import express from "express";
import crypto from "crypto";
import SignatureRequest from "../models/SignatureRequest.js";
import logger from "../utils/logger.js";
import { acceptQuoteOnSignature } from "../services/quoteSignatureSync.js";
import { storeSignedDocuments } from "../services/esignatureDocuments.js";

const router = express.Router();

/**
 * Vérifier le header secret du webhook eSignature
 * On utilise un header custom X-Webhook-Secret envoyé dans le callback
 */
const verifyWebhookSecret = (req) => {
  const webhookSecret = process.env.ESIGNATURE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // Pas de secret configuré, on accepte (dev/sandbox)
    return true;
  }

  const receivedSecret = req.headers["x-webhook-secret"];
  if (!receivedSecret) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(
      Buffer.from(webhookSecret),
      Buffer.from(receivedSecret),
    );
  } catch {
    return false;
  }
};

/**
 * POST /api/esignature/webhook
 * Endpoint pour recevoir les callbacks de l'API eSignature OpenAPI
 *
 * L'API envoie un callback quand le statut d'une signature change
 * (WAIT_SIGNER → DONE, ERROR, etc.)
 */
router.post("/", express.json(), async (req, res) => {
  try {
    logger.info("Webhook eSignature reçu");

    // Vérifier l'authentification du webhook
    if (!verifyWebhookSecret(req)) {
      logger.warn("Webhook eSignature: secret invalide");
      return res.status(401).json({ error: "Invalid webhook secret" });
    }

    const payload = req.body;

    logger.debug(
      "Payload webhook eSignature:",
      JSON.stringify(payload, null, 2),
    );

    // Extraire les infos de la signature
    const externalSignatureId = payload.id || payload._id;
    const state = payload.state;
    const custom = payload.custom || {};
    const signatureRequestId = custom.signatureRequestId;

    if (!externalSignatureId && !signatureRequestId) {
      logger.warn("Webhook eSignature sans ID de signature");
      return res.status(400).json({ error: "Missing signature identifier" });
    }

    // Trouver la SignatureRequest correspondante
    let signatureRequest;

    if (signatureRequestId) {
      signatureRequest = await SignatureRequest.findById(signatureRequestId);
    }

    if (!signatureRequest && externalSignatureId) {
      signatureRequest = await SignatureRequest.findOne({
        externalSignatureId,
      });
    }

    if (!signatureRequest) {
      logger.warn(
        `SignatureRequest non trouvée pour webhook: external=${externalSignatureId}, internal=${signatureRequestId}`,
      );
      // Retourner 200 pour éviter les retries
      return res.status(200).json({
        received: true,
        warning: "SignatureRequest not found",
      });
    }

    // Mapper le statut
    const previousStatus = signatureRequest.status;
    const newStatus = mapExternalStatus(state);

    logger.info(
      `Signature ${signatureRequest._id}: ${previousStatus} → ${newStatus}`,
    );

    // Mettre à jour le statut
    signatureRequest.status = newStatus;
    signatureRequest.callbackReceived = true;

    if (payload.errorMessage) {
      signatureRequest.errorMessage = payload.errorMessage;
    }
    if (payload.errorNumber) {
      signatureRequest.errorNumber = payload.errorNumber;
    }

    await signatureRequest.save();

    logger.info(`Signature ${signatureRequest._id} mise à jour: ${newStatus}`);

    // Une fois terminé : récupérer le document signé/cacheté puis auto-accepter le devis
    if (newStatus === "DONE") {
      try {
        await storeSignedDocuments(signatureRequest);
      } catch (downloadError) {
        logger.warn(
          `Impossible de stocker le document signé: ${downloadError.message}`,
        );
      }
      try {
        await acceptQuoteOnSignature(signatureRequest);
      } catch (acceptError) {
        logger.warn(
          `Impossible d'auto-accepter le devis après signature: ${acceptError.message}`,
        );
      }
    }

    // TODO: Publier événement Redis PubSub pour notification temps réel
    // pubsub.publish(`SIGNATURE_UPDATED_${signatureRequest.organizationId}`, { ... })

    res.status(200).json({
      received: true,
      signatureRequestId: signatureRequest._id.toString(),
      newStatus,
    });
  } catch (error) {
    logger.error("Erreur traitement webhook eSignature:", error);

    // Retourner 500 pour que l'API retente
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  }
});

/**
 * Mapper le statut externe vers le statut interne
 */
function mapExternalStatus(externalState) {
  const statusMap = {
    WAIT_VALIDATION: "WAIT_VALIDATION",
    WAIT_SIGN: "WAIT_SIGN",
    WAIT_SIGNER: "WAIT_SIGNER",
    DONE: "DONE",
    ERROR: "ERROR",
  };
  // Normaliser la casse : l'API peut renvoyer l'état en minuscules/casse mixte
  const key = String(externalState || "")
    .trim()
    .toUpperCase();
  const mapped = statusMap[key];
  if (!mapped) {
    logger.warn(
      `mapExternalStatus: état eSignature inconnu "${externalState}", repli sur PENDING`,
    );
    return "PENDING";
  }
  return mapped;
}

/**
 * GET /api/esignature/webhook/health
 * Endpoint de santé
 */
router.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "eSignature Webhook",
    timestamp: new Date().toISOString(),
  });
});

export default router;
