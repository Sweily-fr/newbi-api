/**
 * Construction des lignes d'une facture liée à un devis (acompte, facture
 * partielle, facture de solde).
 *
 * La facture liée ne reprend pas les lignes du devis : elle porte un montant
 * TTC à facturer, ramené au HT pour tenir dans une ligne unique. Le taux de TVA
 * de cette conversion était écrit en dur à 20 %, ce qui faussait la ventilation
 * HT / TVA de tout devis à un autre taux (un devis à 5,5 % ressortait en facture
 * à 20 % : même TTC, mais TVA collectée fausse).
 *
 * Le taux est donc repris du devis. Si le devis mélange plusieurs taux, une
 * seule ligne ne peut pas être juste : on émet une ligne par taux, au prorata du
 * TTC que chaque taux représente dans le devis. La remise globale, la retenue de
 * garantie et l'escompte s'appliquent proportionnellement à tous les taux, ils ne
 * changent donc pas ces parts.
 *
 * Ce module est dupliqué à l'identique dans NewbiV2
 * (src/utils/linked-invoice-items.js) et dans l'app mobile
 * (lib/linkedInvoiceItems.js) : les trois chemins de création d'une facture liée
 * doivent produire les mêmes lignes.
 */

const DEFAULT_ITEM = {
  quantity: 1,
  unit: "forfait",
  discount: 0,
  discountType: "FIXED",
  details: "",
};

/** Taux de repli quand le devis ne permet rien de déduire (comportement historique). */
const FALLBACK_VAT_RATE = 20;

/**
 * Mentions portées par une ligne à 0 % : le modèle (schemas/item.js) exige un
 * vatExemptionText non vide quand vatRate vaut 0, et vide sinon.
 */
export const REVERSE_CHARGE_MENTION =
  "Autoliquidation - TVA due par le preneur (art. 283-2 du CGI)";
export const VAT_EXEMPT_MENTION = "TVA non applicable, art. L. 223-3 du CIBS";

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** "5,5" / "20" pour l'affichage dans le libellé d'une ligne. */
const formatRate = (rate) => String(rate).replace(".", ",");

/** HT d'une ligne de devis, avancement et remise de ligne appliqués. */
const itemTotalHT = (item) => {
  const progress =
    item?.progressPercentage === undefined || item?.progressPercentage === null
      ? 100
      : toNumber(item.progressPercentage);

  let ht =
    toNumber(item?.quantity) * toNumber(item?.unitPrice) * (progress / 100);

  if (item?.discount) {
    const type = String(item.discountType || "").toUpperCase();
    ht =
      type === "PERCENTAGE"
        ? ht * (1 - Math.min(toNumber(item.discount), 100) / 100)
        : Math.max(0, ht - toNumber(item.discount));
  }

  return ht;
};

/**
 * TTC du devis ventilé par taux de TVA (mêmes règles que calculateInvoiceTotals),
 * avec la mention d'exonération rencontrée pour un taux à 0.
 *
 * @returns {Map<number, {ttc: number, exemptionText: string}>}
 */
export function vatBreakdown(quote) {
  const breakdown = new Map();
  const add = (rate, ttc, exemptionText) => {
    if (ttc <= 0) return;
    const current = breakdown.get(rate) || { ttc: 0, exemptionText: "" };
    breakdown.set(rate, {
      ttc: current.ttc + ttc,
      exemptionText: current.exemptionText || exemptionText || "",
    });
  };

  const items = Array.isArray(quote?.items) ? quote.items : [];
  for (const item of items) {
    const rate = toNumber(item?.vatRate);
    add(rate, itemTotalHT(item) * (1 + rate / 100), item?.vatExemptionText);
  }

  if (quote?.shipping?.billShipping) {
    const rate = toNumber(quote.shipping.shippingVatRate);
    add(rate, toNumber(quote.shipping.shippingAmountHT) * (1 + rate / 100), "");
  }

  return breakdown;
}

/**
 * Lignes d'une facture liée pour un montant TTC donné.
 *
 * @param {Object} params
 * @param {Object} params.quote - Devis source (items, shipping, indicateurs TVA)
 * @param {number} params.amountTTC - Montant TTC à facturer
 * @param {string} params.description - Libellé (ex: "Facture sur devis D-092026-0002")
 * @returns {Array<Object>} une ligne par taux de TVA concerné
 */
export function buildLinkedInvoiceItems({ quote, amountTTC, description }) {
  const amount = toNumber(amountTTC);

  const line = (unitPrice, vatRate, label, exemptionText = "") => ({
    ...DEFAULT_ITEM,
    description: label,
    unitPrice,
    vatRate,
    // Obligatoire à 0 %, interdit sinon (cf. models/schemas/item.js).
    vatExemptionText:
      vatRate === 0 ? exemptionText || VAT_EXEMPT_MENTION : "",
  });

  // Auto-liquidation / franchise en base : la facture liée ne porte pas de TVA,
  // le montant saisi est donc à la fois le HT et le TTC.
  if (quote?.isReverseCharge) {
    return [line(amount, 0, description, REVERSE_CHARGE_MENTION)];
  }
  if (quote?.isVatExempt) {
    return [line(amount, 0, description, VAT_EXEMPT_MENTION)];
  }

  const breakdown = vatBreakdown(quote);
  const totalTTC = [...breakdown.values()].reduce(
    (sum, { ttc }) => sum + ttc,
    0,
  );

  // Devis sans montant exploitable : on garde une ligne unique, au taux de la
  // première ligne du devis à défaut de mieux.
  if (breakdown.size === 0 || totalTTC <= 0) {
    const firstItem = quote?.items?.[0];
    const rate =
      firstItem?.vatRate === undefined || firstItem?.vatRate === null
        ? FALLBACK_VAT_RATE
        : toNumber(firstItem.vatRate);
    return [
      line(
        amount / (1 + rate / 100),
        rate,
        description,
        firstItem?.vatExemptionText,
      ),
    ];
  }

  // Taux unique : le cas courant, une seule ligne au taux du devis.
  if (breakdown.size === 1) {
    const [[rate, { exemptionText }]] = [...breakdown.entries()];
    return [line(amount / (1 + rate / 100), rate, description, exemptionText)];
  }

  // Devis multi-taux : une ligne par taux, au prorata du TTC de chaque taux.
  // Parts décroissantes pour que le reliquat d'arrondi tombe sur la plus petite.
  const rates = [...breakdown.entries()].sort((a, b) => b[1].ttc - a[1].ttc);
  let remainingCents = Math.round(amount * 100);
  const lines = [];

  rates.forEach(([rate, { ttc, exemptionText }], index) => {
    const cents =
      index === rates.length - 1
        ? remainingCents
        : Math.round(amount * (ttc / totalTTC) * 100);
    remainingCents -= cents;
    if (cents <= 0) return;
    lines.push(
      line(
        cents / 100 / (1 + rate / 100),
        rate,
        `${description} (TVA ${formatRate(rate)} %)`,
        exemptionText,
      ),
    );
  });

  return lines;
}
