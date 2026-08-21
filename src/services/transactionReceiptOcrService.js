import logger from "../utils/logger.js";
import mongoose from "mongoose";
import claudeVisionOcrService from "./claudeVisionOcrService.js";
import hybridOcrService from "./hybridOcrService.js";
import mistralIntelligentAnalysisService from "./mistralIntelligentAnalysisService.js";
import Transaction from "../models/Transaction.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import Supplier from "../models/Supplier.js";
import { syncLinkedTransactionCategories } from "../utils/purchaseInvoiceCategorySync.js";
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
  const totals = ef.totals || {};

  const supplierName =
    td.vendor_name ||
    td.supplier_name ||
    transaction.metadata?.vendor ||
    transaction.description ||
    "Fournisseur inconnu";

  const amountTTC =
    toPositiveNumber(td.amount) ||
    toPositiveNumber(totals.total_ttc) ||
    Math.abs(transaction.amount) ||
    null;

  if (!amountTTC) {
    throw new Error(
      "Impossible de déterminer le montant TTC (OCR et transaction)",
    );
  }

  const amountHT =
    toPositiveNumber(td.amount_ht) || toPositiveNumber(totals.total_ht) || 0;
  const amountTVA =
    toPositiveNumber(td.tax_amount) || toPositiveNumber(totals.total_tax) || 0;
  // Un taux de 0 % est valide (autoliquidation, franchise...) : ne pas
  // l'écraser par le défaut. À défaut de taux extrait, on le dérive des
  // montants, et en dernier recours 20 %.
  const extractedVatRate = toNonNegativeNumber(td.tax_rate);
  const vatRate =
    extractedVatRate !== null
      ? extractedVatRate
      : amountHT > 0
        ? Math.round((amountTVA / amountHT) * 10000) / 100
        : 20;
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
    currency: td.currency || transaction.currency || "EUR",
    // Le débit bancaire a déjà eu lieu : la facture est payée et rapprochée
    status: "PAID",
    paymentDate: transaction.date || new Date(),
    paymentMethod: mapPaymentMethod(
      td.payment_method,
      transaction.metadata?.paymentMethod,
    ),
    category,
    source: "OCR",
    notes: `Créée automatiquement depuis le justificatif de la transaction "${transaction.description || transaction.externalId || transaction._id}"`,
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
          amountTTC: toPositiveNumber(td.amount),
          currency: td.currency || undefined,
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
 * Point d'entrée : traite les justificatifs non encore traités d'une
 * transaction dépense et crée les factures d'achat correspondantes.
 *
 * @param {Object} params
 * @param {string} params.transactionId
 * @param {string} params.workspaceId
 * @param {string} params.userId
 * @param {Object<string, Buffer>} [params.buffersByKey] buffers des fichiers
 *   fraîchement uploadés, indexés par clé R2 (évite un re-téléchargement)
 * @returns {Promise<Array>} factures créées
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

  // Transaction déjà rapprochée à une facture d'achat : le justificatif
  // correspond très probablement à cette facture existante — ne pas créer
  // de doublon
  if ((transaction.linkedPurchaseInvoiceIds || []).length > 0) {
    return [];
  }

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
    // d'appels concurrents (upload + update simultanés). La condition sur
    // linkedPurchaseInvoiceIds re-vérifie au dernier moment qu'un
    // rapprochement manuel n'a pas eu lieu entre le chargement et le claim.
    const claimed = await Transaction.findOneAndUpdate(
      {
        _id: transaction._id,
        workspaceId,
        $and: [
          {
            $or: [
              { linkedPurchaseInvoiceIds: { $exists: false } },
              { linkedPurchaseInvoiceIds: { $size: 0 } },
            ],
          },
          {
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
        ],
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

      // Re-vérification finale : l'OCR peut durer plusieurs secondes, un
      // rapprochement manuel a pu avoir lieu entre-temps — ne pas créer de
      // facture en double
      const fresh = await Transaction.findOne({
        _id: transaction._id,
        workspaceId,
      }).select("linkedPurchaseInvoiceIds reconciliationStatus");
      if (
        !fresh ||
        (fresh.linkedPurchaseInvoiceIds || []).length > 0 ||
        fresh.reconciliationStatus === "ignored"
      ) {
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
          `ℹ️ [RECEIPT OCR] Rapprochement manuel détecté pendant l'OCR, création annulée (transaction ${transaction._id})`,
        );
        continue;
      }

      const invoice = await createPurchaseInvoiceFromReceipt({
        transaction,
        receiptFile,
        financial,
        extractedText,
        ocrSucceeded,
        workspaceId,
        userId,
      });

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
      logger.info(
        `✅ [RECEIPT OCR] Facture d'achat ${invoice._id} créée depuis le justificatif ${receiptFile.filename} (transaction ${transaction._id})`,
      );
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
  processReceiptsForTransaction,
  isExpenseTransaction,
};
