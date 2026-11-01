import express from "express";
import crypto from "crypto";
import logger from "../utils/logger.js";
import { publishEmailTrackingUpdate } from "../resolvers/documentEmail.js";
import { recordTrialNudgeEmailEvent } from "../services/trialNudgeService.js";
import {
  findDocumentByResendId,
  isDeliveryEvent,
  recordDeliveryEvent,
} from "../services/documentDeliveryService.js";
import { markEmailLogOpened } from "../services/documentEmailLogService.js";

const router = express.Router();

/**
 * Vérifie la signature Svix du webhook Resend sur le CORPS BRUT.
 * https://resend.com/docs/dashboard/webhooks/verify-webhooks
 *
 * Le header `svix-signature` contient une ou plusieurs signatures
 * `v1,<base64>` séparées par des espaces, calculées en HMAC-SHA256 sur
 * `${id}.${timestamp}.${rawBody}` avec le secret décodé de base64.
 */
// Écart toléré entre l'horodatage signé et l'heure du serveur (recommandation
// Svix) : un événement capturé ne se rejoue pas au-delà
export const SVIX_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function verifySvixSignature({
  id,
  timestamp,
  rawBody,
  signatureHeader,
  secret,
  now = Date.now(),
}) {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const signedAtMs = Number(timestamp) * 1000;
  if (
    !Number.isFinite(signedAtMs) ||
    Math.abs(now - signedAtMs) > SVIX_TIMESTAMP_TOLERANCE_MS
  ) {
    return false;
  }
  try {
    const secretBytes = Buffer.from(
      String(secret).replace(/^whsec_/, ""),
      "base64",
    );
    const signedContent = `${id}.${timestamp}.${rawBody}`;
    const expected = crypto
      .createHmac("sha256", secretBytes)
      .update(signedContent)
      .digest("base64");
    const expectedBuf = Buffer.from(expected);

    return String(signatureHeader)
      .split(" ")
      .map((part) => (part.includes(",") ? part.split(",")[1] : part))
      .some((sig) => {
        try {
          const sigBuf = Buffer.from(sig);
          return (
            sigBuf.length === expectedBuf.length &&
            crypto.timingSafeEqual(sigBuf, expectedBuf)
          );
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/**
 * POST /webhook/resend
 * Reçoit les événements Resend (email.opened, email.delivered, email.bounced, etc.)
 */
router.post("/", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string"
        ? req.body
        : JSON.stringify(req.body || {});

    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
    const svixId = req.headers["svix-id"] || req.headers["webhook-id"];
    const svixTimestamp =
      req.headers["svix-timestamp"] || req.headers["webhook-timestamp"];
    const svixSignature =
      req.headers["svix-signature"] ||
      req.headers["webhook-signature"] ||
      req.headers["resend-signature"];

    // 🔐 Fail-closed : si un secret est configuré, la signature est OBLIGATOIRE
    // et vérifiée sur le corps brut. Sans secret, on ne peut pas authentifier
    // (on log un avertissement) — mais on ne renvoie plus `true` par défaut.
    if (webhookSecret) {
      const isValid = verifySvixSignature({
        id: svixId,
        timestamp: svixTimestamp,
        rawBody,
        signatureHeader: svixSignature,
        secret: webhookSecret,
      });
      if (!isValid) {
        logger.warn("[ResendWebhook] Signature invalide ou absente");
        return res.status(401).json({ error: "Invalid signature" });
      }
    } else {
      logger.warn(
        "[ResendWebhook] RESEND_WEBHOOK_SECRET non configuré — événement non authentifié",
      );
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const { type, data } = parsedBody;

    if (!type || !data) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    logger.info(
      `[ResendWebhook] Événement reçu: ${type} (email_id: ${data.email_id})`,
    );

    // Relances de l'essai gratuit (trial_nudge_log) : suivi à part des
    // documents, best-effort
    try {
      if (await recordTrialNudgeEmailEvent(type, data.email_id)) {
        return res.status(200).json({ received: true });
      }
    } catch (nudgeError) {
      logger.warn(
        `[ResendWebhook] suivi de relance d'essai en échec: ${nudgeError.message}`,
      );
    }

    // Remise de l'e-mail d'un document (remis, retardé, rejeté) : reçu ou
    // alerte à l'émetteur
    if (isDeliveryEvent(type)) {
      await recordDeliveryEvent(parsedBody);
      return res.status(200).json({ received: true });
    }

    // Traiter les événements pertinents
    if (type === "email.opened") {
      const resendMessageId = data.email_id;

      if (!resendMessageId) {
        return res.status(200).json({ received: true });
      }

      await markEmailLogOpened({ resendMessageId });

      const result = await findDocumentByResendId(resendMessageId);

      if (result) {
        const { doc, Model, documentType } = result;
        const now = new Date();
        const newOpenCount = (doc.emailTracking?.emailOpenCount || 0) + 1;

        const updateData = {
          "emailTracking.emailOpenCount": newOpenCount,
        };

        const emailOpenedAt = doc.emailTracking?.emailOpenedAt || now;
        if (!doc.emailTracking?.emailOpenedAt) {
          updateData["emailTracking.emailOpenedAt"] = now;
        }

        await Model.updateOne({ _id: doc._id }, { $set: updateData });

        logger.info(
          `[ResendWebhook] Email ouvert pour ${Model.modelName} ${doc._id} (${newOpenCount}x)`,
        );

        // Publier la mise à jour en temps réel
        publishEmailTrackingUpdate({
          documentId: doc._id.toString(),
          documentType,
          workspaceId: doc.workspaceId.toString(),
          emailTracking: {
            emailSentAt: doc.emailTracking?.emailSentAt?.toISOString() || null,
            emailOpenedAt: emailOpenedAt.toISOString(),
            emailOpenCount: newOpenCount,
          },
        });
      } else {
        logger.debug(
          `[ResendWebhook] Document non trouvé pour resendMessageId: ${resendMessageId}`,
        );
      }
    }

    // Toujours répondre 200 pour éviter les retries de Resend
    res.status(200).json({ received: true });
  } catch (error) {
    logger.error(`[ResendWebhook] Erreur: ${error.message}`);
    // Répondre 200 même en cas d'erreur pour éviter les retries
    res.status(200).json({ received: true, error: error.message });
  }
});

export default router;
