/**
 * Extraction "de secours" des champs d'une facture à partir du texte brut OCR,
 * sans IA (gratuit, local). Utilisée quand aucun moteur d'analyse (Claude,
 * Mistral) n'est disponible : quotas dépassés, clés absentes, panne.
 *
 * Couvre les libellés français (via invoiceExtractionService) et anglais
 * (Balance due, Total, Subtotal, Sales tax, Invoice #, Issue date...), les
 * montants au format européen (1 234,56) et américain (3,577.78), et la
 * détection de la devise ($, £, CHF, €).
 *
 * La qualité est volontairement marquée "partial" : le résultat sert à
 * pré-remplir la facture, l'utilisateur doit la vérifier.
 */
import invoiceExtractionService from "../services/invoiceExtractionService.js";

const CURRENCY_MARKERS = [
  { code: "USD", re: /US\$|USD|\$/g },
  { code: "GBP", re: /GBP|£/g },
  { code: "CHF", re: /\bCHF\b/g },
  { code: "CAD", re: /\bCAD\b|C\$/g },
  { code: "EUR", re: /EUR|€/g },
];

/**
 * Devise dominante du texte. Retourne null si aucun marqueur n'est trouvé
 * (l'appelant décide alors du défaut, en général la devise du compte).
 */
export function detectCurrency(text) {
  if (!text) return null;
  let best = null;
  let bestCount = 0;
  for (const { code, re } of CURRENCY_MARKERS) {
    const count = (text.match(re) || []).length;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

/**
 * "3,577.78" → 3577.78 ; "1 234,56" → 1234.56 ; "4.077,78" → 4077.78 ;
 * "120,00" → 120 ; "249.00" → 249 ; "3 847" → 3847.
 * Le dernier séparateur suivi d'exactement 2 chiffres est la décimale.
 */
export function parseLocalizedAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw)
    .replace(/[^\d.,\s-]/g, "")
    .trim();
  if (!s) return null;
  const negative = s.startsWith("-");
  s = s.replace(/-/g, "").replace(/\s/g, "");
  const lastSep = Math.max(s.lastIndexOf(","), s.lastIndexOf("."));
  let normalized;
  if (lastSep === -1) {
    normalized = s;
  } else {
    const decimals = s.slice(lastSep + 1);
    const integer = s.slice(0, lastSep).replace(/[.,]/g, "");
    normalized =
      decimals.length === 2
        ? `${integer}.${decimals}`
        : `${integer}${decimals}`;
  }
  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

const AMOUNT = "(-?\\s?[$£€]?\\s?[0-9][0-9\\s.,]*[0-9]|[0-9])";

// Libellés anglais, du plus précis (montant réellement dû) au plus générique
const EN_TOTAL_PATTERNS = [
  new RegExp(`(?:balance|amount|total)\\s+due[^0-9\\n-]*${AMOUNT}`, "i"),
  new RegExp(`grand\\s+total[^0-9\\n-]*${AMOUNT}`, "i"),
  new RegExp(`total\\s*\\((?:USD|EUR|GBP|CHF|CAD)\\)[^0-9\\n-]*${AMOUNT}`, "i"),
  new RegExp(
    `(?:^|\\n)\\s*total(?!\\s*(?:h\\.?t|ttc|tva|vat|tax|hors))[^0-9\\n-]*${AMOUNT}`,
    "i",
  ),
];
const EN_SUBTOTAL = new RegExp(`sub\\s*-?\\s*total[^0-9\\n-]*${AMOUNT}`, "i");
const EN_TAX_WITH_RATE =
  /(?:sales\s*tax|vat|tax|tva)[^0-9\n]*?(\d{1,2}(?:[.,]\d{1,2})?)\s*%[^0-9\n-]*?(-?\s?[$£€]?\s?[0-9][0-9\s.,]*[0-9])/i;
const EN_TAX = new RegExp(
  `(?:sales\\s*tax|vat|tax)\\b[^0-9\\n%-]*${AMOUNT}`,
  "i",
);
const EN_INVOICE_NUMBER = [
  /(?:invoice|facture)\s*(?:#|no\.?|number|n°|num[ée]ro)\s*[:-]?\s*((?=[A-Z0-9/.-]*\d)[A-Z0-9][A-Z0-9/.-]{2,})/i,
  /\b(INV[-_/]?[0-9]{2,}[-_/]?[0-9A-Z]*)\b/i,
  /\b(F(?:AC|A)?[-_/]?[0-9]{4,}[-_/]?[0-9A-Z]*)\b/,
];
const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
  janvier: 1,
  février: 2,
  fevrier: 2,
  mars: 3,
  avril: 4,
  mai: 5,
  juin: 6,
  juillet: 7,
  août: 8,
  aout: 8,
  septembre: 9,
  octobre: 10,
  novembre: 11,
  décembre: 12,
  decembre: 12,
};
const MONTH_NAME = Object.keys(MONTHS).join("|");
const DATE_TEXT = new RegExp(
  `(?:(\\d{1,2})\\s+)?(${MONTH_NAME})\\.?\\s+(\\d{1,2})?,?\\s*(\\d{4})`,
  "i",
);
const DATE_NUMERIC = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/;
const DATE_ISO = /(\d{4})-(\d{2})-(\d{2})/;

const pad = (n) => String(n).padStart(2, "0");

/** Date en ISO (YYYY-MM-DD) depuis "March 4, 2026", "4 mars 2026", "04/03/2026", "2026-03-04". */
export function parseTextDate(fragment) {
  if (!fragment) return null;
  const iso = fragment.match(DATE_ISO);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const text = fragment.match(DATE_TEXT);
  if (text) {
    const month = MONTHS[text[2].toLowerCase()];
    const day = parseInt(text[1] || text[3], 10);
    if (month && day >= 1 && day <= 31) {
      return `${text[4]}-${pad(month)}-${pad(day)}`;
    }
  }
  const num = fragment.match(DATE_NUMERIC);
  if (num) {
    const year = num[3].length === 2 ? `20${num[3]}` : num[3];
    // Format français : jour/mois/année
    return `${year}-${pad(num[2])}-${pad(num[1])}`;
  }
  return null;
}

function findDate(text, labels) {
  const re = new RegExp(`(?:${labels})\\s*[:\\-]?\\s*([^\\n]{4,30})`, "i");
  const m = text.match(re);
  return m ? parseTextDate(m[1]) : null;
}

function firstMatch(text, patterns, parse = (v) => v) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      const v = parse(m[1]);
      if (v !== null && v !== undefined && v !== "") return v;
    }
  }
  return null;
}

/**
 * Numéro de facture : le candidat le plus long parmi tous les motifs (EN,
 * générique, service FR). "2026-INV-0873" bat "INV-0873", "FA-2026-0177" bat
 * "2026" (le motif FR ne capture que les chiffres après "FA-").
 */
function pickInvoiceNumber(text, frCandidate) {
  const candidates = [];
  for (const re of EN_INVOICE_NUMBER) {
    const m = text.match(re);
    if (m?.[1]) candidates.push(m[1]);
  }
  const yearPrefixed = text.match(/\b(\d{4}[-/][A-Z]{2,5}[-/]\d{2,})\b/i);
  if (yearPrefixed?.[1]) candidates.push(yearPrefixed[1]);
  if (frCandidate) candidates.push(String(frCandidate));
  const valid = candidates.filter((c) => /\d/.test(c) && !/^\d{4}$/.test(c));
  if (!valid.length) return null;
  return valid.reduce((best, c) => (c.length > best.length ? c : best));
}

// Token qui ressemble à une référence (2026-INV-0873, FA-2026-0177, 98104)
// et non à un mot du nom d'entreprise
const REFERENCE_TOKEN = /^(?=.*\d)[A-Z0-9]+(?:[-/.][A-Z0-9]+)*$/i;

const NOISE_LINE =
  /^(facture|invoice|receipt|re[çc]u|ticket|devis|quote|bill\s*to|ship\s*to|page)\b/i;

/** Première ligne "propre" du document : en général le nom de l'émetteur. */
export function guessVendorName(text) {
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 8)) {
    if (NOISE_LINE.test(line)) continue;
    const cleaned = line
      .replace(/\b(invoice|facture|re[çc]u|receipt)\b/gi, "")
      .replace(/[|•·]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Un numéro de facture ou une date collés en fin de ligne par l'OCR
    // ("Blue Harbor Supply Co. 2026-INV-0873") ne font pas partie du nom
    const tokens = cleaned.split(" ");
    while (
      tokens.length > 1 &&
      (REFERENCE_TOKEN.test(tokens[tokens.length - 1]) ||
        /^\d/.test(tokens[tokens.length - 1]))
    ) {
      tokens.pop();
    }
    const name = tokens.join(" ").trim();
    const letters = (name.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    if (letters < 3 || name.length > 80) continue;
    if (/\d{5,}/.test(name)) continue; // ligne de SIRET / téléphone / adresse
    return name;
  }
  return null;
}

/**
 * Champs extraits du texte OCR, au format transaction_data / extracted_fields
 * attendu par les services de facture d'achat.
 * @returns {{ transaction_data: Object, extracted_fields: Object, found: boolean }}
 */
export function extractInvoiceFieldsFromText(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return { transaction_data: null, extracted_fields: {}, found: false };
  }

  let fr = null;
  try {
    fr = invoiceExtractionService.extractWithPatterns(raw);
  } catch {
    fr = null;
  }

  const currency = detectCurrency(raw);

  const frTTC =
    parseLocalizedAmount(fr?.netToPay) || parseLocalizedAmount(fr?.totalTTC);
  const enTTC = firstMatch(raw, EN_TOTAL_PATTERNS, parseLocalizedAmount);
  const amount = frTTC || enTTC || 0;

  const frHT =
    parseLocalizedAmount(fr?.totalHT) || parseLocalizedAmount(fr?.totalHtMois);
  const enHT = firstMatch(raw, [EN_SUBTOTAL], parseLocalizedAmount);
  const amountHT = frHT || enHT || 0;

  // Taux : d'abord un pourcentage accolé à un libellé de taxe (Sales tax
  // 10.25 %), sinon le taux FR ("TVA 20 %"), sinon dérivé des montants. Le
  // motif FR seul prendrait le premier "%" venu (remise 3 %...).
  let taxRate = null;
  let taxAmount = parseLocalizedAmount(fr?.tvaAmount) || 0;
  const taxWithRate = raw.match(EN_TAX_WITH_RATE);
  if (taxWithRate) {
    taxRate = parseLocalizedAmount(taxWithRate[1]);
    if (!taxAmount) taxAmount = parseLocalizedAmount(taxWithRate[2]) || 0;
  } else if (!taxAmount) {
    taxAmount = firstMatch(raw, [EN_TAX], parseLocalizedAmount) || 0;
  }
  if (taxRate === null && fr?.tvaRate != null && /\bTVA\b/i.test(raw)) {
    taxRate = parseLocalizedAmount(fr.tvaRate);
  }
  if (fr?.isReverseCharge) {
    taxRate = 0;
    taxAmount = 0;
  }
  if (taxRate === null && amountHT > 0 && taxAmount > 0) {
    taxRate = Math.round((taxAmount / amountHT) * 10000) / 100;
  }

  const documentNumber = pickInvoiceNumber(raw, fr?.invoiceNumber);
  const issueDate =
    parseTextDate(fr?.invoiceDate) ||
    findDate(raw, "issue\\s*date|invoice\\s*date|date\\s*of\\s*issue|date") ||
    null;
  const dueDate =
    parseTextDate(fr?.dueDate) ||
    findDate(raw, "due\\s*date|payment\\s*due|[ée]ch[ée]ance") ||
    null;
  const vendorName = guessVendorName(raw);

  const found = Boolean(amount > 0 || documentNumber || vendorName);

  return {
    found,
    transaction_data: {
      type: "expense",
      vendor_name: vendorName || "",
      amount: amount || 0,
      amount_ht: amountHT || 0,
      tax_amount: taxAmount || 0,
      tax_rate: taxRate,
      transaction_date: issueDate,
      invoice_date: issueDate,
      due_date: dueDate,
      document_number: documentNumber,
      currency: currency || "EUR",
      category: "OTHER",
      payment_method: fr?.paymentMethod || "",
      description: vendorName
        ? `Achat chez ${vendorName}`
        : "Document importé via OCR",
    },
    extracted_fields: {
      vendor_siret: fr?.siret || null,
      vendor_vat_number: fr?.vatNumber || null,
      vendor_email: fr?.email || null,
      vendor_phone: fr?.phone || null,
      vendor_city: fr?.city || "",
      vendor_postal_code: fr?.postalCode || "",
      iban: fr?.iban || null,
      bic: fr?.bic || null,
      totals: {
        total_ht: amountHT || 0,
        total_tax: taxAmount || 0,
        total_ttc: amount || 0,
      },
    },
  };
}

export default {
  detectCurrency,
  parseLocalizedAmount,
  parseTextDate,
  guessVendorName,
  extractInvoiceFieldsFromText,
};
