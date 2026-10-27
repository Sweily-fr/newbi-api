import express from "express";
import mongoose from "mongoose";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import DocumentEmailLog from "../models/DocumentEmailLog.js";
import cloudflareService from "../services/cloudflareService.js";
import logger from "../utils/logger.js";
import { userHasWorkspaceLevel } from "../utils/workspace-membership.js";

const router = express.Router();

// Page dont « Voir » est exigé, selon le document envoyé
const DOCUMENT_MODULES = {
  invoice: "invoices",
  quote: "quotes",
  creditNote: "creditNotes",
  purchaseOrder: "purchaseOrders",
  deliveryNote: "deliveryNotes",
};

// Seuls ces formats s'affichent dans le navigateur. Les autres (HTML, SVG…
// choisis par l'utilisateur) sont téléchargés : servis par le proxy du site,
// ils ne doivent jamais être interprétés sur l'origine de l'application.
const INLINE_TYPES = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function inlineTypeOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(filename || "");
  return match ? INLINE_TYPES[match[1].toLowerCase()] : undefined;
}

/**
 * GET /documents/email-logs/:logId/attachment?index=<n>
 *
 * Streame un fichier joint à la main à un e-mail de document, conservé à
 * l'envoi dans un bucket privé. Ouvert depuis la page de l'e-mail envoyé via
 * le proxy same-origin /api/document-preview (cookie de session transmis).
 * Auth session/JWT + « Voir » du document dans l'espace de l'envoi.
 */
router.get("/email-logs/:logId/attachment", validateJWT, async (req, res) => {
  try {
    const userId = req.user;
    if (!userId) return res.status(401).json({ error: "Non authentifié" });

    const { logId } = req.params;
    const rawIndex = String(req.query.index ?? "");
    if (
      !mongoose.Types.ObjectId.isValid(logId) ||
      !/^\d{1,3}$/.test(rawIndex)
    ) {
      return res.status(400).json({ error: "Fichier invalide" });
    }

    const log = await DocumentEmailLog.findById(logId)
      .select("workspaceId documentType attachments")
      .lean();
    if (!log) return res.status(404).json({ error: "Envoi introuvable" });

    if (
      !(await userHasWorkspaceLevel(
        userId,
        String(log.workspaceId),
        DOCUMENT_MODULES[log.documentType],
        "read",
      ))
    ) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const attachment = log.attachments?.[Number(rawIndex)];
    if (!attachment?.storageKey) {
      return res.status(404).json({ error: "Fichier non conservé" });
    }

    let buffer;
    try {
      buffer = await cloudflareService.getEmailAttachmentBuffer(
        attachment.storageKey,
      );
    } catch (error) {
      if (
        error?.name === "NoSuchKey" ||
        error?.$metadata?.httpStatusCode === 404
      ) {
        return res.status(404).json({ error: "Fichier non conservé" });
      }
      throw error;
    }

    const inlineType = inlineTypeOf(attachment.filename);
    // Nom libre : le header n'accepte que du Latin-1 → repli ASCII + variante
    // UTF-8 (RFC 5987)
    const asciiName =
      attachment.filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "") ||
      "piece-jointe";
    res.setHeader("Content-Type", inlineType || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `${inlineType ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    );
    return res.send(buffer);
  } catch (error) {
    logger.error("[email-attachment] Erreur:", error);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération du fichier" });
  }
});

export default router;
