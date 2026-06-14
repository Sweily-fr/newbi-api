import axios from "axios";
import Invoice from "../models/Invoice.js";
import cloudflareService from "./cloudflareService.js";
import logger from "../utils/logger.js";

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const PDF_TIMEOUT = Number(process.env.PDF_GENERATION_TIMEOUT_MS) || 120000;

/**
 * Génère le PDF Factur-X d'une facture (via NewbiV2) et l'archive sur Cloudflare R2.
 *
 * Parité avec l'archivage client desktop (useArchiveInvoicePdf / buildFacturXFile),
 * mais côté serveur → fonctionne pour TOUS les clients (mobile inclus), déclenché à
 * la finalisation. La génération Factur-X reste centralisée dans NewbiV2
 * (POST /api/invoices/facturx-pdf), on ne fait qu'orchestrer + uploader sur R2.
 *
 * Réécrit l'archive si rappelée. NON BLOQUANT via triggerInvoiceFacturXArchive.
 */
export async function archiveInvoiceFacturX(invoice, workspaceId) {
  if (!invoice?._id || invoice.status === "DRAFT" || !workspaceId) return;
  if (!process.env.INTERNAL_API_SECRET) {
    logger.warn(
      "[FacturXArchive] INTERNAL_API_SECRET non défini : archivage ignoré.",
    );
    return;
  }

  const invoiceId = invoice._id.toString();

  // 1. Générer le Factur-X complet (orchestration NewbiV2, serveur-à-serveur)
  const { data } = await axios.post(
    `${FRONTEND_URL}/api/invoices/facturx-pdf`,
    { invoiceId },
    {
      timeout: PDF_TIMEOUT,
      headers: { "x-internal-secret": process.env.INTERNAL_API_SECRET },
    },
  );
  if (!data?.success || !data.pdfBase64) {
    throw new Error("Génération Factur-X échouée (réponse invalide)");
  }
  const pdfBuffer = Buffer.from(data.pdfBase64, "base64");

  // 2. Upload sur R2 (bucket factures privé)
  const fileName = `facture_${invoice.prefix || ""}${invoice.number || invoiceId}.pdf`;
  const { key } = await cloudflareService.uploadInvoicePdf(
    pdfBuffer,
    String(workspaceId),
    invoiceId,
    { source: "NEWBI", fileName },
  );

  // 3. Référencer l'archive sur la facture (updateOne pour éviter toute course
  //    avec le document Mongoose encore manipulé par le resolver appelant)
  await Invoice.updateOne(
    { _id: invoice._id },
    {
      $set: {
        archivedPdfKey: key,
        archivedPdfUrl: null,
        archivedPdfStoredAt: new Date(),
        archivedPdfSource: "NEWBI",
        ...(data.facturx
          ? {
              facturXData: {
                xmlGenerated: true,
                profile: "EN16931",
                generatedAt: new Date(),
              },
            }
          : {}),
      },
    },
  );

  logger.info(
    `🗄️ [FacturXArchive] Facture ${invoiceId} archivée sur R2 (${key}, facturx=${!!data.facturx})`,
  );
}

/**
 * Version fire-and-forget : ne bloque/échoue JAMAIS le flux de finalisation.
 */
export function triggerInvoiceFacturXArchive(invoice, workspaceId) {
  archiveInvoiceFacturX(invoice, workspaceId).catch((err) =>
    logger.warn(`[FacturXArchive] archivage ignoré: ${err?.message || err}`),
  );
}
