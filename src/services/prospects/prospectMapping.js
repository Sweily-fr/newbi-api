import {
  PHONE_REGEX,
  NAME_REGEX,
  STREET_REGEX,
  CITY_REGEX,
  isValidEmail,
} from "../../utils/validators.js";

/**
 * Passage d'une fiche Societeinfo à une fiche client Newbi.
 */

// Adresses à proposer en premier pour une prise de contact commerciale
const PREFERRED_LOCAL_PARTS = [
  "contact",
  "accueil",
  "info",
  "infos",
  "bonjour",
  "hello",
  "commercial",
  "devis",
  "direction",
];
// Adresses de service interne : gardées en dernier recours seulement
const AVOIDED_LOCAL_PARTS =
  /^(factur|compta|comptabilite|invoice|paie|rh|recrutement|jobs?|webmaster|admin|postmaster|abuse|dpo|rgpd)/;
// Jamais : une réponse n'arrivera pas
const REJECTED_LOCAL_PARTS = /^(no-?reply|ne-?pas-?repondre|mailer-daemon)/;
const INVALID_TEST_RESULTS = new Set(["invalid", "undeliverable", "rejected"]);

function emailCandidates(contacts = {}) {
  const list = [];
  for (const e of contacts.emails || []) {
    if (typeof e === "string") list.push({ value: e });
    else if (e?.value) list.push(e);
  }
  if (contacts.email) list.push({ value: contacts.email });
  return list;
}

function emailScore(candidate) {
  const value = String(candidate.value).trim().toLowerCase();
  const local = value.split("@")[0] || "";
  if (!isValidEmail(value) || REJECTED_LOCAL_PARTS.test(local)) return null;
  const test = String(candidate.email_test_result || "").toLowerCase();
  if (INVALID_TEST_RESULTS.has(test)) return null;

  let score = 0;
  if (PREFERRED_LOCAL_PARTS.includes(local)) score += 3;
  if (AVOIDED_LOCAL_PARTS.test(local)) score -= 5;
  if (test === "valid" || test === "safe") score += 2;
  return score;
}

/**
 * Meilleur email générique de l'entreprise : contact@ ou accueil@ avant
 * facturation@ ou compta@, jamais une adresse « no-reply » ni une adresse
 * déclarée invalide par le fournisseur.
 */
export function pickBestEmail(contacts) {
  let best = null;
  let bestScore = -Infinity;
  const seen = new Set();
  for (const candidate of emailCandidates(contacts)) {
    const value = String(candidate.value).trim().toLowerCase();
    if (seen.has(value)) continue;
    seen.add(value);
    const score = emailScore(candidate);
    if (score !== null && score > bestScore) {
      best = value;
      bestScore = score;
    }
  }
  return best;
}

/** « 0549513030 », « +33 5 49… » → « 05 49 51 30 30 » ; null si inexploitable. */
export function formatFrenchPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0033")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("33") && digits.length === 11) {
    digits = `0${digits.slice(2)}`;
  }
  if (/^0[1-9]\d{8}$/.test(digits))
    return digits.replace(/(\d{2})(?=\d)/g, "$1 ");
  const trimmed = String(raw).trim();
  return PHONE_REGEX.test(trimmed) ? trimmed : null;
}

export function pickPhone(contacts = {}) {
  for (const p of contacts.phones || []) {
    const phone = formatFrenchPhone(typeof p === "string" ? p : p?.value);
    if (phone) return phone;
  }
  return null;
}

const keepIf = (value, regex) => {
  const v = typeof value === "string" ? value.trim() : "";
  return v && regex.test(v) ? v : undefined;
};

/** « 2012-05-14 » → Date ; null si absente ou fictive (« 1970-01-01 » du fournisseur). */
export function parseCreationDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1800) return null;
  return value.startsWith("1970-01-01") ? null : date;
}

/**
 * Champs de la fiche client à partir de la fiche Societeinfo (`result` de
 * company.json). Les contacts peuvent être rangés à la racine ou sous
 * `organization` selon la réponse : on lit les deux.
 */
export function mapCompanyToClient(company, fallback = {}) {
  const org = company?.organization || {};
  const contacts = company?.contacts || org.contacts || {};
  const address = org.address || {};

  const rawName = org.name || fallback.name || "";
  const name = keepIf(rawName.slice(0, 200), NAME_REGEX);
  const siren = org.registration_number || fallback.siren || null;

  return {
    name,
    siren,
    siret: siren,
    email: pickBestEmail(contacts),
    phone: pickPhone(contacts),
    vatNumber: org.vat_number || undefined,
    address: {
      street: keepIf(address.street, STREET_REGEX),
      postalCode: address.postal_code || fallback.postalCode || undefined,
      city: keepIf(address.city || fallback.city, CITY_REGEX),
      country: "France",
    },
    website:
      company?.web_infos?.website_url || org.web_infos?.website_url || null,
    activityLabel: org.activity?.ape_name || fallback.activity || null,
    companyCreatedAt: parseCreationDate(org.creation_date),
  };
}
