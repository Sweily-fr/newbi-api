import AbbyAccount from "../models/AbbyAccount.js";
import ImportedInvoice from "../models/ImportedInvoice.js";
import ImportedQuote from "../models/ImportedQuote.js";
import Quote from "../models/Quote.js";
import Notification from "../models/Notification.js";
import { cancelActiveQuoteSignatures } from "./quoteSignatureSync.js";
import documentAutomationService from "./documentAutomationService.js";
import { matchExistingClient } from "../utils/clientMatching.js";
import abbyService, {
  fromCents,
  fromTimestamp,
  mapVatCodeToRate,
} from "./abbyService.js";
import cloudflareService from "./cloudflareService.js";
import { convertSingleImportedQuote } from "../resolvers/importedQuote.js";
import { publishNotification } from "../resolvers/notification.js";
import logger from "../utils/logger.js";

/**
 * Sens Abby → Newbi.
 *
 * Abby n'expose pas de webhooks documentés : on interroge l'API par polling
 * (cron abbyImportCron + mutation importFromAbby). La liste des documents
 * (/v2/billings) ne se filtre pas par date de modification mais par date
 * d'émission : on relit une fenêtre glissante depuis le curseur, avec un
 * chevauchement, et on dédoublonne par `abbyId`.
 *
 *  - Factures finalisées / payées dans Abby → ImportedInvoice (ventes importées)
 *  - Devis finalisés dans Abby → ImportedQuote (devis importés), signé →
 *    converti en vrai devis accepté, refusé → rejeté
 *
 * Idempotent : chaque document Newbi porte l'`abbyId` d'origine.
 */

// Chevauchement sur le curseur (date d'émission) : un document antidaté ou
// finalisé tardivement reste visible pendant cette fenêtre
const CURSOR_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000;

const INVOICE_STATE_MAP = {
  finalized: "VALIDATED",
  paid: "COMPLETED",
};

// Statut ImportedQuote à la création (signé → converti ensuite en vrai Quote)
const QUOTE_STATE_MAP = {
  finalized: "PENDING_REVIEW",
  signed: "PENDING_REVIEW",
  refused: "REJECTED",
};

// Nombre max de devis importés relus par passage pour suivre leur statut
const QUOTE_STATUS_REFRESH_LIMIT = 50;

function toDate(value) {
  return fromTimestamp(value);
}

function safeFileName(name, fallback) {
  const base = String(name || fallback || "document").replace(
    /[^a-zA-Z0-9._-]/g,
    "-",
  );
  return /\.[a-z0-9]{2,4}$/i.test(base) ? base : `${base}.pdf`;
}

function customerDisplayName(customer = {}) {
  return (
    customer.name ||
    customer.commercialName ||
    `${customer.firstname || ""} ${customer.lastname || ""}`.trim() ||
    "Client Abby"
  );
}

function customerAddress(customer = {}) {
  const a = customer.billingAddress || {};
  return {
    address: a.line1 || a.address || "",
    city: a.city || "",
    postalCode: a.zipCode || "",
  };
}

function mapLines(lines = []) {
  return (lines || []).map((line) => ({
    description: [line.designation, line.description]
      .filter(Boolean)
      .join(" - "),
    quantity: Number(line.quantity) || 1,
    unitPrice: fromCents(line.unitPriceHT ?? line.unitPrice),
    totalPrice: fromCents(line.priceWithoutTaxAfterDiscount),
    vatRate: mapVatCodeToRate(line.vatCode),
  }));
}

function totalsOf(doc, detail) {
  const total = detail?.total || {};
  const totalHT = fromCents(
    total.amountWithoutTaxAfterDiscount ??
      doc.totalAmountWithoutTaxAfterDiscount,
  );
  const totalTTC = fromCents(
    total.amountWithTaxAfterDiscount ?? doc.totalAmountWithTaxAfterDiscount,
  );
  return {
    totalHT,
    totalTTC,
    totalVAT: Math.round((totalTTC - totalHT) * 100) / 100,
  };
}

/**
 * Télécharge le PDF Abby et le dépose sur R2 (bucket OCR, même destination
 * que les justificatifs uploadés à la main).
 */
async function fetchPdfToR2(
  apiKey,
  billingId,
  { workspaceId, userId, fallbackName },
) {
  const file = await abbyService.downloadPdf(apiKey, billingId, fallbackName);
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

async function notifyImported({
  userId,
  workspaceId,
  documentType,
  documentId,
  documentNumber,
  counterpartName,
  amountTTC,
  url,
  event = "IMPORTED",
}) {
  try {
    const notification = await Notification.createDocumentImportedNotification({
      userId,
      workspaceId,
      documentType,
      documentId,
      documentNumber,
      source: "ABBY",
      counterpartName,
      amountTTC,
      url,
      event,
    });
    await publishNotification(notification);
  } catch (error) {
    logger.warn(
      `[ABBY-IMPORT] notification non envoyée (${documentType} ${documentNumber || documentId}): ${error.message}`,
    );
  }
}

async function* iterateBillings(apiKey, { from, test, states }) {
  let page = 1;
  do {
    const { items, nextPage } = await abbyService.listBillings(apiKey, {
      from,
      test,
      states,
      page,
    });
    for (const item of items) yield item;
    page = nextPage;
  } while (page);
}

/**
 * Importe / met à jour les factures finalisées dans Abby
 */
export async function importClientInvoices(account, userId) {
  const apiKey = account.getDecryptedApiKey();
  const workspaceId = String(account.organizationId);
  const result = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  const cursor = account.importCursors?.clientInvoices || new Date();
  const from = new Date(cursor.getTime() - CURSOR_OVERLAP_MS);
  let maxEmittedAt = cursor;

  for await (const doc of iterateBillings(apiKey, {
    from,
    test: account.isTestMode,
    states: ["finalized", "paid"],
  })) {
    if (doc.type !== "invoice") continue;
    const emittedAt = toDate(doc.emittedAt);
    try {
      const abbyId = String(doc.id);
      const mappedStatus = INVOICE_STATE_MAP[doc.state];
      if (!mappedStatus) {
        result.skipped++;
        continue;
      }

      const existing = await ImportedInvoice.findOne({ workspaceId, abbyId });
      if (existing) {
        let changed = false;
        if (
          existing.status !== mappedStatus &&
          !["ARCHIVED", "REJECTED"].includes(existing.status)
        ) {
          existing.status = mappedStatus;
          changed = true;
        }
        const paidAt = toDate(doc.paidAt);
        if (paidAt && !existing.paymentDate) {
          existing.paymentDate = paidAt;
          changed = true;
        }
        if (changed) {
          await existing.save();
          result.updated++;
          if (mappedStatus === "COMPLETED") {
            await notifyImported({
              userId,
              workspaceId,
              documentType: "INVOICE",
              documentId: existing._id,
              documentNumber: existing.originalInvoiceNumber,
              counterpartName: existing.client?.name,
              amountTTC: existing.totalTTC,
              url: "/dashboard/outils/factures",
              event: "PAID",
            });
          }
        } else {
          result.skipped++;
        }
        continue;
      }

      const detail = await abbyService.getBilling(apiKey, abbyId);
      const file = await fetchPdfToR2(apiKey, abbyId, {
        workspaceId,
        userId,
        fallbackName: `facture-${doc.number || abbyId}`,
      });
      if (!file) {
        result.errors++;
        continue;
      }

      const customer = detail?.customer || doc.customer || {};
      const clientName = customerDisplayName(customer);
      const email = customer.emails?.[0] || null;
      const siret = customer.siret || null;
      const matchedClient = await matchExistingClient(workspaceId, {
        name: clientName,
        email,
        siret,
      }).catch(() => null);
      const totals = totalsOf(doc, detail);
      const addr = customerAddress(customer);

      const created = await ImportedInvoice.create({
        workspaceId,
        importedBy: userId,
        abbyId,
        source: "ABBY",
        status: mappedStatus,
        originalInvoiceNumber: doc.number || detail?.number || null,
        vendor: { name: account.companyName || "" },
        client: {
          id: matchedClient ? String(matchedClient._id) : null,
          name: clientName,
          email,
          address: addr.address,
          city: addr.city,
          postalCode: addr.postalCode,
          siret,
        },
        invoiceDate: emittedAt || toDate(doc.createdAt),
        dueDate: toDate(doc.dueAt ?? detail?.dueAt),
        paymentDate: toDate(doc.paidAt ?? detail?.paidAt),
        totalHT: totals.totalHT,
        totalVAT: totals.totalVAT,
        totalTTC: totals.totalTTC,
        currency: doc.currencyCode || detail?.currencyCode || "EUR",
        items: mapLines(detail?.lines),
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
        `[ABBY-IMPORT] Facture ${doc.number || abbyId} importée depuis Abby (org=${workspaceId})`,
      );
      await notifyImported({
        userId,
        workspaceId,
        documentType: "INVOICE",
        documentId: created._id,
        documentNumber: doc.number,
        counterpartName: clientName,
        amountTTC: totals.totalTTC,
        url: "/dashboard/outils/factures",
      });
    } catch (error) {
      result.errors++;
      logger.error(`[ABBY-IMPORT] Facture Abby ${doc.id}: ${error.message}`);
    } finally {
      if (emittedAt && emittedAt > maxEmittedAt) maxEmittedAt = emittedAt;
    }
  }

  account.importCursors.clientInvoices = maxEmittedAt;
  return result;
}

/**
 * Devis importé : signé dans Abby → converti en vrai devis accepté,
 * refusé → rejeté. Renvoie true si quelque chose a changé.
 */
async function applyAbbyQuoteState(doc, state, userId) {
  if (state === "signed" && doc.status === "PENDING_REVIEW") {
    const quote = await convertSingleImportedQuote(doc, userId);
    await Quote.updateOne(
      { _id: quote._id },
      { $set: { status: "COMPLETED" } },
    );
    return true;
  }
  if (state === "refused" && doc.status !== "REJECTED") {
    doc.status = "REJECTED";
    await doc.save();
    return true;
  }
  return false;
}

/**
 * Décision du client prise dans Abby sur un devis envoyé depuis Newbi :
 * signé → accepté, refusé → annulé (mêmes effets qu'une décision manuelle).
 */
async function applyPushedQuoteDecision(quote, state, { workspaceId, userId }) {
  if (quote.status !== "PENDING") return false;
  const decision =
    state === "signed" ? "COMPLETED" : state === "refused" ? "CANCELED" : null;
  if (!decision) return false;

  quote.status = decision;
  await quote.save();
  logger.info(
    `[ABBY-IMPORT] Devis ${quote.prefix || ""}${quote.number} ${decision === "COMPLETED" ? "signé" : "refusé"} dans Abby (org=${workspaceId})`,
  );

  cancelActiveQuoteSignatures(quote._id).catch((err) =>
    logger.warn(`[ABBY-IMPORT] annulation signatures devis: ${err.message}`),
  );
  documentAutomationService
    .executeAutomations(
      decision === "COMPLETED" ? "QUOTE_ACCEPTED" : "QUOTE_CANCELED",
      workspaceId,
      {
        documentId: quote._id.toString(),
        documentType: "quote",
        documentNumber: quote.number,
        prefix: quote.prefix || "",
        clientName: quote.client?.name || "",
        issueDate: quote.issueDate || quote.createdAt,
        clientId: quote.client?._id || quote.clientId || null,
      },
      userId,
    )
    .catch((err) =>
      logger.error(`[ABBY-IMPORT] automatisations devis: ${err.message}`),
    );
  return true;
}

/**
 * Importe les devis finalisés dans Abby et suit le statut des devis déjà
 * importés (signé / refusé)
 */
export async function importQuotes(account, userId) {
  const apiKey = account.getDecryptedApiKey();
  const workspaceId = String(account.organizationId);
  const result = { imported: 0, updated: 0, skipped: 0, errors: 0 };

  const cursor = account.importCursors?.quotes || new Date();
  const from = new Date(cursor.getTime() - CURSOR_OVERLAP_MS);
  let maxEmittedAt = cursor;

  for await (const doc of iterateBillings(apiKey, {
    from,
    test: account.isTestMode,
    states: ["finalized", "signed", "refused"],
  })) {
    if (doc.type !== "estimate") continue;
    const emittedAt = toDate(doc.emittedAt);
    try {
      const abbyId = String(doc.id);

      // Devis poussé par Newbi : jamais réimporté, mais la décision du client
      // prise dans Abby (signé / refusé) est répercutée sur le devis Newbi.
      const pushed = await Quote.findOne({ workspaceId, abbyId });
      if (pushed) {
        if (
          await applyPushedQuoteDecision(pushed, doc.state, {
            workspaceId,
            userId,
          })
        ) {
          result.updated++;
          await notifyImported({
            userId,
            workspaceId,
            documentType: "QUOTE",
            documentId: pushed._id,
            documentNumber: `${pushed.prefix || ""}${pushed.number || ""}`,
            counterpartName: pushed.client?.name,
            amountTTC: pushed.finalTotalTTC,
            url: "/dashboard/outils/devis",
            event: pushed.status === "COMPLETED" ? "ACCEPTED" : "REFUSED",
          });
        } else {
          result.skipped++;
        }
        continue;
      }

      const existing = await ImportedQuote.findOne({ workspaceId, abbyId });
      if (existing) {
        if (await applyAbbyQuoteState(existing, doc.state, userId)) {
          result.updated++;
          await notifyImported({
            userId,
            workspaceId,
            documentType: "QUOTE",
            documentId: existing._id,
            documentNumber: existing.originalQuoteNumber,
            counterpartName: existing.client?.name,
            amountTTC: existing.totalTTC,
            url: "/dashboard/outils/devis",
            event: doc.state === "signed" ? "ACCEPTED" : "REFUSED",
          });
        } else {
          result.skipped++;
        }
        continue;
      }

      const mappedStatus = QUOTE_STATE_MAP[doc.state];
      if (!mappedStatus || doc.state === "refused") {
        result.skipped++;
        continue;
      }

      const detail = await abbyService.getBilling(apiKey, abbyId);
      const file = await fetchPdfToR2(apiKey, abbyId, {
        workspaceId,
        userId,
        fallbackName: `devis-${doc.number || abbyId}`,
      });
      if (!file) {
        result.errors++;
        continue;
      }

      const customer = detail?.customer || doc.customer || {};
      const totals = totalsOf(doc, detail);
      const addr = customerAddress(customer);

      const created = await ImportedQuote.create({
        workspaceId,
        importedBy: userId,
        abbyId,
        source: "ABBY",
        status: mappedStatus,
        originalQuoteNumber: doc.number || detail?.number || null,
        vendor: { name: account.companyName || "" },
        client: {
          name: customerDisplayName(customer),
          address: addr.address,
          city: addr.city,
          postalCode: addr.postalCode,
          siret: customer.siret || null,
        },
        quoteDate: emittedAt || toDate(doc.createdAt),
        validUntil: toDate(doc.expiredAt ?? detail?.expiredAt),
        totalHT: totals.totalHT,
        totalVAT: totals.totalVAT,
        totalTTC: totals.totalTTC,
        currency: doc.currencyCode || detail?.currencyCode || "EUR",
        items: mapLines(detail?.lines),
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
        `[ABBY-IMPORT] Devis ${doc.number || abbyId} importé depuis Abby (org=${workspaceId})`,
      );
      await notifyImported({
        userId,
        workspaceId,
        documentType: "QUOTE",
        documentId: created._id,
        documentNumber: doc.number,
        counterpartName: customerDisplayName(customer),
        amountTTC: totals.totalTTC,
        url: "/dashboard/outils/devis",
      });

      // Déjà signé côté Abby : devient tout de suite un vrai devis accepté
      if (doc.state === "signed") {
        try {
          await applyAbbyQuoteState(created, "signed", userId);
        } catch (error) {
          logger.warn(
            `[ABBY-IMPORT] Conversion du devis signé ${doc.number || abbyId} impossible: ${error.message}`,
          );
        }
      }
    } catch (error) {
      result.errors++;
      logger.error(`[ABBY-IMPORT] Devis Abby ${doc.id}: ${error.message}`);
    } finally {
      if (emittedAt && emittedAt > maxEmittedAt) maxEmittedAt = emittedAt;
    }
  }

  account.importCursors.quotes = maxEmittedAt;

  // Devis importés encore en attente, émis avant la fenêtre : relecture unitaire
  const pending = await ImportedQuote.find({
    workspaceId,
    source: "ABBY",
    status: "PENDING_REVIEW",
    abbyId: { $ne: null },
    quoteDate: { $lt: from },
  })
    .sort({ createdAt: 1 })
    .limit(QUOTE_STATUS_REFRESH_LIMIT);

  for (const doc of pending) {
    try {
      const fresh = await abbyService.getBilling(apiKey, doc.abbyId);
      if (await applyAbbyQuoteState(doc, fresh?.state, userId)) {
        result.updated++;
        await notifyImported({
          userId,
          workspaceId,
          documentType: "QUOTE",
          documentId: doc._id,
          documentNumber: doc.originalQuoteNumber,
          counterpartName: doc.client?.name,
          amountTTC: doc.totalTTC,
          url: "/dashboard/outils/devis",
          event: fresh.state === "signed" ? "ACCEPTED" : "REFUSED",
        });
      }
    } catch (error) {
      result.errors++;
      logger.warn(
        `[ABBY-IMPORT] Statut devis Abby ${doc.abbyId}: ${error.message}`,
      );
    }
  }

  return result;
}

/**
 * Lance l'import Abby → Newbi pour un compte (factures + devis selon les
 * préférences), met à jour curseurs et stats.
 *
 * @param {import("mongoose").Document} account - AbbyAccount connecté
 * @param {string} userId - Utilisateur attribué aux documents créés
 * @param {Object} [options]
 * @param {boolean} [options.force] - Ignorer les préférences autoSync (import manuel)
 */
export async function importFromAbby(account, userId, { force = false } = {}) {
  const empty = { imported: 0, updated: 0, skipped: 0, errors: 0 };
  const results = { clientInvoices: { ...empty }, quotes: { ...empty } };

  if (!account?.isConnected) {
    return { success: false, message: "Compte Abby non connecté", results };
  }

  try {
    // Compte connecté sans curseur : on démarre à maintenant plutôt que
    // d'importer tout l'historique Abby.
    for (const key of ["clientInvoices", "quotes"]) {
      if (!account.importCursors?.[key]) {
        account.importCursors[key] = new Date();
      }
    }

    if (force || account.autoSync?.importClientInvoices) {
      results.clientInvoices = await importClientInvoices(account, userId);
    }
    if (force || account.autoSync?.importQuotes) {
      results.quotes = await importQuotes(account, userId);
    }

    account.stats.clientInvoicesImported += results.clientInvoices.imported;
    account.stats.quotesImported += results.quotes.imported;
    account.lastImportAt = new Date();
    account.importError = null;
    await account.save();

    const total = results.clientInvoices.imported + results.quotes.imported;
    const updated = results.clientInvoices.updated + results.quotes.updated;
    const errors = results.clientInvoices.errors + results.quotes.errors;

    return {
      success: true,
      results,
      message: `Import Abby terminé : ${total} document${total > 1 ? "s" : ""} importé${total > 1 ? "s" : ""}${updated ? `, ${updated} mis à jour` : ""}${errors ? `, ${errors} erreur${errors > 1 ? "s" : ""}` : ""}`,
    };
  } catch (error) {
    account.importError = error.message;
    await account.save().catch(() => {});
    logger.error(
      `[ABBY-IMPORT] Échec import org=${account.organizationId}: ${error.message}`,
    );
    return { success: false, message: error.message, results };
  }
}

/**
 * Import pour toutes les organisations connectées (cron)
 * @param {(organizationId: string) => Promise<string|null>} resolveUserId
 */
export async function importAllFromAbby(resolveUserId) {
  const accounts = await AbbyAccount.find({
    isConnected: true,
    $or: [
      { "autoSync.importClientInvoices": true },
      { "autoSync.importQuotes": true },
    ],
  });

  let totalImported = 0;
  for (const account of accounts) {
    try {
      const userId = await resolveUserId(account.organizationId);
      if (!userId) {
        logger.warn(
          `[ABBY-IMPORT] aucun utilisateur pour l'org ${account.organizationId}, ignorée`,
        );
        continue;
      }
      const out = await importFromAbby(account, userId);
      const n =
        (out.results?.clientInvoices?.imported || 0) +
        (out.results?.quotes?.imported || 0);
      totalImported += n;
      if (n > 0 || !out.success) {
        logger.info(
          `[ABBY-IMPORT] org ${account.organizationId}: ${out.message}`,
        );
      }
    } catch (error) {
      logger.error(
        `[ABBY-IMPORT] échec org ${account.organizationId}: ${error.message}`,
      );
    }
  }
  return { accounts: accounts.length, totalImported };
}
