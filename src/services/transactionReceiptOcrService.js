import logger from "../utils/logger.js";
import mongoose from "mongoose";
import claudeVisionOcrService from "./claudeVisionOcrService.js";
import hybridOcrService from "./hybridOcrService.js";
import mistralIntelligentAnalysisService from "./mistralIntelligentAnalysisService.js";
import Transaction from "../models/Transaction.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import { syncLinkedTransactionCategories } from "../utils/purchaseInvoiceCategorySync.js";
import { resolvePurchaseInvoiceCategoryInput } from "../utils/categoryTaxonomy.js";
import { findPurchaseInvoiceDuplicates } from "../utils/purchaseInvoiceDuplicates.js";
import { resolveSupplier } from "../utils/supplierResolution.js";
import {
  buildReconciliationLinkEntry,
  forgetReconciliationLink,
} from "../utils/reconciliationLinkOrigin.js";
import crypto from "crypto";
import exchangeRateService from "./exchangeRateService.js";

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

// Justificatifs analysés en parallèle sur une même transaction. Plafonné pour
// ne pas saturer les quotas des fournisseurs OCR sur un dépôt en lot.
const OCR_CONCURRENCY = 3;

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

/**
 * Catégorie de la facture d'achat créée depuis un justificatif.
 *
 * Une catégorie choisie à la main sur la transaction (categoryIsManual) est
 * une décision explicite de l'utilisateur : elle prime sur la catégorie
 * devinée par l'OCR, et la facture l'hérite (sous-catégorie fine + catégorie
 * large dérivée) pour que les deux pages concordent. Sinon, comportement
 * historique : l'OCR propose, puis la facture est propagée à la transaction.
 *
 * @returns {{ category: string, subcategory: string|null }}
 */
function resolveReceiptInvoiceCategory({ transaction, ocrCategory }) {
  if (transaction.categoryIsManual && transaction.category) {
    const resolved = resolvePurchaseInvoiceCategoryInput({
      subcategory: transaction.category,
    });
    // Code hors référentiel (ex. code Bridge brut) : impossible à
    // représenter sur la facture, on retombe sur l'OCR.
    if (resolved.subcategory || resolved.category !== "OTHER") {
      return resolved;
    }
  }
  return {
    category: mapCategory(ocrCategory, transaction.expenseCategory),
    subcategory: null,
  };
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
        provider: "claude-vision",
        extractionQuality: "full",
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
  let extractionQuality = "full";
  if (hybridResult.provider === "claude-vision") {
    financial = {
      transaction_data: hybridResult.transaction_data,
      extracted_fields: hybridResult.extracted_fields,
      document_analysis: hybridResult.document_analysis,
    };
  } else {
    financial =
      await mistralIntelligentAnalysisService.analyzeDocument(hybridResult);
    if (financial?.success === false) {
      // Analyse IA indisponible (quota, clé, panne). Secours gratuit : les
      // champs extraits par regex, soit par le provider (Tesseract, Google
      // OCR basique), soit par l'analyse de secours Mistral.
      if (
        hybridResult.extractionQuality === "partial" &&
        hybridResult.transaction_data
      ) {
        financial = {
          transaction_data: hybridResult.transaction_data,
          extracted_fields: hybridResult.extracted_fields || {},
          document_analysis: { confidence: 0.4, provider: "regex-fallback" },
        };
        extractionQuality = "partial";
      } else {
        extractionQuality = financial.extractionQuality || "none";
      }
      logger.warn(
        `⚠️ [RECEIPT OCR] Analyse IA indisponible pour ${receiptFile.filename}, champs de secours (${extractionQuality}) via ${hybridResult.provider}`,
      );
    }
  }

  return {
    financial,
    extractedText: hybridResult.extractedText || hybridResult.text || null,
    provider: hybridResult.provider || "hybrid",
    extractionQuality,
  };
}

/**
 * Crée la facture d'achat pour un justificatif donné et lie la transaction.
 */
/**
 * Lance l'OCR des justificatifs en parallèle (plafonné) : c'est la seule
 * étape longue de la chaîne, plusieurs secondes par fichier. La création des
 * factures reste séquentielle côté appelant pour que la déduplication voie
 * les factures créées par les justificatifs précédents.
 *
 * Ne rejette jamais : un OCR en échec rend un résultat vide, la facture est
 * alors créée depuis les données de la transaction (comportement inchangé).
 *
 * @returns {Promise<Map<string, Object>>} résultat indexé par id de justificatif
 */
async function runOcrForFiles(files, buffersByKey, workspaceId) {
  const results = new Map();
  let cursor = 0;

  const worker = async () => {
    while (cursor < files.length) {
      const receiptFile = files[cursor];
      cursor += 1;
      const startedAt = Date.now();
      try {
        const ocrResult = await runOcr(
          receiptFile,
          buffersByKey[receiptFile.key] || null,
          workspaceId,
        );
        results.set(String(receiptFile._id), {
          financial: ocrResult.financial,
          extractedText: ocrResult.extractedText,
          ocrProvider: ocrResult.provider || null,
          extractionQuality: ocrResult.extractionQuality || null,
          ocrSucceeded: Boolean(ocrResult.financial),
        });
        logger.info(
          `⏱️ [RECEIPT OCR] ${receiptFile.filename} analysé en ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${ocrResult.provider || "inconnu"})`,
        );
      } catch (ocrError) {
        results.set(String(receiptFile._id), {
          financial: null,
          extractedText: null,
          ocrProvider: null,
          extractionQuality: null,
          ocrSucceeded: false,
        });
        logger.warn(
          `⚠️ [RECEIPT OCR] OCR impossible pour ${receiptFile.filename} après ${((Date.now() - startedAt) / 1000).toFixed(1)}s, création de la facture avec les données de la transaction: ${ocrError.message}`,
        );
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(OCR_CONCURRENCY, files.length) }, worker),
  );
  return results;
}

async function createPurchaseInvoiceFromReceipt({
  transaction,
  receiptFile,
  financial,
  extractedText,
  ocrSucceeded,
  ocrProvider = null,
  extractionQuality = null,
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
  const { category, subcategory } = resolveReceiptInvoiceCategory({
    transaction,
    ocrCategory: td.category,
  });
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
    subcategory,
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
          provider: ocrProvider || undefined,
          extractionQuality: extractionQuality || "full",
        }
      : {
          // Aucune donnée extraite : facture construite depuis la transaction,
          // à compléter par l'utilisateur
          provider: ocrProvider || undefined,
          extractionQuality: "none",
        },
  });

  try {
    // Fiche fournisseur : identifiants lus, récurrence bancaire, puis nom
    // (cf. supplierResolution.js). Une fiche existante impose son nom à la
    // facture : « Canva » lu sur le PDF devient « Canva Pty. Ltd. ».
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: supplierName,
      siret: ef.vendor_siret || null,
      vatNumber: ef.vendor_vat_number || null,
      transaction,
      userId,
      category,
    });
    invoice.supplierId = supplier._id;
    if (matchedBy !== "created" && supplier.name) {
      invoice.supplierName = supplier.name;
    }
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
 *   privilégiant les factures déjà liées à la transaction. Sans date lue sur
 *   le PDF, c'est la date de la transaction qui sert de repère (la même que
 *   prendrait la facture créée) : un abonnement mensuel a le même fournisseur
 *   et le même montant tous les mois, seule la date distingue les factures.
 *   Incident 21/09/2026 : 23 justificatifs Canva de 2024-2025 (OCR sans date
 *   ni numéro) empilés sur la facture d'août 2026.
 * - OCR échoué : aucune donnée fiable ; si la transaction porte déjà une
 *   facture d'achat, le justificatif lui est rattaché (créer une facture
 *   "fallback" au montant de la transaction doublerait la dépense).
 *
 * Dans les deux cas, la facture retenue doit pouvoir « absorber » le débit
 * (cf. purchaseInvoiceCanAbsorbTransaction) : au-delà, ce n'est pas un
 * doublon mais une autre facture. Exception : même numéro de facture lu par
 * l'OCR, le numéro identifie la facture (relevé mensuel couvrant plusieurs
 * débits, facture en devise déposée sur chaque prélèvement) et créer un
 * second document au même numéro serait pire.
 */
async function findExistingPurchaseInvoiceForReceipt({
  transaction,
  financial,
  ocrSucceeded,
  workspaceId,
}) {
  const linkedIds = transaction.linkedPurchaseInvoiceIds || [];
  let candidate = null;
  let ocrNumber = null;

  if (!ocrSucceeded) {
    if (linkedIds.length === 0) return null;
    candidate = await PurchaseInvoice.findOne({
      _id: { $in: linkedIds },
      workspaceId: new mongoose.Types.ObjectId(workspaceId),
    }).sort({ createdAt: -1 });
  } else {
    const td = financial?.transaction_data || {};
    ocrNumber = td.document_number || td.invoice_number || null;
    // Même montant que celui qui serait enregistré sur la facture : en devise
    // étrangère, une facture déjà créée porte le débit bancaire converti.
    const { amountTTC } = resolveReceiptAmounts({ transaction, financial });
    const candidates = await findPurchaseInvoiceDuplicates({
      workspaceId,
      supplierName: td.vendor_name || td.supplier_name || null,
      invoiceNumber: ocrNumber,
      amountTTC: amountTTC || null,
      issueDate:
        parseOcrDate(td.transaction_date || td.invoice_date) ||
        transaction.date ||
        null,
      preferIds: linkedIds,
      limit: 1,
    });
    candidate = candidates[0] || null;
  }

  if (!candidate) return null;

  const canAbsorb = await purchaseInvoiceCanAbsorbTransaction(
    candidate,
    transaction,
  );
  if (canAbsorb) return { invoice: candidate, linkTransaction: true };

  // Facture déjà couverte par d'autres débits. Deux issues selon la raison
  // pour laquelle on est tombé dessus :
  if (sameInvoiceNumber(ocrNumber, candidate.invoiceNumber)) {
    // C'est littéralement le même document (même numéro lu). Le fichier a sa
    // place sur cette facture, il ne faut surtout pas en créer une seconde.
    // Mais ce débit-ci n'est pas couvert pour autant : un justificatif déposé
    // sur le mauvais mois ne doit pas marquer la dépense comme justifiée.
    logger.info(
      `ℹ️ [RECEIPT OCR] Facture ${candidate._id} (${candidate.amountTTC} ${candidate.currency || "EUR"}) déjà couverte : justificatif rattaché au document, mais transaction ${transaction._id} (${transaction.amount}) laissée à rapprocher`,
    );
    return { invoice: candidate, linkTransaction: false };
  }
  // Simple ressemblance (fournisseur + montant + dates proches) : ce n'est
  // pas le même document, on crée la facture manquante.
  logger.info(
    `ℹ️ [RECEIPT OCR] Facture ${candidate._id} (${candidate.amountTTC} ${candidate.currency || "EUR"}) déjà couverte par ses transactions liées, pas de rattachement de la transaction ${transaction._id} (${transaction.amount})`,
  );
  return null;
}

const normalizeInvoiceNumber = (n) =>
  (n || "").toString().toLowerCase().replace(/\s+/g, "");

const sameInvoiceNumber = (a, b) => {
  const na = normalizeInvoiceNumber(a);
  return na.length >= 3 && na === normalizeInvoiceNumber(b);
};

/**
 * Tolérance sur la somme des débits rattachés à une facture : 1 % (arrondis
 * de conversion de devise) et jamais moins d'un centime.
 */
const ABSORB_TOLERANCE_RATIO = 0.01;

/**
 * Une facture d'achat peut se voir rattacher un débit supplémentaire tant que
 * la somme des transactions déjà liées (hors celle-ci) plus ce débit ne
 * dépasse pas son TTC : paiement en plusieurs fois, facture mensuelle
 * regroupant plusieurs prélèvements. Une facture de 11,99 € déjà payée par un
 * débit de 11,99 € ne peut pas en absorber un second : c'est une autre
 * facture (abonnement du mois suivant), pas un doublon.
 *
 * Sans TTC exploitable sur la facture, on ne tranche pas (rattachement
 * autorisé comme avant).
 */
async function purchaseInvoiceCanAbsorbTransaction(invoice, transaction) {
  const ttc = Number(invoice?.amountTTC);
  const debit = Math.abs(Number(transaction?.amount) || 0);
  if (!(ttc > 0) || !(debit > 0)) return true;

  // Devises différentes : comparer les nombres n'a aucun sens (une facture de
  // 100 USD n'est pas couverte par 100 EUR). On ne tranche pas. Une facture
  // créée depuis un justificatif porte toujours la devise du compte (le débit
  // bancaire converti, cf. resolveReceiptAmounts) ; le cas vient donc des
  // factures saisies à la main ou importées.
  const invoiceCurrency = normalizeCurrency(invoice?.currency) || "EUR";
  const debitCurrency = normalizeCurrency(transaction?.currency) || "EUR";
  if (invoiceCurrency !== debitCurrency) return true;

  const otherIds = (invoice.linkedTransactionIds || []).filter(
    (id) => String(id) !== String(transaction._id),
  );
  let alreadyCovered = 0;
  if (otherIds.length > 0) {
    const linked = await Transaction.find({ _id: { $in: otherIds } })
      .select("amount currency")
      .lean();
    // Un débit dans une autre devise n'est pas additionnable : on s'abstient
    // plutôt que de fausser le total.
    if (
      linked.some(
        (t) => (normalizeCurrency(t.currency) || "EUR") !== debitCurrency,
      )
    ) {
      return true;
    }
    alreadyCovered = linked.reduce(
      (sum, t) => sum + Math.abs(Number(t.amount) || 0),
      0,
    );
  }

  const tolerance = Math.max(ttc * ABSORB_TOLERANCE_RATIO, 0.01);
  return alreadyCovered + debit <= ttc + tolerance;
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
  linkTransaction = true,
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

  // Sans liaison de la transaction, on ne touche ni au statut ni au
  // rapprochement de la facture : on ne fait qu'y déposer le fichier.
  const update = linkTransaction
    ? {
        $set: { isReconciled: true, status: nextStatus, paymentDate },
        $addToSet: { linkedTransactionIds: transaction._id },
      }
    : {};
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

  // Rien à écrire (fichier déjà présent et pas de liaison) : on rend la
  // facture telle quelle, un update vide ferait échouer Mongo.
  if (Object.keys(update).length === 0) return invoice;

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
  const startedAt = Date.now();

  // 1) Claim atomique de chaque justificatif (rapide) pour éviter un double
  //    traitement en cas d'appels concurrents (upload + update simultanés).
  const claimedFiles = [];
  for (const receiptFile of pendingFiles) {
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
    if (claimed) claimedFiles.push(receiptFile);
  }
  if (claimedFiles.length === 0) {
    return [];
  }

  // 2) OCR de tous les justificatifs en parallèle (étape longue).
  const ocrResults = await runOcrForFiles(
    claimedFiles,
    buffersByKey,
    workspaceId,
  );
  const ocrElapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // 3) Déduplication, création et liaison : séquentiel à dessein, chaque
  //    justificatif doit voir les factures créées par les précédents.
  for (const receiptFile of claimedFiles) {
    try {
      const {
        financial = null,
        extractedText = null,
        ocrSucceeded = false,
        ocrProvider = null,
        extractionQuality = null,
      } = ocrResults.get(String(receiptFile._id)) || {};

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
      // La facture peut être retrouvée sans que la transaction doive y être
      // liée : même document, mais facture déjà couverte par d'autres débits.
      const linkTransaction = existing ? existing.linkTransaction : true;

      let invoice;
      if (existing) {
        invoice = await attachReceiptToExistingPurchaseInvoice({
          invoice: existing.invoice,
          transaction,
          receiptFile,
          financial,
          ocrSucceeded,
          workspaceId,
          linkTransaction,
        });
        logger.info(
          `ℹ️ [RECEIPT OCR] Justificatif ${receiptFile.filename} rattaché à la facture d'achat existante ${existing.invoice._id}${linkTransaction ? "" : " (transaction non liée : facture déjà couverte)"} (transaction ${transaction._id})`,
        );
      } else {
        invoice = await createPurchaseInvoiceFromReceipt({
          transaction,
          receiptFile,
          financial,
          extractedText,
          ocrSucceeded,
          ocrProvider,
          extractionQuality,
          workspaceId,
          userId,
        });
      }

      if (linkTransaction) {
        // Origine du lien : justificatif déposé (étiquette côté UI).
        const receiptLink = buildReconciliationLinkEntry({
          documentType: "PURCHASE_INVOICE",
          documentId: invoice._id,
          origin: "RECEIPT",
          userId,
        });
        await forgetReconciliationLink(
          { _id: transaction._id, workspaceId },
          "PURCHASE_INVOICE",
          [invoice._id],
        );
        await Transaction.updateOne(
          { _id: transaction._id, workspaceId },
          {
            $addToSet: { linkedPurchaseInvoiceIds: invoice._id },
            $push: { reconciliationLinks: receiptLink },
            $set: {
              reconciliationStatus: "matched",
              reconciliationDate: new Date(),
              "receiptFiles.$[elem].purchaseInvoiceId": invoice._id,
            },
          },
          { arrayFilters: [{ "elem._id": receiptFile._id }] },
        );

        // La facture fait foi : la transaction rapprochée prend la catégorie de
        // la facture créée, pour un affichage identique sur les deux pages.
        // Exception : catégorie choisie à la main sur la transaction, c'est
        // alors la facture qui vient d'en hériter (cf. resolveReceiptInvoiceCategory).
        if (!(transaction.categoryIsManual && transaction.category)) {
          await syncLinkedTransactionCategories({
            category: invoice.category,
            subcategory: invoice.subcategory,
            workspaceId,
            transactionIds: [transaction._id],
          });
        }
      } else {
        // Facture déjà couverte : on note seulement d'où vient le fichier, la
        // dépense reste à rapprocher et n'hérite pas de la catégorie.
        await Transaction.updateOne(
          { _id: transaction._id, workspaceId },
          {
            $set: {
              "receiptFiles.$[elem].purchaseInvoiceId": invoice._id,
            },
          },
          { arrayFilters: [{ "elem._id": receiptFile._id }] },
        );
      }

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

  logger.info(
    `⏱️ [RECEIPT OCR] ${claimedFiles.length} justificatif(s) traité(s) en ${((Date.now() - startedAt) / 1000).toFixed(1)}s dont ${ocrElapsed}s d'OCR (transaction ${transaction._id})`,
  );
  return createdInvoices;
}

/**
 * Rend HT / TVA / TTC cohérents entre eux. Le TTC (montant dû) et la TVA
 * (ligne explicite) sont les valeurs les plus fiables d'une facture ; le
 * « HT » lu est souvent un sous-total avant remise, frais ou avoir. Donc :
 *  - TTC et TVA connus → HT = TTC − TVA ;
 *  - TTC et HT connus sans TVA → TVA = TTC − HT ;
 *  - HT et TVA connus sans TTC → TTC = HT + TVA.
 * Le taux explicite est gardé, sinon dérivé de TVA / HT.
 */
function reconcileAmounts({ amountHT, amountTVA, amountTTC, vatRate }) {
  let ht = amountHT;
  let tva = amountTVA;
  let ttc = amountTTC;
  if (ttc !== null && tva !== null && ttc >= tva) {
    ht = round2(ttc - tva);
  } else if (ttc !== null && ht !== null && ttc >= ht) {
    tva = round2(ttc - ht);
  } else if (ttc === null && ht !== null && tva !== null) {
    ttc = round2(ht + tva);
  }
  const rate =
    vatRate !== null && vatRate !== undefined
      ? vatRate
      : ht && tva !== null
        ? round2((tva / ht) * 100)
        : null;
  return { amountHT: ht, amountTVA: tva, amountTTC: ttc, vatRate: rate };
}

/**
 * Relit un fichier de facture d'achat (même chaîne OCR que les justificatifs
 * de transaction : Claude Vision puis pipeline hybride) et renvoie les
 * valeurs lues au format facture d'achat, sans rien enregistrer. Sert à la
 * mutation reanalyzePurchaseInvoice : l'utilisateur compare et applique.
 */
async function analyzePurchaseInvoiceFile({
  receiptFile,
  fileBuffer,
  workspaceId,
}) {
  const { financial, provider, extractionQuality } = await runOcr(
    receiptFile,
    fileBuffer,
    workspaceId,
  );
  const td = financial?.transaction_data || {};
  const hasData = Boolean(
    td.vendor_name ||
    td.supplier_name ||
    td.document_number ||
    td.invoice_number ||
    toPositiveNumber(td.amount),
  );
  const confidence =
    typeof financial?.document_analysis?.confidence === "number" &&
    financial.document_analysis.confidence >= 0 &&
    financial.document_analysis.confidence <= 1
      ? financial.document_analysis.confidence
      : null;
  const { amountHT, amountTVA, amountTTC, vatRate } = reconcileAmounts({
    amountHT: toPositiveNumber(td.amount_ht),
    amountTVA: toPositiveNumber(td.tax_amount),
    amountTTC: toPositiveNumber(td.amount),
    vatRate: toNonNegativeNumber(td.tax_rate),
  });
  const ocrCategory = td.category ? String(td.category).toUpperCase() : null;
  const ef = financial?.extracted_fields || {};
  return {
    hasData,
    supplierName: td.vendor_name || td.supplier_name || null,
    supplierSiret: ef.vendor_siret || null,
    supplierVatNumber: ef.vendor_vat_number || null,
    invoiceNumber: td.document_number || td.invoice_number || null,
    invoiceDate: parseOcrDate(td.transaction_date || td.invoice_date),
    dueDate: parseOcrDate(td.due_date),
    amountHT,
    amountTVA,
    vatRate,
    amountTTC,
    currency: normalizeCurrency(td.currency),
    category:
      ocrCategory && VALID_PI_CATEGORIES.has(ocrCategory) ? ocrCategory : null,
    paymentMethod: td.payment_method
      ? mapPaymentMethod(td.payment_method, null)
      : null,
    confidence,
    provider: provider || null,
    extractionQuality: extractionQuality || "full",
  };
}

const normKey = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * Relit tous les justificatifs d'une facture d'achat et en déduit une
 * proposition combinée :
 *  - chaque fichier est analysé (en parallèle) ;
 *  - les montants lus dans une autre devise que celle de la facture sont
 *    convertis au taux BCE du jour du document (repli : dernier taux) ;
 *  - les fichiers décrivant le même document (même numéro, ou même
 *    fournisseur + même TTC sans numéro) sont dédoublonnés : une facture en
 *    deux formats ou une facture + sa preuve de paiement ne comptent qu'une
 *    fois ;
 *  - les documents distincts sont additionnés (plusieurs reçus pour une
 *    même dépense) ;
 *  - si une transaction bancaire liée existe dans la devise cible et qu'au
 *    moins un document était en devise étrangère, le débit bancaire fait foi
 *    pour le TTC (HT/TVA au prorata), comme pour l'automatisation.
 * Rien n'est enregistré.
 */
async function analyzePurchaseInvoiceFiles({
  files,
  workspaceId,
  targetCurrency = "EUR",
  transaction = null,
  // Devise du document quand l'OCR ne la lit pas (ex. devise d'origine notée
  // sur la facture à sa création) : évite de prendre des dollars pour des
  // euros faute de symbole reconnu.
  defaultCurrency = null,
}) {
  const fallbackCurrency = normalizeCurrency(defaultCurrency);
  const settled = await Promise.allSettled(
    files.map((f) =>
      analyzePurchaseInvoiceFile({
        receiptFile: f.receiptFile,
        fileBuffer: f.fileBuffer,
        workspaceId,
      }),
    ),
  );

  const results = [];
  for (let i = 0; i < files.length; i += 1) {
    const r = settled[i];
    const base = { fileId: files[i].fileId, filename: files[i].filename };
    if (r.status !== "fulfilled") {
      results.push({
        ...base,
        ok: false,
        error: r.reason?.message || "Analyse échouée",
        proposal: null,
      });
      continue;
    }
    if (!r.value.hasData) {
      results.push({
        ...base,
        ok: false,
        error: "Aucune valeur exploitable lue",
        proposal: r.value,
      });
      continue;
    }
    results.push({ ...base, ok: true, error: null, proposal: r.value });
  }

  // Conversion par fichier vers la devise de la facture
  let conversionUnavailable = false;
  for (const r of results) {
    if (!r.ok) continue;
    const p = r.proposal;
    if (!p.currency && fallbackCurrency) p.currency = fallbackCurrency;
    const from = p.currency || targetCurrency;
    if (from === targetCurrency) {
      r.converted = {
        amountHT: p.amountHT,
        amountTVA: p.amountTVA,
        amountTTC: p.amountTTC,
        rate: null,
        rateDate: null,
      };
      continue;
    }
    const fx = await exchangeRateService.getRate(
      from,
      targetCurrency,
      p.invoiceDate || new Date(),
    );
    if (!fx) {
      conversionUnavailable = true;
      r.converted = {
        amountHT: null,
        amountTVA: null,
        amountTTC: null,
        rate: null,
        rateDate: null,
      };
      continue;
    }
    const conv = (v) =>
      v === null || v === undefined ? null : round2(v * fx.rate);
    r.converted = {
      amountHT: conv(p.amountHT),
      amountTVA: conv(p.amountTVA),
      amountTTC: conv(p.amountTTC),
      rate: fx.rate,
      rateDate: fx.date,
    };
  }

  // Dédoublonnage : même document lu dans plusieurs fichiers
  const readable = results.filter((r) => r.ok);
  const groups = [];
  for (const r of readable) {
    const num = normKey(r.proposal.invoiceNumber);
    const supplier = normKey(r.proposal.supplierName);
    const ttc = r.converted.amountTTC ?? r.proposal.amountTTC;
    const group = groups.find((g) => {
      if (num && g.num) return num === g.num;
      if (num || g.num) return false;
      return (
        supplier &&
        supplier === g.supplier &&
        ttc !== null &&
        g.ttc !== null &&
        Math.abs(ttc - g.ttc) < 0.01
      );
    });
    if (group) {
      group.members.push(r);
      if (!group.num && num) group.num = num;
    } else {
      groups.push({ num, supplier, ttc, members: [r] });
    }
  }
  // Représentant : le plus confiant, à défaut le plus complet
  const score = (r) =>
    (r.proposal.confidence || 0) * 100 +
    [
      "supplierName",
      "invoiceNumber",
      "invoiceDate",
      "amountHT",
      "amountTTC",
    ].filter((k) => r.proposal[k] !== null && r.proposal[k] !== undefined)
      .length;
  const distinct = groups.map((g) => {
    const rep = [...g.members].sort((a, b) => score(b) - score(a))[0];
    for (const m of g.members) {
      m.duplicateOf = m === rep ? null : rep.fileId;
    }
    return rep;
  });

  // Proposition combinée
  let combined = null;
  let conversionMethod = "none";
  let conversionNote = null;
  let bankAmount = null;
  if (distinct.length > 0) {
    const anyForeign = distinct.some(
      (r) => (r.proposal.currency || targetCurrency) !== targetCurrency,
    );
    const usable = distinct.filter((r) => r.converted.amountTTC !== null);
    const base = [...distinct].sort((a, b) => score(b) - score(a))[0].proposal;
    const sum = (key) => {
      const vals = usable
        .map((r) => r.converted[key])
        .filter((v) => v !== null && v !== undefined);
      return vals.length ? round2(vals.reduce((a, b) => a + b, 0)) : null;
    };
    // Somme des TTC et des TVA des documents distincts, HT déduit (les
    // montants de chaque fichier ont déjà été rendus cohérents).
    const summed = reconcileAmounts({
      amountTTC: sum("amountTTC"),
      amountTVA: sum("amountTVA"),
      amountHT: sum("amountHT"),
      vatRate: null,
    });
    let { amountTTC, amountHT, amountTVA } = summed;
    const rates = distinct
      .map((r) => r.proposal.vatRate)
      .filter((v) => v !== null && v !== undefined);
    let vatRate =
      distinct.length === 1 && rates.length
        ? rates[0]
        : rates.length > 1 && rates.every((v) => v === rates[0])
          ? rates[0]
          : summed.vatRate;
    const dates = distinct
      .map((r) => r.proposal.invoiceDate)
      .filter((d) => d instanceof Date && !isNaN(d.getTime()));
    const dues = distinct
      .map((r) => r.proposal.dueDate)
      .filter((d) => d instanceof Date && !isNaN(d.getTime()));

    if (anyForeign) {
      conversionMethod = conversionUnavailable ? "unavailable" : "rate";
      if (conversionMethod === "rate") {
        const parts = distinct
          .filter((r) => r.converted.rate)
          .map(
            (r) =>
              `1 ${r.proposal.currency} = ${r.converted.rate} ${targetCurrency} (BCE ${r.converted.rateDate})`,
          );
        conversionNote = [...new Set(parts)].join(" ; ");
      } else {
        conversionNote =
          "Taux de change indisponible : montants en devise étrangère non convertis.";
      }
    }

    // Débit bancaire lié : fait foi si devise étrangère
    const txCurrency =
      normalizeCurrency(transaction?.currency) || targetCurrency;
    const txAmount =
      typeof transaction?.amount === "number"
        ? Math.abs(transaction.amount)
        : 0;
    if (anyForeign && txAmount > 0 && txCurrency === targetCurrency) {
      bankAmount = txAmount;
      const ref = amountTTC && amountTTC > 0 ? amountTTC : null;
      // Le débit ne fait foi que s'il correspond bien à ce document : écart
      // au montant converti ≤ 15 % (frais et taux de la banque). Au-delà,
      // la transaction liée n'est probablement pas ce paiement (acompte,
      // mauvais lien) : on garde le taux BCE et on le signale.
      const plausible = !ref || Math.abs(txAmount - ref) / ref <= 0.15;
      if (plausible) {
        const ratio = ref ? txAmount / ref : null;
        amountHT =
          ratio && amountHT !== null ? round2(amountHT * ratio) : amountHT;
        amountTVA =
          amountHT !== null ? round2(Math.max(txAmount - amountHT, 0)) : null;
        amountTTC = txAmount;
        conversionMethod = "bank";
        conversionNote = `Débit bancaire retenu : ${txAmount.toFixed(2)} ${targetCurrency}, montants HT/TVA ramenés au prorata.`;
      } else if (conversionMethod === "rate") {
        conversionNote = `${conversionNote}. Débit bancaire lié (${txAmount.toFixed(2)} ${targetCurrency}) trop éloigné du montant lu (${ref.toFixed(2)} ${targetCurrency}) : non retenu.`;
      }
    }

    // Fiche fournisseur existante (identifiants, récurrence bancaire, nom) :
    // la proposition porte alors le nom de la fiche, pas le nom brut lu.
    let supplierName = base.supplierName;
    let supplierId = null;
    if (supplierName) {
      try {
        const { supplier } = await resolveSupplier({
          workspaceId,
          name: supplierName,
          siret: base.supplierSiret || null,
          vatNumber: base.supplierVatNumber || null,
          transaction,
          create: false,
        });
        if (supplier) {
          supplierName = supplier.name;
          supplierId = supplier._id.toString();
        }
      } catch (err) {
        logger.warn(
          `⚠️ [RECEIPT OCR] Résolution fournisseur impossible (${err.message})`,
        );
      }
    }

    combined = {
      supplierName,
      supplierId,
      invoiceNumber: distinct.length === 1 ? base.invoiceNumber : null,
      invoiceDate: dates.length ? new Date(Math.min(...dates)) : null,
      dueDate: dues.length ? new Date(Math.max(...dues)) : null,
      amountHT,
      amountTVA,
      vatRate,
      amountTTC,
      currency: targetCurrency,
      category: base.category,
      paymentMethod: base.paymentMethod,
      confidence: base.confidence,
      provider: base.provider,
      extractionQuality: distinct.some(
        (r) => r.proposal.extractionQuality === "partial",
      )
        ? "partial"
        : "full",
    };
  }

  return {
    files: results,
    combined,
    distinctCount: distinct.length,
    conversionMethod,
    conversionNote,
    bankAmount,
  };
}

export {
  findExistingPurchaseInvoiceForReceipt,
  purchaseInvoiceCanAbsorbTransaction,
};

export default {
  resolveReceiptAmounts,
  processReceiptsForTransaction,
  isExpenseTransaction,
  analyzePurchaseInvoiceFile,
  analyzePurchaseInvoiceFiles,
};
