import express from "express";
import mongoose from "mongoose";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import Invoice from "../models/Invoice.js";
import cloudflareService from "../services/cloudflareService.js";
import superPdpService from "../services/superPdpService.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /invoices/:id/document-pdf
 *
 * Streame le PDF Factur-X d'une facture directement depuis R2 (ou SuperPDP),
 * en utilisant les credentials serveur. Aucune URL signée côté navigateur.
 * Auth : session/JWT (cookie envoyé par l'iframe). RBAC : membre de l'org.
 */
router.get("/:id/document-pdf", validateJWT, async (req, res) => {
  try {
    const userId = req.user;
    if (!userId) return res.status(401).json({ error: "Non authentifié" });

    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ error: "Facture introuvable" });
    }

    // Vérifier l'appartenance de l'utilisateur à l'organisation de la facture
    const member =
      await EInvoicingSettingsService.getMemberCollection().findOne({
        userId: new mongoose.Types.ObjectId(userId),
        organizationId: invoice.workspaceId,
      });
    if (!member) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    // Les brouillons n'ont pas de document archivé
    if (invoice.status === "DRAFT") {
      return res
        .status(404)
        .json({ error: "Aucun document pour un brouillon" });
    }

    const workspaceId = invoice.workspaceId.toString();
    let buffer = null;

    // Cas SuperPDP : document faisant foi récupéré en direct (+ repli R2)
    if (invoice.superPdpInvoiceId) {
      try {
        buffer = await superPdpService.getArchivedPdf(
          workspaceId,
          invoice.superPdpInvoiceId,
        );
      } catch (err) {
        logger.warn(
          `[invoice-document] SuperPDP indisponible pour ${invoice._id}, repli R2: ${err.message}`,
        );
      }
    }

    // Sinon (ou repli) : PDF archivé sur R2
    if (!buffer && invoice.archivedPdfKey) {
      buffer = await cloudflareService.getInvoiceObjectBuffer(
        invoice.archivedPdfKey,
      );
    }

    if (!buffer) {
      return res.status(404).json({ error: "Aucun document disponible" });
    }

    // Autoriser l'affichage dans une iframe du frontend (helmet pose par défaut
    // X-Frame-Options: SAMEORIGIN et CORP: same-origin qui bloqueraient le cross-origin).
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      `frame-ancestors 'self' ${frontendUrl}`,
    );
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="facture-${invoice.prefix || ""}${invoice.number || invoice._id}.pdf"`,
    );
    return res.send(buffer);
  } catch (error) {
    logger.error("[invoice-document] Erreur:", error);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération du document" });
  }
});

export default router;
