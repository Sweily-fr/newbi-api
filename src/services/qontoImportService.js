import mongoose from "mongoose";
import QontoAccount from "../models/QontoAccount.js";
import Invoice from "../models/Invoice.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import Quote from "../models/Quote.js";
import ImportedQuote from "../models/ImportedQuote.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import qontoService from "./qontoService.js";
import cloudflareService from "./cloudflareService.js";
import { convertSingleImportedQuote } from "../resolvers/importedQuote.js";
import Notification from "../models/Notification.js";
import { publishNotification } from "../resolvers/notification.js";
import logger from "../utils/logger.js";

/**
 * Sens Qonto → Newbi.
 *
 * Qonto n'expose les webhooks qu'aux apps OAuth : on interroge donc l'API par
 * polling (cron qontoImportCron + mutation importFromQonto) avec un curseur
 * `updated_at_from` par type de document, comme la réception SuperPDP.
 *
 *  - Factures clients créées dans Qonto  → ImportedInvoice (ventes importées)
 *  - Factures fournisseurs déposées dans Qonto → PurchaseInvoice (achats)
 *
 * Idempotent : chaque document Newbi porte le `qontoId` d'origine. Les documents
 * que Newbi a lui-même poussés vers Qonto (Invoice/PurchaseInvoice
 * .qontoId) ne sont jamais réimportés.
 */

// Marge de sécurité sur le curseur : Qonto peut indexer avec un léger retard
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

const CLIENT_STATUS_MAP = {
  unpaid: "VALIDATED",
  paid: "COMPLETED",
  canceled: "REJECTED",
};

// Statut ImportedQuote à la création. Un devis accepté côté Qonto est ensuite
// converti en vrai Quote (statut IMPORTED) via convertSingleImportedQuote,
// comme le bouton « Valider » de Newbi : c'est cette conversion qui passe
// l'ImportedQuote en VALIDATED (masqué du tableau au profit du vrai devis).
const QUOTE_STATUS_MAP = {
  pending_approval: "PENDING_REVIEW",
  approved: "PENDING_REVIEW",
  canceled: "REJECTED",
};

// Nombre max de devis Qonto relus par passage pour suivre leur statut
const QUOTE_STATUS_REFRESH_LIMIT = 50;

const SUPPLIER_STATUS_MAP = {
  to_review: "TO_PROCESS",
  to_approve: "TO_PROCESS",
  awaiting_payment: "TO_PAY",
  to_pay: "TO_PAY",
  pending: "PENDING",
  scheduled: "PENDING",
  paid: "PAID",
  archived: "ARCHIVED",
};

// Statuts Qonto pour lesquels on ne crée pas de nouveau document Newbi
const SUPPLIER_STATUS_SKIP_NEW = new Set(["rejected", "discarded", "archived"]);

function num(value) {
  const n = parseFloat(value?.value ?? value);
  return Number.isFinite(n) ? n : 0;
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function safeFileName(name, fallback) {
  const base = String(name || fallback || "document").replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
  return /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.pdf`;
}

function clientDisplayName(client = {}) {
  return (
    client.name ||
    `${client.first_name || ""} ${client.last_name || ""}`.trim() ||
    "Client Qonto"
  );
}

/**
 * Télécharge la pièce jointe Qonto et la dépose sur R2 (bucket OCR, même
 * destination que les justificatifs uploadés à la main).
 * @returns {Promise<{buffer, fileName, mimeType, upload}|null>}
 */
async function fetchAttachmentToR2(
  credentials,
  attachmentId,
  { workspaceId, userId, fallbackName },
) {
  const file = await qontoService.downloadAttachment(credentials, attachmentId);
  if (!file?.buffer?.length) return null;
  const fileName = safeFileName(file.fileName, fallbackName);
  const upload = await cloudflareService.uploadImage(
    file.buffer,
    fileName,
    userId,
    "ocr",
    workspaceId,
  );
  return {
    buffer: file.buffer,
    fileName,
    mimeType: file.contentType || "application/pdf",
    upload,
  };
}

/**
 * Importe / met à jour les factures clients créées dans Qonto
 */
export async function importClientInvoices(account, userId) {
  const credentials = account.getCredentials();
  const workspaceId = String(account.organizationId);
  const result = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  const since = account.importCursors?.clientInvoices
    ? new Date(
        account.importCursors.clientInvoices.getTime() - CURSOR_OVERLAP_MS,
      )
    : null;

  let page = 1;
  let maxUpdatedAt = account.importCursors?.clientInvoices || null;
  let deferredMin = null; // PDF pas encore généré côté Qonto → à revoir au prochain tour

  do {
    const { items, nextPage } = await qontoService.listClientInvoices(
      credentials,
      { updatedAtFrom: since, page },
    );

    for (const ci of items) {
      const updatedAt = toDate(ci.updated_at) || toDate(ci.created_at);
      try {
        if (ci.status === "draft") {
          result.skipped++;
          continue;
        }

        // Facture poussée par Newbi lui-même : ne jamais la réimporter
        const pushed = await Invoice.exists({
          workspaceId,
          qontoId: String(ci.id),
        });
        if (pushed) {
          result.skipped++;
          continue;
        }

        const existing = await ImportedInvoice.findOne({
          workspaceId,
          qontoId: String(ci.id),
        });

        const mappedStatus = CLIENT_STATUS_MAP[ci.status];
        if (existing) {
          // Mise à jour de statut uniquement (payée / annulée côté Qonto)
          let changed = false;
          if (
            mappedStatus &&
            existing.status !== mappedStatus &&
            !["ARCHIVED"].includes(existing.status)
          ) {
            existing.status = mappedStatus;
            changed = true;
          }
          const paidAt = toDate(ci.paid_at);
          if (paidAt && !existing.paymentDate) {
            existing.paymentDate = paidAt;
            changed = true;
          }
          if (changed) {
            await existing.save();
            result.updated++;
          } else {
            result.skipped++;
          }
          continue;
        }

        if (!mappedStatus || ci.status === "canceled") {
          result.skipped++;
          continue;
        }

        // Le PDF Qonto est généré de façon asynchrone après création
        if (!ci.attachment_id) {
          if (!deferredMin || (updatedAt && updatedAt < deferredMin)) {
            deferredMin = updatedAt || new Date();
          }
          result.skipped++;
          continue;
        }

        const file = await fetchAttachmentToR2(credentials, ci.attachment_id, {
          workspaceId,
          userId,
          fallbackName: `facture-${ci.number || ci.id}`,
        });
        if (!file) {
          result.errors++;
          continue;
        }

        const totalTTC = num(ci.total_amount);
        const totalVAT = num(ci.vat_amount);
        const client = ci.client || {};
        const billing = client.billing_address || {};

        const createdInvoice = await ImportedInvoice.create({
          workspaceId,
          importedBy: userId,
          qontoId: String(ci.id),
          source: "QONTO",
          status: mappedStatus,
          originalInvoiceNumber: ci.number || null,
          vendor: { name: ci.organization?.legal_name || "" },
          client: {
            id: client.id || null,
            name: clientDisplayName(client),
            address: billing.street_address || client.address || "",
            city: billing.city || client.city || "",
            postalCode: billing.zip_code || client.zip_code || "",
            siret: client.tax_identification_number || null,
          },
          invoiceDate: toDate(ci.issue_date) || toDate(ci.created_at),
          dueDate: toDate(ci.due_date),
          paymentDate: toDate(ci.paid_at),
          totalHT: Math.round((totalTTC - totalVAT) * 100) / 100,
          totalVAT,
          totalTTC,
          currency: ci.currency || "EUR",
          items: (ci.items || []).map((it) => ({
            description: [it.title, it.description].filter(Boolean).join(" - "),
            quantity: num(it.quantity) || 1,
            unitPrice: num(it.unit_price),
            totalPrice: num(it.subtotal) || num(it.total_amount),
            vatRate: Math.round(num(it.vat_rate) * 10000) / 100,
          })),
          file: {
            url: file.upload.url,
            cloudflareKey: file.upload.key,
            originalFileName: file.fileName,
            mimeType: file.mimeType,
            fileSize: file.buffer.length,
          },
        });

        result.imported++;
        logger.info(
          `[QONTO-IMPORT] Facture client ${ci.number || ci.id} importée depuis Qonto (org=${workspaceId})`,
        );
        await notifyImported({
          userId,
          workspaceId,
          documentType: "INVOICE",
          documentId: createdInvoice._id,
          documentNumber: ci.number,
          counterpartName: clientDisplayName(client),
          amountTTC: totalTTC,
          url: "/dashboard/outils/factures",
        });
      } catch (error) {
        result.errors++;
        logger.error(
          `[QONTO-IMPORT] Facture client Qonto ${ci.id}: ${error.message}`,
        );
      } finally {
        if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
          maxUpdatedAt = updatedAt;
        }
      }
    }

    page = nextPage;
  } while (page);

  // Ne pas dépasser une facture dont le PDF n'était pas encore prêt
  const cursor =
    deferredMin && (!maxUpdatedAt || deferredMin < maxUpdatedAt)
      ? deferredMin
      : maxUpdatedAt;
  if (cursor) account.importCursors.clientInvoices = cursor;

  return result;
}

/**
 * Importe / met à jour les factures fournisseurs déposées dans Qonto
 */
export async function importSupplierInvoices(account, userId) {
  const credentials = account.getCredentials();
  const workspaceId = String(account.organizationId);
  const workspaceObjectId = new mongoose.Types.ObjectId(workspaceId);
  const result = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  const since = account.importCursors?.supplierInvoices
    ? new Date(
        account.importCursors.supplierInvoices.getTime() - CURSOR_OVERLAP_MS,
      )
    : null;

  let page = 1;
  let maxUpdatedAt = account.importCursors?.supplierInvoices || null;

  do {
    const { items, nextPage } = await qontoService.listSupplierInvoices(
      credentials,
      { updatedAtFrom: since, page },
    );

    for (const si of items) {
      const updatedAt = toDate(si.updated_at) || toDate(si.created_at);
      try {
        const qontoId = String(si.id);

        // Déposée par Newbi (facture d'achat) : ne pas réimporter
        const pushed = await PurchaseInvoice.exists({
          workspaceId: workspaceObjectId,
          qontoId,
          source: { $ne: "QONTO" },
        });
        if (pushed) {
          result.skipped++;
          continue;
        }

        const mappedStatus = SUPPLIER_STATUS_MAP[si.status] || "TO_PROCESS";
        const amountTTC = num(si.total_amount);
        const amountHT = num(si.total_amount_excluding_taxes);
        const amountTVA =
          num(si.total_tax_amount) ||
          Math.round((amountTTC - amountHT) * 100) / 100;

        const existing = await PurchaseInvoice.findOne({
          workspaceId: workspaceObjectId,
          qontoId,
          source: "QONTO",
        });

        if (existing) {
          let changed = false;
          // Qonto analyse le fichier après dépôt : compléter les montants absents
          if (!existing.amountTTC && amountTTC) {
            existing.amountTTC = amountTTC;
            existing.amountHT = amountHT;
            existing.amountTVA = amountTVA;
            if (amountHT > 0) {
              existing.vatRate =
                Math.round((amountTVA / amountHT) * 10000) / 100;
            }
            changed = true;
          }
          // Numéro provisoire « QONTO-xxxxxxxx » remplacé par le vrai numéro
          const placeholderNumber = /^QONTO-[A-Z0-9-]{4,12}$/.test(
            existing.invoiceNumber || "",
          );
          if (
            si.invoice_number &&
            (!existing.invoiceNumber?.trim() || placeholderNumber)
          ) {
            existing.invoiceNumber = si.invoice_number;
            changed = true;
          }
          if (
            si.supplier_name &&
            existing.supplierName === "Fournisseur Qonto"
          ) {
            existing.supplierName = si.supplier_name;
            changed = true;
          }
          if (
            si.status === "paid" &&
            existing.status !== "PAID" &&
            existing.status !== "ARCHIVED"
          ) {
            existing.status = "PAID";
            existing.paymentDate = toDate(si.payment_date) || new Date();
            changed = true;
          }
          if (changed) {
            await existing.save();
            result.updated++;
          } else {
            result.skipped++;
          }
          continue;
        }

        if (SUPPLIER_STATUS_SKIP_NEW.has(si.status)) {
          result.skipped++;
          continue;
        }

        const attachmentId = si.attachment_id || si.display_attachment_id;
        if (!attachmentId) {
          result.skipped++;
          continue;
        }

        const invoiceNumber =
          si.invoice_number || `QONTO-${qontoId.slice(0, 8).toUpperCase()}`;
        const supplierName =
          si.supplier_name || si.issuer_name || "Fournisseur Qonto";

        const file = await fetchAttachmentToR2(credentials, attachmentId, {
          workspaceId,
          userId,
          fallbackName: si.file_name || `facture-achat-${invoiceNumber}`,
        });
        if (!file) {
          result.errors++;
          continue;
        }

        // Fournisseur : trouver (insensible à la casse) ou créer
        const escaped = supplierName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        let supplier = await Supplier.findOne({
          workspaceId: workspaceObjectId,
          name: { $regex: new RegExp(`^${escaped}$`, "i") },
        });
        if (!supplier) {
          supplier = await Supplier.create({
            workspaceId: workspaceObjectId,
            createdBy: new mongoose.Types.ObjectId(userId),
            name: supplierName,
            vatNumber: si.vat_number || undefined,
            siret: si.tin_number || undefined,
          });
        }

        const createdPurchase = await PurchaseInvoice.create({
          workspaceId: workspaceObjectId,
          createdBy: new mongoose.Types.ObjectId(userId),
          qontoId,
          source: "QONTO",
          status: mappedStatus,
          supplierId: supplier._id,
          supplierName,
          invoiceNumber,
          issueDate:
            toDate(si.issue_date) || toDate(si.created_at) || new Date(),
          dueDate: toDate(si.due_date) || undefined,
          paymentDate:
            si.status === "paid" ? toDate(si.payment_date) : undefined,
          amountHT,
          amountTVA,
          amountTTC,
          vatRate:
            amountHT > 0 ? Math.round((amountTVA / amountHT) * 10000) / 100 : 0,
          currency: si.total_amount?.currency || "EUR",
          description: si.description || undefined,
          files: [
            {
              filename: file.upload.key || file.fileName,
              originalFilename: file.fileName,
              mimetype: file.mimeType,
              path: file.upload.key,
              size: file.buffer.length,
              url: file.upload.url,
              ocrProcessed: false,
              ocrData: null,
            },
          ],
          ocrMetadata: {
            supplierName,
            supplierVatNumber: si.vat_number || undefined,
            amountHT,
            amountTVA,
            amountTTC,
          },
        });

        result.imported++;
        logger.info(
          `[QONTO-IMPORT] Facture fournisseur ${invoiceNumber} (${supplierName}) importée depuis Qonto (org=${workspaceId})`,
        );
        await notifyImported({
          userId,
          workspaceId,
          documentType: "PURCHASE_INVOICE",
          documentId: createdPurchase._id,
          documentNumber: invoiceNumber,
          counterpartName: supplierName,
          amountTTC,
          url: `/dashboard/outils/factures-achat?invoice=${createdPurchase._id}`,
        });
      } catch (error) {
        result.errors++;
        logger.error(
          `[QONTO-IMPORT] Facture fournisseur Qonto ${si.id}: ${error.message}`,
        );
      } finally {
        if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) {
          maxUpdatedAt = updatedAt;
        }
      }
    }

    page = nextPage;
  } while (page);

  if (maxUpdatedAt) account.importCursors.supplierInvoices = maxUpdatedAt;

  return result;
}

/**
 * Applique le statut Qonto d'un devis à son ImportedQuote :
 *  - approved  → conversion en vrai Quote accepté (COMPLETED, qontoId conservé)
 *  - canceled  → REJECTED
 * @returns {Promise<boolean>} true si le document a changé
 */
async function applyQontoQuoteStatus(doc, qontoStatus, userId) {
  if (qontoStatus === "approved" && doc.status === "PENDING_REVIEW") {
    const quote = await convertSingleImportedQuote(doc, userId);
    // Accepté côté Qonto → accepté côté Newbi (transition IMPORTED → COMPLETED,
    // la seule autorisée avec CANCELED pour un devis importé)
    await Quote.updateOne(
      { _id: quote._id },
      {
        $set: {
          status: "COMPLETED",
          qontoId: doc.qontoId,
          qontoSyncStatus: "SYNCED",
        },
      },
    );
    return true;
  }
  if (qontoStatus === "canceled" && doc.status !== "REJECTED") {
    doc.status = "REJECTED";
    await doc.save();
    return true;
  }
  return false;
}

/**
 * Notification « document importé » (best-effort) : alimente la cloche et
 * permet au front de rafraîchir la liste sans recharger la page.
 */
async function notifyImported({
  userId,
  workspaceId,
  documentType,
  documentId,
  documentNumber,
  counterpartName,
  amountTTC,
  url,
}) {
  try {
    const notification = await Notification.createDocumentImportedNotification({
      userId,
      workspaceId,
      documentType,
      documentId,
      documentNumber,
      source: "QONTO",
      counterpartName,
      amountTTC,
      url,
    });
    await publishNotification(notification);
  } catch (error) {
    logger.warn(
      `[QONTO-IMPORT] notification non envoyée (${documentType} ${documentNumber || documentId}): ${error.message}`,
    );
  }
}

function mapQuoteItems(items = []) {
  return items.map((it) => ({
    description: [it.title, it.description].filter(Boolean).join(" - "),
    quantity: num(it.quantity) || 1,
    unitPrice: num(it.unit_price),
    totalPrice: num(it.subtotal) || num(it.total_amount),
    vatRate: Math.round(num(it.vat_rate) * 10000) / 100,
  }));
}

/**
 * Importe les devis créés dans Qonto (→ devis importés) et suit le statut
 * des devis déjà importés (accepté / refusé).
 * L'endpoint /quotes n'a qu'un filtre created_at : curseur sur la création.
 */
export async function importQuotes(account, userId) {
  const credentials = account.getCredentials();
  const workspaceId = String(account.organizationId);
  const result = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  const since = account.importCursors?.quotes
    ? new Date(account.importCursors.quotes.getTime() - CURSOR_OVERLAP_MS)
    : null;

  let page = 1;
  let maxCreatedAt = account.importCursors?.quotes || null;
  let deferredMin = null;

  do {
    const { items, nextPage } = await qontoService.listQuotes(credentials, {
      createdAtFrom: since,
      page,
    });

    for (const q of items) {
      const createdAt = toDate(q.created_at);
      try {
        const qontoId = String(q.id);

        // Devis poussé par Newbi : ne jamais le réimporter
        const pushed = await Quote.exists({ workspaceId, qontoId });
        if (pushed) {
          result.skipped++;
          continue;
        }
        if (await ImportedQuote.exists({ workspaceId, qontoId })) {
          result.skipped++;
          continue;
        }

        const mappedStatus = QUOTE_STATUS_MAP[q.status];
        if (!mappedStatus || q.status === "canceled") {
          result.skipped++;
          continue;
        }

        if (!q.attachment_id) {
          if (!deferredMin || (createdAt && createdAt < deferredMin)) {
            deferredMin = createdAt || new Date();
          }
          result.skipped++;
          continue;
        }

        const file = await fetchAttachmentToR2(credentials, q.attachment_id, {
          workspaceId,
          userId,
          fallbackName: `devis-${q.number || q.id}`,
        });
        if (!file) {
          result.errors++;
          continue;
        }

        const totalTTC = num(q.total_amount);
        const totalVAT = num(q.vat_amount);
        const client = q.client || {};
        const billing = client.billing_address || {};

        const created = await ImportedQuote.create({
          workspaceId,
          importedBy: userId,
          qontoId,
          source: "QONTO",
          status: mappedStatus,
          originalQuoteNumber: q.number || null,
          vendor: { name: q.organization?.legal_name || "" },
          client: {
            name: clientDisplayName(client),
            address: billing.street_address || client.address || "",
            city: billing.city || client.city || "",
            postalCode: billing.zip_code || client.zip_code || "",
            siret: client.tax_identification_number || null,
          },
          quoteDate: toDate(q.issue_date) || createdAt,
          validUntil: toDate(q.expiry_date),
          totalHT: Math.round((totalTTC - totalVAT) * 100) / 100,
          totalVAT,
          totalTTC,
          currency: q.currency || "EUR",
          items: mapQuoteItems(q.items),
          file: {
            url: file.upload.url,
            cloudflareKey: file.upload.key,
            originalFileName: file.fileName,
            mimeType: file.mimeType,
            fileSize: file.buffer.length,
          },
        });

        result.imported++;
        logger.info(
          `[QONTO-IMPORT] Devis ${q.number || q.id} importé depuis Qonto (org=${workspaceId})`,
        );
        await notifyImported({
          userId,
          workspaceId,
          documentType: "QUOTE",
          documentId: created._id,
          documentNumber: q.number,
          counterpartName: clientDisplayName(client),
          amountTTC: totalTTC,
          url: "/dashboard/outils/devis",
        });

        // Déjà accepté côté Qonto : devient tout de suite un vrai devis
        if (q.status === "approved") {
          try {
            await applyQontoQuoteStatus(created, "approved", userId);
          } catch (error) {
            logger.warn(
              `[QONTO-IMPORT] Conversion du devis accepté ${q.number || q.id} impossible: ${error.message}`,
            );
          }
        }
      } catch (error) {
        result.errors++;
        logger.error(`[QONTO-IMPORT] Devis Qonto ${q.id}: ${error.message}`);
      } finally {
        if (createdAt && (!maxCreatedAt || createdAt > maxCreatedAt)) {
          maxCreatedAt = createdAt;
        }
      }
    }

    page = nextPage;
  } while (page);

  const cursor =
    deferredMin && (!maxCreatedAt || deferredMin < maxCreatedAt)
      ? deferredMin
      : maxCreatedAt;
  if (cursor) account.importCursors.quotes = cursor;

  // Suivi de statut des devis importés encore en attente (accepté / refusé)
  const pending = await ImportedQuote.find({
    workspaceId,
    source: "QONTO",
    status: "PENDING_REVIEW",
    qontoId: { $ne: null },
  })
    .sort({ createdAt: 1 })
    .limit(QUOTE_STATUS_REFRESH_LIMIT);

  for (const doc of pending) {
    try {
      const fresh = await qontoService.getQuote(credentials, doc.qontoId);
      if (await applyQontoQuoteStatus(doc, fresh?.status, userId)) {
        result.updated++;
        logger.info(
          `[QONTO-IMPORT] Devis ${doc.originalQuoteNumber || doc.qontoId} → ${fresh.status} (org=${workspaceId})`,
        );
        await notifyImported({
          userId,
          workspaceId,
          documentType: "QUOTE",
          documentId: doc._id,
          documentNumber: doc.originalQuoteNumber,
          counterpartName: doc.client?.name,
          amountTTC: doc.totalTTC,
          url: "/dashboard/outils/devis",
        });
      }
    } catch (error) {
      result.errors++;
      logger.warn(
        `[QONTO-IMPORT] Statut devis Qonto ${doc.qontoId}: ${error.message}`,
      );
    }
  }

  return result;
}

/**
 * Lance l'import Qonto → Newbi pour un compte (factures clients + fournisseurs
 * selon les préférences), met à jour curseurs et stats.
 *
 * @param {import("mongoose").Document} account - QontoAccount connecté
 * @param {string} userId - Utilisateur attribué aux documents créés
 * @param {Object} [options]
 * @param {boolean} [options.force] - Ignorer les préférences autoSync (import manuel)
 */
export async function importFromQonto(account, userId, { force = false } = {}) {
  const empty = { imported: 0, updated: 0, skipped: 0, errors: 0 };
  const results = {
    clientInvoices: { ...empty },
    supplierInvoices: { ...empty },
    quotes: { ...empty },
  };

  if (!account?.isConnected) {
    return { success: false, message: "Compte Qonto non connecté", results };
  }

  try {
    // Compte connecté avant l'introduction des curseurs : on démarre à
    // maintenant plutôt que d'importer tout l'historique Qonto.
    let initialized = false;
    for (const key of ["clientInvoices", "supplierInvoices", "quotes"]) {
      if (!account.importCursors?.[key]) {
        account.importCursors[key] = new Date();
        initialized = true;
      }
    }
    if (initialized) {
      logger.info(
        `[QONTO-IMPORT] Curseurs initialisés à maintenant pour org=${account.organizationId} (historique Qonto non importé)`,
      );
    }

    if (force || account.autoSync?.importClientInvoices) {
      results.clientInvoices = await importClientInvoices(account, userId);
    }
    if (force || account.autoSync?.importSupplierInvoices) {
      results.supplierInvoices = await importSupplierInvoices(account, userId);
    }
    if (force || account.autoSync?.importQuotes) {
      results.quotes = await importQuotes(account, userId);
    }

    account.stats.clientInvoicesImported += results.clientInvoices.imported;
    account.stats.supplierInvoicesImported += results.supplierInvoices.imported;
    account.stats.quotesImported += results.quotes.imported;
    account.lastImportAt = new Date();
    account.importError = null;
    await account.save();

    const total =
      results.clientInvoices.imported +
      results.supplierInvoices.imported +
      results.quotes.imported;
    const updated =
      results.clientInvoices.updated +
      results.supplierInvoices.updated +
      results.quotes.updated;
    const errors =
      results.clientInvoices.errors +
      results.supplierInvoices.errors +
      results.quotes.errors;

    return {
      success: true,
      results,
      message: `Import Qonto terminé : ${total} document${total > 1 ? "s" : ""} importé${total > 1 ? "s" : ""}${updated ? `, ${updated} mis à jour` : ""}${errors ? `, ${errors} erreur${errors > 1 ? "s" : ""}` : ""}`,
    };
  } catch (error) {
    account.importError = error.message;
    await account.save().catch(() => {});
    logger.error(
      `[QONTO-IMPORT] Échec import org=${account.organizationId}: ${error.message}`,
    );
    return { success: false, message: error.message, results };
  }
}

/**
 * Import pour toutes les organisations connectées (cron)
 * @param {(organizationId: string) => Promise<string|null>} resolveUserId
 */
export async function importAllFromQonto(resolveUserId) {
  const accounts = await QontoAccount.find({
    isConnected: true,
    $or: [
      { "autoSync.importClientInvoices": true },
      { "autoSync.importSupplierInvoices": true },
      { "autoSync.importQuotes": true },
    ],
  });

  let totalImported = 0;
  for (const account of accounts) {
    try {
      const userId = await resolveUserId(account.organizationId);
      if (!userId) {
        logger.warn(
          `[QONTO-IMPORT] aucun utilisateur pour l'org ${account.organizationId}, ignorée`,
        );
        continue;
      }
      const out = await importFromQonto(account, userId);
      const n =
        (out.results?.clientInvoices?.imported || 0) +
        (out.results?.supplierInvoices?.imported || 0) +
        (out.results?.quotes?.imported || 0);
      totalImported += n;
      if (n > 0 || !out.success) {
        logger.info(
          `[QONTO-IMPORT] org ${account.organizationId}: ${out.message}`,
        );
      }
    } catch (error) {
      logger.error(
        `[QONTO-IMPORT] échec org ${account.organizationId}: ${error.message}`,
      );
    }
  }
  return { accounts: accounts.length, totalImported };
}
