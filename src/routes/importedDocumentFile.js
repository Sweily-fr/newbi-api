import express from "express";
import mongoose from "mongoose";
import { validateJWT } from "../middlewares/better-auth-jwt.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import ImportedQuote from "../models/ImportedQuote.js";
import ImportedPurchaseOrder from "../models/ImportedPurchaseOrder.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Transaction from "../models/Transaction.js";
import { findTransactionReceiptFile } from "../utils/transactionReceiptFiles.js";
import cloudflareService from "../services/cloudflareService.js";
import superPdpService from "../services/superPdpService.js";
import logger from "../utils/logger.js";
import { contentDisposition, safeFileHeaders } from "../utils/fileSignature.js";
import { userHasWorkspaceLevel } from "../utils/workspace-membership.js";

const router = express.Router();

// Config par type : modèle, page dont « Voir » est exigé (une liste : l'une
// suffit) et extraction du fichier stocké sur R2.
// Les documents importés portent un fichier unique (doc.file) ; les factures
// d'achat portent un tableau de justificatifs → sélection via ?fileId=.
const DOC_CONFIG = {
  // Factures importées : aussi l'antichambre des factures d'achat (Gmail)
  importedInvoice: {
    Model: ImportedInvoice,
    module: ["importedInvoices", "purchaseInvoices"],
    getFile: (doc) => doc.file,
  },
  importedQuote: {
    Model: ImportedQuote,
    module: "importedQuotes",
    getFile: (doc) => doc.file,
  },
  importedPurchaseOrder: {
    Model: ImportedPurchaseOrder,
    module: "importedPurchaseOrders",
    getFile: (doc) => doc.file,
  },
  purchaseInvoice: {
    Model: PurchaseInvoice,
    module: "purchaseInvoices",
    getFile: (doc, fileId) => (fileId ? doc.files?.id(fileId) : doc.files?.[0]),
  },
  // Justificatifs attachés directement à une transaction bancaire. Les
  // anciens justificatifs (migrés via le driver brut) n'avaient pas de _id :
  // findTransactionReceiptFile accepte aussi l'identifiant de repli
  // `<tx>-receipt-<n>`, et ?index=<n> reste possible.
  transaction: {
    Model: Transaction,
    module: "banking",
    getFile: (doc, fileId, index) => {
      if (fileId) return findTransactionReceiptFile(doc, fileId);
      if (index !== undefined) return doc.receiptFiles?.[index];
      return doc.receiptFiles?.[0];
    },
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
 * Auth session/JWT + RBAC (membre de l'org). Affichable en iframe pour les
 * PDF et les images, téléchargé pour tout autre contenu.
 *
 * ?download=1 : servi en pièce jointe (bouton « Télécharger »), le type
 * servi restant celui établi d'après le contenu.
 *
 * Facture d'achat reçue via la plateforme agréée (SuperPDP) dont le PDF n'a
 * pas pu être rattaché à la réception : le PDF est lu chez SuperPDP à la
 * demande et servi tel quel, sans rien enregistrer sur la facture.
 */

/**
 * PDF d'une facture d'achat reçue via SuperPDP, lu à la demande.
 * Le repli /download de SuperPDP peut renvoyer le XML d'origine : seul un
 * vrai PDF est retenu.
 *
 * @returns {Promise<{buffer: Buffer, filename: string}|null>}
 */
async function fetchReceivedEInvoicePdf(doc) {
  try {
    const buffer = await superPdpService.getArchivedPdf(
      String(doc.workspaceId),
      doc.superPdpInvoiceId,
    );
    if (!buffer?.length) return null;
    if (!buffer.subarray(0, 1024).toString("latin1").includes("%PDF")) {
      return null;
    }
    const safeNumber = String(doc.invoiceNumber || doc.superPdpInvoiceId)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 100);
    return { buffer, filename: `facture-${safeNumber}.pdf` };
  } catch (error) {
    logger.warn(
      `[imported-document-file] PDF SuperPDP indisponible pour ${doc._id}: ${error.message}`,
    );
    return null;
  }
}
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

    // Vérifier l'appartenance de l'utilisateur à l'organisation du document.
    // workspaceId est un ObjectId sur les documents importés mais une String
    // sur Transaction : normaliser avant le lookup.
    if (!mongoose.Types.ObjectId.isValid(doc.workspaceId)) {
      return res.status(403).json({ error: "Accès refusé" });
    }
    if (
      !(await userHasWorkspaceLevel(
        userId,
        String(doc.workspaceId),
        config.module,
        "read",
      ))
    ) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    const rawIndex = req.query.index;
    const fileIndex =
      rawIndex !== undefined && /^\d{1,3}$/.test(String(rawIndex))
        ? Number(rawIndex)
        : undefined;
    const file = config.getFile(doc, req.query.fileId, fileIndex);
    // Facture reçue via la plateforme agréée, sans justificatif rattaché
    const receivedEInvoice =
      !file?.url &&
      docType === "purchaseInvoice" &&
      !req.query.fileId &&
      doc.source === "SUPERPDP" &&
      doc.superPdpInvoiceId
        ? await fetchReceivedEInvoicePdf(doc)
        : null;
    if (!file?.url && !receivedEInvoice) {
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

    let buffer;
    let rawName;
    if (receivedEInvoice) {
      ({ buffer, filename: rawName } = receivedEInvoice);
    } else {
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
      buffer = object.buffer;
      // Nom de fichier libre (saisi par l'utilisateur à l'import)
      rawName =
        file.originalFileName ||
        file.originalFilename ||
        file.filename ||
        `${docType}-${doc._id}`;
    }

    // Type établi d'après le contenu, jamais d'après le type R2 (déduit de
    // l'extension choisie par le client) ni le type enregistré : seuls les
    // PDF et les images matricielles s'affichent, le reste se télécharge.
    const headers = safeFileHeaders({
      buffer,
      filename: rawName,
      frameAncestors: `'self' ${frontendUrl}`,
    });
    if (req.query.download === "1") {
      headers["Content-Disposition"] = contentDisposition(
        "attachment",
        rawName,
      );
    }
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    return res.send(buffer);
  } catch (error) {
    logger.error("[imported-document-file] Erreur:", error);
    return res
      .status(500)
      .json({ error: "Erreur lors de la récupération du fichier" });
  }
});

export default router;
