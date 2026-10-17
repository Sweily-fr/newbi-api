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

// Taux légaux (métropole, Corse, DOM), préférés au quotient brut quand ils
// redonnent la TVA au centime près
const LEGAL_VAT_RATES = [20, 10, 5.5, 2.1, 13, 0.9, 8.5, 1.75, 1.05];

/**
 * Taux d'une facture dont le taux n'est pas connu (non lu par l'OCR, champ
 * vidé), déduit des montants plutôt que fixé à 20 % : sans TVA, 0 % (et non
 * « TVA 0 € à 20 % »). Base : le HT, sinon TTC - TVA. 8,33 € de HT pour
 * 1,67 € de TVA donnent 20 % et non 20,05 %. 20 % ne reste qu'en dernier
 * recours : TVA connue sans aucune base.
 */
export function deriveVatRate({ amountHT, amountTVA, amountTTC } = {}) {
  const tva = Math.abs(toNumber(amountTVA) ?? 0);
  if (tva === 0) return 0;
  const ht = Math.abs(toNumber(amountHT) ?? 0);
  const ttc = Math.abs(toNumber(amountTTC) ?? 0);
  const base = ht > 0 ? ht : ttc > tva ? round2(ttc - tva) : 0;
  if (base === 0) return 20;
  const raw = (tva / base) * 100;
  // Comparaison en centimes entiers (1,77 - 1,76 ne vaut pas 0,01 en flottant)
  const legal = LEGAL_VAT_RATES.filter(
    (rate) => Math.abs(Math.round(base * rate) - Math.round(tva * 100)) <= 1,
  );
  if (legal.length === 0) return round2(raw);
  return legal.reduce((a, b) =>
    Math.abs(b - raw) < Math.abs(a - raw) ? b : a,
  );
}

const isLegalVatRate = (rate) => LEGAL_VAT_RATES.includes(rate);

// Taux qui redonne la TVA au centime près (en centimes entiers)
const rateMatchesAmounts = (rate, ht, tva) =>
  Math.abs(Math.round(Math.abs(ht) * rate) - Math.round(Math.abs(tva) * 100)) <=
  1;

// HT et TVA positifs qui donnent un taux légal
const formsLegalRate = (ht, tva) =>
  ht > 0 &&
  tva > 0 &&
  isLegalVatRate(deriveVatRate({ amountHT: ht, amountTVA: tva }));

// Taux final : celui fourni s'il redonne la TVA (un taux légal qui la redonne
// aussi lui est préféré : 20,05 % devient 20 %), sinon celui des montants
const settleVatRate = (rate, ht, tva) => {
  const derived = deriveVatRate({ amountHT: ht, amountTVA: tva });
  const matches =
    rate !== null &&
    (tva === 0 ? rate === 0 : ht !== 0 && rateMatchesAmounts(rate, ht, tva));
  const keep =
    matches && (rate === 0 || isLegalVatRate(rate) || !isLegalVatRate(derived));
  return keep ? rate : derived;
};

/**
 * Complète des montants de TVA partiels (lecture OCR, saisie) de façon
 * cohérente. null = inconnu, 0 = valeur connue.
 * - HT et TVA connus et cohérents entre eux (relié par le taux fourni, ou
 *   formant un taux légal) : gardés même si le TTC diffère, qui peut porter
 *   une part hors TVA (taxe de séjour, débours, acompte déduit). Incohérents
 *   et en désaccord avec le TTC : le TTC corrige la lecture qui redonne alors
 *   un taux légal.
 * - TVA connue seule : HT = TVA / taux si un taux légal est fourni (le reste
 *   du TTC est hors TVA), sinon TTC - TVA.
 * - HT connu seul : TVA = HT x taux si un taux légal est fourni ; sinon TTC -
 *   HT s'il forme un taux légal (une taxe d'assurance n'est pas de la TVA),
 *   à défaut 0 (fillMissingVat) ou inconnue.
 * - Ni HT ni TVA : HT = TTC / (1 + taux) si un taux est fourni (fromRate),
 *   sinon sans TVA, HT = TTC et 0 % (fillMissingVat).
 * Le taux fourni n'est gardé que s'il redonne la TVA (les moteurs OCR en
 * fabriquent : 5,5 % arrondi à 6, 0 % par défaut), un taux légal qui la
 * redonne aussi lui étant préféré ; sinon il est déduit (deriveVatRate).
 */
export function completeVatAmounts(
  { amountHT, amountTVA, amountTTC, vatRate } = {},
  { fillMissingVat = false, fromRate = true } = {},
) {
  let ht = toNumber(amountHT);
  let tva = toNumber(amountTVA);
  let ttc = toNumber(amountTTC);
  let rate = toNumber(vatRate);
  if (rate !== null && (rate < 0 || rate > 100)) rate = null;
  // TVA plus grande que le TTC : lecture impossible, donc inconnue
  if (ttc !== null && ttc > 0 && tva !== null && tva > ttc) tva = null;
  const legalRateGiven = rate !== null && (rate === 0 || isLegalVatRate(rate));

  if (ht !== null && tva !== null) {
    if (ttc === null) ttc = round2(ht + tva);
    const coherent =
      (rate !== null &&
        (tva === 0 ? rate === 0 : rateMatchesAmounts(rate, ht, tva))) ||
      formsLegalRate(ht, tva);
    if (!coherent && ttc > 0 && Math.abs(round2(ht + tva) - ttc) > 0.01) {
      if (formsLegalRate(round2(ttc - tva), tva)) ht = round2(ttc - tva);
      else if (formsLegalRate(ht, round2(ttc - ht))) tva = round2(ttc - ht);
    }
  } else if (ttc !== null && ttc > 0) {
    if (tva !== null) {
      const htFromRate =
        legalRateGiven && rate > 0 && tva > 0
          ? round2((tva * 100) / rate)
          : null;
      ht =
        htFromRate !== null && htFromRate <= round2(ttc - tva) + 0.01
          ? htFromRate
          : round2(ttc - tva);
    } else if (ht !== null) {
      if (legalRateGiven) {
        tva = round2((ht * rate) / 100);
      } else {
        const rest = round2(ttc - ht);
        if (rest === 0 || formsLegalRate(ht, rest)) tva = rest;
        else if (fillMissingVat) tva = 0;
      }
    } else if (fromRate && rate !== null) {
      ht = round2(ttc / (1 + rate / 100));
      tva = round2(ttc - ht);
    } else if (fillMissingVat) {
      ht = ttc;
      tva = 0;
    }
  }

  if (ht !== null && tva !== null) rate = settleVatRate(rate, ht, tva);
  return { amountHT: ht, amountTVA: tva, amountTTC: ttc, vatRate: rate };
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
