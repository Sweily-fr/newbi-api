import logger from "../utils/logger.js";
import EInvoicingSettingsService from "./eInvoicingSettingsService.js";

/**
 * Service pour interagir avec l'API SuperPDP
 * Documentation: https://www.superpdp.tech/documentation
 *
 * SuperPDP est une Plateforme de Dématérialisation Partenaire (PDP) agréée
 * pour la facturation électronique en France.
 *
 * Fonctionnalités supportées:
 * - Émission de factures électroniques (Factur-X, UBL, CII)
 * - Réception de factures
 * - Cycle de vie des factures (statuts)
 * - E-reporting
 * - Archivage légal (10 ans)
 * - Interconnexion Peppol
 */
class SuperPdpService {
  constructor() {
    // URLs de l'API SuperPDP (selon documentation officielle)
    // API: https://api.superpdp.tech/v1.beta/
    // OAuth2: https://api.superpdp.tech/oauth2/
    this.baseUrls = {
      sandbox: "https://api.superpdp.tech/v1.beta",
      production: "https://api.superpdp.tech/v1.beta",
    };
    this.oauthUrl = "https://api.superpdp.tech/oauth2";

    // Cache pour les tokens d'accès (par organisation)
    this.tokenCache = new Map();
  }

  /**
   * Obtenir l'URL de base selon l'environnement
   * @param {string} environment - 'sandbox' ou 'production'
   * @returns {string} - URL de base
   */
  getBaseUrl(environment = "sandbox") {
    return this.baseUrls[environment] || this.baseUrls.sandbox;
  }

  /**
   * Obtenir un token d'accès OAuth2 pour une organisation
   * Supporte deux modes:
   * 1. Authorization Code Flow (tokens stockés via OAuth2)
   * 2. Client Credentials Flow (fallback avec variables d'environnement)
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<string>} - Token d'accès
   */
  async getAccessToken(organizationId) {
    try {
      // Vérifier le cache mémoire
      const cachedToken = this.tokenCache.get(organizationId);
      if (cachedToken && cachedToken.expiresAt > Date.now()) {
        logger.debug(`🔑 Token SuperPDP en cache pour ${organizationId}`);
        return cachedToken.accessToken;
      }

      // 1. Essayer d'utiliser les tokens OAuth2 stockés (Authorization Code Flow)
      const storedTokens =
        await EInvoicingSettingsService.getSuperPdpTokens(organizationId);

      if (storedTokens && storedTokens.accessToken) {
        // Vérifier si le token n'est pas expiré
        if (!storedTokens.isExpired) {
          logger.info(
            `🔑 Utilisation du token OAuth2 stocké pour ${organizationId}`,
          );

          // Mettre en cache
          this.tokenCache.set(organizationId, {
            accessToken: storedTokens.accessToken,
            expiresAt: new Date(storedTokens.expiresAt).getTime(),
          });

          return storedTokens.accessToken;
        }

        // Token expiré - essayer de le rafraîchir
        if (storedTokens.refreshToken) {
          logger.info(
            `🔄 Rafraîchissement du token OAuth2 pour ${organizationId}`,
          );
          const newToken = await this.refreshAccessToken(
            organizationId,
            storedTokens.refreshToken,
          );
          if (newToken) {
            return newToken;
          }
        }
      }

      // 2. Fallback: Client Credentials Flow (pour compatibilité)
      logger.info(
        `🔐 Fallback vers Client Credentials Flow pour ${organizationId}`,
      );

      const credentials =
        await EInvoicingSettingsService.getSuperPdpCredentials(organizationId);

      logger.info("🔐 Credentials SuperPDP récupérés:", {
        hasClientId: !!credentials?.clientId,
        hasClientSecret: !!credentials?.clientSecret,
        environment: credentials?.environment,
        clientIdPrefix: credentials?.clientId?.substring(0, 8) + "...",
      });

      if (!credentials || !credentials.clientId || !credentials.clientSecret) {
        throw new Error(
          "Compte SuperPDP non connecté. Veuillez connecter votre compte SuperPDP dans les paramètres de facturation électronique.",
        );
      }

      const tokenUrl = `${this.oauthUrl}/token`;

      logger.info("🌐 Tentative d'authentification OAuth2 SuperPDP:", {
        tokenUrl,
        baseUrl: this.getBaseUrl(credentials.environment),
      });

      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error(
          `Erreur authentification SuperPDP: ${response.status} - ${errorData}`,
        );
        throw new Error(`Erreur authentification SuperPDP: ${response.status}`);
      }

      const tokenData = await response.json();

      // Mettre en cache le token (avec marge de sécurité de 5 minutes)
      this.tokenCache.set(organizationId, {
        accessToken: tokenData.access_token,
        expiresAt: Date.now() + (tokenData.expires_in - 300) * 1000,
      });

      logger.info(
        `✅ Token SuperPDP obtenu pour l'organisation ${organizationId}`,
      );
      return tokenData.access_token;
    } catch (error) {
      logger.error("Erreur lors de l'obtention du token SuperPDP:", error);
      throw error;
    }
  }

  /**
   * Rafraîchir un token d'accès OAuth2 expiré
   * @param {string} organizationId - ID de l'organisation
   * @param {string} refreshToken - Token de rafraîchissement
   * @returns {Promise<string|null>} - Nouveau token d'accès ou null
   */
  async refreshAccessToken(organizationId, refreshToken) {
    try {
      const credentials =
        await EInvoicingSettingsService.getSuperPdpCredentials(organizationId);

      if (!credentials?.clientId || !credentials?.clientSecret) {
        logger.error("Credentials manquants pour rafraîchir le token");
        return null;
      }

      const tokenUrl = `${this.oauthUrl}/token`;

      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error(
          `Erreur rafraîchissement token SuperPDP: ${response.status} - ${errorData}`,
        );
        // Supprimer les tokens invalides
        await EInvoicingSettingsService.removeSuperPdpTokens(organizationId);
        return null;
      }

      const tokenData = await response.json();

      // Stocker les nouveaux tokens
      await EInvoicingSettingsService.storeSuperPdpTokens(organizationId, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshToken,
        expiresIn: tokenData.expires_in,
        tokenType: tokenData.token_type,
      });

      // Mettre en cache
      this.tokenCache.set(organizationId, {
        accessToken: tokenData.access_token,
        expiresAt: Date.now() + (tokenData.expires_in - 300) * 1000,
      });

      logger.info(
        `✅ Token SuperPDP rafraîchi pour l'organisation ${organizationId}`,
      );
      return tokenData.access_token;
    } catch (error) {
      logger.error("Erreur lors du rafraîchissement du token SuperPDP:", error);
      return null;
    }
  }

  /**
   * Effectuer une requête authentifiée à l'API SuperPDP
   * @param {string} organizationId - ID de l'organisation
   * @param {string} endpoint - Endpoint de l'API
   * @param {Object} options - Options de la requête (method, body, etc.)
   * @returns {Promise<Object>} - Réponse de l'API
   */
  async makeRequest(organizationId, endpoint, options = {}) {
    try {
      const credentials =
        await EInvoicingSettingsService.getSuperPdpCredentials(organizationId);
      const baseUrl = this.getBaseUrl(credentials?.environment);
      const accessToken = await this.getAccessToken(organizationId);

      const response = await fetch(`${baseUrl}${endpoint}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...options.headers,
        },
      });

      if (!response.ok) {
        const errorData = await response.text();
        logger.error(`Erreur API SuperPDP: ${response.status} - ${errorData}`);
        throw new Error(
          `Erreur API SuperPDP: ${response.status} - ${errorData}`,
        );
      }

      return await response.json();
    } catch (error) {
      logger.error("Erreur lors de la requête SuperPDP:", error);
      throw error;
    }
  }

  /**
   * Transformer une facture Newbi en format SuperPDP EN16931
   * @param {Object} invoice - Facture Newbi
   * @returns {Object} - Données formatées pour SuperPDP (format EN16931)
   */
  transformInvoiceForSuperPdp(invoice) {
    // Formater la date au format ISO (YYYY-MM-DD)
    const formatDate = (date) => {
      if (!date) return null;
      const d = new Date(date);
      return d.toISOString().split("T")[0];
    };

    // Formater un montant en string avec 2 décimales
    const formatAmount = (amount) => {
      return (Math.round((parseFloat(amount) || 0) * 100) / 100).toFixed(2);
    };

    // Construire les lignes de facture au format EN16931
    const lines = (invoice.items || []).map((item, index) => {
      const quantity = parseFloat(item.quantity) || 1;
      const unitPrice = parseFloat(item.unitPrice) || 0;
      const vatRate = item.vatRate != null ? parseFloat(item.vatRate) : 20;
      const discount = parseFloat(item.discount) || 0;
      const discountType = item.discountType || "PERCENTAGE";
      const progressPercentage =
        item.progressPercentage != null
          ? parseFloat(item.progressPercentage)
          : 100;

      // Calculer le montant HT de la ligne
      let lineAmount = quantity * unitPrice * (progressPercentage / 100);

      // Appliquer la remise
      if (discount > 0) {
        if (discountType === "PERCENTAGE") {
          lineAmount = lineAmount * (1 - Math.min(discount, 100) / 100);
        } else {
          lineAmount = Math.max(0, lineAmount - discount);
        }
      }

      // Convertir l'unité en code UN/ECE
      const unitCode = this.getUnitCode(item.unit);

      return {
        identifier: String(index + 1),
        invoiced_quantity: formatAmount(quantity),
        invoiced_quantity_code: unitCode,
        net_amount: formatAmount(lineAmount),
        item_information: {
          name: item.description || "Article",
          description: item.description || "",
        },
        price_details: {
          item_net_price: formatAmount(unitPrice),
          item_price_base_quantity: "1",
          quantity_unit_code: unitCode,
        },
        vat_information: {
          invoiced_item_vat_category_code: vatRate === 0 ? "Z" : "S", // S = Standard, Z = Zero
          invoiced_item_vat_rate: formatAmount(vatRate),
        },
      };
    });

    // Calculer la ventilation TVA
    const vatBreakDown = [];
    const vatGroups = {};

    (invoice.items || []).forEach((item) => {
      const vatRate = item.vatRate != null ? parseFloat(item.vatRate) : 20;
      const quantity = parseFloat(item.quantity) || 1;
      const unitPrice = parseFloat(item.unitPrice) || 0;
      let lineAmount = quantity * unitPrice;

      const discount = parseFloat(item.discount) || 0;
      const discountType = item.discountType || "PERCENTAGE";
      if (discount > 0) {
        if (discountType === "PERCENTAGE") {
          lineAmount = lineAmount * (1 - Math.min(discount, 100) / 100);
        } else {
          lineAmount = Math.max(0, lineAmount - discount);
        }
      }

      if (!vatGroups[vatRate]) {
        vatGroups[vatRate] = { taxableAmount: 0, taxAmount: 0 };
      }
      vatGroups[vatRate].taxableAmount += lineAmount;
      vatGroups[vatRate].taxAmount += (lineAmount * vatRate) / 100;
    });

    Object.entries(vatGroups).forEach(([rate, amounts]) => {
      vatBreakDown.push({
        vat_category_code: parseFloat(rate) === 0 ? "Z" : "S",
        vat_category_rate: formatAmount(rate),
        vat_category_taxable_amount: formatAmount(amounts.taxableAmount),
        vat_category_tax_amount: formatAmount(amounts.taxAmount),
      });
    });

    // Construire l'objet facture au format SuperPDP EN16931
    const sellerSiret = invoice.companyInfo?.siret || "";
    const buyerSiret = invoice.client?.siret || "";
    // Extraire le SIREN (9 premiers chiffres du SIRET)
    const sellerSiren = sellerSiret ? sellerSiret.substring(0, 9) : "";
    const buyerSiren = buyerSiret ? buyerSiret.substring(0, 9) : "";
    // Numéro de TVA intracommunautaire
    const sellerVat =
      invoice.companyInfo?.vatNumber ||
      (sellerSiren ? `FR${this.computeVatKey(sellerSiren)}${sellerSiren}` : "");
    const buyerVat = invoice.client?.vatNumber || "";
    // Générer un identifiant unique pour le buyer s'il n'a pas de SIREN
    const buyerEndpointId =
      buyerSiren || `BUYER_${invoice._id?.toString() || Date.now()}`;

    const superPdpInvoice = {
      en_invoice: {
        number: `${invoice.prefix || ""}${invoice.number}`,
        issue_date: formatDate(invoice.issueDate),
        payment_due_date: formatDate(invoice.dueDate),
        // UNTDID 1001 : 380 facture, 386 facture d'acompte.
        // NB : les avoirs (381) sont un modèle CreditNote distinct, non routé par
        // ce service — ils ne transitent donc pas par cette transformation.
        type_code: invoice.isDeposit ? 386 : 380,
        currency_code: "EUR",

        // Nature de l'opération (réforme 2026)
        ...(invoice.operationType && { operation_type: invoice.operationType }),

        // Notes obligatoires pour la France (BR-FR-05)
        notes: [
          {
            subject_code: "PMT",
            note: "L'indemnité forfaitaire légale pour frais de recouvrement est de 40 €.",
          },
          {
            subject_code: "PMD",
            note: "À défaut de règlement à la date d'échéance, une pénalité de 10 % du net à payer TTC sera applicable immédiatement.",
          },
          {
            subject_code: "AAB",
            note: "Aucun escompte pour paiement anticipé.",
          },
          // TVA sur les débits (mention conditionnelle)
          ...(invoice.companyInfo?.vatPaymentCondition === "DEBITS"
            ? [{ subject_code: "REG", note: "TVA acquittée sur les débits" }]
            : []),
        ],

        process_control: {
          business_process_type: "M1",
          specification_identifier: "urn:cen.eu:en16931:2017",
        },

        seller: {
          name: invoice.companyInfo?.name || "Entreprise",
          identifiers: sellerSiren
            ? [{ value: sellerSiren, scheme: "0002" }]
            : [],
          legal_registration_identifier: sellerSiren
            ? { value: sellerSiren, scheme: "0002" }
            : undefined,
          vat_identifier: sellerVat,
          electronic_address: sellerSiren
            ? { value: sellerSiren, scheme: "0009" }
            : undefined,
          postal_address: {
            country_code:
              this.getCountryCode(invoice.companyInfo?.address?.country) ||
              "FR",
          },
        },

        buyer: {
          name: invoice.client?.name || "Client",
          identifiers: buyerSiren
            ? [{ value: buyerSiren, scheme: "0002" }]
            : [],
          legal_registration_identifier: buyerSiren
            ? { value: buyerSiren, scheme: "0002" }
            : undefined,
          vat_identifier: buyerVat,
          electronic_address: { value: buyerEndpointId, scheme: "0009" },
          postal_address: {
            country_code:
              this.getCountryCode(invoice.client?.address?.country) || "FR",
          },
        },

        // Adresse de livraison (si disponible)
        ...(invoice.shipping?.billShipping && invoice.shipping?.shippingAddress
          ? {
              delivery: {
                deliver_to_address: {
                  country_code:
                    this.getCountryCode(
                      invoice.shipping.shippingAddress.country,
                    ) || "FR",
                  ...(invoice.shipping.shippingAddress.postalCode && {
                    post_code: invoice.shipping.shippingAddress.postalCode,
                  }),
                  ...(invoice.shipping.shippingAddress.street && {
                    address_line_1: invoice.shipping.shippingAddress.street,
                  }),
                  ...(invoice.shipping.shippingAddress.city && {
                    city: invoice.shipping.shippingAddress.city,
                  }),
                },
              },
            }
          : {}),

        totals: {
          sum_invoice_lines_amount: formatAmount(invoice.finalTotalHT || 0),
          total_without_vat: formatAmount(invoice.finalTotalHT || 0),
          total_vat_amount: {
            value: formatAmount(invoice.finalTotalVAT || 0),
            currency_code: "EUR",
          },
          total_with_vat: formatAmount(invoice.finalTotalTTC || 0),
          amount_due_for_payment: formatAmount(invoice.finalTotalTTC || 0),
        },

        vat_break_down: vatBreakDown,
        lines: lines,
      },
    };

    return superPdpInvoice;
  }

  /**
   * Calculer la clé TVA à partir du SIREN
   */
  computeVatKey(siren) {
    const sirenNum = parseInt(siren, 10);
    const key = (12 + 3 * (sirenNum % 97)) % 97;
    return key.toString().padStart(2, "0");
  }

  /**
   * Convertir le code pays en code ISO 2 lettres
   * @param {string} country - Nom du pays
   * @returns {string} - Code ISO 2 lettres
   */
  getCountryCode(country) {
    if (!country) return "FR";

    const countryMap = {
      france: "FR",
      allemagne: "DE",
      belgique: "BE",
      espagne: "ES",
      italie: "IT",
      luxembourg: "LU",
      "pays-bas": "NL",
      portugal: "PT",
      "royaume-uni": "GB",
      suisse: "CH",
    };

    const normalized = country.toLowerCase().trim();

    // Si c'est déjà un code ISO
    if (normalized.length === 2) {
      return normalized.toUpperCase();
    }

    return countryMap[normalized] || "FR";
  }

  /**
   * Convertir l'unité en code UN/ECE Recommendation 20
   * @param {string} unit - Unité Newbi (texte ou code)
   * @returns {string} - Code UN/ECE
   */
  getUnitCode(unit) {
    if (!unit) return "C62"; // C62 = unité par défaut (one)

    const unitMap = {
      // Textes français courants
      unité: "C62",
      unite: "C62",
      pièce: "C62",
      piece: "C62",
      heure: "HUR",
      heures: "HUR",
      jour: "DAY",
      jours: "DAY",
      mois: "MON",
      semaine: "WEE",
      semaines: "WEE",
      forfait: "C62",
      lot: "C62",
      kg: "KGM",
      kilogramme: "KGM",
      g: "GRM",
      gramme: "GRM",
      l: "LTR",
      litre: "LTR",
      m: "MTR",
      mètre: "MTR",
      metre: "MTR",
      m2: "MTK",
      "m²": "MTK",
      m3: "MTQ",
      "m³": "MTQ",
      km: "KMT",
      "personne(s)": "C62",
      personne: "C62",
      personnes: "C62",
      // Codes UN/ECE déjà valides
      c62: "C62",
      hur: "HUR",
      day: "DAY",
      mon: "MON",
      wee: "WEE",
      kgm: "KGM",
      grm: "GRM",
      ltr: "LTR",
      mtr: "MTR",
      mtk: "MTK",
      mtq: "MTQ",
      kmt: "KMT",
    };

    const normalized = unit.toLowerCase().trim();
    return unitMap[normalized] || "C62";
  }

  /**
   * Convertir le mode de paiement en code UNCL 4461
   * @param {string} paymentMethod - Mode de paiement Newbi
   * @returns {string} - Code UNCL 4461
   */
  getPaymentMeansCode(paymentMethod) {
    const paymentMap = {
      BANK_TRANSFER: "30", // Virement
      CASH: "10", // Espèces
      CHECK: "20", // Chèque
      CARD: "48", // Carte bancaire
      DIRECT_DEBIT: "49", // Prélèvement
      OTHER: "1", // Autre
    };

    return paymentMap[paymentMethod] || "30";
  }

  /**
   * Envoyer une facture à SuperPDP
   * @param {string} organizationId - ID de l'organisation
   * @param {Object} invoice - Facture Newbi
   * @returns {Promise<Object>} - Réponse de SuperPDP avec l'ID de la facture
   */
  async sendInvoice(organizationId, invoice) {
    try {
      logger.info(
        `📤 Envoi de la facture ${invoice.prefix}${invoice.number} à SuperPDP...`,
      );

      // Vérifier que l'e-invoicing est activé
      const isEnabled =
        await EInvoicingSettingsService.isEInvoicingEnabled(organizationId);
      if (!isEnabled) {
        throw new Error(
          "La facturation électronique n'est pas activée pour cette organisation",
        );
      }

      // Transformer la facture au format SuperPDP
      const superPdpInvoice = this.transformInvoiceForSuperPdp(invoice);

      // Log de la facture transformée pour debug
      logger.debug("📋 Facture transformée pour SuperPDP:", {
        number: superPdpInvoice.en_invoice?.number,
        issue_date: superPdpInvoice.en_invoice?.issue_date,
        total_with_vat: superPdpInvoice.en_invoice?.totals?.total_with_vat,
        linesCount: superPdpInvoice.en_invoice?.lines?.length,
        hasEnInvoice: !!superPdpInvoice.en_invoice,
      });

      // Log complet pour debug
      logger.debug(
        "📋 Payload complet:",
        JSON.stringify(superPdpInvoice, null, 2).substring(0, 500),
      );

      // Étape 1: Convertir EN16931 JSON → UBL XML via /invoices/convert (endpoint public)
      logger.info("🔄 Conversion EN16931 → UBL via /invoices/convert...");

      const en16931Payload = JSON.stringify(superPdpInvoice.en_invoice);

      // L'endpoint /invoices/convert est PUBLIC (security: [] dans la spec OpenAPI)
      const convertResponse = await fetch(
        "https://api.superpdp.tech/v1.beta/invoices/convert?from=en16931&to=ubl",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/xml",
          },
          body: en16931Payload,
        },
      );

      if (!convertResponse.ok) {
        const errorText = await convertResponse.text();
        logger.error(
          `❌ Erreur conversion SuperPDP: ${convertResponse.status} - ${errorText}`,
        );
        throw new Error(
          `Erreur conversion SuperPDP: ${convertResponse.status} - ${errorText}`,
        );
      }

      const ublXml = await convertResponse.text();
      logger.info(
        `✅ Conversion réussie, XML UBL généré (${ublXml.length} chars)`,
      );
      logger.debug("📄 XML UBL (début):", ublXml.substring(0, 500));

      // Étape 2: Envoyer le XML UBL à /invoices (endpoint authentifié)
      logger.info("🚀 Envoi du XML UBL à SuperPDP POST /invoices...");

      const response = await this.makeRequest(organizationId, "/invoices", {
        method: "POST",
        body: ublXml,
        headers: {
          "Content-Type": "application/xml",
        },
      });

      // Réponse réelle : { id, direction, en_invoice, events[], external_id, ... }
      const superPdpInvoiceId = response.id;
      const events = this.extractEvents(response.events);
      const { status, lastCode } = this.deriveStatusFromEvents(events);

      logger.info(
        `✅ Facture envoyée à SuperPDP: id=${superPdpInvoiceId}, ${events.length} événement(s), statut dérivé=${status}`,
      );

      return {
        success: true,
        superPdpInvoiceId,
        status,
        lastCode,
        events,
        message: "Facture envoyée avec succès",
        response,
      };
    } catch (error) {
      logger.error(
        "❌ Erreur lors de l'envoi de la facture à SuperPDP:",
        error,
      );

      return {
        success: false,
        error: error.message,
        superPdpInvoiceId: null,
        status: "ERROR",
      };
    }
  }

  /**
   * Récupérer le statut d'une facture chez SuperPDP
   * @param {string} organizationId - ID de l'organisation
   * @param {string} superPdpInvoiceId - ID de la facture chez SuperPDP
   * @returns {Promise<Object>} - Statut de la facture
   */
  async getInvoiceStatus(organizationId, superPdpInvoiceId) {
    try {
      // Pas d'endpoint /status : le statut est porté par le tableau events[] de la facture.
      const response = await this.makeRequest(
        organizationId,
        `/invoices/${superPdpInvoiceId}?expand[]=events`,
      );

      const events = this.extractEvents(response.events);
      const { status, lastCode } = this.deriveStatusFromEvents(events);

      return {
        success: true,
        status,
        lastCode,
        events,
        statusHistory: events,
        lastUpdated:
          events.length > 0 ? events[events.length - 1].occurredAt : null,
      };
    } catch (error) {
      logger.error(
        `Erreur lors de la récupération du statut de la facture ${superPdpInvoiceId}:`,
        error,
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Récupérer le PDF archivé d'une facture chez SuperPDP
   * @param {string} organizationId - ID de l'organisation
   * @param {string} superPdpInvoiceId - ID de la facture chez SuperPDP
   * @returns {Promise<Buffer>} - PDF de la facture
   */
  async getArchivedPdf(organizationId, superPdpInvoiceId) {
    try {
      const credentials =
        await EInvoicingSettingsService.getSuperPdpCredentials(organizationId);
      const baseUrl = this.getBaseUrl(credentials?.environment);
      const accessToken = await this.getAccessToken(organizationId);

      // Pas d'endpoint /pdf : on demande le rendu Factur-X de la facture.
      // Fallback sur /download (fichier brut) si le format n'est pas disponible.
      const urls = [
        `${baseUrl}/invoices/${superPdpInvoiceId}?format=factur-x&force_superpdp_pdf_renderer=true`,
        `${baseUrl}/invoices/${superPdpInvoiceId}/download`,
      ];

      let lastError = null;
      for (const url of urls) {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/pdf",
          },
        });

        if (response.ok) {
          const pdfBuffer = await response.arrayBuffer();
          return Buffer.from(pdfBuffer);
        }
        lastError = `${response.status} sur ${url}`;
      }

      throw new Error(
        `Erreur lors de la récupération du PDF Factur-X: ${lastError}`,
      );
    } catch (error) {
      logger.error("Erreur lors de la récupération du PDF archivé:", error);
      throw error;
    }
  }

  /**
   * Consulter l'annuaire SuperPDP pour vérifier si un destinataire peut recevoir des e-factures
   * @param {string} organizationId - ID de l'organisation
   * @param {string} siret - SIRET du destinataire
   * @returns {Promise<Object>} - Informations sur le destinataire
   */
  async checkRecipientDirectory(organizationId, siret) {
    try {
      // L'annuaire s'interroge par SIREN (9 premiers chiffres du SIRET).
      const cleaned = String(siret || "").replace(/\s/g, "");
      const siren = cleaned.substring(0, 9);

      if (!siren || siren.length < 9) {
        return {
          success: false,
          canReceiveEInvoices: false,
          error: "SIRET/SIREN invalide",
        };
      }

      // GET /french_directory/entries?number={SIREN} : liste les inscriptions annuaire.
      // Présence d'au moins une entrée ⇒ le destinataire peut recevoir des e-factures.
      const response = await this.makeRequest(
        organizationId,
        `/french_directory/entries?number=${encodeURIComponent(siren)}`,
      );

      const entries = response.data || response.entries || [];
      const firstEntry = Array.isArray(entries) ? entries[0] : null;

      return {
        success: true,
        canReceiveEInvoices: Array.isArray(entries) && entries.length > 0,
        pdpName: firstEntry?.pdp_name || firstEntry?.pdpName || null,
        pdpId: firstEntry?.pdp_id || firstEntry?.pdpId || null,
        peppolId: firstEntry?.peppol_id || firstEntry?.peppolId || null,
      };
    } catch (error) {
      logger.error(
        `Erreur lors de la consultation de l'annuaire pour ${siret}:`,
        error,
      );

      return {
        success: false,
        canReceiveEInvoices: false,
        error: error.message,
      };
    }
  }

  // ============================================================
  // ONBOARDING : SESSION OAUTH, ENTREPRISE, ANNUAIRE
  // ============================================================

  /**
   * Récupérer la session OAuth courante (statut de vérification KYC/KYB).
   * IMPORTANT : tant que company_verification_status !== "verified",
   * toutes les autres routes SuperPDP renvoient 403.
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<{clientId, companyVerificationStatus, userIdentityVerificationStatus}>}
   */
  async getOAuthSession(organizationId) {
    const response = await this.makeRequest(
      organizationId,
      "/oauth2_sessions/me",
    );
    return {
      clientId: response.client_id || null,
      companyVerificationStatus: response.company_verification_status || null,
      userIdentityVerificationStatus:
        response.user_identity_verification_status || null,
    };
  }

  /**
   * Récupérer l'entreprise associée au token courant.
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object>} - Entreprise SuperPDP (companies/me)
   */
  async getCurrentCompany(organizationId) {
    const response = await this.makeRequest(organizationId, "/companies/me");
    return {
      id: response.id,
      formalName: response.formal_name || null,
      tradeName: response.trade_name || null,
      number: response.number || null,
      numberScheme: response.number_scheme || null,
      vatRegime:
        typeof response.vat_regime === "object"
          ? response.vat_regime?.value || response.vat_regime?.code || null
          : response.vat_regime || null,
      env: response.env || null,
      raw: response,
    };
  }

  /**
   * Inscrire l'entreprise dans un annuaire (peppol|ppf) pour pouvoir RECEVOIR.
   * @param {string} organizationId - ID de l'organisation
   * @param {string} directory - "peppol" | "ppf"
   * @param {string} identifier - Identifiant (SIREN)
   * @returns {Promise<Object>} - Entrée d'annuaire créée
   */
  async registerDirectoryEntry(organizationId, directory, identifier) {
    const response = await this.makeRequest(
      organizationId,
      "/directory_entries",
      {
        method: "POST",
        body: JSON.stringify({ directory, identifier }),
      },
    );
    return {
      id: response.id,
      directory: response.directory,
      identifier: response.identifier,
      status: response.status,
      statusMessage: response.status_message || null,
      effectiveDate: response.effective_date || null,
    };
  }

  /**
   * Lister les entrées d'annuaire de l'entreprise.
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Array>} - Entrées d'annuaire
   */
  async getDirectoryEntries(organizationId) {
    const response = await this.makeRequest(
      organizationId,
      "/directory_entries",
    );
    const data = response.data || [];
    return data.map((e) => ({
      id: e.id,
      directory: e.directory,
      identifier: e.identifier,
      status: e.status,
      statusMessage: e.status_message || null,
      effectiveDate: e.effective_date || null,
    }));
  }

  // ============================================================
  // E-REPORTING (B2C / international / paiements)
  // ============================================================

  /**
   * Calculer la ventilation TVA d'une facture (montants en number).
   * @param {Object} invoice
   * @returns {Array<{rate:number, taxableAmount:number, taxAmount:number}>}
   */
  _computeVatGroups(invoice) {
    const groups = {};
    (invoice.items || []).forEach((item) => {
      const vatRate = item.vatRate != null ? parseFloat(item.vatRate) : 20;
      const quantity = parseFloat(item.quantity) || 1;
      const unitPrice = parseFloat(item.unitPrice) || 0;
      let lineAmount = quantity * unitPrice;
      const discount = parseFloat(item.discount) || 0;
      const discountType = item.discountType || "PERCENTAGE";
      if (discount > 0) {
        lineAmount =
          discountType === "PERCENTAGE"
            ? lineAmount * (1 - Math.min(discount, 100) / 100)
            : Math.max(0, lineAmount - discount);
      }
      if (!groups[vatRate])
        groups[vatRate] = { taxableAmount: 0, taxAmount: 0 };
      groups[vatRate].taxableAmount += lineAmount;
      groups[vatRate].taxAmount += (lineAmount * vatRate) / 100;
    });
    return Object.entries(groups).map(([rate, a]) => ({
      rate: parseFloat(rate),
      taxableAmount: a.taxableAmount,
      taxAmount: a.taxAmount,
    }));
  }

  /**
   * Résout le category_code e-reporting (enum imposé, Annexe A Z12-012) à partir
   * de la NATURE DE L'OPÉRATION de la facture (champ `operationType`, obligatoire 2026) :
   *   LB (livraison de biens) → TLB1 · PS (prestation de services) → TPS1 · LBPS (mixte) → TMA1
   * Repli : EREPORTING_CATEGORY_CODE (validé) sinon TPS1. On NE renvoie JAMAIS une
   * valeur hors enum (sinon SuperPDP rejette la soumission). (TNT1 = non taxable,
   * uniquement via override env.)
   * @param {Object} invoice
   * @returns {string}
   */
  _resolveEReportingCategory(invoice) {
    const VALID = ["TLB1", "TPS1", "TNT1", "TMA1"];
    const MAP = { LB: "TLB1", PS: "TPS1", LBPS: "TMA1" };
    const fromOp = MAP[invoice?.operationType];
    if (fromOp) return fromOp;

    const env = process.env.EREPORTING_CATEGORY_CODE;
    if (env && VALID.includes(env)) return env;
    logger.warn(
      `category_code e-reporting indéterminé (operationType=${invoice?.operationType ?? "null"}) → repli TPS1. Renseignez la « Nature de l'opération » sur la facture ou EREPORTING_CATEGORY_CODE.`,
    );
    return "TPS1";
  }

  /**
   * Soumettre une transaction B2C / e-reporting transaction à SuperPDP.
   * SuperPDP stocke puis agrège/transmet au PPF selon le régime TVA.
   * @param {string} organizationId
   * @param {Object} invoice - Facture Newbi (flux E_REPORTING_TRANSACTION)
   * @returns {Promise<{success, id?, status?, error?}>}
   */
  async submitB2cTransaction(organizationId, invoice) {
    try {
      const fmt = (n) =>
        (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
      const date = invoice.issueDate
        ? new Date(invoice.issueDate).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

      const groups = this._computeVatGroups(invoice);
      const taxSubtotals = groups.map((g) => ({
        tax_percent: fmt(g.rate),
        tax_total: fmt(g.taxAmount),
        taxable_amount: fmt(g.taxableAmount),
      }));

      // ⚠️ category_code n'a pas d'énum documenté dans la spec : valeur par défaut
      // prudente, surchargée par EREPORTING_CATEGORY_CODE — à valider en sandbox.
      const categoryCode = this._resolveEReportingCategory(invoice);

      const item = {
        category_code: String(categoryCode),
        currency: "EUR",
        date,
        role_code: "SE",
        tax_exclusive_amount: fmt(invoice.finalTotalHT),
        tax_total: fmt(invoice.finalTotalVAT),
        tax_subtotals: taxSubtotals,
      };

      const response = await this.makeRequest(
        organizationId,
        "/b2c_transactions",
        { method: "POST", body: JSON.stringify({ data: [item] }) },
      );

      const created = response.data?.[0] || {};
      logger.info(
        `📊 E-reporting transaction soumise pour ${invoice.prefix || ""}${invoice.number} (id=${created.id})`,
      );
      return { success: true, id: created.id, status: created.status };
    } catch (error) {
      logger.error("❌ Erreur soumission e-reporting transaction:", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Soumettre un paiement B2C (TVA sur encaissements) à SuperPDP.
   * @param {string} organizationId
   * @param {Object} invoice
   * @param {Date|string} paymentDate
   * @returns {Promise<{success, id?, error?}>}
   */
  async submitB2cPayment(organizationId, invoice, paymentDate) {
    try {
      const fmt = (n) =>
        (Math.round((parseFloat(n) || 0) * 100) / 100).toFixed(2);
      const date = paymentDate
        ? new Date(paymentDate).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

      // category_code est REQUIS sur chaque b2c_payment_subtotal (cf. spec).
      const categoryCode = this._resolveEReportingCategory(invoice);

      const groups = this._computeVatGroups(invoice);
      // Montant encaissé par taux = HT + TVA du groupe (TTC)
      const subtotals = groups.map((g) => ({
        category_code: String(categoryCode),
        tax_percent: fmt(g.rate),
        amount: fmt(g.taxableAmount + g.taxAmount),
        currency_code: "EUR",
      }));

      const response = await this.makeRequest(organizationId, "/b2c_payments", {
        method: "POST",
        body: JSON.stringify({ data: [{ date, subtotals }] }),
      });

      const created = response.data?.[0] || {};
      logger.info(
        `📊 E-reporting paiement soumis pour ${invoice.prefix || ""}${invoice.number} (id=${created.id})`,
      );
      return { success: true, id: created.id };
    } catch (error) {
      logger.error("❌ Erreur soumission e-reporting paiement:", error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Mettre à jour le régime TVA de l'entreprise (pilote le calendrier PPF).
   * @param {string} organizationId
   * @param {string} vatRegime - monthly|quarterly|simplified|vat_exemption
   */
  async updateVatRegime(organizationId, vatRegime) {
    const response = await this.makeRequest(organizationId, "/companies", {
      method: "PATCH",
      body: JSON.stringify({ vat_regime: vatRegime }),
    });
    return { vatRegime: response.vat_regime || vatRegime };
  }

  /**
   * Lister les e-reportings transmis au PPF (affichage).
   * @param {string} organizationId
   * @param {Object} opts - { limit }
   */
  async getEReportings(organizationId, opts = {}) {
    const params = new URLSearchParams({
      role_code: "SE",
      order: "desc",
      limit: String(opts.limit || 50),
    });
    const response = await this.makeRequest(
      organizationId,
      `/ereportings?${params.toString()}`,
    );
    return response.data || [];
  }

  /**
   * Émettre un événement de cycle de vie sur une facture (reçue) — côté destinataire.
   * Permet d'approuver (fr:205), refuser (fr:210), contester (fr:207), etc.
   * @param {string} organizationId
   * @param {string|number} superPdpInvoiceId - ID SuperPDP de la facture
   * @param {string} statusCode - code fr:204..fr:212
   * @param {Object} [opts] - { reason }
   * @returns {Promise<{success, statusCode?, error?}>}
   */
  async submitInvoiceEvent(
    organizationId,
    superPdpInvoiceId,
    statusCode,
    opts = {},
  ) {
    try {
      const body = {
        invoice_id: Number(superPdpInvoiceId),
        status_code: statusCode,
        ...(opts.reason ? { details: [{ reason: opts.reason }] } : {}),
      };
      const response = await this.makeRequest(
        organizationId,
        "/invoice_events",
        { method: "POST", body: JSON.stringify(body) },
      );
      logger.info(
        `🔄 Événement cycle de vie ${statusCode} émis pour facture SuperPDP ${superPdpInvoiceId}`,
      );
      return { success: true, statusCode: response.status_code || statusCode };
    } catch (error) {
      logger.error(
        `❌ Erreur émission événement ${statusCode} (facture ${superPdpInvoiceId}):`,
        error,
      );
      return { success: false, error: error.message };
    }
  }

  /**
   * Tester la connexion à SuperPDP
   * @param {string} organizationId - ID de l'organisation
   * @returns {Promise<Object>} - Résultat du test
   */
  async testConnection(organizationId) {
    try {
      // Vider le cache pour forcer un nouveau test
      this.tokenCache.delete(organizationId);

      // Essayer d'obtenir un token - si ça réussit, la connexion est valide
      const token = await this.getAccessToken(organizationId);

      if (token) {
        logger.info(
          `✅ Test de connexion SuperPDP réussi pour ${organizationId}`,
        );
        return {
          success: true,
          message: "Connexion à SuperPDP réussie - Token OAuth2 obtenu",
          profile: { tokenObtained: true },
        };
      }

      return {
        success: false,
        message: "Impossible d'obtenir un token OAuth2",
        error: "Token non obtenu",
      };
    } catch (error) {
      logger.error(`❌ Test de connexion SuperPDP échoué: ${error.message}`);
      return {
        success: false,
        message: `Erreur de connexion: ${error.message}`,
        error: error.message,
      };
    }
  }

  // ============================================================
  // RÉCEPTION DE FACTURES D'ACHAT (factures fournisseurs)
  // ============================================================

  /**
   * Récupérer les factures reçues depuis SuperPDP
   * @param {string} organizationId - ID de l'organisation
   * @param {Object} options - Options de filtrage
   * @param {number} options.page - Page (défaut: 1)
   * @param {number} options.limit - Limite par page (défaut: 50)
   * @param {string} options.since - Date ISO depuis laquelle récupérer
   * @param {string} options.status - Filtrer par statut
   * @returns {Promise<Object>} - { invoices: [], totalCount, page, totalPages }
   */
  async getReceivedInvoices(organizationId, options = {}) {
    try {
      const { limit = 50, startingAfterId, date } = options;

      logger.info(
        `📥 Récupération des factures reçues depuis SuperPDP pour ${organizationId}`,
      );

      // Spec réelle : direction=in (enum in|out), pagination par curseur
      // (starting_after_id / ending_before_id), réponse { count, data[], has_after, has_before }.
      const params = new URLSearchParams({
        direction: "in",
        limit: String(limit),
        order: "desc",
      });

      if (startingAfterId)
        params.append("starting_after_id", String(startingAfterId));
      if (date) params.append("date", date);

      const response = await this.makeRequest(
        organizationId,
        `/invoices?${params.toString()}`,
      );

      const data = response.data || [];

      logger.info(
        `✅ ${data.length} facture(s) reçue(s) récupérée(s) depuis SuperPDP`,
      );

      return {
        invoices: data,
        totalCount: response.count ?? data.length,
        hasAfter: response.has_after || false,
        hasBefore: response.has_before || false,
      };
    } catch (error) {
      logger.error("❌ Erreur récupération factures reçues SuperPDP:", error);
      throw error;
    }
  }

  /**
   * Récupérer le détail d'une facture reçue au format EN16931
   * @param {string} organizationId - ID de l'organisation
   * @param {string} superPdpInvoiceId - ID SuperPDP de la facture
   * @returns {Promise<Object>} - Détail de la facture (format EN16931)
   */
  async getReceivedInvoiceDetail(organizationId, superPdpInvoiceId) {
    try {
      const response = await this.makeRequest(
        organizationId,
        `/invoices/${superPdpInvoiceId}?format=en16931`,
      );
      return response;
    } catch (error) {
      logger.error(
        `❌ Erreur récupération détail facture ${superPdpInvoiceId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Transformer une facture SuperPDP reçue en format PurchaseInvoice Newbi
   * @param {Object} superPdpInvoice - Facture reçue au format SuperPDP/EN16931
   * @param {string} workspaceId - ID du workspace
   * @param {string} userId - ID de l'utilisateur
   * @returns {Object} - Données pour créer un PurchaseInvoice
   */
  transformReceivedInvoiceToPurchaseInvoice(
    superPdpInvoice,
    workspaceId,
    userId,
  ) {
    const invoice = superPdpInvoice.en_invoice || superPdpInvoice;

    // Extraire les informations du vendeur (= fournisseur pour nous)
    const seller = invoice.seller || {};
    const supplierName = seller.name || "Fournisseur inconnu";
    const supplierSiret =
      seller.legal_registration_identifier?.value ||
      seller.identifiers?.[0]?.value ||
      "";
    const supplierVatNumber = seller.vat_identifier || "";

    // Extraire les montants
    const totals = invoice.totals || {};
    const amountHT = parseFloat(totals.total_without_vat) || 0;
    const amountTTC =
      parseFloat(totals.total_with_vat) ||
      parseFloat(totals.amount_due_for_payment) ||
      0;
    const vatAmount =
      typeof totals.total_vat_amount === "object"
        ? parseFloat(totals.total_vat_amount.value) || 0
        : parseFloat(totals.total_vat_amount) || 0;

    // Calculer le taux de TVA principal
    const vatBreakDown = invoice.vat_break_down || [];
    let mainVatRate = 20;
    if (vatBreakDown.length > 0) {
      // Prendre le taux du plus gros montant imposable
      const largest = vatBreakDown.reduce((a, b) =>
        parseFloat(a.vat_category_taxable_amount || 0) >=
        parseFloat(b.vat_category_taxable_amount || 0)
          ? a
          : b,
      );
      mainVatRate = parseFloat(largest.vat_category_rate) || 20;
    }

    // Dates
    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      const d = new Date(dateStr);
      return isNaN(d.getTime()) ? null : d;
    };

    // Catégoriser automatiquement basé sur le nom du fournisseur
    const category = this.guessCategoryFromSupplier(supplierName);

    return {
      supplierName,
      invoiceNumber: invoice.number || "",
      issueDate: parseDate(invoice.issue_date) || new Date(),
      dueDate: parseDate(invoice.payment_due_date),
      amountHT,
      amountTVA: vatAmount,
      vatRate: mainVatRate,
      amountTTC,
      currency: invoice.currency_code || "EUR",
      status: "TO_PROCESS",
      category,
      source: "SUPERPDP",
      superPdpInvoiceId: superPdpInvoice.id || superPdpInvoice.invoiceId || "",
      eInvoiceStatus: "RECEIVED",
      eInvoiceReceivedAt: new Date(),
      eInvoiceRawData: superPdpInvoice,
      ocrMetadata: {
        supplierName,
        supplierSiret,
        supplierVatNumber,
        invoiceNumber: invoice.number || "",
        invoiceDate: parseDate(invoice.issue_date),
        dueDate: parseDate(invoice.payment_due_date),
        amountHT,
        amountTVA: vatAmount,
        vatRate: mainVatRate,
        amountTTC,
        currency: invoice.currency_code || "EUR",
        confidenceScore: 1.0, // Donnée structurée = confiance maximale
      },
      workspaceId,
      createdBy: userId,
    };
  }

  /**
   * Deviner la catégorie de dépense à partir du nom du fournisseur
   * @param {string} supplierName - Nom du fournisseur
   * @returns {string} - Catégorie PurchaseInvoice
   */
  guessCategoryFromSupplier(supplierName) {
    if (!supplierName) return "OTHER";
    const name = supplierName.toLowerCase();

    const rules = [
      {
        keywords: ["edf", "engie", "total energies", "direct energie"],
        category: "ENERGY",
      },
      {
        keywords: ["orange", "sfr", "bouygues telecom", "free", "ovh", "ionos"],
        category: "TELECOMMUNICATIONS",
      },
      {
        keywords: ["axa", "allianz", "maif", "macif", "groupama", "generali"],
        category: "INSURANCE",
      },
      {
        keywords: [
          "sncf",
          "air france",
          "uber",
          "bolt",
          "blablacar",
          "hertz",
          "europcar",
        ],
        category: "TRANSPORT",
      },
      {
        keywords: [
          "amazon web services",
          "aws",
          "google cloud",
          "microsoft azure",
          "github",
          "gitlab",
          "notion",
          "slack",
          "figma",
          "canva",
          "adobe",
          "jetbrains",
        ],
        category: "SOFTWARE",
      },
      {
        keywords: ["apple", "dell", "lenovo", "hp", "samsung"],
        category: "HARDWARE",
      },
      {
        keywords: ["loyer", "bail", "foncier", "immobilier"],
        category: "RENT",
      },
      {
        keywords: [
          "google ads",
          "meta ads",
          "facebook ads",
          "linkedin ads",
          "mailchimp",
          "sendinblue",
          "brevo",
        ],
        category: "MARKETING",
      },
      {
        keywords: ["restaurant", "deliveroo", "uber eats", "just eat"],
        category: "MEALS",
      },
      {
        keywords: ["urssaf", "impot", "taxe", "dgfip", "cfe"],
        category: "TAXES",
      },
    ];

    for (const rule of rules) {
      if (rule.keywords.some((kw) => name.includes(kw))) {
        return rule.category;
      }
    }

    return "OTHER";
  }

  /**
   * Mapper un code d'événement SuperPDP (api:* / fr:* / ppf:*) vers le statut
   * d'affichage Newbi (eInvoiceStatus).
   *
   * IMPORTANT : SuperPDP n'est PAS une state machine — les statuts sont un tableau
   * d'événements. Ce mapping ne sert qu'à dériver un statut d'AFFICHAGE à partir d'un
   * code. L'historique brut complet est conservé dans invoice.eInvoiceEvents.
   *
   * Réf. spec status_code : codes officiels fr:200-213/501 (cycle de vie DGFiP).
   * @param {string} code - Code SuperPDP (ex. "fr:205", "api:sent")
   * @returns {string|null} - eInvoiceStatus, ou null si code non reconnu (ex. ppf:*)
   */
  mapSuperPdpCodeToStatus(code) {
    if (!code) return null;
    const map = {
      // Statuts internes SuperPDP / Peppol
      "api:uploaded": "PENDING_VALIDATION",
      "api:invalid": "ERROR",
      "api:validated": "VALIDATED",
      "api:sent": "SENT_TO_RECIPIENT",
      "api:received": "RECEIVED",
      "api:acknowledged": "RECEIVED",
      "api:accepted": "ACCEPTED",
      "api:rejected": "REJECTED",
      // Statuts officiels français (cycle de vie DGFiP)
      "fr:200": "PENDING_VALIDATION", // Submitted
      "fr:201": "SENT_TO_RECIPIENT", // Sent
      "fr:202": "RECEIVED", // Received
      "fr:203": "RECEIVED", // Made available
      "fr:204": "RECEIVED", // Acknowledged
      "fr:205": "ACCEPTED", // Accepted
      "fr:206": "PARTIALLY_ACCEPTED", // Partly accepted
      "fr:207": "DISPUTED", // Disputed
      "fr:208": "ON_HOLD", // On hold
      "fr:209": "ACCEPTED", // Completed
      "fr:210": "REFUSED", // Refused
      "fr:211": "PAYMENT_SENT", // Payment sent
      "fr:212": "PAID", // Payment received
      "fr:213": "REJECTED", // Rejected
      "fr:501": "ERROR", // Inadmissible
    };
    // ppf:* et codes inconnus → null (n'écrasent pas le statut d'affichage)
    return map[code] || null;
  }

  /**
   * Normaliser le tableau d'événements brut renvoyé par SuperPDP en un format
   * compact stockable : [{ code, label, occurredAt }].
   * @param {Array} rawEvents - events[] de la réponse SuperPDP
   * @returns {Array<{code:string,label:string,occurredAt:Date}>}
   */
  extractEvents(rawEvents) {
    if (!Array.isArray(rawEvents)) return [];
    return rawEvents
      .map((ev) => ({
        code: ev.status_code || ev.code || null,
        label: ev.status_text || ev.label || "",
        occurredAt: ev.created_at ? new Date(ev.created_at) : new Date(),
      }))
      .filter((ev) => ev.code);
  }

  /**
   * Dériver le statut d'affichage + le dernier code à partir d'un tableau d'événements.
   * On parcourt les événements du plus récent au plus ancien et on retient le premier
   * code qui correspond à un statut d'affichage connu (les ppf:* sont ignorés pour
   * l'affichage mais restent dans l'historique).
   * @param {Array<{code:string,occurredAt:Date}>} events
   * @returns {{ status: string, lastCode: string|null }}
   */
  deriveStatusFromEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
      return { status: "PENDING_VALIDATION", lastCode: null };
    }

    // Trier par date croissante puis prendre le dernier code "affichable"
    const sorted = [...events].sort(
      (a, b) =>
        new Date(a.occurredAt || 0).getTime() -
        new Date(b.occurredAt || 0).getTime(),
    );

    const lastCode = sorted[sorted.length - 1].code || null;

    let status = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const mapped = this.mapSuperPdpCodeToStatus(sorted[i].code);
      if (mapped) {
        status = mapped;
        break;
      }
    }

    return { status: status || "PENDING_VALIDATION", lastCode };
  }

  /**
   * @deprecated Conservé pour compatibilité (webhook SuperPDP Phase 2, non monté).
   * Utiliser mapSuperPdpCodeToStatus + deriveStatusFromEvents.
   */
  mapStatusToNewbi(code) {
    return this.mapSuperPdpCodeToStatus(code) || "PENDING_VALIDATION";
  }
}

// Exporter une instance singleton
export default new SuperPdpService();
