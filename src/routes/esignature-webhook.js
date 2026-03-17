import express from "express";
import crypto from "crypto";
import SignatureRequest from "../models/SignatureRequest.js";
import esignatureService from "../services/esignatureService.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * Upload un fichier vers R2 dans le bucket OCR (réutilisé pour les documents signés)
 */
async function uploadFileToR2(fileBuffer, key, contentType) {
  const client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_API_URL,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  const bucket = process.env.OCR_BUCKET;
  const publicUrl = process.env.OCR_URL;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await client.send(command);

  const cleanUrl = publicUrl?.endsWith("/")
    ? publicUrl.slice(0, -1)
    : publicUrl;
  return `${cleanUrl}/${key}`;
}

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
      Buffer.from(receivedSecret)
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
      JSON.stringify(payload, null, 2)
    );

    // Extraire les infos de la signature
    const externalSignatureId = payload.id || payload._id;
    const state = payload.state;
    const custom = payload.custom || {};
    const signatureRequestId = custom.signatureRequestId;

    if (!externalSignatureId && !signatureRequestId) {
      logger.warn("Webhook eSignature sans ID de signature");
      return res
        .status(400)
        .json({ error: "Missing signature identifier" });
    }

    // Trouver la SignatureRequest correspondante
    let signatureRequest;

    if (signatureRequestId) {
      signatureRequest = await SignatureRequest.findById(
        signatureRequestId
      );
    }

    if (!signatureRequest && externalSignatureId) {
      signatureRequest = await SignatureRequest.findOne({
        externalSignatureId,
      });
    }

    if (!signatureRequest) {
      logger.warn(
        `SignatureRequest non trouvée pour webhook: external=${externalSignatureId}, internal=${signatureRequestId}`
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
      `Signature ${signatureRequest._id}: ${previousStatus} → ${newStatus}`
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

    // Si la signature est terminée, télécharger le document signé
    if (newStatus === "DONE" && externalSignatureId) {
      try {
        // Télécharger le document signé
        const signedDocBuffer =
          await esignatureService.downloadSignedDocument(
            externalSignatureId
          );

        if (signedDocBuffer && Buffer.isBuffer(signedDocBuffer)) {
          const key = `esignature/${signatureRequest.organizationId}/${signatureRequest._id}/signed-${signatureRequest.documentNumber || signatureRequest.documentId}.pdf`;

          const url = await uploadFileToR2(
            signedDocBuffer,
            key,
            "application/pdf"
          );

          signatureRequest.signedDocumentUrl = url;
        }

        // Télécharger l'audit trail
        try {
          const auditTrail =
            await esignatureService.downloadAuditTrail(
              externalSignatureId
            );

          if (auditTrail) {
            const auditBuffer = Buffer.isBuffer(auditTrail)
              ? auditTrail
              : Buffer.from(JSON.stringify(auditTrail));

            const auditKey = `esignature/${signatureRequest.organizationId}/${signatureRequest._id}/audit-trail.${Buffer.isBuffer(auditTrail) ? "pdf" : "json"}`;

            const auditUrl = await uploadFileToR2(
              auditBuffer,
              auditKey,
              Buffer.isBuffer(auditTrail)
                ? "application/pdf"
                : "application/json"
            );

            signatureRequest.auditTrailUrl = auditUrl;
          }
        } catch (auditError) {
          logger.warn(
            `Impossible de télécharger l'audit trail: ${auditError.message}`
          );
        }

        // Mettre à jour la date de signature des signataires
        signatureRequest.signers = signatureRequest.signers.map(
          (signer) => ({
            ...signer.toObject ? signer.toObject() : signer,
            signedAt: signer.signedAt || new Date(),
          })
        );
      } catch (downloadError) {
        logger.error(
          `Erreur téléchargement document signé: ${downloadError.message}`
        );
        signatureRequest.errorMessage = `Document signé mais erreur au téléchargement: ${downloadError.message}`;
      }
    }

    await signatureRequest.save();

    logger.info(
      `Signature ${signatureRequest._id} mise à jour: ${newStatus}`
    );

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
  return statusMap[externalState] || "PENDING";
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
