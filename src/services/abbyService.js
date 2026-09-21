import logger from "../utils/logger.js";
import AbbyAccount from "../models/AbbyAccount.js";

/**
 * Service d'intégration Abby (API publique, authentification par clé API).
 *
 * Doc : https://docs.abby.fr (le SDK @abby-inc/node décrit les routes réelles,
 * plus complètes que la doc).
 *  - Auth   : header `Authorization: Bearer suk_…`
 *  - Test   : GET /company + GET /v2/company/me
 *  - Clients: GET /organizations?search=, POST /organization,
 *             GET /contacts?search=, POST /contact
 *  - Recettes : POST /incomeBook (facture Newbi encaissée)
 *  - Devis    : POST /v2/billing/estimate/{customerId}, PATCH lines/title/
 *               timeline, finalize, sign (devis Newbi créé comme devis Abby)
 *  - Documents Abby : GET /v2/billings (liste), GET /v2/billing/{id},
 *             GET /v2/billing/{id}/download (PDF)
 *
 * Abby est un outil de facturation : on ne recrée jamais une facture Newbi
 * dans Abby (double numérotation fiscale). Les factures encaissées vont dans le
 * livre des recettes ; les devis, sans valeur fiscale, sont créés comme devis
 * Abby (numéro Abby, numéro Newbi dans le titre).
 *
 * Même contrat que qontoService : chaque méthode publique renvoie
 * { success, message, abbyId? } et ne lève jamais.
 */

const ABBY_BASE_URL =
  process.env.ABBY_API_BASE_URL || "https://api.app-abby.com";

const PAGE_SIZE = 100;

// Moyen de paiement Newbi → identifiant legacy Abby (ordre de l'enum Abby :
// transfer, direct_debit, credit_card, cheque, cesu, cash, paypal, stripe, other)
const PAYMENT_METHOD_MAP = {
  BANK_TRANSFER: 1,
  DIRECT_DEBIT: 2,
  CREDIT_CARD: 3,
  CHECK: 4,
  CASH: 6,
  PAYPAL: 7,
  STRIPE: 8,
  OTHER: 9,
};

// Code TVA Abby → taux Newbi
const VAT_CODE_RATES = {
  FR_210: 2.1,
  FR_550: 5.5,
  FR_850: 8.5,
  FR_1000: 10,
  FR_2000: 20,
  FR_00HT: 0,
  FR_00UE: 0,
  FR_0HUE: 0,
};

const MAX_DESIGNATION_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1800;

// Unités Newbi → unités Abby (enum ProductUnit)
const UNIT_MAP = {
  "": "unit",
  unité: "unit",
  unite: "unit",
  pièce: "unit",
  piece: "unit",
  u: "unit",
  unit: "unit",
  heure: "hour",
  heures: "hour",
  h: "hour",
  hour: "hour",
  jour: "day",
  jours: "day",
  j: "day",
  day: "day",
  semaine: "week",
  week: "week",
  mois: "month",
  month: "month",
  an: "year",
  année: "year",
  annee: "year",
  year: "year",
  minute: "minute",
  min: "minute",
  g: "gram",
  gramme: "gram",
  gram: "gram",
  kg: "kilogram",
  kilogramme: "kilogram",
  kilogram: "kilogram",
  tonne: "ton",
  t: "ton",
  ton: "ton",
  litre: "liter",
  l: "liter",
  liter: "liter",
  mètre: "meter",
  metre: "meter",
  m: "meter",
  meter: "meter",
  km: "kilometer",
  "m²": "square_meter",
  m2: "square_meter",
  square_meter: "square_meter",
  "m³": "cubic_meter",
  m3: "cubic_meter",
  cubic_meter: "cubic_meter",
  ml: "linear_meter",
  lot: "batch",
  batch: "batch",
  forfait: "fixed_rate",
  fixed_rate: "fixed_rate",
  personne: "person",
  person: "person",
  page: "page",
  mot: "word",
  word: "word",
  licence: "license",
  license: "license",
  article: "article",
  nuit: "overnight_stay",
  nuitée: "overnight_stay",
};

function mapUnit(unit) {
  if (!unit) return "unit";
  const normalized = String(unit).toLowerCase().trim();
  return UNIT_MAP[normalized] || "unit";
}

// Taux de TVA Newbi → code TVA Abby (taux inconnu → 20 %)
const VAT_RATE_CODES = {
  0: "FR_00HT",
  2.1: "FR_210",
  5.5: "FR_550",
  8.5: "FR_850",
  10: "FR_1000",
  20: "FR_2000",
};

function mapVatRateToCode(rate) {
  const value = parseFloat(rate);
  if (!Number.isFinite(value) || value <= 0) return "FR_00HT";
  return VAT_RATE_CODES[value] || "FR_2000";
}

function truncate(value, max) {
  if (!value) return "";
  const str = String(value);
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * Date → timestamp Abby (secondes)
 */
function toTimestamp(date) {
  const d = date ? new Date(date) : new Date();
  return Math.floor(
    (Number.isNaN(d.getTime()) ? Date.now() : d.getTime()) / 1000,
  );
}

/**
 * HT d'une ligne (même logique que calculateInvoiceTotals côté resolver) :
 * quantity × unitPrice × avancement, moins la remise de ligne.
 */
function computeItemHT(item) {
  const quantity = item.quantity || 0;
  const unitPrice = item.unitPrice || 0;
  let itemHT = quantity * unitPrice;
  const progress =
    item.progressPercentage != null ? item.progressPercentage : 100;
  itemHT = itemHT * (progress / 100);
  const discount = item.discount || 0;
  if (discount > 0) {
    if ((item.discountType || "PERCENTAGE") === "PERCENTAGE") {
      itemHT = itemHT * (1 - Math.min(discount, 100) / 100);
    } else {
      itemHT = Math.max(0, itemHT - discount);
    }
  }
  return itemHT;
}

function mapPaymentMethod(method) {
  return PAYMENT_METHOD_MAP[String(method || "").toUpperCase()] || 1;
}

function mapVatCodeToRate(code) {
  const rate = VAT_CODE_RATES[String(code || "").toUpperCase()];
  return Number.isFinite(rate) ? rate : 0;
}

/**
 * Montant Abby (centimes) → euros
 */
function fromCents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) / 100 : 0;
}

/**
 * Timestamp Abby (secondes) → Date
 */
function fromTimestamp(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return new Date(n < 1e12 ? n * 1000 : n);
}

/**
 * Normalisation pour comparer des noms (casse, accents, espaces)
 */
function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Euros → centimes (entier)
 */
function toCents(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function round2(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function toIsoDate(date) {
  const d = date ? new Date(date) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
}

/**
 * Jour calendaire YYYY-MM-DD (fuseau Europe/Paris, celui de l'API Abby)
 */
function toParisDay(date) {
  const d = date ? new Date(date) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(safe);
}

function mapCountryToAlpha2(country) {
  if (!country) return "FR";
  const upper = String(country).toUpperCase().trim();
  if (upper.length === 2) return upper;
  const map = {
    FRANCE: "FR",
    BELGIQUE: "BE",
    BELGIUM: "BE",
    SUISSE: "CH",
    SWITZERLAND: "CH",
    LUXEMBOURG: "LU",
    ALLEMAGNE: "DE",
    GERMANY: "DE",
    ESPAGNE: "ES",
    SPAIN: "ES",
    ITALIE: "IT",
    ITALY: "IT",
    "PAYS-BAS": "NL",
    NETHERLANDS: "NL",
    PORTUGAL: "PT",
    "ROYAUME-UNI": "GB",
    "UNITED KINGDOM": "GB",
    MONACO: "MC",
    CANADA: "CA",
    "ÉTATS-UNIS": "US",
    "UNITED STATES": "US",
    MAROC: "MA",
    MOROCCO: "MA",
    TUNISIE: "TN",
    TUNISIA: "TN",
  };
  return map[upper] || "FR";
}

/**
 * Erreur API Abby enrichie (status HTTP + détail de validation)
 */
class AbbyApiError extends Error {
  constructor(status, body = null, raw = "") {
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const details = errors
      .map((e) =>
        e?.constraints ? Object.values(e.constraints).join(", ") : e?.message,
      )
      .filter(Boolean)
      .join(" ; ");
    super(
      `Abby API ${status}: ${details || body?.message || raw || "erreur inconnue"}`,
    );
    this.name = "AbbyApiError";
    this.status = status;
    this.errors = errors;
    this.code = body?.message || null;
  }
}

function buildHeaders(apiKey, body) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  // Abby renvoie un 400 muet sur un POST sans corps : toujours envoyer du JSON
  if (body !== undefined && body !== null) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Appel HTTP vers l'API Abby avec retry sur 429 (rate limit) et 5xx.
 * @param {Object} [options]
 * @param {boolean} [options.raw] - renvoyer la Response brute (PDF)
 */
async function abbyRequest(
  apiKey,
  method,
  endpoint,
  body = null,
  { retries = 3, raw = false } = {},
) {
  const url = `${ABBY_BASE_URL}${endpoint}`;
  const options = { method, headers: buildHeaders(apiKey, body) };
  if (body !== undefined && body !== null) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get("retry-after") || "5", 10);
    logger.warn(`[ABBY] Rate limit 429, retry in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return abbyRequest(apiKey, method, endpoint, body, {
      retries: retries - 1,
      raw,
    });
  }

  if (response.status >= 500 && retries > 0) {
    logger.warn(
      `[ABBY] Server error ${response.status}, retry in 1s... (${retries} left)`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    return abbyRequest(apiKey, method, endpoint, body, {
      retries: retries - 1,
      raw,
    });
  }

  if (!response.ok) {
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      /* corps non JSON */
    }
    throw new AbbyApiError(response.status, parsed, text);
  }

  if (raw) return response;
  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      value.forEach((v) => search.append(key, String(v)));
    } else {
      search.append(key, String(value));
    }
  }
  const s = search.toString();
  return s ? `?${s}` : "";
}

function clientSearchName(client) {
  return (
    client?.name || `${client?.firstName || ""} ${client?.lastName || ""}`
  ).trim();
}

/**
 * Prénom / nom d'un particulier tels qu'envoyés à Abby (firstname/lastname
 * obligatoires sur POST /contact).
 */
function clientNameParts(client) {
  const first = String(client?.firstName || "").trim();
  const last = String(client?.lastName || "").trim();
  if (first && last) return { first, last };
  const words = String(client?.name || `${first} ${last}`)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return { first: "Client", last: "Client" };
  if (words.length === 1) return { first: words[0], last: words[0] };
  return { first: words[0], last: words.slice(1).join(" ") };
}

function buildAddress(address = {}) {
  return {
    address: address.street || null,
    zipCode: address.postalCode || null,
    city: address.city || null,
    country: mapCountryToAlpha2(address.country),
  };
}

function pdfUrlOf(doc) {
  return doc?.cachedPdf?.url || doc?.archivedPdfUrl || null;
}

const abbyService = {
  /**
   * Teste la clé API
   * Endpoints: GET /company (nom, SIRET) + GET /v2/company/me (mode test)
   */
  async testConnection(apiKey) {
    try {
      if (!apiKey || !/^suk_/i.test(String(apiKey).trim())) {
        return {
          success: false,
          message: "Clé API Abby requise (elle commence par suk_)",
        };
      }

      const company = await abbyRequest(apiKey, "GET", "/company");
      if (!company?.id) {
        return {
          success: false,
          message: "Réponse Abby inattendue (entreprise absente)",
        };
      }

      let me = null;
      try {
        me = await abbyRequest(apiKey, "GET", "/v2/company/me");
      } catch (error) {
        logger.warn(`[ABBY] GET /v2/company/me ignoré: ${error.message}`);
      }

      const companyName =
        company.commercialName ||
        company.name ||
        me?.user?.fullname ||
        "Compte Abby";

      return {
        success: true,
        companyName,
        companyId: String(company.id),
        isTestMode: !!(me?.company?.isInTestMode ?? company.isInTestMode),
        message: "Connexion à Abby réussie",
      };
    } catch (error) {
      logger.error(`[ABBY] testConnection failed: ${error.message}`);
      const message =
        error.status === 401 || error.status === 403
          ? "Clé API Abby invalide ou révoquée"
          : `Échec de la connexion à Abby: ${error.message}`;
      return { success: false, message };
    }
  },

  /**
   * Crée le client (entreprise ou particulier) dans Abby
   * Endpoints: POST /organization | POST /contact
   */
  async syncClient(apiKey, client) {
    try {
      const isIndividual = client.type === "INDIVIDUAL";
      const emails = client.email ? [String(client.email).trim()] : [];
      const billingAddress = buildAddress(client.address);

      let data;
      if (isIndividual) {
        const parts = clientNameParts(client);
        data = await abbyRequest(apiKey, "POST", "/contact", {
          firstname: parts.first,
          lastname: parts.last,
          emails,
          billingAddress,
        });
      } else {
        const siret = digits(client.siret);
        data = await abbyRequest(apiKey, "POST", "/organization", {
          name: clientSearchName(client) || "Client inconnu",
          emails,
          ...(siret.length === 14 && { siret }),
          ...(client.vatNumber && { vatNumber: client.vatNumber }),
          billingAddress,
        });
      }

      return {
        success: true,
        abbyId: String(data?.id || ""),
        message: "Client synchronisé avec Abby",
      };
    } catch (error) {
      logger.error(`[ABBY] syncClient failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  },

  /**
   * Cherche le client Abby (SIRET / n° TVA / nom exact normalisé), sinon le crée.
   * @returns {Promise<string>} id de l'organisation ou du contact Abby
   */
  async _findOrCreateCustomer(apiKey, client) {
    const searchName = clientSearchName(client);
    if (!searchName) {
      throw new Error(
        "Impossible de trouver ou créer le client dans Abby : nom du client manquant",
      );
    }
    const isIndividual = client.type === "INDIVIDUAL";
    const target = normalizeName(searchName);
    const siret = digits(client.siret);
    const vat = normalizeName(client.vatNumber);

    try {
      if (isIndividual) {
        const parts = clientNameParts(client);
        const list = await abbyRequest(
          apiKey,
          "GET",
          `/contacts${query({ page: 1, limit: 25, search: searchName })}`,
        );
        const match = (list?.docs || []).find((c) => {
          if (c.organization?.id) return false; // contact d'entreprise
          const full = normalizeName(
            c.fullname || `${c.firstname || ""} ${c.lastname || ""}`,
          );
          return (
            full === target ||
            full === normalizeName(`${parts.first} ${parts.last}`)
          );
        });
        if (match) return String(match.id);
      } else {
        const list = await abbyRequest(
          apiKey,
          "GET",
          `/organizations${query({ page: 1, limit: 25, search: searchName })}`,
        );
        const orgs = list?.docs || [];
        const bySiret = siret && orgs.find((o) => digits(o.siret) === siret);
        const byVat =
          !bySiret &&
          vat &&
          orgs.find((o) => normalizeName(o.vatNumber) === vat);
        const byName =
          !bySiret &&
          !byVat &&
          orgs.find(
            (o) =>
              normalizeName(o.name) === target ||
              normalizeName(o.commercialName) === target,
          );
        const match = bySiret || byVat || byName;
        if (match) return String(match.id);
      }
    } catch (error) {
      throw new Error(
        `Impossible de trouver ou créer le client dans Abby : ${error.message}`,
      );
    }

    const created = await this.syncClient(apiKey, client);
    if (!created.success || !created.abbyId) {
      throw new Error(
        `Impossible de trouver ou créer le client dans Abby : ${created.message || "réponse Abby sans identifiant"}`,
      );
    }
    return created.abbyId;
  },

  /**
   * Facture Newbi encaissée → livre des recettes Abby
   * Endpoint: POST /incomeBook
   *
   * @param {string} apiKey
   * @param {Object} invoice - document Invoice (statut COMPLETED attendu)
   * @param {Object} options - { productType } type de produit Abby (1-5)
   */
  async syncCustomerInvoice(apiKey, invoice, { productType = 2 } = {}) {
    try {
      if (invoice.status !== "COMPLETED") {
        return {
          success: false,
          message:
            "Seules les factures encaissées (payées) sont enregistrées dans le livre des recettes Abby",
        };
      }

      // Le client du livre des recettes est un texte libre (affiché tel quel
      // dans Abby). Le client Abby est tout de même créé s'il n'existe pas,
      // pour qu'il apparaisse dans l'annuaire clients d'Abby.
      const clientName = clientSearchName(invoice.client);
      if (!clientName) {
        return {
          success: false,
          message:
            "Impossible d'enregistrer la recette : nom du client manquant",
        };
      }
      try {
        await this._findOrCreateCustomer(apiKey, invoice.client);
      } catch (error) {
        logger.warn(`[ABBY] Client non créé dans Abby: ${error.message}`);
      }

      const ref = `${invoice.prefix || ""}${invoice.number || ""}`.trim();
      const totalHT = round2(invoice.finalTotalHT ?? invoice.totalHT);
      const totalTTC = round2(invoice.finalTotalTTC ?? invoice.totalTTC);
      const totalVAT = round2(
        invoice.finalTotalVAT ?? invoice.totalVAT ?? totalTTC - totalHT,
      );
      const pdfUrl = pdfUrlOf(invoice);

      // Montants du livre des recettes en centimes
      const payload = {
        client: clientName,
        priceWithoutTax: toCents(totalHT),
        priceTotalTax: toCents(totalTTC),
        vatAmount: toCents(totalVAT),
        reference: ref || String(invoice._id),
        productType: [1, 2, 3, 4, 5].includes(Number(productType))
          ? Number(productType)
          : 2,
        paidAt: toIsoDate(invoice.paymentDate || invoice.issueDate),
        paymentMethodUsed: { value: mapPaymentMethod(invoice.paymentMethod) },
        isTaxIncluded: false,
        ...(pdfUrl && {
          file: { url: pdfUrl, name: `facture-${ref || invoice._id}.pdf` },
        }),
      };

      const data = await abbyRequest(apiKey, "POST", "/incomeBook", payload);
      const abbyId = data?._id || data?.id || "";
      logger.info(
        `[ABBY] Facture ${ref || invoice._id} enregistrée dans le livre des recettes Abby (${abbyId})`,
      );

      return {
        success: true,
        abbyId: String(abbyId),
        message: "Facture enregistrée dans le livre des recettes Abby",
      };
    } catch (error) {
      logger.error(`[ABBY] syncCustomerInvoice failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  },

  /**
   * Lignes Abby d'un devis Newbi (prix en centimes, TVA par code, remise de
   * ligne). Une ligne à avancement partiel est envoyée à quantité 1 au HT réel.
   */
  _buildEstimateLines(quote) {
    const isReverseCharge = !!quote.isReverseCharge;
    return (quote.items || []).map((item) => {
      const label = String(item.description || "Article").trim() || "Article";
      const progress =
        item.progressPercentage != null ? item.progressPercentage : 100;
      const line = {
        designation: truncate(label, MAX_DESIGNATION_LENGTH),
        ...(label.length > MAX_DESIGNATION_LENGTH && {
          description: truncate(label, MAX_DESCRIPTION_LENGTH),
        }),
        ...(item.details && {
          description: truncate(item.details, MAX_DESCRIPTION_LENGTH),
        }),
        quantityUnit: mapUnit(item.unit),
        type: "service_delivery",
        vatCode: isReverseCharge ? "FR_00HT" : mapVatRateToCode(item.vatRate),
        isTaxIncluded: false,
      };
      if (progress !== 100) {
        return {
          ...line,
          unitPrice: toCents(computeItemHT(item)),
          quantity: 1,
        };
      }
      line.unitPrice = toCents(item.unitPrice);
      line.quantity = Number(item.quantity) || 0;
      if (item.discount > 0) {
        line.discount =
          item.discountType === "FIXED"
            ? { mode: "AMOUNT", amount: toCents(item.discount) }
            : {
                mode: "PERCENTAGE",
                amount: toCents(Math.min(item.discount, 100)),
              };
      }
      return line;
    });
  },

  /**
   * Devis Newbi → devis Abby (brouillon, lignes, titre, dates, finalisation,
   * signature si le devis Newbi est accepté).
   * Endpoints: POST /v2/billing/estimate/{customerId}, PATCH …/lines,
   * PATCH …/title, PATCH /v2/billing/estimate/{id}/timeline,
   * PATCH …/general-informations, PATCH …/finalize, PATCH …/sign
   *
   * Abby attribue son propre numéro (D-AAAA-NNNN) : le numéro Newbi est repris
   * dans le titre du devis Abby.
   */
  async syncQuote(apiKey, quote) {
    let estimateId = null;
    try {
      if (!["PENDING", "COMPLETED"].includes(quote.status)) {
        return {
          success: false,
          message: "Seuls les devis envoyés ou acceptés sont créés dans Abby",
        };
      }
      const lines = this._buildEstimateLines(quote);
      if (lines.length === 0) {
        return {
          success: false,
          message: "Le devis n'a aucun article à synchroniser",
        };
      }
      if (!quote.client) {
        return {
          success: false,
          message: "Impossible de trouver ou créer le client dans Abby",
        };
      }
      const customerId = await this._findOrCreateCustomer(apiKey, quote.client);

      const created = await abbyRequest(
        apiKey,
        "POST",
        `/v2/billing/estimate/${customerId}`,
        {},
      );
      estimateId = created?.id;
      if (!estimateId) {
        throw new Error("réponse Abby sans identifiant de devis");
      }

      const linesPayload = { lines };
      if (quote.discount > 0) {
        linesPayload.discount =
          quote.discountType === "PERCENTAGE"
            ? {
                mode: "PERCENTAGE",
                amount: toCents(Math.min(quote.discount, 100)),
              }
            : { mode: "AMOUNT", amount: toCents(quote.discount) };
      }
      await abbyRequest(
        apiKey,
        "PATCH",
        `/v2/billing/${estimateId}/lines`,
        linesPayload,
      );

      const ref = `${quote.prefix || ""}${quote.number || ""}`.trim();
      await abbyRequest(apiKey, "PATCH", `/v2/billing/${estimateId}/title`, {
        title: truncate(`Devis Newbi ${ref || quote._id}`, 120),
      });

      const issueDate = quote.issueDate
        ? new Date(quote.issueDate)
        : new Date();
      const validUntil = quote.validUntil
        ? new Date(quote.validUntil)
        : new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000);
      await abbyRequest(
        apiKey,
        "PATCH",
        `/v2/billing/estimate/${estimateId}/timeline`,
        {
          emittedAt: toTimestamp(issueDate),
          expiredAt: toTimestamp(
            validUntil > issueDate
              ? validUntil
              : new Date(issueDate.getTime() + 24 * 60 * 60 * 1000),
          ),
          paymentDelay: "thirty_days",
        },
      );

      const general = {};
      if (quote.headerNotes)
        general.headerNote = truncate(quote.headerNotes, 1000);
      if (quote.footerNotes)
        general.footerNote = truncate(quote.footerNotes, 2000);
      if (quote.termsAndConditions) {
        general.generalTermsAndConditionsOfSale = truncate(
          quote.termsAndConditions,
          5000,
        );
      }
      if (quote.isReverseCharge) {
        general.vatMention = "reverse_charge";
      }
      if (Object.keys(general).length > 0) {
        try {
          await abbyRequest(
            apiKey,
            "PATCH",
            `/v2/billing/estimate/${estimateId}/general-informations`,
            general,
          );
        } catch (error) {
          logger.warn(
            `[ABBY] Informations générales du devis ${ref} ignorées: ${error.message}`,
          );
        }
      }

      const finalized = await abbyRequest(
        apiKey,
        "PATCH",
        `/v2/billing/${estimateId}/finalize`,
        {},
      );

      if (quote.status === "COMPLETED") {
        await this.signEstimate(apiKey, estimateId);
      }

      logger.info(
        `[ABBY] Devis ${ref || quote._id} créé sur Abby (${finalized?.number || estimateId})`,
      );
      return {
        success: true,
        abbyId: String(estimateId),
        abbyNumber: finalized?.number || null,
        message: `Devis créé dans Abby${finalized?.number ? ` (${finalized.number})` : ""}`,
      };
    } catch (error) {
      logger.error(`[ABBY] syncQuote failed: ${error.message}`);
      // Brouillon orphelin : supprimé pour ne pas encombrer Abby
      if (estimateId) {
        await abbyRequest(apiKey, "DELETE", `/v2/billing/${estimateId}`, null, {
          raw: true,
        }).catch(() => {});
      }
      return { success: false, message: error.message };
    }
  },

  /**
   * Marque un devis Abby comme signé (devis Newbi accepté après création)
   * Endpoint: PATCH /v2/billing/estimate/{id}/sign
   */
  async signEstimate(apiKey, estimateId) {
    try {
      await abbyRequest(
        apiKey,
        "PATCH",
        `/v2/billing/estimate/${estimateId}/sign`,
        {},
      );
      return { success: true, message: "Devis signé dans Abby" };
    } catch (error) {
      // Déjà signé côté Abby : rien à faire
      if (/already_signed|already signed|est déjà signé/i.test(error.message)) {
        return { success: true, message: "Devis déjà signé dans Abby" };
      }
      logger.warn(`[ABBY] signEstimate ${estimateId}: ${error.message}`);
      return { success: false, message: error.message };
    }
  },

  /**
   * Liste paginée des documents Abby (factures, devis…) émis dans une plage
   * de jours (sens Abby → Newbi). Le filtre `type` de l'API est cassé côté
   * Abby (400 quelle que soit la valeur) : le type est filtré côté Newbi.
   * Endpoint: GET /v2/billings
   *
   * @param {Object} options
   * @param {Date} options.from - début (date d'émission)
   * @param {Date} [options.to] - fin (défaut aujourd'hui)
   * @param {boolean} [options.test] - compte Abby en mode test
   * @param {string[]} [options.states] - états Abby (draft, finalized, signed, refused, paid)
   * @returns {Promise<{items: Object[], nextPage: number|null}>}
   */
  async listBillings(
    apiKey,
    { from, to, test = false, states, page = 1 } = {},
  ) {
    const params = {
      page,
      limit: PAGE_SIZE,
      test: !!test,
      archived: false,
    };
    if (from) {
      params.rangeType = "emittedAt";
      params.range = [toParisDay(from), toParisDay(to || new Date())];
    }
    if (states?.length) params.state = states;

    const data = await abbyRequest(
      apiKey,
      "GET",
      `/v2/billings${query(params)}`,
    );
    return {
      items: data?.docs || [],
      nextPage: data?.hasNextPage ? (data.nextPage ?? page + 1) : null,
    };
  },

  /**
   * Détail d'un document Abby (facture, devis, avoir) avec ses lignes
   * Endpoint: GET /v2/billing/{id}
   */
  async getBilling(apiKey, billingId) {
    if (!billingId) return null;
    return abbyRequest(apiKey, "GET", `/v2/billing/${billingId}`);
  },

  /**
   * PDF d'un document Abby
   * Endpoint: GET /v2/billing/{id}/download
   * @returns {Promise<{buffer: Buffer, fileName: string, contentType: string}|null>}
   */
  async downloadPdf(apiKey, billingId, fallbackName = "document") {
    if (!billingId) return null;
    const response = await abbyRequest(
      apiKey,
      "GET",
      `/v2/billing/${billingId}/download`,
      null,
      { raw: true },
    );
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return null;
    const disposition = response.headers.get("content-disposition") || "";
    const nameMatch = disposition.match(
      /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i,
    );
    return {
      buffer,
      fileName: nameMatch?.[1]
        ? decodeURIComponent(nameMatch[1])
        : `${fallbackName}.pdf`,
      contentType: response.headers.get("content-type") || "application/pdf",
    };
  },

  /**
   * Sync complète : factures encaissées + devis envoyés ou acceptés
   */
  async syncAll(organizationId, { Invoice, Quote }) {
    const account = await AbbyAccount.findOne({ organizationId });
    if (!account || !account.isConnected) {
      return { success: false, message: "Compte Abby non connecté" };
    }

    const apiKey = account.getDecryptedApiKey();
    const results = {
      invoices: { synced: 0, errors: 0 },
      quotes: { synced: 0, errors: 0 },
    };

    account.syncStatus = "IN_PROGRESS";
    await account.save();

    try {
      // 1. Factures clients encaissées → livre des recettes
      if (account.autoSync.invoices && Invoice) {
        const invoices = await Invoice.find({
          workspaceId: organizationId,
          status: "COMPLETED",
          abbySyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[ABBY] syncAll: ${invoices.length} factures à enregistrer`,
        );

        for (const invoice of invoices) {
          const result = await this.syncCustomerInvoice(apiKey, invoice, {
            productType: account.incomeProductType,
          });
          if (result.success) {
            invoice.abbySyncStatus = "SYNCED";
            invoice.abbyId = result.abbyId;
            await invoice.save();
            results.invoices.synced++;
          } else {
            invoice.abbySyncStatus = "ERROR";
            await invoice.save();
            results.invoices.errors++;
            logger.warn(
              `[ABBY] syncAll facture ${invoice.prefix || ""}${invoice.number || invoice._id}: ${result.message}`,
            );
          }
        }
      }

      // 2. Devis envoyés ou acceptés → devis Abby
      if (account.autoSync.quotes && Quote) {
        const quotes = await Quote.find({
          workspaceId: organizationId,
          status: { $in: ["PENDING", "COMPLETED"] },
          abbySyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(`[ABBY] syncAll: ${quotes.length} devis à créer`);

        for (const quote of quotes) {
          const result = await this.syncQuote(apiKey, quote);
          if (result.success) {
            quote.abbySyncStatus = "SYNCED";
            quote.abbyId = result.abbyId;
            await quote.save();
            results.quotes.synced++;
          } else {
            quote.abbySyncStatus = "ERROR";
            await quote.save();
            results.quotes.errors++;
            logger.warn(
              `[ABBY] syncAll devis ${quote.prefix || ""}${quote.number || quote._id}: ${result.message}`,
            );
          }
        }
      }

      account.syncStatus = "SUCCESS";
      account.lastSyncAt = new Date();
      account.syncError = null;
      account.stats.invoicesSynced += results.invoices.synced;
      account.stats.quotesSynced += results.quotes.synced;
      await account.save();

      const total = results.invoices.synced + results.quotes.synced;
      const totalErrors = results.invoices.errors + results.quotes.errors;

      return {
        success: true,
        results,
        message: `Synchronisation terminée: ${total} éléments enregistrés dans Abby${totalErrors > 0 ? `, ${totalErrors} erreurs` : ""}`,
      };
    } catch (error) {
      account.syncStatus = "ERROR";
      account.syncError = error.message;
      await account.save();

      logger.error(`[ABBY] syncAll failed: ${error.message}`);
      return { success: false, message: error.message, results };
    }
  },
};

export {
  AbbyApiError,
  abbyRequest,
  normalizeName,
  mapPaymentMethod,
  mapVatCodeToRate,
  fromCents,
  toCents,
  fromTimestamp,
  toTimestamp,
  toParisDay,
  mapUnit,
  mapVatRateToCode,
};
export default abbyService;
