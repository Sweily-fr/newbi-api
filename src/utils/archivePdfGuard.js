import { AppError, ERROR_CODES } from "./errors.js";
import { isEInvoiceTransmitted } from "./eInvoiceLock.js";

/**
 * Contrôles communs à l'archivage d'un PDF envoyé par le site
 * (archiveInvoicePdf, archiveCreditNotePdf). Cette archive est le document
 * qui fait foi : aperçu, bouton PDF et envois la reprennent.
 */

const PDF_SIGNATURE = Buffer.from("%PDF-");
const MAX_PDF_BYTES = 20 * 1024 * 1024;

/**
 * Lit le fichier envoyé et vérifie que c'est bien un PDF : type annoncé
 * application/pdf ET contenu qui commence par « %PDF- » (un fichier HTML
 * ou une image renommés en .pdf sont refusés). Renvoie son contenu.
 * @param {Promise} file - Upload graphql-upload
 * @returns {Promise<Buffer>}
 */
export async function readUploadedPdf(file) {
  const { createReadStream, mimetype } = await file;
  if (mimetype !== "application/pdf") {
    throw new AppError(
      "Le document à archiver doit être un PDF",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream()) {
    size += chunk.length;
    if (size > MAX_PDF_BYTES) {
      throw new AppError("PDF trop volumineux", ERROR_CODES.VALIDATION_ERROR);
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE)) {
    throw new AppError(
      "Le document à archiver doit être un PDF",
      ERROR_CODES.VALIDATION_ERROR,
    );
  }
  return buffer;
}

/**
 * Refuse de remplacer l'archive d'un document qui fait foi tel qu'il a été
 * archivé : facture payée ou annulée, document transmis en facturation
 * électronique. La première archive reste possible.
 * @param {Object} doc - facture ou avoir enregistré
 * @param {"invoice"|"creditNote"} type
 */
export function assertArchiveReplaceable(doc, type = "invoice") {
  if (!doc?.archivedPdfKey) return;
  const plain = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const settled =
    type === "invoice" && ["COMPLETED", "CANCELED"].includes(plain.status);
  if (settled || isEInvoiceTransmitted(plain)) {
    throw new AppError(
      type === "invoice"
        ? "Cette facture est payée, annulée ou transmise : son document archivé ne se remplace plus."
        : "Cet avoir a été transmis en facturation électronique : son document archivé ne se remplace plus.",
      ERROR_CODES.RESOURCE_LOCKED,
      { resource: type, action: "archive", status: plain.status ?? null },
    );
  }
}
