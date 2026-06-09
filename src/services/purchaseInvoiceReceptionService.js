import mongoose from "mongoose";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import Notification from "../models/Notification.js";
import superPdpService from "./superPdpService.js";
import { publishNotification } from "../resolvers/notification.js";
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
