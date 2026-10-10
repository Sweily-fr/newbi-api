/**
 * Métadonnées OCR d'une facture d'achat (`ocrMetadata`) : ce qui a été lu
 * sur le justificatif, montants et devise d'origine compris (la ligne
 * « Montant sur le justificatif » du tiroir en dépend).
 *
 * Les données OCR jointes à un justificatif arrivent sous deux formes :
 *  - le JSON brut de l'analyse (processDocumentOcr → financialAnalysis),
 *    envoyé par le desktop : transaction_data.{vendor_name, document_number,
 *    amount, amount_ht, tax_amount, tax_rate, currency…},
 *    extracted_fields.{vendor_siret, vendor_vat_number, totals, payment_details…}
 *    et document_analysis.confidence ;
 *  - l'ancienne forme à plat en camelCase (supplierName, amountTTC…).
 * Les deux sont lues, avec les mêmes règles que pour un justificatif de
 * transaction (transactionReceiptOcrService).
 */

export function parseOcrDate(value) {
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

export function toPositiveNumber(value) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (typeof n !== "number" || isNaN(n) || n <= 0) return null;
  return n;
}

export function toNonNegativeNumber(value) {
  const n = typeof value === "string" ? parseFloat(value) : value;
  if (typeof n !== "number" || isNaN(n) || n < 0) return null;
  return n;
}

const CURRENCY_SYMBOLS = { "€": "EUR", $: "USD", US$: "USD", "£": "GBP" };

export function normalizeCurrency(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (CURRENCY_SYMBOLS[raw]) return CURRENCY_SYMBOLS[raw];
  const code = raw.toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Premier texte non vide parmi les candidats. */
const firstText = (...values) => {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
};

/** Première valeur numérique acceptée par `parse` parmi les candidats. */
const firstNumber = (parse, ...values) => {
  for (const value of values) {
    const n = parse(value);
    if (n !== null) return n;
  }
  return null;
};

/**
 * Champs `ocrMetadata` lus dans les données OCR d'un justificatif, sous
 * l'une ou l'autre forme. Seuls les champs effectivement lus sont renvoyés :
 * un champ absent n'écrase pas une valeur déjà enregistrée.
 *
 * @param {Object|string} ocrData - JSON OCR (objet ou chaîne)
 * @returns {Object} champs à reporter dans ocrMetadata
 */
export function ocrMetadataFromOcrData(ocrData) {
  let ocr = ocrData;
  if (typeof ocr === "string") {
    try {
      ocr = JSON.parse(ocr);
    } catch {
      return {};
    }
  }
  if (!ocr || typeof ocr !== "object") return {};

  const td = ocr.transaction_data || {};
  const ef = ocr.extracted_fields || {};
  const totals = ef.totals || {};
  const payment = ef.payment_details || {};
  const confidence = ocr.document_analysis?.confidence ?? ocr.confidenceScore;

  const metadata = {
    supplierName: firstText(
      td.vendor_name,
      td.supplier_name,
      ocr.vendor_name,
      ocr.supplier_name,
      ocr.supplierName,
    ),
    supplierAddress: firstText(ef.vendor_address, ocr.supplierAddress),
    supplierVatNumber: firstText(ef.vendor_vat_number, ocr.supplierVatNumber),
    supplierSiret: firstText(ef.vendor_siret, ocr.supplierSiret),
    invoiceNumber: firstText(
      td.document_number,
      td.invoice_number,
      ocr.invoice_number,
      ocr.document_number,
      ocr.invoiceNumber,
    ),
    invoiceDate: parseOcrDate(
      td.transaction_date ||
        td.invoice_date ||
        ocr.invoice_date ||
        ocr.invoiceDate,
    ),
    dueDate: parseOcrDate(td.due_date || ocr.due_date || ocr.dueDate),
    amountHT: firstNumber(
      toPositiveNumber,
      td.amount_ht,
      totals.total_ht,
      ocr.amount_ht,
      ocr.total_ht,
      ocr.amountHT,
    ),
    amountTVA: firstNumber(
      toPositiveNumber,
      td.tax_amount,
      totals.total_tax,
      ocr.tax_amount,
      ocr.total_vat,
      ocr.amountTVA,
    ),
    vatRate: firstNumber(
      toNonNegativeNumber,
      td.tax_rate,
      ocr.tax_rate,
      ocr.vatRate,
    ),
    // Montant et devise tels que lus sur le justificatif
    amountTTC: firstNumber(
      toPositiveNumber,
      td.amount,
      totals.total_ttc,
      ocr.total_ttc,
      ocr.amount_ttc,
      ocr.amountTTC,
    ),
    currency: normalizeCurrency(td.currency || ocr.currency),
    iban: firstText(payment.iban, ocr.iban),
    bic: firstText(payment.bic, ocr.bic),
    confidenceScore:
      typeof confidence === "number" && confidence >= 0 && confidence <= 1
        ? confidence
        : null,
  };

  return Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== null),
  );
}
