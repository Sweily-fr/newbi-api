import logger from "../utils/logger.js";
import QontoAccount from "../models/QontoAccount.js";

/**
 * Service d'intégration Qonto (Business API v2, authentification par clé API).
 *
 * Doc : https://docs.qonto.com
 *  - Auth   : header `Authorization: {login}:{secret_key}` (pas de Basic/Base64)
 *  - Test   : GET /organization (200 = identifiants valides, 401 sinon)
 *  - Clients: GET /clients?filter[name]=…, POST /clients
 *  - Factures clients : POST /client_invoices/uploads (PDF Newbi) puis POST /client_invoices
 *  - Factures fournisseurs : POST /supplier_invoices/bulk (multipart, max 20, idempotency_key)
 *
 * Même contrat que pennylaneService : chaque méthode publique renvoie
 * { success, message, qontoId? } et ne lève jamais.
 */

const QONTO_BASE_URLS = {
  production: "https://thirdparty.qonto.com/v2",
  sandbox: "https://thirdparty-sandbox.staging.qonto.co/v2",
};

const MAX_TITLE_LENGTH = 40;
const MAX_DESCRIPTION_LENGTH = 1800;
const MAX_NUMBER_LENGTH = 40;
const MAX_TERMS_LENGTH = 525;

/**
 * Taux de TVA Newbi (20) → décimal Qonto ("0.2")
 */
function mapVatRate(rate) {
  const value = parseFloat(rate);
  if (!Number.isFinite(value) || value <= 0) return "0";
  // Évite les artefacts flottants (5.5 / 100 = 0.055000000000000005)
  return String(Math.round(value * 10000) / 1000000);
}

/**
 * Unités Newbi → unités Qonto
 * Qonto accepte notamment : unit, hour, day, month, week, year, minute, second,
 * gram, kilogram, ton, liter, milliliter, meter, centimeter, millimeter,
 * square_meter, cubic_meter, set, pair, number_of_articles
 */
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
  seconde: "second",
  second: "second",
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
  ml: "milliliter",
  mètre: "meter",
  metre: "meter",
  m: "meter",
  meter: "meter",
  cm: "centimeter",
  mm: "millimeter",
  "m²": "square_meter",
  m2: "square_meter",
  square_meter: "square_meter",
  "m³": "cubic_meter",
  m3: "cubic_meter",
  cubic_meter: "cubic_meter",
  lot: "set",
  set: "set",
  paire: "pair",
  pair: "pair",
  forfait: "unit",
  package: "unit",
};

function mapUnit(unit) {
  if (!unit) return "unit";
  const normalized = String(unit).toLowerCase().trim();
  return UNIT_MAP[normalized] || "unit";
}

function truncate(value, max) {
  if (!value) return "";
  const str = String(value);
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * Formate une date en YYYY-MM-DD
 */
function formatDate(date) {
  if (!date) return new Date().toISOString().split("T")[0];
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().split("T")[0];
  return d.toISOString().split("T")[0];
}

/**
 * Montant → chaîne décimale à 2 décimales ("10.00")
 */
function money(value) {
  const n = parseFloat(value);
  return (Number.isFinite(n) ? n : 0).toFixed(2);
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

/**
 * Calcule le HT d'une ligne (même logique que calculateInvoiceTotals côté resolver) :
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
    const discountType = item.discountType || "PERCENTAGE";
    if (discountType === "PERCENTAGE") {
      itemHT = itemHT * (1 - Math.min(discount, 100) / 100);
    } else {
      itemHT = Math.max(0, itemHT - discount);
    }
  }

  return itemHT;
}

/**
 * Convertit un nom de pays en code ISO alpha-2 (cas courants FR)
 */
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
 * Erreur API Qonto enrichie (status HTTP, code et liste d'erreurs Qonto)
 */
class QontoApiError extends Error {
  constructor(status, errors = [], raw = "") {
    const details = errors
      .map((e) => e.detail || e.code)
      .filter(Boolean)
      .join(" ; ");
    super(`Qonto API ${status}: ${details || raw || "erreur inconnue"}`);
    this.name = "QontoApiError";
    this.status = status;
    this.errors = errors;
    this.code = errors[0]?.code || null;
  }

  hasPointer(fragment) {
    return this.errors.some((e) =>
      String(e?.source?.pointer || "").includes(fragment),
    );
  }
}

function buildHeaders(credentials, body) {
  const headers = {
    Authorization: `${credentials.login}:${credentials.secretKey}`,
    Accept: "application/json",
  };
  if (
    credentials.environment === "sandbox" &&
    process.env.QONTO_STAGING_TOKEN
  ) {
    headers["X-Qonto-Staging-Token"] = process.env.QONTO_STAGING_TOKEN;
  }
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Appel HTTP vers l'API Qonto avec retry sur 429 (rate limit) et 5xx.
 */
async function qontoRequest(
  credentials,
  method,
  endpoint,
  body = null,
  retries = 3,
) {
  const base =
    QONTO_BASE_URLS[credentials.environment] || QONTO_BASE_URLS.production;
  const url = `${base}${endpoint}`;

  const options = { method, headers: buildHeaders(credentials, body) };
  if (body) {
    options.body = body instanceof FormData ? body : JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get("retry-after") || "5", 10);
    logger.warn(`[QONTO] Rate limit 429, retry in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return qontoRequest(credentials, method, endpoint, body, retries - 1);
  }

  if (response.status >= 500 && retries > 0) {
    logger.warn(
      `[QONTO] Server error ${response.status}, retry in 1s... (${retries} left)`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    return qontoRequest(credentials, method, endpoint, body, retries - 1);
  }

  if (!response.ok) {
    const raw = await response.text();
    let errors = [];
    try {
      const parsed = JSON.parse(raw);
      errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    } catch (_) {
      /* corps non JSON */
    }
    throw new QontoApiError(response.status, errors, raw);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  if (!text) return null;
  return JSON.parse(text);
}

/**
 * Télécharge un fichier (R2/S3) et le renvoie sous forme de Blob
 */
async function downloadFile(fileUrl) {
  const fileResponse = await fetch(fileUrl);
  if (!fileResponse.ok) {
    throw new Error(
      `Impossible de télécharger le fichier: ${fileResponse.status}`,
    );
  }
  return fileResponse.blob();
}

/**
 * Le sandbox Qonto (et certains rôles) renvoient un IBAN masqué ("FRXXXX…") :
 * inutilisable comme moyen de paiement sur une facture.
 */
function isUsableIban(iban) {
  return (
    !!iban &&
    /^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$/.test(String(iban).replace(/\s+/g, ""))
  );
}

/**
 * Numéro fiscal du client attendu par Qonto (tax_identification_number).
 * Obligatoire pour les sociétés françaises : SIRET (14) ou SIREN (9) acceptés.
 */
function clientTaxId(client) {
  const raw = String(client?.siret || client?.siren || "").replace(/\s+/g, "");
  return raw || null;
}

function pickPdfFile(files = []) {
  if (!Array.isArray(files) || files.length === 0) return null;
  return files.find((f) => f?.mimetype === "application/pdf") || files[0];
}

/**
 * Snapshot des comptes bancaires Qonto pour QontoAccount.bankAccounts
 */
function mapBankAccounts(bankAccounts = []) {
  return (bankAccounts || [])
    .filter((a) => a && !a.is_external_account)
    .map((a) => ({
      qontoId: String(a.id),
      slug: a.slug || null,
      name: a.name || null,
      iban: a.iban || null,
      bic: a.bic || null,
      currency: a.currency || "EUR",
      main: !!a.main,
      status: a.status || null,
    }));
}

const qontoService = {
  /**
   * Teste les identifiants (login + clé secrète)
   * Endpoint: GET /organization
   */
  async testConnection(credentials) {
    try {
      if (!credentials?.login || !credentials?.secretKey) {
        return {
          success: false,
          message: "Identifiant et clé secrète Qonto requis",
        };
      }

      const data = await qontoRequest(credentials, "GET", "/organization");
      const org = data?.organization;
      if (!org?.id) {
        return {
          success: false,
          message: "Réponse Qonto inattendue (organisation absente)",
        };
      }

      return {
        success: true,
        organizationName: org.legal_name || org.name || null,
        organizationId: String(org.id),
        slug: org.slug || null,
        bankAccounts: mapBankAccounts(org.bank_accounts),
        message: "Connexion à Qonto réussie",
      };
    } catch (error) {
      logger.error("[QONTO] testConnection failed:", error.message);
      const message =
        error.status === 401
          ? "Identifiants Qonto invalides (vérifiez l'identifiant et la clé secrète)"
          : `Échec de la connexion à Qonto: ${error.message}`;
      return { success: false, message };
    }
  },

  /**
   * Crée un client Qonto à partir d'un client Newbi
   * Endpoint: POST /clients
   */
  async syncClient(credentials, client) {
    try {
      const isIndividual = client.type === "INDIVIDUAL";
      const fullName =
        client.name ||
        `${client.firstName || ""} ${client.lastName || ""}`.trim();

      let payload;
      if (isIndividual) {
        payload = {
          kind: "individual",
          first_name: client.firstName || fullName || "Client",
          last_name: client.lastName || fullName || "Client",
        };
      } else {
        payload = {
          kind: "company",
          name: fullName || "Client inconnu",
          ...(client.firstName && { first_name: client.firstName }),
          ...(client.lastName && { last_name: client.lastName }),
          ...(client.vatNumber && { vat_number: client.vatNumber }),
          ...(clientTaxId(client) && {
            tax_identification_number: clientTaxId(client),
          }),
        };
      }

      if (client.email) payload.email = client.email;
      payload.currency = "EUR";
      payload.locale = "fr";

      const addr = client.address || {};
      payload.billing_address = {
        street_address: truncate(addr.street || "Non renseignée", 250),
        city: truncate(addr.city || "Non renseignée", 50),
        zip_code: truncate(addr.postalCode || "00000", 20),
        country_code: mapCountryToAlpha2(addr.country),
      };

      const data = await qontoRequest(credentials, "POST", "/clients", payload);
      return {
        success: true,
        qontoId: String(data?.client?.id || ""),
        message: "Client synchronisé avec Qonto",
      };
    } catch (error) {
      logger.error("[QONTO] syncClient failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Cherche un client Qonto (n° TVA puis nom exact), sinon le crée
   */
  async _findOrCreateClient(credentials, client) {
    try {
      const searchName =
        client.name ||
        `${client.firstName || ""} ${client.lastName || ""}`.trim();
      if (!searchName) return null;

      // 1. Par numéro de TVA (match exact côté Qonto)
      if (client.vatNumber) {
        const byVat = await qontoRequest(
          credentials,
          "GET",
          `/clients?filter[vat_number]=${encodeURIComponent(client.vatNumber)}&per_page=5`,
        );
        if (byVat?.clients?.length > 0) {
          return this._ensureClientTaxId(credentials, byVat.clients[0], client);
        }
      }

      // 2. Par nom (filtre partiel côté Qonto → on exige un match exact normalisé)
      if (searchName.length >= 2) {
        const byName = await qontoRequest(
          credentials,
          "GET",
          `/clients?filter[name]=${encodeURIComponent(searchName)}&per_page=25`,
        );
        const target = normalizeName(searchName);
        const match = (byName?.clients || []).find((c) => {
          const candidates = [
            c.name,
            `${c.first_name || ""} ${c.last_name || ""}`,
          ];
          return candidates.some((n) => normalizeName(n) === target);
        });
        if (match) return this._ensureClientTaxId(credentials, match, client);
      }

      // 3. Créer
      const created = await this.syncClient(credentials, client);
      return created.success && created.qontoId ? created.qontoId : null;
    } catch (error) {
      logger.warn("[QONTO] _findOrCreateClient failed:", error.message);
      return null;
    }
  },

  /**
   * Qonto refuse une facture pour une société sans tax_identification_number
   * (`tin_number must have a value`). Si le client Qonto existant n'en a pas et
   * que Newbi connaît le SIRET, on le complète (PATCH /clients/{id}).
   */
  async _ensureClientTaxId(credentials, qontoClient, client) {
    const taxId = clientTaxId(client);
    if (
      !taxId ||
      qontoClient.kind === "individual" ||
      qontoClient.tax_identification_number
    ) {
      return qontoClient.id;
    }
    try {
      await qontoRequest(credentials, "PATCH", `/clients/${qontoClient.id}`, {
        tax_identification_number: taxId,
      });
    } catch (error) {
      logger.warn(
        `[QONTO] Impossible d'ajouter le numéro fiscal au client ${qontoClient.id}: ${error.message}`,
      );
    }
    return qontoClient.id;
  },

  /**
   * Upload du PDF Newbi pour l'attacher à une facture client
   * Endpoint: POST /client_invoices/uploads (multipart, champ client_invoices_upload)
   */
  async uploadClientInvoiceFile(
    credentials,
    fileUrl,
    filename = "facture.pdf",
  ) {
    try {
      const blob = await downloadFile(fileUrl);
      const formData = new FormData();
      formData.append("client_invoices_upload", blob, filename);

      const data = await qontoRequest(
        credentials,
        "POST",
        "/client_invoices/uploads",
        formData,
      );
      return data?.data?.id || data?.data?.attributes?.id || null;
    } catch (error) {
      logger.warn("[QONTO] uploadClientInvoiceFile failed:", error.message);
      return null;
    }
  },

  /**
   * Construit les lignes Qonto d'une facture Newbi.
   * Si la ligne n'a pas d'avancement partiel, on envoie quantité × PU réels
   * (+ remise de ligne) ; sinon on envoie une ligne à quantité 1 au HT réel.
   */
  _buildItems(invoice) {
    const isReverseCharge = invoice.isReverseCharge || false;
    const currency = invoice.currency || "EUR";
    const items = (invoice.items || []).map((item) => {
      const label = item.description || "Article";
      const vatRate = isReverseCharge ? "0" : mapVatRate(item.vatRate);
      const progress =
        item.progressPercentage != null ? item.progressPercentage : 100;

      const base = {
        title: truncate(label, MAX_TITLE_LENGTH),
        ...(label.length > MAX_TITLE_LENGTH && {
          description: truncate(label, MAX_DESCRIPTION_LENGTH),
        }),
        unit: mapUnit(item.unit),
        vat_rate: vatRate,
      };

      if (progress !== 100) {
        return {
          ...base,
          quantity: "1",
          unit_price: { value: money(computeItemHT(item)), currency },
        };
      }

      const line = {
        ...base,
        quantity: String(item.quantity || 0),
        unit_price: { value: money(item.unitPrice), currency },
      };

      if (item.discount > 0) {
        const type = item.discountType === "FIXED" ? "absolute" : "percentage";
        line.discount = {
          type,
          value:
            type === "percentage"
              ? String(Math.min(item.discount, 100) / 100)
              : money(item.discount),
        };
      }
      return line;
    });

    if (
      invoice.shipping?.billShipping &&
      invoice.shipping.shippingAmountHT > 0
    ) {
      items.push({
        title: "Frais de livraison",
        quantity: "1",
        unit: "unit",
        unit_price: {
          value: money(invoice.shipping.shippingAmountHT),
          currency,
        },
        vat_rate: isReverseCharge
          ? "0"
          : mapVatRate(invoice.shipping.shippingVatRate ?? 20),
      });
    }

    return items;
  },

  /**
   * Sync une facture client Newbi → Qonto client invoice
   * Endpoints: POST /client_invoices/uploads puis POST /client_invoices
   *
   * @param {Object} credentials - { login, secretKey, environment }
   * @param {Object} invoice - document Invoice
   * @param {Object} options - { iban } IBAN Qonto affiché comme moyen de paiement
   */
  async syncCustomerInvoice(credentials, invoice, { iban } = {}) {
    try {
      if (!isUsableIban(iban)) {
        return {
          success: false,
          message: iban
            ? "L'IBAN du compte Qonto sélectionné est masqué : choisissez un autre compte dans les paramètres Qonto"
            : "Aucun compte bancaire Qonto sélectionné pour les factures (IBAN requis)",
        };
      }

      const items = this._buildItems(invoice);
      if (items.length === 0) {
        return {
          success: false,
          message: "La facture n'a aucun article à synchroniser",
        };
      }

      let clientId = null;
      if (invoice.client) {
        clientId = await this._findOrCreateClient(credentials, invoice.client);
      }
      if (!clientId) {
        return {
          success: false,
          message: "Impossible de trouver ou créer le client dans Qonto",
        };
      }

      const ref = truncate(
        `${invoice.prefix || ""}${invoice.number || ""}`.trim(),
        MAX_NUMBER_LENGTH,
      );

      const issueDate = formatDate(invoice.issueDate);
      let dueDate = formatDate(invoice.dueDate || invoice.issueDate);
      if (dueDate < issueDate) dueDate = issueDate;

      let uploadId = null;
      const pdfUrl = invoice.cachedPdf?.url || invoice.archivedPdfUrl;
      if (pdfUrl) {
        uploadId = await this.uploadClientInvoiceFile(
          credentials,
          pdfUrl,
          `facture-${ref || invoice._id}.pdf`,
        );
      }

      const payload = {
        client_id: clientId,
        issue_date: issueDate,
        due_date: dueDate,
        status: "unpaid",
        currency: invoice.currency || "EUR",
        payment_methods: { iban },
        items,
        ...(ref && { number: ref }),
        ...(uploadId && { upload_id: uploadId }),
        ...(invoice.purchaseOrderNumber && {
          purchase_order: truncate(invoice.purchaseOrderNumber, 40),
        }),
      };

      if (invoice.discount > 0) {
        if (invoice.discountType === "PERCENTAGE") {
          payload.discount = {
            type: "percentage",
            value: String(Math.min(invoice.discount, 100) / 100),
          };
        } else {
          payload.discount = {
            type: "absolute",
            value: money(invoice.discount),
          };
        }
      }

      if (invoice.isReverseCharge) {
        payload.terms_and_conditions = truncate(
          "Autoliquidation - TVA due par le preneur (art. 283-2 du CGI)",
          MAX_TERMS_LENGTH,
        );
      }

      let data;
      try {
        data = await qontoRequest(
          credentials,
          "POST",
          "/client_invoices",
          payload,
        );
      } catch (error) {
        // Numérotation automatique activée côté Qonto → le numéro est refusé.
        // On retente sans numéro : Qonto attribue le sien.
        if (
          error instanceof QontoApiError &&
          error.status === 422 &&
          payload.number &&
          error.hasPointer("/number")
        ) {
          logger.warn(
            `[QONTO] Numéro ${payload.number} refusé (numérotation auto Qonto), retry sans numéro`,
          );
          const withoutNumber = { ...payload };
          delete withoutNumber.number;
          data = await qontoRequest(
            credentials,
            "POST",
            "/client_invoices",
            withoutNumber,
          );
        } else {
          throw error;
        }
      }

      const qontoId = data?.client_invoice?.id || data?.id || "";
      logger.info(
        `[QONTO] Facture ${ref || invoice._id} créée sur Qonto (${qontoId})`,
      );

      return {
        success: true,
        qontoId: String(qontoId),
        message: "Facture synchronisée avec Qonto",
      };
    } catch (error) {
      if (
        error instanceof QontoApiError &&
        (error.status === 409 || error.code === "invoice_number_already_exists")
      ) {
        logger.info("[QONTO] Facture déjà existante sur Qonto");
        return {
          success: true,
          qontoId: "existing",
          message: "Facture déjà existante sur Qonto",
        };
      }
      logger.error("[QONTO] syncCustomerInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Envoie un PDF comme facture fournisseur Qonto
   * Endpoint: POST /supplier_invoices/bulk (multipart)
   * La clé d'idempotence = id Newbi → un renvoi ne crée pas de doublon.
   */
  async _uploadSupplierInvoice(
    credentials,
    { fileUrl, filename, idempotencyKey },
  ) {
    const blob = await downloadFile(fileUrl);
    const formData = new FormData();
    formData.append("supplier_invoices[][file]", blob, filename);
    formData.append("supplier_invoices[][idempotency_key]", idempotencyKey);

    const data = await qontoRequest(
      credentials,
      "POST",
      "/supplier_invoices/bulk",
      formData,
    );

    // L'endpoint renvoie 200 même en cas d'erreur par facture
    const errors = Array.isArray(data?.errors) ? data.errors : [];
    if (errors.length > 0) {
      throw new QontoApiError(200, errors);
    }

    const created = (data?.supplier_invoices || [])[0];
    return created?.id ? String(created.id) : null;
  },

  /**
   * Sync une facture d'achat (PurchaseInvoice) Newbi → Qonto supplier invoice
   */
  async syncPurchaseInvoice(credentials, purchaseInvoice) {
    try {
      const file = pickPdfFile(purchaseInvoice.files);
      const fileUrl = file?.url || purchaseInvoice.archivedPdfUrl;
      if (!fileUrl) {
        return {
          success: false,
          message:
            "Aucun fichier attaché : Qonto exige le PDF de la facture fournisseur",
        };
      }

      const ref = purchaseInvoice.invoiceNumber || purchaseInvoice._id;
      const qontoId = await this._uploadSupplierInvoice(credentials, {
        fileUrl,
        filename: file?.filename || `facture-achat-${ref}.pdf`,
        idempotencyKey: String(purchaseInvoice._id),
      });

      return {
        success: true,
        qontoId: qontoId || "imported",
        message: "Facture d'achat synchronisée avec Qonto",
      };
    } catch (error) {
      logger.error("[QONTO] syncPurchaseInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync une dépense (Expense) Newbi → Qonto supplier invoice
   */
  async syncSupplierInvoice(credentials, expense) {
    try {
      const file = pickPdfFile(expense.files);
      if (!file?.url) {
        return {
          success: false,
          message:
            "Aucun justificatif attaché : Qonto exige le fichier de la dépense",
        };
      }

      const ref = expense.invoiceNumber || expense.title || expense._id;
      const qontoId = await this._uploadSupplierInvoice(credentials, {
        fileUrl: file.url,
        filename: file.filename || `depense-${ref}.pdf`,
        idempotencyKey: String(expense._id),
      });

      return {
        success: true,
        qontoId: qontoId || "imported",
        message: "Dépense synchronisée avec Qonto",
      };
    } catch (error) {
      logger.error("[QONTO] syncSupplierInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Rafraîchit la liste des comptes bancaires Qonto stockée sur le compte
   */
  async refreshBankAccounts(account) {
    const result = await this.testConnection(account.getCredentials());
    if (!result.success) return result;
    account.bankAccounts = result.bankAccounts;
    account.organizationName =
      result.organizationName || account.organizationName;
    await account.save();
    return result;
  },

  /**
   * Sync complète : factures clients + factures d'achat + dépenses
   */
  async syncAll(organizationId, { Invoice, Expense, PurchaseInvoice }) {
    const account = await QontoAccount.findOne({ organizationId });
    if (!account || !account.isConnected) {
      return { success: false, message: "Compte Qonto non connecté" };
    }

    const credentials = account.getCredentials();
    const iban = account.getInvoiceBankAccount()?.iban || null;
    const results = {
      invoices: { synced: 0, errors: 0 },
      expenses: { synced: 0, errors: 0 },
    };

    account.syncStatus = "IN_PROGRESS";
    await account.save();

    try {
      // 1. Factures clients
      if (account.autoSync.invoices && Invoice) {
        const invoices = await Invoice.find({
          workspaceId: organizationId,
          status: { $in: ["PENDING", "COMPLETED", "OVERDUE"] },
          qontoSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[QONTO] syncAll: ${invoices.length} factures à synchroniser`,
        );

        for (const invoice of invoices) {
          const result = await this.syncCustomerInvoice(credentials, invoice, {
            iban,
          });
          if (result.success) {
            invoice.qontoSyncStatus = "SYNCED";
            invoice.qontoId = result.qontoId;
            await invoice.save();
            results.invoices.synced++;
          } else {
            invoice.qontoSyncStatus = "ERROR";
            await invoice.save();
            results.invoices.errors++;
            logger.warn(
              `[QONTO] syncAll facture ${invoice.prefix || ""}${invoice.number || invoice._id}: ${result.message}`,
            );
          }
        }
      }

      // 2. Factures d'achat
      if (account.autoSync.supplierInvoices && PurchaseInvoice) {
        const purchaseInvoices = await PurchaseInvoice.find({
          workspaceId: organizationId,
          status: { $in: ["TO_PAY", "PENDING", "PAID", "OVERDUE"] },
          qontoSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[QONTO] syncAll: ${purchaseInvoices.length} factures d'achat à synchroniser`,
        );

        for (const pi of purchaseInvoices) {
          const result = await this.syncPurchaseInvoice(credentials, pi);
          if (result.success) {
            pi.qontoSyncStatus = "SYNCED";
            pi.qontoId = result.qontoId;
            await pi.save();
            results.expenses.synced++;
          } else {
            pi.qontoSyncStatus = "ERROR";
            await pi.save();
            results.expenses.errors++;
            logger.warn(
              `[QONTO] syncAll facture d'achat ${pi.invoiceNumber || pi._id}: ${result.message}`,
            );
          }
        }
      }

      // 3. Dépenses
      if (account.autoSync.supplierInvoices && Expense) {
        const expenses = await Expense.find({
          workspaceId: organizationId,
          status: { $in: ["APPROVED", "PAID"] },
          qontoSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[QONTO] syncAll: ${expenses.length} dépenses à synchroniser`,
        );

        for (const expense of expenses) {
          const result = await this.syncSupplierInvoice(credentials, expense);
          if (result.success) {
            expense.qontoSyncStatus = "SYNCED";
            expense.qontoId = result.qontoId;
            await expense.save();
            results.expenses.synced++;
          } else {
            expense.qontoSyncStatus = "ERROR";
            await expense.save();
            results.expenses.errors++;
            logger.warn(
              `[QONTO] syncAll dépense ${expense.title || expense._id}: ${result.message}`,
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
        message: `Synchronisation terminée: ${total} éléments synchronisés${totalErrors > 0 ? `, ${totalErrors} erreurs` : ""}`,
      };
    } catch (error) {
      account.syncStatus = "ERROR";
      account.syncError = error.message;
      await account.save();

      logger.error("[QONTO] syncAll failed:", error.message);
      return { success: false, message: error.message, results };
    }
  },
};

export { QontoApiError, mapVatRate, mapUnit, normalizeName, isUsableIban };
export default qontoService;
