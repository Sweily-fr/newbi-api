import express from "express";
import mongoose from "mongoose";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import ImportedQuote from "../models/ImportedQuote.js";
import ImportedPurchaseOrder from "../models/ImportedPurchaseOrder.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import cloudflareService from "../services/cloudflareService.js";
import EInvoicingSettingsService from "../services/eInvoicingSettingsService.js";
import logger from "../utils/logger.js";

const router = express.Router();

// Config par type : modèle + extraction du fichier stocké sur R2.
// Les documents importés portent un fichier unique (doc.file) ; les factures
// d'achat portent un tableau de justificatifs → sélection via ?fileId=.
const DOC_CONFIG = {
  importedInvoice: { Model: ImportedInvoice, getFile: (doc) => doc.file },
  importedQuote: { Model: ImportedQuote, getFile: (doc) => doc.file },
  importedPurchaseOrder: {
    Model: ImportedPurchaseOrder,
    getFile: (doc) => doc.file,
  },
  purchaseInvoice: {
    Model: PurchaseInvoice,
    getFile: (doc, fileId) => (fileId ? doc.files?.id(fileId) : doc.files?.[0]),
  },
};

/**
 * GET /documents/imported/:docType/:id/file
 *
 * Streame le fichier original d'un document importé (facture, devis, bon de
 * commande importés, justificatif de facture d'achat) depuis R2, avec les
 * credentials serveur. Le frontend ne charge jamais l'URL publique R2
 * directement : la CSP stricte (frame-src) bloque les iframes vers des
 * domaines externes, l'aperçu passe par le proxy same-origin
 * /api/document-preview qui appelle cette route avec le cookie de session.
 * Auth session/JWT + RBAC (membre de l'org). Affichable en iframe.
 */
router.get("/imported/:docType/:id/file", validateJWT, async (req, res) => {
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

    // Vérifier l'appartenance de l'utilisateur à l'organisation du document
    const member =
      await EInvoicingSettingsService.getMemberCollection().findOne({
        userId: new mongoose.Types.ObjectId(userId),
        organizationId: doc.workspaceId,
      });
    if (!member) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const file = config.getFile(doc, req.query.fileId);
    if (!file?.url) {
      return res.status(404).json({ error: "Aucun fichier disponible" });
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

    let object;
    try {
      object = await cloudflareService.getObjectByUrl(file.url);
    } catch (error) {
      // URL en base mais objet absent du bucket (ex: importé dans un autre env)
      if (
        error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404
      ) {
        return res.status(404).json({ error: "Aucun fichier disponible" });
      }
      throw error;
    }

    const contentType =
      object.contentType ||
      file.mimeType ||
      file.mimetype ||
      "application/octet-stream";
    // Nom de fichier libre (saisi par l'utilisateur à l'import) : le header
    // n'accepte que du Latin-1 → fallback ASCII + variante UTF-8 (RFC 5987).
    const rawName =
      file.originalFileName || file.originalFilename || `${docType}-${doc._id}`;
    const asciiName =
      rawName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "") ||
      `${docType}-${doc._id}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`,
    );
    return res.send(object.buffer);
  } catch (error) {
    logger.error("[imported-document-file] Erreur:", error);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération du fichier" });
  }
});

export default router;
