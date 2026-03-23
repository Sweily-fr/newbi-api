import express from "express";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import CreditNote from "../models/CreditNote.js";
import logger from "../utils/logger.js";
import { publishEmailTrackingUpdate } from "../resolvers/documentEmail.js";

const router = express.Router();

// Image GIF transparente 1x1 pixel
const TRANSPARENT_PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

// Modèles de documents avec leur type GraphQL
const DOCUMENT_MODELS = [
  { model: Invoice, type: "invoice" },
  { model: Quote, type: "quote" },
  { model: PurchaseOrder, type: "purchaseOrder" },
  { model: CreditNote, type: "creditNote" },
];

/**
 * GET /tracking/open/:token
 * Endpoint de tracking d'ouverture d'email.
 * Cherche le document associé au token, enregistre l'ouverture,
 * et retourne une image transparente 1x1 pixel.
 */
router.get("/open/:token", async (req, res) => {
  const { token } = req.params;

  try {
    // Chercher le document dans tous les modèles
    for (const { model: Model, type: documentType } of DOCUMENT_MODELS) {
      const doc = await Model.findOne({ "emailTracking.trackingToken": token });

      if (doc) {
        const newOpenCount = (doc.emailTracking?.emailOpenCount || 0) + 1;
        const now = new Date();

        // Enregistrer l'ouverture
        const updateData = {
          "emailTracking.emailOpenCount": newOpenCount,
        };

        // Ne mettre à jour emailOpenedAt que lors de la première ouverture
        const emailOpenedAt = doc.emailTracking?.emailOpenedAt || now;
        if (!doc.emailTracking?.emailOpenedAt) {
          updateData["emailTracking.emailOpenedAt"] = now;
        }

        await Model.updateOne({ _id: doc._id }, { $set: updateData });

        logger.info(
          `[EmailTracking] Email ouvert pour ${Model.modelName} ${doc._id} (${newOpenCount}x)`,
        );

        // Publier la mise à jour en temps réel via GraphQL subscription
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

        break;
      }
    }
  } catch (error) {
    // Ne pas bloquer la réponse en cas d'erreur
    logger.warn(`[EmailTracking] Erreur tracking: ${error.message}`);
  }

  // Toujours retourner le pixel transparent, même en cas d'erreur
  res.set({
    "Content-Type": "image/gif",
    "Content-Length": TRANSPARENT_PIXEL.length,
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  res.status(200).send(TRANSPARENT_PIXEL);
});

export default router;
