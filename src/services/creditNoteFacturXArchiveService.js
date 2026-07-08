import axios from "axios";
import CreditNote from "../models/CreditNote.js";
import cloudflareService from "./cloudflareService.js";
import logger from "../utils/logger.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const PDF_TIMEOUT = Number(process.env.PDF_GENERATION_TIMEOUT_MS) || 120000;

/**
 * Génère le PDF d'un avoir (via NewbiV2) et l'archive sur Cloudflare R2.
 *
 * Pendant serveur de l'archivage client desktop (archiveCreditNotePdf), calqué
 * sur invoiceFacturXArchiveService → fonctionne pour TOUS les clients (mobile
 * inclus), déclenché à la création. La génération PDF reste centralisée dans
 * NewbiV2 (POST /api/credit-notes/generate-pdf), on ne fait qu'orchestrer +
 * uploader sur R2. NON BLOQUANT via triggerCreditNoteFacturXArchive.
 */
export async function archiveCreditNoteFacturX(creditNote, workspaceId) {
  if (!creditNote?._id || !workspaceId) return;
  if (!process.env.INTERNAL_API_SECRET) {
    logger.warn(
      "[CreditNoteArchive] INTERNAL_API_SECRET non défini : archivage ignoré.",
    );
    return;
  }

  const creditNoteId = creditNote._id.toString();

  // 1. Générer le PDF de l'avoir (orchestration NewbiV2, serveur-à-serveur).
  //    L'endpoint renvoie le PDF binaire (Content-Type application/pdf).
  const response = await axios.post(
    `${FRONTEND_URL}/api/credit-notes/generate-pdf`,
    { creditNoteId },
    {
      timeout: PDF_TIMEOUT,
      responseType: "arraybuffer",
      headers: { "x-internal-secret": process.env.INTERNAL_API_SECRET },
    },
  );
  const pdfBuffer = Buffer.from(response.data);
  if (!pdfBuffer?.length) {
    throw new Error("Génération PDF avoir échouée (réponse vide)");
  }

  // 2. Upload sur R2 (bucket avoirs privé).
  const fileName = `avoir_${creditNote.prefix || ""}${creditNote.number || creditNoteId}.pdf`;
  const { key } = await cloudflareService.uploadDocumentPdf(
    "creditNote",
    pdfBuffer,
    String(workspaceId),
    creditNoteId,
    { fileName },
  );

  // 3. Référencer l'archive sur l'avoir (updateOne pour éviter toute course avec
  //    le document Mongoose encore manipulé par le resolver appelant).
  await CreditNote.updateOne(
    { _id: creditNote._id },
    {
      $set: {
        archivedPdfKey: key,
        archivedPdfStoredAt: new Date(),
        archivedPdfSource: "NEWBI",
      },
    },
  );

  logger.info(
    `🗄️ [CreditNoteArchive] Avoir ${creditNoteId} archivé sur R2 (${key})`,
  );
}

/**
 * Version fire-and-forget : ne bloque/échoue JAMAIS le flux de création.
 */
export function triggerCreditNoteFacturXArchive(creditNote, workspaceId) {
  archiveCreditNoteFacturX(creditNote, workspaceId).catch((err) =>
    logger.warn(`[CreditNoteArchive] archivage ignoré: ${err?.message || err}`),
  );
}
