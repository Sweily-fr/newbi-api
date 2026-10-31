import cloudflareService from "../services/cloudflareService.js";

/**
 * Lit le PDF archivé (légal) d'un document finalisé, ou renvoie null s'il
 * n'y en a pas. Les factures ont leur bucket dédié ; devis, avoirs, bons de
 * commande et bons de livraison passent par les buckets de documents.
 *
 * @param {string} documentType - "invoice" | "quote" | "creditNote" | "purchaseOrder" | "deliveryNote"
 * @param {{ status?: string, archivedPdfKey?: string }} doc
 * @returns {Promise<Buffer|null>}
 */
export async function readArchivedDocumentPdf(documentType, doc) {
  if (!doc?.archivedPdfKey || doc.status === "DRAFT") return null;
  if (documentType === "invoice") {
    return cloudflareService.getInvoiceObjectBuffer(doc.archivedPdfKey);
  }
  if (cloudflareService.documentBuckets?.[documentType]) {
    return cloudflareService.getDocumentObjectBuffer(
      documentType,
      doc.archivedPdfKey,
    );
  }
  return null;
}

export default readArchivedDocumentPdf;
