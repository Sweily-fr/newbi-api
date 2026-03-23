import express from "express";
import crypto from "crypto";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import CreditNote from "../models/CreditNote.js";
import logger from "../utils/logger.js";
import { publishEmailTrackingUpdate } from "../resolvers/documentEmail.js";

const router = express.Router();

// Modèles de documents avec leur type
const DOCUMENT_MODELS = [
  { model: Invoice, type: "invoice" },
  { model: Quote, type: "quote" },
  { model: PurchaseOrder, type: "purchaseOrder" },
  { model: CreditNote, type: "creditNote" },
];

/**
 * Vérifie la signature du webhook Resend (optionnel mais recommandé)
 * https://resend.com/docs/dashboard/webhooks/verify-webhooks
 */
function verifyResendSignature(payload, signature, secret) {
  if (!secret || !signature) return true; // Skip si pas configuré

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  } catch {
    return false;
  }
}

/**
 * Cherche un document par son resendMessageId
 */
async function findDocumentByResendId(resendMessageId) {
  for (const { model: Model, type: documentType } of DOCUMENT_MODELS) {
    const doc = await Model.findOne({
      "emailTracking.resendMessageId": resendMessageId,
    });

    if (doc) {
      return { doc, Model, documentType };
    }
  }
  return null;
}

/**
 * POST /webhook/resend
 * Reçoit les événements Resend (email.opened, email.delivered, email.bounced, etc.)
 */
router.post("/", express.json(), async (req, res) => {
  try {
    const signature =
      req.headers["resend-signature"] || req.headers["svix-signature"];
    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

    // Vérifier la signature si configurée
    if (webhookSecret && signature) {
      const isValid = verifyResendSignature(
        JSON.stringify(req.body),
        signature,
        webhookSecret,
      );

      if (!isValid) {
        logger.warn("[ResendWebhook] Signature invalide");
        return res.status(401).json({ error: "Invalid signature" });
      }
    }

    const { type, data } = req.body;

    if (!type || !data) {
      return res.status(400).json({ error: "Invalid payload" });
    }

    logger.info(
      `[ResendWebhook] Événement reçu: ${type} (email_id: ${data.email_id})`,
    );

    // Traiter les événements pertinents
    if (type === "email.opened") {
      const resendMessageId = data.email_id;

      if (!resendMessageId) {
        return res.status(200).json({ received: true });
      }

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
