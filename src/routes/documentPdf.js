import express from "express";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import Quote from "../models/Quote.js";
import CreditNote from "../models/CreditNote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import DeliveryNote from "../models/DeliveryNote.js";
import cloudflareService from "../services/cloudflareService.js";
import logger from "../utils/logger.js";
import { userHasWorkspaceLevel } from "../utils/workspace-membership.js";

const router = express.Router();

// Config par type : modèle, statut brouillon (null = pas de notion de
// brouillon) et page dont « Voir » est exigé
const DOC_CONFIG = {
  quote: { Model: Quote, draftStatus: "DRAFT", module: "quotes" },
  creditNote: { Model: CreditNote, draftStatus: null, module: "creditNotes" },
  purchaseOrder: {
    Model: PurchaseOrder,
    draftStatus: "DRAFT",
    module: "purchaseOrders",
  },
  deliveryNote: {
    Model: DeliveryNote,
    draftStatus: "DRAFT",
    module: "deliveryNotes",
  },
};

/**
 * GET /documents/:docType/:id/document-pdf
 *
 * Streame le PDF archivé d'un devis / avoir / bon de commande depuis R2,
 * avec les credentials serveur (aucune URL signée côté navigateur).
 * Auth session/JWT + RBAC (membre de l'org). Affichable en iframe.
 */
router.get("/:docType/:id/document-pdf", validateJWT, async (req, res) => {
  try {
    const { docType, id } = req.params;
    const config = DOC_CONFIG[docType];
    if (!config) {
      return res.status(404).json({ error: "Type de document inconnu" });
    }

    const userId = req.user;
    if (!userId) return res.status(401).json({ error: "Non authentifié" });

    const doc = await config.Model.findById(id);
    if (!doc) {
      return res.status(404).json({ error: "Document introuvable" });
    }

    // Membre de l'organisation du document, avec « Voir » de sa page
    if (
      !(await userHasWorkspaceLevel(
        userId,
        doc.workspaceId,
        config.module,
        "read",
      ))
    ) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    if (config.draftStatus && doc.status === config.draftStatus) {
      return res
        .status(404)
        .json({ error: "Aucun document pour un brouillon" });
    }
    if (!doc.archivedPdfKey) {
      return res.status(404).json({ error: "Aucun document disponible" });
    }

    // Autoriser l'affichage en iframe du frontend (helmet bloque par défaut).
    // Posé avant le fetch pour que même une réponse d'erreur reste affichable
    // dans l'iframe (sinon X-Frame-Options: SAMEORIGIN bloque le rendu).
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors 'self' ${frontendUrl}`,
    );
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    let buffer;
    try {
      buffer = await cloudflareService.getDocumentObjectBuffer(
        docType,
        doc.archivedPdfKey,
      );
    } catch (error) {
      // Clé en base mais objet absent du bucket (ex: archivé dans un autre env)
      if (
        error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404
      ) {
        return res.status(404).json({ error: "Aucun document disponible" });
      }
      throw error;
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${docType}-${doc.prefix || ""}${doc.number || doc._id}.pdf"`,
    );
    return res.send(buffer);
  } catch (error) {
    logger.error("[document-pdf] Erreur:", error);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération du document" });
  }
});

export default router;
