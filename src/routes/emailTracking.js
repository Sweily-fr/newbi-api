import express from "express";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import CreditNote from "../models/CreditNote.js";
import logger from "../utils/logger.js";
import { publishEmailTrackingUpdate } from "../resolvers/documentEmail.js";
import {
  cacheDocumentPdf,
  generateDocumentPdf,
} from "../services/documentAutomationService.js";

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

/**
 * GET /tracking/click/:token
 * Endpoint de tracking de clic dans un email.
 * Enregistre le clic, puis redirige vers le PDF du document.
 */
router.get("/click/:token", async (req, res) => {
  const { token } = req.params;
  let redirectUrl = null;
  let foundDoc = null;
  let foundType = null;

  try {
    for (const { model: Model, type: documentType } of DOCUMENT_MODELS) {
      const doc = await Model.findOne({ "emailTracking.trackingToken": token });

      if (doc) {
        const newClickCount = (doc.emailTracking?.emailClickCount || 0) + 1;
        const now = new Date();

        const updateData = {
          "emailTracking.emailClickCount": newClickCount,
        };

        const emailClickedAt = doc.emailTracking?.emailClickedAt || now;
        if (!doc.emailTracking?.emailClickedAt) {
          updateData["emailTracking.emailClickedAt"] = now;
        }

        // Enregistrer aussi comme "ouvert" (un clic implique une ouverture)
        if (!doc.emailTracking?.emailOpenedAt) {
          updateData["emailTracking.emailOpenedAt"] = now;
          updateData["emailTracking.emailOpenCount"] =
            (doc.emailTracking?.emailOpenCount || 0) + 1;
        }

        await Model.updateOne({ _id: doc._id }, { $set: updateData });

        logger.info(
          `[EmailTracking] Lien cliqué pour ${Model.modelName} ${doc._id} (${newClickCount}x)`,
        );

        // Publier la mise à jour en temps réel
        publishEmailTrackingUpdate({
          documentId: doc._id.toString(),
          documentType,
          workspaceId: doc.workspaceId.toString(),
          emailTracking: {
            emailSentAt: doc.emailTracking?.emailSentAt?.toISOString() || null,
            emailOpenedAt: (
              doc.emailTracking?.emailOpenedAt || now
            ).toISOString(),
            emailOpenCount: doc.emailTracking?.emailOpenedAt
              ? doc.emailTracking.emailOpenCount
              : (doc.emailTracking?.emailOpenCount || 0) + 1,
            emailClickedAt: emailClickedAt.toISOString(),
            emailClickCount: newClickCount,
          },
        });

        // URL du PDF partagé
        if (doc.cachedPdf?.url) {
          redirectUrl = doc.cachedPdf.url;
        }

        foundDoc = doc;
        foundType = documentType;
        break;
      }
    }
  } catch (error) {
    logger.warn(`[EmailTracking] Erreur tracking clic: ${error.message}`);
  }

  if (redirectUrl) {
    return res.redirect(302, redirectUrl);
  }

  // Document trouvé mais PDF absent du cache R2 (envoi antérieur à la mise en
  // cache, échec d'upload…) : générer le PDF à la volée et le servir
  // directement, plutôt que de renvoyer le destinataire vers la page Newbi.
  if (foundDoc) {
    try {
      const pdfBuffer = await generateDocumentPdf(
        foundDoc._id.toString(),
        foundType,
      );
      if (pdfBuffer?.length) {
        // Mise en cache pour les prochains clics — fire-and-forget.
        cacheDocumentPdf(
          foundDoc._id.toString(),
          foundType,
          pdfBuffer,
          foundDoc.workspaceId?.toString(),
        ).catch((err) =>
          logger.warn(
            `[EmailTracking] Échec cache PDF après génération: ${err.message}`,
          ),
        );

        const baseName = `${foundDoc.prefix ? `${foundDoc.prefix}-` : ""}${
          foundDoc.number || foundDoc._id
        }`.replace(/[^\w.-]/g, "_");
        res.set({
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${baseName}.pdf"`,
        });
        return res.send(pdfBuffer);
      }
    } catch (error) {
      logger.warn(
        `[EmailTracking] Génération PDF à la volée impossible: ${error.message}`,
      );
    }
  }

  // Fallback : page Newbi
  const frontendUrl = process.env.FRONTEND_URL || "https://www.newbi.fr";
  res.redirect(302, frontendUrl);
});

export default router;
