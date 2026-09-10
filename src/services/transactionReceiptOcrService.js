import logger from "../utils/logger.js";
import mongoose from "mongoose";
import claudeVisionOcrService from "./claudeVisionOcrService.js";
import hybridOcrService from "./hybridOcrService.js";
import mistralIntelligentAnalysisService from "./mistralIntelligentAnalysisService.js";
import Transaction from "../models/Transaction.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import { syncLinkedTransactionCategories } from "../utils/purchaseInvoiceCategorySync.js";
import { findPurchaseInvoiceDuplicates } from "../utils/purchaseInvoiceDuplicates.js";
import crypto from "crypto";

/**
 * Service de création automatique de factures d'achat depuis les justificatifs
 * de transactions bancaires de type dépense.
 *
 * Déclenché en fire-and-forget après uploadTransactionReceipt (avec les buffers
 * des fichiers encore en mémoire) et après updateTransaction (sans buffers :
 * l'OCR passe alors par l'URL R2 du justificatif).
 *
 * Pour chaque justificatif non encore traité (receiptFiles[].ocrProcessed):
 *   1. OCR (Claude Vision en direct si buffer disponible, sinon pipeline
 *      hybride depuis l'URL Cloudflare)
 *   2. Création d'une PurchaseInvoice (source OCR, statut PAID car le débit
 *      bancaire a déjà eu lieu) avec le justificatif attaché et ocrMetadata
 *   3. Liaison bidirectionnelle transaction <-> facture (rapprochement matched)
 *
 * Si l'OCR échoue, la facture est quand même créée à partir des données de la
 * transaction (fournisseur = libellé, TTC = |montant|) pour ne pas perdre le
 * rattachement du justificatif.
 */

const VALID_PI_CATEGORIES = new Set(
  Object.values(PurchaseInvoice.PURCHASE_INVOICE_CATEGORY),
);

// Délai au-delà duquel un claim OCR sans facture produite est considéré
// comme interrompu (crash/restart) et redevient traitable
const STALE_CLAIM_MS = 15 * 60 * 1000;

// expenseCategory (Transaction) -> category (PurchaseInvoice)
const EXPENSE_TO_PI_CATEGORY = {
  OFFICE_SUPPLIES: "OFFICE_SUPPLIES",
  TRAVEL: "TRANSPORT",
  MEALS: "MEALS",
  ACCOMMODATION: "TRANSPORT",
  SOFTWARE: "SOFTWARE",
  HARDWARE: "HARDWARE",
  SERVICES: "SERVICES",
  MARKETING: "MARKETING",
  TAXES: "TAXES",
  RENT: "RENT",
  UTILITIES: "UTILITIES",
  SALARIES: "SERVICES",
  INSURANCE: "INSURANCE",
  MAINTENANCE: "MAINTENANCE",
  TRAINING: "TRAINING",
  SUBSCRIPTIONS: "SUBSCRIPTIONS",
  OTHER: "OTHER",
};

const PAYMENT_METHOD_MAP = {
  card: "CREDIT_CARD",
  credit_card: "CREDIT_CARD",
  carte: "CREDIT_CARD",
  cb: "CREDIT_CARD",
  transfer: "BANK_TRANSFER",
  bank_transfer: "BANK_TRANSFER",
  virement: "BANK_TRANSFER",
  direct_debit: "DIRECT_DEBIT",
  prelevement: "DIRECT_DEBIT",
  check: "CHECK",
  cheque: "CHECK",
  cash: "CASH",
  especes: "CASH",
};

function isExpenseTransaction(transaction) {
  if (!transaction) return false;
  if (typeof transaction.amount === "number" && transaction.amount < 0) {
    return true;
  }
  return transaction.type === "debit";
}

function parseOcrDate(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  const str = String(value).trim();
  // Format français DD/MM/YYYY (ou DD-MM-YYYY, DD.MM.YYYY)
  const frMatch = str.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (frMatch) {
    const [, day, month, year] = frMatch;
    const d = new Date(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00.000Z`,
    );
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function toPositiveNumber(value) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (typeof n !== "number" || isNaN(n) || n <= 0) return null;
  return n;
}

function toNonNegativeNumber(value) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (typeof n !== "number" || isNaN(n) || n < 0) return null;
  return n;
}

const CURRENCY_SYMBOLS = { "€": "EUR", $: "USD", US$: "USD", "£": "GBP" };

function normalizeCurrency(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (CURRENCY_SYMBOLS[raw]) return CURRENCY_SYMBOLS[raw];
  const code = raw.toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Montants retenus pour la facture d'achat créée depuis un justificatif.
 *
 * Par défaut ce sont les montants lus par l'OCR sur le justificatif. Mais si
 * celui-ci est libellé dans une autre devise que le compte bancaire (facture
 * MongoDB en USD payée depuis un compte en EUR), le montant lu ne correspond
 * pas à la dépense réelle : c'est le débit bancaire, déjà converti par la
 * banque, qui fait foi. La facture est alors enregistrée dans la devise du
 * compte, HT et TVA sont ramenés au prorata, et le montant d'origine est
 * conservé dans `conversion` (repris dans ocrMetadata et les notes).
 */
function resolveReceiptAmounts({ transaction, financial }) {
  const td = financial?.transaction_data || {};
  const totals = financial?.extracted_fields?.totals || {};

  const ocrTTC =
    toPositiveNumber(td.amount) || toPositiveNumber(totals.total_ttc) || null;
  const ocrHT =
    toPositiveNumber(td.amount_ht) || toPositiveNumber(totals.total_ht) || 0;
  const ocrTVA =
    toPositiveNumber(td.tax_amount) || toPositiveNumber(totals.total_tax) || 0;
  const ocrCurrency = normalizeCurrency(td.currency);
  const txCurrency = normalizeCurrency(transaction?.currency) || "EUR";
  const txAmount =
    typeof transaction?.amount === "number" ? Math.abs(transaction.amount) : 0;

  // Un taux de 0 % est valide (autoliquidation, franchise...) : ne pas
  // l'écraser par le défaut. À défaut de taux extrait, on le dérive des
  // montants, et en dernier recours 20 %.
  const extractedVatRate = toNonNegativeNumber(td.tax_rate);
  const vatRate =
    extractedVatRate !== null
      ? extractedVatRate
      : ocrHT > 0
        ? Math.round((ocrTVA / ocrHT) * 10000) / 100
        : 20;

  const foreignCurrency =
    Boolean(ocrCurrency) &&
    ocrCurrency !== txCurrency &&
    ocrTTC > 0 &&
    txAmount > 0;

  if (foreignCurrency) {
    const ratio = txAmount / ocrTTC;
    const amountHT = ocrHT > 0 ? round2(ocrHT * ratio) : 0;
    const amountTVA =
      ocrTVA > 0
        ? amountHT > 0
          ? round2(Math.max(txAmount - amountHT, 0))
          : round2(ocrTVA * ratio)
        : 0;
    return {
      amountTTC: txAmount,
      amountHT,
      amountTVA,
      vatRate,
      currency: txCurrency,
      conversion: { originalAmountTTC: ocrTTC, originalCurrency: ocrCurrency },
    };
  }

  return {
    amountTTC: ocrTTC || txAmount || null,
    amountHT: ocrHT,
    amountTVA: ocrTVA,
    vatRate,
    currency: ocrCurrency || txCurrency,
    conversion: null,
  };
}

function mapCategory(ocrCategory, transactionExpenseCategory) {
  if (ocrCategory && VALID_PI_CATEGORIES.has(ocrCategory)) return ocrCategory;
  if (
    transactionExpenseCategory &&
    EXPENSE_TO_PI_CATEGORY[transactionExpenseCategory]
  ) {
    return EXPENSE_TO_PI_CATEGORY[transactionExpenseCategory];
  }
  return "OTHER";
}

function mapPaymentMethod(ocrPaymentMethod, transactionPaymentMethod) {
  const candidates = [ocrPaymentMethod, transactionPaymentMethod];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const normalized = String(candidate).toLowerCase().trim();
    if (PAYMENT_METHOD_MAP[normalized]) return PAYMENT_METHOD_MAP[normalized];
    if (
      Object.values(PurchaseInvoice.PAYMENT_METHOD).includes(
        String(candidate).toUpperCase(),
      )
    ) {
      return String(candidate).toUpperCase();
    }
  }
  return "OTHER";
}

/**
 * OCR d'un justificatif : Claude Vision direct (base64) si le buffer est
 * disponible, sinon pipeline hybride depuis l'URL Cloudflare.
 * @returns {{ financial: object|null, extractedText: string|null }}
 */
async function runOcr(receiptFile, fileBuffer, workspaceId) {
  // Tentative 1 : Claude Vision direct depuis le buffer
  if (fileBuffer) {
    try {
      const contentHash = crypto
        .createHash("sha256")
        .update(fileBuffer)
        .digest("hex");
      const rawResult = await claudeVisionOcrService.processFromBase64(
        fileBuffer.toString("base64"),
        receiptFile.mimetype,
        receiptFile.filename,
        contentHash,
        { useBatchModel: true },
      );
      if (!rawResult.success) {
        throw new Error(rawResult.error || rawResult.message || "OCR échoué");
      }
      const structured = claudeVisionOcrService.toInvoiceFormat(rawResult);
      return {
        financial: {
          transaction_data: structured.transaction_data,
          extracted_fields: structured.extracted_fields,
          document_analysis: structured.document_analysis,
        },
        extractedText: rawResult.extractedText || null,
      };
    } catch (error) {
      logger.warn(
        `⚠️ [RECEIPT OCR] Claude Vision échoué pour ${receiptFile.filename}: ${error.message}`,
      );
    }
  }

  // Tentative 2 : pipeline hybride depuis l'URL R2
  const hybridResult = await hybridOcrService.processDocumentFromUrl(
    receiptFile.url,
    receiptFile.filename,
    receiptFile.mimetype,
    workspaceId,
  );
  if (!hybridResult.success) {
    throw new Error(hybridResult.error || "OCR hybride échoué");
  }

  let financial;
  if (hybridResult.provider === "claude-vision") {
    financial = {
      transaction_data: hybridResult.transaction_data,
      extracted_fields: hybridResult.extracted_fields,
      document_analysis: hybridResult.document_analysis,
    };
  } else {
    financial =
      await mistralIntelligentAnalysisService.analyzeDocument(hybridResult);
  }

  return {
    financial,
    extractedText: hybridResult.extractedText || hybridResult.text || null,
  };
}

async function findOrCreateSupplier(
  supplierName,
  workspaceId,
  userId,
  category,
) {
  let supplier = await Supplier.findOne({
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    name: {
      $regex: `^${supplierName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      $options: "i",
    },
  });

  if (!supplier) {
    supplier = await Supplier.create({
      name: supplierName,
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
      createdBy: userId,
      defaultCategory: category || "OTHER",
    });
  }
  return supplier;
}

/**
 * Crée la facture d'achat pour un justificatif donné et lie la transaction.
 */
async function createPurchaseInvoiceFromReceipt({
  transaction,
  receiptFile,
  financial,
  extractedText,
  ocrSucceeded,
  workspaceId,
  userId,
}) {
  const td = financial?.transaction_data || {};
  const ef = financial?.extracted_fields || {};

  const supplierName =
    td.vendor_name ||
    td.supplier_name ||
    transaction.metadata?.vendor ||
    transaction.description ||
    "Fournisseur inconnu";

  const { amountTTC, amountHT, amountTVA, vatRate, currency, conversion } =
    resolveReceiptAmounts({ transaction, financial });

  if (!amountTTC) {
    throw new Error(
      "Impossible de déterminer le montant TTC (OCR et transaction)",
    );
  }

  const conversionNote = conversion
    ? ` Montant du justificatif : ${conversion.originalAmountTTC.toFixed(2)} ${conversion.originalCurrency}, débit bancaire retenu : ${amountTTC.toFixed(2)} ${currency}.`
    : "";
  const category = mapCategory(td.category, transaction.expenseCategory);
  const issueDate =
    parseOcrDate(td.transaction_date || td.invoice_date) ||
    transaction.date ||
    new Date();

  const invoice = new PurchaseInvoice({
    supplierName,
    invoiceNumber: td.document_number || td.invoice_number || undefined,
    issueDate,
    dueDate: parseOcrDate(td.due_date) || undefined,
    amountHT,
    amountTVA,
    vatRate,
    amountTTC,
    currency,
    // Le débit bancaire a déjà eu lieu : la facture est payée et rapprochée
    status: "PAID",
    paymentDate: transaction.date || new Date(),
    paymentMethod: mapPaymentMethod(
      td.payment_method,
      transaction.metadata?.paymentMethod,
    ),
    category,
    source: "OCR",
    notes: `Créée automatiquement depuis le justificatif de la transaction "${transaction.description || transaction.externalId || transaction._id}".${conversionNote}`,
    workspaceId: new mongoose.Types.ObjectId(workspaceId),
    createdBy: userId,
    linkedTransactionIds: [transaction._id],
    isReconciled: true,
    files: [
      {
        filename: receiptFile.filename,
        originalFilename: receiptFile.filename,
        mimetype: receiptFile.mimetype,
        path: receiptFile.key,
        size: receiptFile.size,
        url: receiptFile.url,
        ocrProcessed: ocrSucceeded,
        ocrData: financial || null,
      },
    ],
    ocrMetadata: ocrSucceeded
      ? {
          supplierName: td.vendor_name || td.supplier_name || undefined,
          supplierAddress: ef.vendor_address || undefined,
          supplierVatNumber: ef.vendor_vat_number || undefined,
          supplierSiret: ef.vendor_siret || undefined,
          invoiceNumber: td.document_number || td.invoice_number || undefined,
          invoiceDate: parseOcrDate(td.transaction_date || td.invoice_date),
          dueDate: parseOcrDate(td.due_date),
          amountHT: toPositiveNumber(td.amount_ht),
          amountTVA: toPositiveNumber(td.tax_amount),
          vatRate: toNonNegativeNumber(td.tax_rate),
          // Montant et devise tels que lus sur le justificatif (avant
          // éventuelle substitution par le débit bancaire converti)
          amountTTC: toPositiveNumber(td.amount),
          currency: normalizeCurrency(td.currency) || undefined,
          confidenceScore:
            typeof financial?.document_analysis?.confidence === "number" &&
            financial.document_analysis.confidence >= 0 &&
            financial.document_analysis.confidence <= 1
              ? financial.document_analysis.confidence
              : undefined,
          rawExtractedText: extractedText
            ? String(extractedText).slice(0, 50000)
            : undefined,
        }
      : {},
  });

  try {
    const supplier = await findOrCreateSupplier(
      supplierName,
      workspaceId,
      userId,
      category,
    );
    invoice.supplierId = supplier._id;
  } catch (supplierError) {
    // Nom invalide pour le schéma Supplier (ex: < 2 ou > 100 caractères) :
    // la facture est créée sans fournisseur lié
    logger.warn(
      `⚠️ [RECEIPT OCR] Fournisseur non créé ("${supplierName}"): ${supplierError.message}`,
    );
  }

  await invoice.save();
  return invoice;
}

/**
 * Facture d'achat existante à laquelle rattacher le justificatif plutôt que
 * d'en créer une nouvelle (une facture Qonto mensuelle couvre plusieurs
 * prélèvements ; une facture saisie à la main puis son justificatif déposé
 * sur la transaction ne doit pas donner deux factures).
 *
 * - OCR réussi : recherche par numéro / fournisseur / montant / date, en
 *   privilégiant les factures déjà liées à la transaction.
 * - OCR échoué : aucune donnée fiable ; si la transaction porte déjà une
 *   facture d'achat, le justificatif lui est rattaché (créer une facture
 *   "fallback" au montant de la transaction doublerait la dépense).
 */
async function findExistingPurchaseInvoiceForReceipt({
  transaction,
  financial,
  ocrSucceeded,
  workspaceId,
}) {
  const linkedIds = transaction.linkedPurchaseInvoiceIds || [];

  if (!ocrSucceeded) {
    if (linkedIds.length === 0) return null;
    return PurchaseInvoice.findOne({
      _id: { $in: linkedIds },
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    }).sort({ createdAt: -1 });
  }

  const td = financial?.transaction_data || {};
  // Même montant que celui qui serait enregistré sur la facture : en devise
  // étrangère, une facture déjà créée porte le débit bancaire converti.
  const { amountTTC } = resolveReceiptAmounts({ transaction, financial });
  const candidates = await findPurchaseInvoiceDuplicates({
    workspaceId,
    supplierName: td.vendor_name || td.supplier_name || null,
    invoiceNumber: td.document_number || td.invoice_number || null,
    amountTTC: amountTTC || null,
    issueDate: parseOcrDate(td.transaction_date || td.invoice_date) || null,
    preferIds: linkedIds,
    limit: 1,
  });
  return candidates[0] || null;
}

/**
 * Rattache un justificatif à une facture d'achat existante : fichier ajouté
 * à la facture (sans doublon de clé R2), facture marquée payée/rapprochée,
 * lien N↔N avec la transaction.
 */
async function attachReceiptToExistingPurchaseInvoice({
  invoice,
  transaction,
  receiptFile,
  financial,
  ocrSucceeded,
  workspaceId,
}) {
  const alreadyHasFile = (invoice.files || []).some(
    (f) => f.path === receiptFile.key || f.url === receiptFile.url,
  );

  const nextStatus = ["TO_PROCESS", "TO_PAY", "PENDING", "OVERDUE"].includes(
    invoice.status,
  )
    ? "PAID"
    : invoice.status;
  const paymentDate = invoice.paymentDate || transaction.date || new Date();

  const update = {
    $set: { isReconciled: true, status: nextStatus, paymentDate },
    $addToSet: { linkedTransactionIds: transaction._id },
  };
  if (!alreadyHasFile) {
    update.$push = {
      files: {
        filename: receiptFile.filename,
        originalFilename: receiptFile.filename,
        mimetype: receiptFile.mimetype,
        path: receiptFile.key,
        size: receiptFile.size,
        url: receiptFile.url,
        ocrProcessed: ocrSucceeded,
        ocrData: financial || null,
      },
    };
  }

  // Update ciblé (pas de save()) : ne revalide pas tout le document, des
  // factures legacy peuvent avoir des champs hors enum.
  return PurchaseInvoice.findOneAndUpdate(
    { _id: invoice._id, workspaceId: new mongoose.Types.ObjectId(workspaceId) },
    update,
    { new: true },
  );
}

/**
 * Point d'entrée : traite les justificatifs non encore traités d'une
 * transaction dépense et crée les factures d'achat correspondantes.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} params.workspaceId
 * @param {string} params.userId
 * @param {Object<string, Buffer>} [params.buffersByKey] buffers des fichiers
 *   fraîchement uploadés, indexés par clé R2 (évite un re-téléchargement)
 * @returns {Promise<Array>} factures créées ou rattachées (une par justificatif)
 */
async function processReceiptsForTransaction({
  transactionId,
  workspaceId,
  userId,
  buffersByKey = {},
}) {
  const transaction = await Transaction.findOne({
    _id: transactionId,
    workspaceId,
  });

  if (!transaction || !isExpenseTransaction(transaction)) {
    return [];
  }

  // Transaction volontairement ignorée du rapprochement : on respecte le
  // choix de l'utilisateur, pas de rapprochement automatique
  if (transaction.reconciliationStatus === "ignored") {
    return [];
  }

  // Transaction déjà rapprochée à une facture d'achat : on traite quand même
  // les nouveaux justificatifs (plusieurs factures par transaction), la
  // déduplication ci-dessous évite de recréer une facture existante.

  // Un claim est périmé s'il a été posé il y a longtemps sans jamais aboutir
  // à une facture (crash/restart PM2 pendant l'OCR) : on le retraite.
  const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const isPending = (file) =>
    file.url &&
    !file.purchaseInvoiceId &&
    (!file.ocrProcessed ||
      (file.ocrClaimedAt && file.ocrClaimedAt < staleClaimBefore));

  const pendingFiles = (transaction.receiptFiles || []).filter(isPending);
  if (pendingFiles.length === 0) {
    return [];
  }

  const createdInvoices = [];

  for (const receiptFile of pendingFiles) {
    // Claim atomique du fichier pour éviter un double traitement en cas
    // d'appels concurrents (upload + update simultanés).
    const claimed = await Transaction.findOneAndUpdate(
      {
        _id: transaction._id,
        workspaceId,
        receiptFiles: {
          $elemMatch: {
            _id: receiptFile._id,
            purchaseInvoiceId: null,
            $or: [
              { ocrProcessed: { $ne: true } },
              { ocrClaimedAt: { $lt: staleClaimBefore } },
            ],
          },
        },
      },
      {
        $set: {
          "receiptFiles.$[elem].ocrProcessed": true,
          "receiptFiles.$[elem].ocrClaimedAt": new Date(),
        },
      },
      { new: true, arrayFilters: [{ "elem._id": receiptFile._id }] },
    );
    if (!claimed) continue;

    try {
      let financial = null;
      let extractedText = null;
      let ocrSucceeded = false;

      try {
        const ocrResult = await runOcr(
          receiptFile,
          buffersByKey[receiptFile.key] || null,
          workspaceId,
        );
        financial = ocrResult.financial;
        extractedText = ocrResult.extractedText;
        ocrSucceeded = Boolean(financial);
      } catch (ocrError) {
        logger.warn(
          `⚠️ [RECEIPT OCR] OCR impossible pour ${receiptFile.filename}, création de la facture avec les données de la transaction: ${ocrError.message}`,
        );
      }

      // Re-vérification finale : l'OCR peut durer plusieurs secondes, la
      // transaction a pu être ignorée ou rapprochée à la main entre-temps.
      // On relit ses liens pour que la déduplication les prenne en compte.
      const fresh = await Transaction.findOne({
        _id: transaction._id,
        workspaceId,
      }).select("linkedPurchaseInvoiceIds reconciliationStatus");
      if (!fresh || fresh.reconciliationStatus === "ignored") {
        await Transaction.updateOne(
          { _id: transaction._id, workspaceId },
          {
            $set: {
              "receiptFiles.$[elem].ocrProcessed": false,
              "receiptFiles.$[elem].ocrClaimedAt": null,
            },
          },
          { arrayFilters: [{ "elem._id": receiptFile._id }] },
        ).catch(() => {});
        logger.info(
          `ℹ️ [RECEIPT OCR] Transaction ignorée pendant l'OCR, création annulée (transaction ${transaction._id})`,
        );
        continue;
      }
      transaction.linkedPurchaseInvoiceIds = fresh.linkedPurchaseInvoiceIds;

      // Déduplication : facture existante (même numéro / fournisseur +
      // montant, ou facture déjà liée si l'OCR a échoué) → on y rattache le
      // justificatif et la transaction au lieu de créer un doublon.
      const existing = await findExistingPurchaseInvoiceForReceipt({
        transaction,
        financial,
        ocrSucceeded,
        workspaceId,
      });

      let invoice;
      if (existing) {
        invoice = await attachReceiptToExistingPurchaseInvoice({
          invoice: existing,
          transaction,
          receiptFile,
          financial,
          ocrSucceeded,
          workspaceId,
        });
        logger.info(
          `ℹ️ [RECEIPT OCR] Justificatif ${receiptFile.filename} rattaché à la facture d'achat existante ${existing._id} (transaction ${transaction._id})`,
        );
      } else {
        invoice = await createPurchaseInvoiceFromReceipt({
          transaction,
          receiptFile,
          financial,
          extractedText,
          ocrSucceeded,
          workspaceId,
          userId,
        });
      }

      await Transaction.updateOne(
        { _id: transaction._id, workspaceId },
        {
          $addToSet: { linkedPurchaseInvoiceIds: invoice._id },
          $set: {
            reconciliationStatus: "matched",
            reconciliationDate: new Date(),
            "receiptFiles.$[elem].purchaseInvoiceId": invoice._id,
          },
        },
        { arrayFilters: [{ "elem._id": receiptFile._id }] },
      );

      // La facture fait foi : la transaction rapprochée prend la catégorie de
      // la facture créée, pour un affichage identique sur les deux pages
      await syncLinkedTransactionCategories({
        category: invoice.category,
        workspaceId,
        transactionIds: [transaction._id],
      });

      createdInvoices.push(invoice);
      if (!existing) {
        logger.info(
          `✅ [RECEIPT OCR] Facture d'achat ${invoice._id} créée depuis le justificatif ${receiptFile.filename} (transaction ${transaction._id})`,
        );
      }
    } catch (error) {
      // Libérer le claim pour permettre un retraitement ultérieur
      console.error(
        `❌ [RECEIPT OCR] Échec création facture d'achat pour ${receiptFile.filename}:`,
        error.message,
      );
      await Transaction.updateOne(
        { _id: transaction._id, workspaceId },
        {
          $set: {
            "receiptFiles.$[elem].ocrProcessed": false,
            "receiptFiles.$[elem].ocrClaimedAt": null,
          },
        },
        { arrayFilters: [{ "elem._id": receiptFile._id }] },
      ).catch(() => {});
    }
  }

  return createdInvoices;
}

export default {
  resolveReceiptAmounts,
  processReceiptsForTransaction,
  isExpenseTransaction,
};
