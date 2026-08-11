import express from "express";
import crypto from "crypto";
import SignatureRequest from "../models/SignatureRequest.js";
import logger from "../utils/logger.js";
import { acceptQuoteOnSignature } from "../services/quoteSignatureSync.js";
import { storeSignedDocuments } from "../services/esignatureDocuments.js";
import { publishSignatureStatus } from "../services/esignaturePubsub.js";
import { mapExternalStatus } from "../services/esignatureStatus.js";

const router = express.Router();

/**
 * Vérifier le header secret du webhook eSignature
 * On utilise un header custom X-Webhook-Secret envoyé dans le callback
 */
const verifyWebhookSecret = (req) => {
  const webhookSecret = process.env.ESIGNATURE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // En production/staging, un webhook non authentifié est refusé : le secret
    // DOIT être configuré (ESIGNATURE_WEBHOOK_SECRET) côté API et callback.
    const env = process.env.NODE_ENV;
    if (env === "production" || env === "staging") {
      logger.error(
        "Webhook eSignature: ESIGNATURE_WEBHOOK_SECRET non configuré en " +
          `${env} — callback refusé. Définissez le secret pour activer le webhook.`,
      );
      return false;
    }
    // Dev/sandbox uniquement : on accepte sans secret.
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

    // Extraire les infos de la signature. L'API encapsule ses réponses REST
    // dans `.data` et le callback observé en production suit la même forme :
    // lire `payload.state` seul faisait arriver l'état à `undefined`.
    const body =
      payload?.data && typeof payload.data === "object" ? payload.data : {};
    const externalSignatureId =
      payload.id || payload._id || body.id || body._id;
    const state = payload.state ?? body.state;
    const custom = payload.custom || body.custom || {};
    const signatureRequestId = custom.signatureRequestId;

    // Clés seulement, jamais les valeurs (le payload porte les coordonnées des
    // signataires) : de quoi identifier la forme réelle du callback en cas de
    // nouvel écart, sans écrire de données personnelles dans les logs.
    logger.info(
      `Webhook eSignature: clés=[${Object.keys(payload || {}).join(",")}]` +
        `${payload?.data ? ` data=[${Object.keys(body).join(",")}]` : ""}` +
        ` state=${state ?? "absent"}`,
    );

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

    // Mapper le statut. Un état inexploitable ne doit JAMAIS rétrograder la
    // demande : le statut courant est conservé (cf. esignatureStatus.js).
    const previousStatus = signatureRequest.status;
    const mappedStatus = mapExternalStatus(state);
    const newStatus = mappedStatus || previousStatus;

    if (!mappedStatus) {
      logger.warn(
        `Webhook eSignature: état "${state}" inexploitable pour ${signatureRequest._id}, statut ${previousStatus} conservé`,
      );
    }

    logger.info(
      `Signature ${signatureRequest._id}: ${previousStatus} → ${newStatus}`,
    );

    // Mettre à jour le statut
    signatureRequest.status = newStatus;
    signatureRequest.callbackReceived = true;

    const errorMessage = payload.errorMessage ?? body.errorMessage;
    const errorNumber = payload.errorNumber ?? body.errorNumber;
    if (errorMessage) {
      signatureRequest.errorMessage = errorMessage;
    }
    if (errorNumber) {
      signatureRequest.errorNumber = errorNumber;
    }

    await signatureRequest.save();

    // Notifier le front en temps réel du changement de statut
    if (newStatus !== previousStatus) {
      publishSignatureStatus(signatureRequest);
    }

    logger.info(`Signature ${signatureRequest._id} mise à jour: ${newStatus}`);

    // Une fois terminé : récupérer le document signé/cacheté puis auto-accepter
    // le devis. On teste le statut RÉELLEMENT mappé, pas celui conservé par
    // défaut : les relances du fournisseur sur un vrai DONE doivent continuer à
    // repasser ici (le stockage du document a pu échouer au premier appel),
    // mais un callback à l'état illisible ne doit rien redéclencher.
    if (mappedStatus === "DONE") {
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
