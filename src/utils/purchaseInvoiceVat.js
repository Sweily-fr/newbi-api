/**
 * Ventilation de la TVA d'une facture d'achat par taux.
 *
 * Une même facture peut mêler plusieurs taux (restaurant 10 % + boissons
 * alcoolisées 20 %, librairie 5,5 % + papeterie 20 %...). Les champs
 * historiques amountHT / amountTVA / vatRate n'en décrivent qu'un : le détail
 * est porté par `vatBreakdown` (une ligne par taux : base HT et montant de
 * TVA), et les champs historiques en deviennent le résumé (sommes, taux de la
 * plus grosse base) pour tous leurs lecteurs existants (exports, Pennylane,
 * analytics, app mobile).
 *
 * Le détail n'est conservé qu'à partir de deux taux : une facture à taux
 * unique reste décrite par les seuls champs historiques, comme avant.
 */

const round2 = (n) => Math.round(n * 100) / 100;

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  // Montants structurés e-invoicing : { value: "12.50", currency_code }
  const raw =
    typeof value === "object" && value !== null && "value" in value
      ? value.value
      : value;
  const n =
    typeof raw === "string" ? parseFloat(raw.replace(",", ".")) : Number(raw);
  return Number.isFinite(n) ? n : null;
};

const firstNumber = (line, keys) => {
  for (const key of keys) {
    const n = toNumber(line[key]);
    if (n !== null) return n;
  }
  return null;
};

// Noms des champs selon la source : saisie Newbi, Claude Vision
// (rate/base/amount), analyse Mistral et extraction hybride
// (base_amount/tax_amount), e-invoicing EN16931 (vat_category_*).
const RATE_KEYS = ["rate", "vat_category_rate", "vatRate"];
const BASE_KEYS = [
  "baseHT",
  "base",
  "base_amount",
  "taxable_amount",
  "vat_category_taxable_amount",
];
const AMOUNT_KEYS = [
  "amountTVA",
  "amount",
  "tax_amount",
  "vat_category_tax_amount",
];

/**
 * Lignes de TVA propres : une par taux (taux identiques additionnés), triées
 * du plus fort au plus faible taux. Une ligne sans base ni montant, ou dont
 * l'un ne peut pas être déduit de l'autre, est écartée. Les taxes qui ne sont
 * pas de la TVA (éco-participation DEEE lue par l'analyse Mistral) aussi.
 */
export function normalizeVatBreakdown(lines) {
  if (!Array.isArray(lines)) return [];
  const byRate = new Map();
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    if (typeof line.type === "string" && !/tva|vat/i.test(line.type)) continue;
    const rate = firstNumber(line, RATE_KEYS);
    if (rate === null || rate < 0 || rate > 100) continue;
    let base = firstNumber(line, BASE_KEYS);
    let amount = firstNumber(line, AMOUNT_KEYS);
    if (amount === null && base !== null) amount = round2((base * rate) / 100);
    if (base === null && amount !== null && rate > 0) {
      base = round2((amount * 100) / rate);
    }
    if (base === null || amount === null) continue;
    if (base === 0 && amount === 0) continue;
    const key = round2(rate);
    const current = byRate.get(key) || { rate: key, baseHT: 0, amountTVA: 0 };
    current.baseHT += base;
    current.amountTVA += amount;
    byRate.set(key, current);
  }
  return [...byRate.values()]
    .map((l) => ({
      rate: l.rate,
      baseHT: round2(l.baseHT),
      amountTVA: round2(l.amountTVA),
    }))
    .sort((a, b) => b.rate - a.rate);
}

/**
 * Résumé d'une ventilation dans les champs historiques : HT et TVA
 * additionnés, taux = celui de la plus grosse base (le plus fort à égalité).
 */
export function summarizeVatBreakdown(lines) {
  const clean = normalizeVatBreakdown(lines);
  if (clean.length === 0) return null;
  const main = clean.reduce((a, b) =>
    Math.abs(b.baseHT) > Math.abs(a.baseHT) ? b : a,
  );
  return {
    amountHT: round2(clean.reduce((s, l) => s + l.baseHT, 0)),
    amountTVA: round2(clean.reduce((s, l) => s + l.amountTVA, 0)),
    vatRate: main.rate,
  };
}

/** Ventilation ramenée dans une autre devise (taux de change ou prorata). */
export function scaleVatBreakdown(lines, ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return [];
  return normalizeVatBreakdown(
    (lines || []).map((l) => ({
      rate: l.rate,
      baseHT: round2(l.baseHT * ratio),
      amountTVA: round2(l.amountTVA * ratio),
    })),
  );
}

/** Plusieurs documents additionnés : lignes de même taux fusionnées. */
export function mergeVatBreakdowns(lists) {
  return normalizeVatBreakdown((lists || []).flat());
}

/**
 * Ventilation lue par l'OCR (extracted_fields.tax_details), retenue seulement
 * si elle compte au moins deux taux et que la somme de ses TVA correspond au
 * total de TVA lu sur le document (à 1 % ou 5 centimes près). Une lecture
 * incohérente est écartée : le total lu reste alors la seule référence, comme
 * avant, plutôt qu'un détail faux.
 */
export function vatBreakdownFromOcr(financial, { expectedTVA = null } = {}) {
  const lines = normalizeVatBreakdown(financial?.extracted_fields?.tax_details);
  if (lines.length < 2) return [];
  const expected = toNumber(expectedTVA);
  if (expected !== null && expected > 0) {
    const total = lines.reduce((s, l) => s + l.amountTVA, 0);
    if (Math.abs(total - expected) > Math.max(0.05, expected * 0.01)) {
      return [];
    }
  }
  return lines;
}

/**
 * Applique une ventilation saisie ou lue à une facture (document Mongoose ou
 * objet de création) : à partir de deux taux, le détail est gardé et les
 * champs historiques en sont le résumé ; un seul taux redevient les champs
 * historiques seuls ; une liste vide efface le détail.
 */
export function applyVatBreakdown(target, lines) {
  const clean = normalizeVatBreakdown(lines);
  if (clean.length >= 2) {
    const summary = summarizeVatBreakdown(clean);
    target.vatBreakdown = clean;
    target.amountHT = summary.amountHT;
    target.amountTVA = summary.amountTVA;
    target.vatRate = summary.vatRate;
    return target;
  }
  target.vatBreakdown = [];
  if (clean.length === 1) {
    target.amountHT = clean[0].baseHT;
    target.amountTVA = clean[0].amountTVA;
    target.vatRate = clean[0].rate;
  }
  return target;
}

/**
 * Mise à jour qui touche aux champs historiques de TVA sans fournir de
 * ventilation (app mobile, ancien client) : le détail n'est gardé que si ces
 * champs restent ceux qu'il résume. Une TVA réellement modifiée à un seul
 * taux remplace le détail, qui ne correspondrait plus.
 */
export function scalarVatEditBreaksBreakdown(invoice, input) {
  if (!invoice?.vatBreakdown?.length) return false;
  return ["amountHT", "amountTVA", "vatRate"].some((key) => {
    if (input[key] === undefined || input[key] === null) return false;
    const next = toNumber(input[key]);
    const current = toNumber(invoice[key]);
    return (
      next === null || current === null || Math.abs(next - current) > 0.005
    );
  });
}
