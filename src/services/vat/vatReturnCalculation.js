import { computeDocumentTotals } from "../../utils/documentTotals.js";

/**
 * Calcul d'une déclaration de TVA à partir des documents d'une période
 * (fonctions pures, sans base de données).
 *
 * Références : formulaire n° 3310-CA3-SD (10963*31) et sa notice
 * n° 3310-NOT-CA3-SD (50449#29), relus le 04/11/2026 :
 * - base et taxe arrondies à l'euro le plus proche, jamais négatives ;
 * - avoirs clients : base en B5 (taxés) ou F8 (non taxés), TVA en ligne 21,
 *   sans toucher aux autres lignes du cadre A ;
 * - avoirs fournisseurs : TVA à reverser en ligne 15 ;
 * - prestations à un preneur établi à l'étranger : E2, même taxées chez lui ;
 * - exigibilité (CGI, art. 269) : livraison de biens à la livraison, assimilée
 *   ici à la facture ; prestation à l'encaissement, sauf option sur les débits.
 *
 * Côté achats, la TVA suit le mode de l'entreprise : date de facture sur les
 * débits, date de paiement sur les encaissements (une facture d'achat ne dit
 * ni si c'est un bien, ni si le fournisseur a opté pour les débits).
 */

export const VAT_MODES = { DEBITS: "debits", ENCAISSEMENTS: "encaissements" };

// Autoliquidation saisie à la main : calculée au taux normal
const REVERSE_CHARGE_RATE = 20;

const KNOWN_RATES = [20, 13, 10, 8.5, 5.5, 2.1, 1.75, 1.05, 0.9];

const EU_COUNTRIES = new Set([
  "allemagne",
  "germany",
  "deutschland",
  "de",
  "autriche",
  "austria",
  "at",
  "belgique",
  "belgium",
  "be",
  "bulgarie",
  "bulgaria",
  "bg",
  "chypre",
  "cyprus",
  "cy",
  "croatie",
  "croatia",
  "hr",
  "danemark",
  "denmark",
  "dk",
  "espagne",
  "spain",
  "es",
  "estonie",
  "estonia",
  "ee",
  "finlande",
  "finland",
  "fi",
  "grece",
  "greece",
  "gr",
  "el",
  "hongrie",
  "hungary",
  "hu",
  "irlande",
  "ireland",
  "ie",
  "italie",
  "italy",
  "it",
  "lettonie",
  "latvia",
  "lv",
  "lituanie",
  "lithuania",
  "lt",
  "luxembourg",
  "lu",
  "malte",
  "malta",
  "mt",
  "pays-bas",
  "pays bas",
  "netherlands",
  "hollande",
  "nl",
  "pologne",
  "poland",
  "pl",
  "portugal",
  "pt",
  "republique tcheque",
  "tchequie",
  "czechia",
  "czech republic",
  "cz",
  "roumanie",
  "romania",
  "ro",
  "slovaquie",
  "slovakia",
  "sk",
  "slovenie",
  "slovenia",
  "si",
  "suede",
  "sweden",
  "se",
]);

const normalizeText = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();

/** Arrondi fiscal : à l'euro le plus proche, 0,50 compté pour 1. */
export const fiscalRound = (value) => Math.round((Number(value) || 0) + 1e-9);

export function normalizeVatMode(value) {
  const mode = normalizeText(value);
  return mode === VAT_MODES.DEBITS || mode === VAT_MODES.ENCAISSEMENTS
    ? mode
    : null;
}

/** Zone du client : France (par défaut sans pays), Union européenne, autre. */
export function countryZone(country) {
  const name = normalizeText(country);
  if (!name || name === "france" || name === "fr" || name === "monaco") {
    return "FR";
  }
  return EU_COUNTRIES.has(name) ? "EU" : "OTHER";
}

/** Lieu de l'entreprise, qui décide de la ligne de certains taux. */
export function companyRegion(zipCode) {
  const zip = String(zipCode ?? "").trim();
  if (/^97/.test(zip)) return "DOM";
  if (/^20/.test(zip)) return "CORSE";
  return "METROPOLE";
}

/** Ligne du cadre B pour un taux, selon le lieu de l'entreprise. */
export function taxedLineForRate(rate, region = "METROPOLE") {
  const value = Number(rate);
  if (value === 20) return { code: "08", label: "Taux normal 20 %" };
  if (value === 5.5) return { code: "09", label: "Taux réduit 5,5 %" };
  if (value === 10) {
    return region === "CORSE"
      ? { code: "T3", label: "Corse, taux de 10 %" }
      : { code: "9B", label: "Taux réduit 10 %" };
  }
  if (value === 8.5) return { code: "10", label: "DOM, taux normal 8,5 %" };
  if (value === 2.1) {
    if (region === "DOM")
      return { code: "11", label: "DOM, taux réduit 2,1 %" };
    if (region === "CORSE")
      return { code: "T4", label: "Corse, taux de 2,1 %" };
    return { code: "T6", label: "France continentale, taux de 2,1 %" };
  }
  if (value === 13) return { code: "TC", label: "Corse, taux de 13 %" };
  if (value === 0.9) return { code: "T5", label: "Corse, taux de 0,9 %" };
  if (value === 1.75) return { code: "T1", label: "DOM, taux de 1,75 %" };
  if (value === 1.05) return { code: "T2", label: "DOM, taux de 1,05 %" };
  return null;
}

/**
 * Ligne du cadre A d'une vente sans TVA. `certain` : le document dit assez de
 * choses pour trancher ; sinon E2 par défaut et un point à vérifier.
 */
export function classifyNonTaxedSale({
  exemptionText,
  country,
  clientVatNumber,
  operationType,
}) {
  const text = normalizeText(exemptionText);
  if (/262\s*ter/.test(text)) return { line: "F2", certain: true };
  if (/\b262\b|export/.test(text)) return { line: "E1", certain: true };

  const zone = countryZone(country);
  if (zone === "EU") {
    if (operationType === "LB") {
      return clientVatNumber
        ? { line: "F2", certain: true }
        : { line: "E2", certain: false };
    }
    return { line: "E2", certain: operationType === "PS" };
  }
  if (zone === "OTHER") {
    if (operationType === "LB") return { line: "E1", certain: true };
    return { line: "E2", certain: operationType === "PS" };
  }
  return { line: "E2", certain: Boolean(text) };
}

const nearestKnownRate = (rate) =>
  KNOWN_RATES.find((known) => Math.abs(known - rate) <= 0.3) ?? null;

/**
 * Répartition d'une facture ou d'un avoir par taux. Les totaux enregistrés
 * font foi : les lignes ne servent qu'à répartir (remise globale, port non
 * remisé, lignes négatives des factures de solde).
 */
export function splitDocumentByRate(doc) {
  const reverse = Boolean(doc.isReverseCharge);
  const groups = new Map();
  const add = (rate, ht, exemptionText) => {
    const key = reverse || !(Number(rate) > 0) ? 0 : Number(rate);
    const group = groups.get(key) || {
      rate: key,
      ht: 0,
      vat: 0,
      exemptionText,
    };
    group.ht += ht;
    group.exemptionText = group.exemptionText || exemptionText;
    groups.set(key, group);
  };

  let itemsHT = 0;
  for (const item of doc.items || []) {
    const { totalHT } = computeDocumentTotals({ items: [item] });
    itemsHT += totalHT;
    add(item.vatRate ?? 0, totalHT, item.vatExemptionText);
  }

  const storedHT = Number(doc.finalTotalHT);
  const storedVAT = Number(doc.finalTotalVAT);
  const shipping = doc.shipping?.billShipping ? doc.shipping : null;
  const shippingHT = shipping ? Number(shipping.shippingAmountHT) || 0 : 0;

  if (Number.isFinite(storedHT) && itemsHT !== 0) {
    const factor = (storedHT - shippingHT) / itemsHT;
    for (const group of groups.values()) group.ht *= factor;
  }
  if (shippingHT) add(shipping.shippingVatRate ?? 20, shippingHT);

  for (const group of groups.values()) {
    group.vat = (group.ht * group.rate) / 100;
  }

  const rawVAT = [...groups.values()].reduce((sum, g) => sum + g.vat, 0);
  if (Number.isFinite(storedVAT) && rawVAT !== 0) {
    const factor = storedVAT / rawVAT;
    for (const group of groups.values()) group.vat *= factor;
  } else if (Number.isFinite(storedVAT) && storedVAT !== 0) {
    // TVA enregistrée sans ligne pour la porter (document sans lignes)
    groups.clear();
    const ht = Number.isFinite(storedHT) ? storedHT : 0;
    const rate = ht ? (storedVAT / ht) * 100 : 0;
    groups.set(rate, {
      rate: nearestKnownRate(rate) ?? rate,
      ht,
      vat: storedVAT,
    });
  } else if (!groups.size && Number.isFinite(storedHT) && storedHT !== 0) {
    groups.set(0, { rate: 0, ht: storedHT, vat: 0 });
  }

  return [...groups.values()];
}

/**
 * Facture importée : les totaux lus par l'OCR font foi. Un seul taux si le
 * rapport TVA / HT tombe sur un taux connu, sinon répartition par les lignes.
 */
export function splitImportedInvoiceByRate(doc) {
  const ht = Number(doc.totalHT) || 0;
  const vat = Number(doc.totalVAT) || 0;
  if (!vat) return ht ? [{ rate: 0, ht, vat: 0 }] : [];

  const effective = ht ? (vat / ht) * 100 : 0;
  const known = nearestKnownRate(effective);
  if (known !== null) return [{ rate: known, ht, vat }];

  const groups = new Map();
  for (const item of doc.items || []) {
    const lineHT =
      Number(item.totalPrice) ||
      (Number(item.quantity) || 0) * (Number(item.unitPrice) || 0);
    const rate = Number(item.vatRate) || 0;
    groups.set(rate, (groups.get(rate) || 0) + lineHT);
  }
  const itemsHT = [...groups.values()].reduce((sum, value) => sum + value, 0);
  const taxedVat = [...groups.entries()].reduce(
    (sum, [rate, value]) => sum + (value * rate) / 100,
    0,
  );
  if (!itemsHT || !taxedVat) return [{ rate: effective, ht, vat }];

  return [...groups.entries()].map(([rate, value]) => ({
    rate,
    ht: (value / itemsHT) * ht,
    vat: ((value * rate) / 100 / taxedVat) * vat,
  }));
}

/**
 * Jour où la TVA d'une vente devient exigible, null si elle ne l'est pas
 * encore. `missingPaymentDate` : payée sans date connue, date de facture
 * retenue et signalée.
 */
export function saleExigibility({
  vatMode,
  operationType,
  issueDay,
  paymentDay,
  isPaid,
}) {
  if (operationType === "LB" || vatMode === VAT_MODES.DEBITS) {
    return { day: issueDay, missingPaymentDate: false };
  }
  if (!isPaid) return { day: null, missingPaymentDate: false };
  return {
    day: paymentDay || issueDay,
    missingPaymentDate: !paymentDay,
  };
}

const ADJUSTMENT_KEYS = [
  "reverseChargeServicesBase",
  "intraCommunityAcquisitionsBase",
  "fixedAssetsVat",
  "otherDeductibleVat",
  "vatToRepay",
  "previousCredit",
  "refundRequested",
  "assimilatedTaxes",
  "installmentsPaid",
];

/** Montants saisis : nombres positifs en euros entiers, le reste vaut 0. */
export function normalizeAdjustments(input = {}) {
  const adjustments = {};
  for (const key of ADJUSTMENT_KEYS) {
    const value = Math.round(Number(input?.[key]));
    adjustments[key] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return adjustments;
}

const line = (code, label, amount, extra = {}) => ({
  code,
  label,
  amount,
  base: null,
  isTotal: false,
  ...extra,
});

/**
 * Totaux et sections affichées d'une déclaration.
 * @param {Object} params
 * @param {Array} params.sales - { taxed: [{rate, ht, vat}], nonTaxed: [{line, ht}] }
 * @param {Array} params.creditNotes - { taxedHT, nonTaxedHT, vat } en valeur absolue
 * @param {Array} params.purchases - { vat } (négative pour un avoir)
 * @param {Object} params.adjustments - voir normalizeAdjustments
 * @param {number} params.carriedCredit - ligne 27 de la déclaration précédente, null si aucune
 * @param {string} params.region - lieu de l'entreprise
 * @param {"CA3"|"CA12"} params.form
 */
export function computeVatReturn({
  sales = [],
  creditNotes = [],
  purchases = [],
  adjustments: rawAdjustments = {},
  carriedCredit = null,
  region = "METROPOLE",
  form = "CA3",
}) {
  const adjustments = normalizeAdjustments(rawAdjustments);

  // Cadre A + bases et taxes du cadre B
  const byRate = new Map();
  const nonTaxed = { E1: 0, E2: 0, F2: 0 };
  const unknownRates = new Set();
  for (const sale of sales) {
    for (const part of sale.taxed || []) {
      const entry = byRate.get(part.rate) || { rate: part.rate, ht: 0, vat: 0 };
      entry.ht += part.ht;
      entry.vat += part.vat;
      byRate.set(part.rate, entry);
    }
    for (const part of sale.nonTaxed || []) nonTaxed[part.line] += part.ht;
  }

  let regularisedBase = 0;
  let regularisedNonTaxed = 0;
  let collectedRegularisation = 0;
  for (const creditNote of creditNotes) {
    regularisedBase += creditNote.taxedHT;
    regularisedNonTaxed += creditNote.nonTaxedHT;
    collectedRegularisation += creditNote.vat;
  }

  // Une base nette négative (lignes de déduction plus fortes que les ventes)
  // ne se déclare pas : elle part en régularisation, comme un avoir
  const taxedLines = [];
  let salesBase = 0;
  for (const entry of [...byRate.values()].sort((a, b) => b.rate - a.rate)) {
    if (entry.ht < 0 || entry.vat < 0) {
      regularisedBase += Math.abs(Math.min(entry.ht, 0));
      collectedRegularisation += Math.abs(Math.min(entry.vat, 0));
      continue;
    }
    const known = taxedLineForRate(entry.rate, region);
    if (!known) unknownRates.add(entry.rate);
    salesBase += entry.ht;
    taxedLines.push({
      code: known?.code ?? "À classer",
      label:
        known?.label ??
        `Taux de ${String(Math.round(entry.rate * 100) / 100).replace(".", ",")} %, à classer sur la bonne ligne`,
      base: fiscalRound(entry.ht),
      amount: fiscalRound(entry.vat),
      rate: entry.rate,
    });
  }

  // Autoliquidation : base et taxe en 08, déduction de la même taxe en 20
  const { reverseChargeServicesBase: a3, intraCommunityAcquisitionsBase: b2 } =
    adjustments;
  const reverseChargeVat = fiscalRound(((a3 + b2) * REVERSE_CHARGE_RATE) / 100);
  const acquisitionsVat = fiscalRound((b2 * REVERSE_CHARGE_RATE) / 100);
  if (a3 + b2 > 0) {
    const normal = taxedLines.find((row) => row.code === "08");
    if (normal) {
      normal.base += a3 + b2;
      normal.amount += reverseChargeVat;
    } else {
      taxedLines.unshift({
        ...taxedLineForRate(REVERSE_CHARGE_RATE, region),
        base: a3 + b2,
        amount: reverseChargeVat,
        rate: REVERSE_CHARGE_RATE,
      });
    }
  }

  // TVA déductible : un avoir fournisseur est reversé en ligne 15
  let deductible = 0;
  let repaid = 0;
  for (const purchase of purchases) {
    if (purchase.vat >= 0) deductible += purchase.vat;
    else repaid += -purchase.vat;
  }

  const line15 = fiscalRound(repaid) + adjustments.vatToRepay;
  const line16 = taxedLines.reduce((sum, row) => sum + row.amount, 0) + line15;
  const line17 = acquisitionsVat;

  const deductibleTotal = fiscalRound(deductible) + reverseChargeVat;
  const line19 = Math.min(adjustments.fixedAssetsVat, deductibleTotal);
  const line20 = deductibleTotal - line19;
  const line21Regularisation = fiscalRound(collectedRegularisation);
  const line21 = line21Regularisation + adjustments.otherDeductibleVat;
  const line22 = carriedCredit ?? adjustments.previousCredit;
  const line23 = line19 + line20 + line21 + line22;

  const line25 = Math.max(0, line23 - line16);
  const lineTD = Math.max(0, line16 - line23);
  const line26 =
    form === "CA3" ? Math.min(adjustments.refundRequested, line25) : 0;
  const line27 = line25 - line26;
  const line29 = form === "CA3" ? adjustments.assimilatedTaxes : 0;
  const installments = form === "CA12" ? adjustments.installmentsPaid : 0;
  const balance = lineTD - installments;
  const totalToPay = form === "CA12" ? Math.max(0, balance) : lineTD + line29;
  const creditToCarry =
    form === "CA12" ? line25 + Math.max(0, -balance) : line27;

  const a1 = fiscalRound(salesBase);
  const b5 = fiscalRound(regularisedBase);
  const f8 = fiscalRound(regularisedNonTaxed);
  const e1 = fiscalRound(nonTaxed.E1);
  const e2 = fiscalRound(nonTaxed.E2);
  const f2 = fiscalRound(nonTaxed.F2);

  const totals = {
    grossVat: line16,
    deductibleVat: line23,
    vatDue: lineTD,
    credit: line25,
    refundRequested: line26,
    creditToCarry,
    assimilatedTaxes: line29,
    installmentsPaid: installments,
    totalToPay,
    taxedBase: a1,
  };

  const isNil =
    a1 + e1 + e2 + f2 + b5 + f8 + a3 + b2 === 0 &&
    line16 + line23 + line29 === 0;

  const sections =
    form === "CA12"
      ? ca12Sections({
          a1,
          nonTaxedTotal: e1 + e2 + f2,
          taxedLines,
          line15,
          line16,
          line19,
          line20,
          line21,
          line22,
          line23,
          lineTD,
          line25,
          installments,
          totalToPay,
          creditToCarry,
        })
      : ca3Sections({
          a1,
          a3,
          b2,
          b5,
          e1,
          e2,
          f2,
          f8,
          taxedLines,
          line15,
          line16,
          line17,
          line19,
          line20,
          line21,
          line21Regularisation,
          line22,
          line23,
          line25,
          lineTD,
          line26,
          line27,
          line29,
          totalToPay,
        });

  return {
    totals,
    sections,
    isNil,
    unknownRates: [...unknownRates],
    nonTaxedAmounts: { E1: e1, E2: e2, F2: f2 },
    adjustments,
  };
}

// Les lignes à zéro ne s'affichent pas : sur impots.gouv.fr, elles restent
// vides. Les totaux, eux, s'affichent toujours.
const visible = (lines) =>
  lines.filter((row) => row.isTotal || row.amount || row.base);

function ca3Sections(v) {
  return [
    {
      key: "operations",
      title: "A. Montant des opérations réalisées",
      lines: visible([
        line("A1", "Ventes, prestations de services", v.a1),
        line(
          "A3",
          "Achats de prestations de services auprès d'un assujetti non établi en France",
          v.a3,
        ),
        line("B2", "Acquisitions intracommunautaires", v.b2),
        line("B5", "Régularisations (avoirs sur opérations taxées)", v.b5),
        line("E1", "Exportations hors UE", v.e1),
        line("E2", "Autres opérations non imposables", v.e2),
        line(
          "F2",
          "Livraisons intracommunautaires à destination d'une personne assujettie",
          v.f2,
        ),
        line("F8", "Régularisations (avoirs sur opérations non taxées)", v.f8),
      ]),
    },
    {
      key: "gross",
      title: "B. TVA brute",
      lines: visible([
        ...v.taxedLines.map((row) =>
          line(row.code, row.label, row.amount, { base: row.base }),
        ),
        line("15", "TVA antérieurement déduite à reverser", v.line15),
        line("16", "Total de la TVA brute due", v.line16, { isTotal: true }),
        line("17", "Dont TVA sur acquisitions intracommunautaires", v.line17),
      ]),
    },
    {
      key: "deductible",
      title: "TVA déductible",
      lines: visible([
        line("19", "Biens constituant des immobilisations", v.line19),
        line("20", "Autres biens et services", v.line20),
        line("21", "Autre TVA à déduire", v.line21, {
          note: v.line21Regularisation
            ? `Dont régularisation de TVA collectée : ${v.line21Regularisation} €`
            : null,
        }),
        line("22", "Report du crédit de la précédente déclaration", v.line22),
        line("23", "Total TVA déductible", v.line23, { isTotal: true }),
      ]),
    },
    {
      key: "result",
      title: "TVA due ou crédit de TVA",
      lines: visible([
        line("25", "Crédit de TVA", v.line25),
        line("TD", "TVA due", v.lineTD),
        line(
          "26",
          "Remboursement de crédit demandé (formulaire n° 3519)",
          v.line26,
        ),
        line("27", "Crédit de TVA à reporter", v.line27),
        line("28", "TVA nette due", v.lineTD),
        line("29", "Taxes assimilées (annexe n° 3310-A)", v.line29),
        line("32", "Total à payer", v.totalToPay, { isTotal: true }),
      ]),
    },
  ];
}

// La CA12 n'a pas les mêmes numéros de ligne : récapitulatif sans numéro
function ca12Sections(v) {
  return [
    {
      key: "operations",
      title: "Opérations de l'exercice",
      lines: visible([
        line(null, "Ventes et prestations taxées (HT)", v.a1),
        line(null, "Opérations non taxées (HT)", v.nonTaxedTotal),
      ]),
    },
    {
      key: "gross",
      title: "TVA brute",
      lines: visible([
        ...v.taxedLines.map((row) =>
          line(null, row.label, row.amount, { base: row.base }),
        ),
        line(null, "TVA antérieurement déduite à reverser", v.line15),
        line(null, "Total de la TVA brute", v.line16, { isTotal: true }),
      ]),
    },
    {
      key: "deductible",
      title: "TVA déductible",
      lines: visible([
        line(null, "Immobilisations", v.line19),
        line(null, "Autres biens et services", v.line20),
        line(null, "Autre TVA à déduire", v.line21),
        line(null, "Crédit reporté de l'exercice précédent", v.line22),
        line(null, "Total de la TVA déductible", v.line23, { isTotal: true }),
      ]),
    },
    {
      key: "result",
      title: "Solde de l'exercice",
      lines: visible([
        line(null, "TVA due sur l'exercice", v.lineTD),
        line(null, "Crédit de TVA de l'exercice", v.line25),
        line(null, "Acomptes déjà versés", v.installments),
        line(null, "Crédit à reporter", v.creditToCarry),
        line(null, "Solde à payer", v.totalToPay, { isTotal: true }),
      ]),
    },
  ];
}
