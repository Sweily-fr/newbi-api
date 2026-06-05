import cloudflareService from "../services/cloudflareService.js";
import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Helpers partagés d'archivage PDF des documents (devis, avoirs, bons de commande)
 * sur Cloudflare R2, et de construction de l'URL d'aperçu (route de streaming).
 *
 * Le système des FACTURES garde son implémentation dédiée ; ces helpers couvrent
 * uniquement les 3 autres types.
 */

/**
 * Construit l'URL de la route backend qui streame le PDF d'un document.
 * @param {string} docType - "quote" | "creditNote" | "purchaseOrder"
 * @param {string} docId
 * @returns {string}
 */
export function buildDocumentUrl(docType, docId) {
  const base = (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "http://localhost:4000"
  ).replace(/\/$/, "");
  return `${base}/documents/${docType}/${docId}/document-pdf`;
}

/**
 * Archive le PDF (uploadé par le frontend) d'un document sur R2.
 * @param {Object} params
 * @param {import("mongoose").Model} params.Model
 * @param {string} params.docType - "quote" | "creditNote" | "purchaseOrder"
 * @param {string|null} params.draftStatus - statut brouillon non archivable (null si aucun)
 * @param {string} params.workspaceId
 * @param {string} params.docId
 * @param {Promise} params.file - Upload graphql-upload
 * @returns {Promise<Object>} le document mis à jour
 */
export async function archiveDocumentPdf({
  Model,
  docType,
  draftStatus,
  workspaceId,
  docId,
  file,
}) {
  const doc = await Model.findOne({ _id: docId, workspaceId });
  if (!doc) {
    throw new AppError("Document non trouvé", ERROR_CODES.NOT_FOUND);
  }
  if (draftStatus && doc.status === draftStatus) {
    throw new AppError(
      "Un brouillon ne peut pas être archivé",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const { createReadStream, mimetype } = await file;
  if (mimetype && mimetype !== "application/pdf") {
    throw new AppError(
      "Le document à archiver doit être un PDF",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const chunks = [];
  for await (const chunk of createReadStream()) {
    chunks.push(chunk);
  }
  const pdfBuffer = Buffer.concat(chunks);
  if (pdfBuffer.length > 20 * 1024 * 1024) {
    throw new AppError("PDF trop volumineux", ERROR_CODES.VALIDATION_ERROR);
  }

  const fileName = `${docType}_${doc.prefix || ""}${doc.number || docId}.pdf`;
  const { key } = await cloudflareService.uploadDocumentPdf(
    docType,
    pdfBuffer,
    String(workspaceId),
    String(docId),
    { fileName },
  );

  doc.archivedPdfKey = key;
  doc.archivedPdfStoredAt = new Date();
  doc.archivedPdfSource = "NEWBI";
  await doc.save();

  return doc;
}

/**
 * Renvoie l'URL d'aperçu d'un document, ou null (brouillon / pas encore archivé).
 * @param {Object} params - { Model, docType, draftStatus, workspaceId, docId }
 * @returns {Promise<string|null>}
 */
export async function documentUrl({
  Model,
  docType,
  draftStatus,
  workspaceId,
  docId,
}) {
  const doc = await Model.findOne({ _id: docId, workspaceId }).select(
    "status archivedPdfKey",
  );
  if (!doc) {
    throw new AppError("Document non trouvé", ERROR_CODES.NOT_FOUND);
  }
  if (draftStatus && doc.status === draftStatus) return null;
  if (!doc.archivedPdfKey) return null;
  return buildDocumentUrl(docType, docId);
}
