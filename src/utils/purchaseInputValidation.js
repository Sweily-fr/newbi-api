import { AppError, ERROR_CODES } from "./errors.js";

/**
 * Valeurs envoyées à l'API pour une facture d'achat, une fiche fournisseur
 * ou une transaction (appel direct, application mobile, formulaire) :
 * refusées avec un message quand elles ne peuvent pas être justes. Seules
 * les valeurs reçues sont contrôlées : un document existant n'est jamais
 * modifié ni bloqué pour un champ que la requête ne touche pas.
 */

const invalid = (message) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR);

const provided = (value) => value !== undefined && value !== null;

// Codes ISO 4217 connus du moteur Intl (Node 18+), repli sur la forme seule
const KNOWN_CURRENCIES = (() => {
  try {
    return new Set(Intl.supportedValuesOf("currency"));
  } catch {
    return null;
  }
})();

// Symboles qu'une saisie ou une lecture de document peut donner à la place
// du code : ramenés au code, la facture s'affiche et se convertit.
const CURRENCY_SYMBOLS = { "€": "EUR", $: "USD", "£": "GBP" };

export const MAX_SUPPLIER_NAME_LENGTH = 200;
export const MAX_INVOICE_NUMBER_LENGTH = 100;
export const MAX_TRANSACTION_DESCRIPTION_LENGTH = 500;
export const MAX_TRANSACTION_NOTES_LENGTH = 2000;

/**
 * Code de devise à trois lettres (« usd » → « USD », « € » → « EUR »).
 * Refuse tout le reste (« EURO », balise, code inconnu).
 */
export function normalizeCurrency(currency) {
  if (!provided(currency)) return currency;
  const raw = String(currency).trim();
  const code = (CURRENCY_SYMBOLS[raw] || raw).toUpperCase();
  const known = KNOWN_CURRENCIES ? KNOWN_CURRENCIES.has(code) : true;
  if (!/^[A-Z]{3}$/.test(code) || !known) {
    throw invalid(
      "Devise invalide : indiquez un code de devise à trois lettres (EUR, USD, GBP…).",
    );
  }
  return code;
}

const assertRate = (rate) => {
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw invalid(
      "Taux de TVA invalide : il doit être compris entre 0 et 100 %.",
    );
  }
};

const assertNotNegative = (value, label) => {
  if (provided(value) && (!Number.isFinite(value) || value < 0)) {
    throw invalid(`${label} ne peut pas être négatif.`);
  }
};

const assertMaxLength = (value, max, label) => {
  if (provided(value) && String(value).length > max) {
    throw invalid(`${label} ne peut pas dépasser ${max} caractères.`);
  }
};

/**
 * Contrôle (et normalise la devise de) la saisie d'une facture d'achat.
 * `existing` : la facture modifiée, pour comparer la TVA à son TTC quand la
 * requête ne change que l'un des deux.
 * Modifie `input.currency` en place quand elle est fournie.
 */
export function validatePurchaseInvoiceInput(input, { existing = null } = {}) {
  if (!input) return input;

  assertMaxLength(
    input.supplierName,
    MAX_SUPPLIER_NAME_LENGTH,
    "Le nom du fournisseur",
  );
  assertMaxLength(
    input.invoiceNumber,
    MAX_INVOICE_NUMBER_LENGTH,
    "Le numéro de facture",
  );

  if (provided(input.currency)) {
    input.currency = normalizeCurrency(input.currency);
  }

  for (const key of ["issueDate", "dueDate", "paymentDate"]) {
    const value = input[key];
    if (
      provided(value) &&
      value !== "" &&
      Number.isNaN(new Date(value).getTime())
    ) {
      throw invalid("Date invalide : utilisez le format AAAA-MM-JJ.");
    }
  }

  if (provided(input.vatRate)) assertRate(input.vatRate);
  assertNotNegative(input.amountHT, "Le montant HT");
  assertNotNegative(input.amountTVA, "La TVA");

  let breakdownTVA = null;
  if (Array.isArray(input.vatBreakdown)) {
    breakdownTVA = 0;
    for (const line of input.vatBreakdown) {
      assertRate(line?.rate);
      assertNotNegative(line?.baseHT, "La base HT d'un taux");
      assertNotNegative(line?.amountTVA, "La TVA d'un taux");
      breakdownTVA += Number(line?.amountTVA) || 0;
    }
  }

  const ttc = provided(input.amountTTC)
    ? input.amountTTC
    : (existing?.amountTTC ?? null);
  const tva =
    breakdownTVA !== null && input.vatBreakdown.length >= 2
      ? breakdownTVA
      : provided(input.amountTVA)
        ? input.amountTVA
        : null;
  if (ttc !== null && tva !== null && tva > ttc + 0.005) {
    throw invalid("La TVA ne peut pas dépasser le montant TTC.");
  }
  return input;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Contrôle la saisie d'une fiche fournisseur : e-mail, SIRET (14 chiffres,
 * ou SIREN à 9 comme le permet l'app mobile ; espaces retirés) et IBAN
 * (forme : pays, clé, 11 à 30 caractères ; espaces retirés, en majuscules).
 * Normalise SIRET et IBAN en place.
 */
export function validateSupplierInput(input) {
  if (!input) return input;
  if (provided(input.email) && input.email !== "") {
    if (!EMAIL_RE.test(String(input.email).trim())) {
      throw invalid("Adresse e-mail du fournisseur invalide.");
    }
  }
  if (provided(input.siret) && input.siret !== "") {
    const siret = String(input.siret).replace(/\s+/g, "");
    if (!/^(\d{9}|\d{14})$/.test(siret)) {
      throw invalid(
        "SIRET invalide : 14 chiffres attendus (ou SIREN à 9 chiffres).",
      );
    }
    input.siret = siret;
  }
  if (provided(input.iban) && input.iban !== "") {
    const iban = String(input.iban).replace(/\s+/g, "").toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) {
      throw invalid("IBAN invalide : vérifiez le pays, la clé et le numéro.");
    }
    input.iban = iban;
  }
  return input;
}

/** Libellé et notes d'une transaction : longueurs bornées. */
export function validateTransactionTextInput(input) {
  if (!input) return input;
  assertMaxLength(
    input.description,
    MAX_TRANSACTION_DESCRIPTION_LENGTH,
    "Le libellé",
  );
  assertMaxLength(input.notes, MAX_TRANSACTION_NOTES_LENGTH, "Les notes");
  return input;
}
