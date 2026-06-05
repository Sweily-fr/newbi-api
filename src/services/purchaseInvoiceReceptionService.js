import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import superPdpService from "./superPdpService.js";
import logger from "../utils/logger.js";

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

        const purchaseInvoiceData =
          superPdpService.transformReceivedInvoiceToPurchaseInvoice(
            superPdpInvoice,
            workspaceId,
            userId,
          );

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
            name: purchaseInvoiceData.supplierName,
            siret: ocrMeta.supplierSiret || undefined,
            vatNumber: ocrMeta.supplierVatNumber || undefined,
            defaultCategory: purchaseInvoiceData.category,
          });
        }

        purchaseInvoiceData.supplierId = supplier._id;
        await PurchaseInvoice.create(purchaseInvoiceData);
        imported++;

        logger.info(
          `✅ Facture d'achat importée depuis SuperPDP: ${purchaseInvoiceData.invoiceNumber} (${purchaseInvoiceData.supplierName})`,
        );
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
