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
 *  - Achats   : GET /providers?search=, POST /provider, POST /v2/purchaseRegister
 *  - Documents Abby : GET /v2/billings (liste), GET /v2/billing/{id},
 *             GET /v2/billing/{id}/download (PDF)
 *
 * Abby est un outil de facturation : on ne recrée jamais une facture Newbi
 * dans Abby (double numérotation). Les factures encaissées vont dans le livre
 * des recettes, les factures d'achat payées dans le livre des achats.
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
   * Cherche le fournisseur Abby (SIRET puis nom exact normalisé), sinon le crée.
   * Endpoints: GET /providers?search=, POST /provider
   * @returns {Promise<string>} id du tiers Abby (tparty_…)
   */
  async _findOrCreateProvider(apiKey, purchaseInvoice) {
    const name = String(purchaseInvoice.supplierName || "").trim();
    if (!name) {
      throw new Error(
        "Impossible de trouver ou créer le fournisseur dans Abby : nom manquant",
      );
    }
    let supplier = purchaseInvoice.supplier || null;
    if (!supplier && purchaseInvoice.supplierId) {
      try {
        const Supplier = (await import("../models/Supplier.js")).default;
        supplier = await Supplier.findById(purchaseInvoice.supplierId)
          .select("name siret vatNumber")
          .lean();
      } catch (error) {
        logger.warn(
          `[ABBY] Fournisseur ${purchaseInvoice.supplierId} illisible: ${error.message}`,
        );
      }
    }
    supplier = supplier || {};
    const siret = digits(supplier.siret);
    const target = normalizeName(name);

    try {
      const list = await abbyRequest(
        apiKey,
        "GET",
        `/providers${query({ page: 1, limit: 25, search: name })}`,
      );
      const providers = list?.data || list?.docs || [];
      const match =
        (siret && providers.find((p) => digits(p.siret) === siret)) ||
        providers.find(
          (p) =>
            normalizeName(p.name) === target ||
            normalizeName(p.commercialName) === target,
        );
      if (match) return String(match.id);
    } catch (error) {
      throw new Error(
        `Impossible de trouver ou créer le fournisseur dans Abby : ${error.message}`,
      );
    }

    const created = await abbyRequest(apiKey, "POST", "/provider", {
      name,
      ...(siret.length === 14 && { siret }),
      ...(supplier.vatNumber && { vatNumber: supplier.vatNumber }),
    });
    if (!created?.id) {
      throw new Error(
        "Impossible de trouver ou créer le fournisseur dans Abby : réponse sans identifiant",
      );
    }
    return String(created.id);
  },

  /**
   * Facture d'achat Newbi payée → livre des achats Abby
   * Endpoint: POST /v2/purchaseRegister
   * Abby n'expose pas d'upload de fichier par API : la pièce n'est pas jointe.
   */
  async syncPurchaseInvoice(apiKey, purchaseInvoice) {
    try {
      if (purchaseInvoice.status !== "PAID") {
        return {
          success: false,
          message:
            "Seules les factures d'achat payées sont enregistrées dans le livre des achats Abby",
        };
      }

      const thirdPartyId = await this._findOrCreateProvider(
        apiKey,
        purchaseInvoice,
      );
      const ref = purchaseInvoice.invoiceNumber || String(purchaseInvoice._id);
      const amount = round2(purchaseInvoice.amountTTC);
      if (!(amount > 0)) {
        return {
          success: false,
          message: "Montant TTC manquant sur la facture d'achat",
        };
      }

      // Montants du livre des achats en centimes (comme toute l'API v2)
      const amountCents = toCents(amount);
      const payload = {
        valueDate: toIsoDate(
          purchaseInvoice.paymentDate || purchaseInvoice.issueDate,
        ),
        paymentMethodUsed: mapPaymentMethod(purchaseInvoice.paymentMethod),
        amount: amountCents,
        thirdPartyId,
        label: `${purchaseInvoice.supplierName || "Fournisseur"} - ${ref}`,
        reference: ref,
        entries: [{ isPersonal: false, amount: amountCents }],
      };

      const data = await abbyRequest(
        apiKey,
        "POST",
        "/v2/purchaseRegister",
        payload,
      );
      const abbyId = data?.id || data?._id || "";
      logger.info(
        `[ABBY] Facture d'achat ${ref} enregistrée dans le livre des achats Abby (${abbyId})`,
      );

      return {
        success: true,
        abbyId: String(abbyId),
        message: "Facture d'achat enregistrée dans le livre des achats Abby",
      };
    } catch (error) {
      logger.error(`[ABBY] syncPurchaseInvoice failed: ${error.message}`);
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
   * Sync complète : factures encaissées + factures d'achat payées
   */
  async syncAll(organizationId, { Invoice, PurchaseInvoice }) {
    const account = await AbbyAccount.findOne({ organizationId });
    if (!account || !account.isConnected) {
      return { success: false, message: "Compte Abby non connecté" };
    }

    const apiKey = account.getDecryptedApiKey();
    const results = {
      invoices: { synced: 0, errors: 0 },
      expenses: { synced: 0, errors: 0 },
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

      // 2. Factures d'achat payées → livre des achats
      if (account.autoSync.supplierInvoices && PurchaseInvoice) {
        const purchaseInvoices = await PurchaseInvoice.find({
          workspaceId: organizationId,
          status: "PAID",
          abbySyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[ABBY] syncAll: ${purchaseInvoices.length} factures d'achat à enregistrer`,
        );

        for (const pi of purchaseInvoices) {
          const result = await this.syncPurchaseInvoice(apiKey, pi);
          if (result.success) {
            pi.abbySyncStatus = "SYNCED";
            pi.abbyId = result.abbyId;
            await pi.save();
            results.expenses.synced++;
          } else {
            pi.abbySyncStatus = "ERROR";
            await pi.save();
            results.expenses.errors++;
            logger.warn(
              `[ABBY] syncAll facture d'achat ${pi.invoiceNumber || pi._id}: ${result.message}`,
            );
          }
        }
      }

      account.syncStatus = "SUCCESS";
      account.lastSyncAt = new Date();
      account.syncError = null;
      account.stats.invoicesSynced += results.invoices.synced;
      account.stats.expensesSynced += results.expenses.synced;
      await account.save();

      const total = results.invoices.synced + results.expenses.synced;
      const totalErrors = results.invoices.errors + results.expenses.errors;

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
  toParisDay,
};
export default abbyService;
