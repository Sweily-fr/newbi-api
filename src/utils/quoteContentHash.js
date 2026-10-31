import crypto from "crypto";

/**
 * Empreinte du contenu d'un devis tel qu'envoyé en signature : articles,
 * montants, remise, port, client, entreprise, dates, conditions et mentions.
 * Les champs techniques (statut, suivi des e-mails, PDF en cache, archive,
 * synchronisations) n'y entrent pas. Deux lectures du même devis en base
 * donnent la même empreinte ; toute modification de contenu la change.
 */
const QUOTE_CONTENT_FIELDS = [
  "prefix",
  "number",
  "issueDate",
  "validUntil",
  "client",
  "companyInfo",
  "items",
  "discount",
  "discountType",
  "shipping",
  "retenueGarantie",
  "escompte",
  "isReverseCharge",
  "isVatExempt",
  "operationType",
  "customFields",
  "headerNotes",
  "footerNotes",
  "termsAndConditions",
  "termsAndConditionsLinkTitle",
  "termsAndConditionsLink",
  "showBankDetails",
  "totalHT",
  "totalVAT",
  "totalTTC",
  "finalTotalHT",
  "finalTotalVAT",
  "finalTotalTTC",
];

// Forme canonique : clés triées, _id et valeurs vides retirés, dates en ISO
function canonical(value) {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value._bsontype === "ObjectId") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((v) => canonical(v) ?? null);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "_id" || key === "__v") continue;
      const v = canonical(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

/**
 * @param {Object} quote - devis (document Mongoose ou objet lean)
 * @returns {string} empreinte SHA-256 hexadécimale
 */
export function quoteContentHash(quote) {
  const source =
    typeof quote?.toObject === "function"
      ? quote.toObject({ depopulate: true, virtuals: false })
      : quote || {};
  const picked = {};
  for (const field of QUOTE_CONTENT_FIELDS) picked[field] = source[field];
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(picked)))
    .digest("hex");
}

export default quoteContentHash;
