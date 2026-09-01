import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import Notification from "../models/Notification.js";
import superPdpService from "./superPdpService.js";
import cloudflareService from "./cloudflareService.js";
import { publishNotification } from "../resolvers/notification.js";
import logger from "../utils/logger.js";

/**
 * Récupérer le PDF d'une facture reçue chez SuperPDP et l'uploader sur R2
 * (bucket OCR, même destination que les justificatifs uploadés à la main).
 *
 * Best-effort : retourne null en cas d'échec, l'import de la facture ne doit
 * pas être bloqué par l'indisponibilité du rendu PDF.
 *
 * @param {string} workspaceId - ID de l'organisation
 * @param {string} userId - Utilisateur attribué (métadonnées d'upload)
 * @param {string|number} superPdpId - ID SuperPDP de la facture
 * @param {string} [invoiceNumber] - Numéro de facture (nom de fichier)
 * @returns {Promise<Object|null>} - Entrée pour PurchaseInvoice.files, ou null
 */
export async function fetchSuperPdpPdfFile(
  workspaceId,
  userId,
  superPdpId,
  invoiceNumber,
) {
  try {
    const pdfBuffer = await superPdpService.getArchivedPdf(
      workspaceId,
      superPdpId,
    );
    if (!pdfBuffer || pdfBuffer.length === 0) {
      throw new Error("PDF vide");
    }
    // Le fallback /download peut renvoyer le fichier brut d'origine (XML UBL) :
    // ne rattacher que si c'est réellement un PDF.
    if (!pdfBuffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
      throw new Error("le fichier renvoyé n'est pas un PDF");
    }

    const safeNumber = String(invoiceNumber || superPdpId).replace(
      /[^a-zA-Z0-9._-]/g,
      "-",
    );
    const fileName = `facture-${safeNumber}.pdf`;
    const uploadResult = await cloudflareService.uploadImage(
      pdfBuffer,
      fileName,
      userId,
      "ocr",
      workspaceId,
    );

    return {
      filename: uploadResult.key || fileName,
      originalFilename: fileName,
      mimetype: "application/pdf",
      path: uploadResult.key,
      size: pdfBuffer.length,
      url: uploadResult.url,
      ocrProcessed: false,
      ocrData: null,
    };
  } catch (err) {
    logger.warn(
      `[reception] PDF non rattaché pour la facture SuperPDP ${superPdpId}: ${err.message}`,
    );
    return null;
  }
}

/**
 * Importe les factures fournisseurs reçues depuis SuperPDP dans Newbi.
 *
 * Logique partagée entre la mutation manuelle (syncPurchaseInvoicesFromSuperPdp)
 * et le cron de réception automatique. Idempotent : ignore les factures déjà
 * importées (par superPdpInvoiceId).
 *
 * @param {string} workspaceId - ID de l'organisation
 * @param {string} userId - Utilisateur attribué (createdBy, requis)
 * @param {string} [since] - Date ISO de filtrage (optionnel)
 * @returns {Promise<{imported:number, skipped:number, errors:number}>}
 */
export async function importReceivedInvoices(workspaceId, userId, since) {
  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let startingAfterId = undefined;
  let hasMore = true;

  while (hasMore) {
    const result = await superPdpService.getReceivedInvoices(workspaceId, {
      startingAfterId,
      limit: 50,
      date: since,
    });

    for (const superPdpInvoice of result.invoices) {
      try {
        const superPdpId = superPdpInvoice.id || superPdpInvoice.invoiceId;

        const existing = await PurchaseInvoice.findOne({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          superPdpInvoiceId: superPdpId,
        });
        if (existing) {
          skipped++;
          continue;
        }

        // La liste GET /invoices ne renvoie que des résumés sans en_invoice :
        // récupérer le détail EN16931 avant transformation, sinon la facture
        // serait créée vide ("Fournisseur inconnu", 0 €).
        let sourceInvoice = superPdpInvoice;
        if (!superPdpService.hasReceivedInvoiceData(sourceInvoice)) {
          sourceInvoice = await superPdpService.getReceivedInvoiceDetail(
            workspaceId,
            superPdpId,
          );
        }
        if (!superPdpService.hasReceivedInvoiceData(sourceInvoice)) {
          throw new Error(
            `détail EN16931 vide pour la facture SuperPDP ${superPdpId}`,
          );
        }

        const purchaseInvoiceData =
          superPdpService.transformReceivedInvoiceToPurchaseInvoice(
            sourceInvoice,
            workspaceId,
            userId,
          );
        // Le détail peut être un EN16931 nu sans champ id : forcer l'ID de la
        // liste pour préserver l'idempotence par superPdpInvoiceId.
        purchaseInvoiceData.superPdpInvoiceId = String(superPdpId);

        // Rattacher le PDF de la facture (best-effort)
        const pdfFile = await fetchSuperPdpPdfFile(
          workspaceId,
          userId,
          superPdpId,
          purchaseInvoiceData.invoiceNumber,
        );
        if (pdfFile) {
          purchaseInvoiceData.files = [pdfFile];
        }

        // Auto-créer ou trouver le fournisseur
        let supplier = await Supplier.findOne({
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          name: {
            $regex: new RegExp(
              `^${purchaseInvoiceData.supplierName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
              "i",
            ),
          },
        });

        if (!supplier) {
          const ocrMeta = purchaseInvoiceData.ocrMetadata || {};
          supplier = await Supplier.create({
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            createdBy: new mongoose.Types.ObjectId(userId),
            name: purchaseInvoiceData.supplierName,
            siret: ocrMeta.supplierSiret || undefined,
            vatNumber: ocrMeta.supplierVatNumber || undefined,
            defaultCategory: purchaseInvoiceData.category,
          });
        }

        purchaseInvoiceData.supplierId = supplier._id;
        const created = await PurchaseInvoice.create(purchaseInvoiceData);
        imported++;

        logger.info(
          `✅ Facture d'achat importée depuis SuperPDP: ${purchaseInvoiceData.invoiceNumber} (${purchaseInvoiceData.supplierName})`,
        );

        // Notifier l'utilisateur de l'arrivée de la facture (best-effort)
        try {
          const notification =
            await Notification.createPurchaseInvoiceReceivedNotification({
              userId,
              workspaceId,
              purchaseInvoiceId: created._id,
              invoiceNumber: purchaseInvoiceData.invoiceNumber,
              supplierName: purchaseInvoiceData.supplierName,
              amountTTC: purchaseInvoiceData.amountTTC,
              url: `/dashboard/outils/factures-achat?invoice=${created._id}`,
            });
          await publishNotification(notification);
        } catch (notifErr) {
          logger.warn(
            `[reception] notification non envoyée pour ${purchaseInvoiceData.invoiceNumber}: ${notifErr.message}`,
          );
        }
      } catch (err) {
        errors++;
        logger.error("❌ Erreur import facture SuperPDP:", err);
      }
    }

    // Pagination par curseur
    const lastInvoice = result.invoices[result.invoices.length - 1];
    hasMore = result.hasAfter && !!lastInvoice;
    startingAfterId = lastInvoice
      ? lastInvoice.id || lastInvoice.invoiceId
      : undefined;
    if (!startingAfterId) hasMore = false;
  }

  return { imported, skipped, errors };
}
