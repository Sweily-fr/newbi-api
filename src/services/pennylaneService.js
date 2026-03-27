import logger from "../utils/logger.js";
import PennylaneAccount from "../models/PennylaneAccount.js";

const PENNYLANE_API_BASE = "https://app.pennylane.com/api/external/v2";

/**
 * Mapping des taux de TVA Newbi → Pennylane
 * Ref: skill reference/enums.md
 */
const VAT_RATE_MAP = {
  20: "FR_200",
  10: "FR_100",
  5.5: "FR_55",
  2.1: "FR_21",
  0: "exempt",
};

function mapVatRate(rate) {
  if (rate == null || rate === 0) return "exempt";
  const key = parseFloat(rate);
  return VAT_RATE_MAP[key] || "FR_200";
}

/**
 * Mapping des unités Newbi → Pennylane
 * Pennylane accepte: piece, hour, day, meter, square_meter, cubic_meter, kilogram, liter, package
 */
const UNIT_MAP = {
  "": "piece",
  unité: "piece",
  unite: "piece",
  pièce: "piece",
  piece: "piece",
  heure: "hour",
  h: "hour",
  hour: "hour",
  jour: "day",
  j: "day",
  day: "day",
  mètre: "meter",
  metre: "meter",
  m: "meter",
  "m²": "square_meter",
  m2: "square_meter",
  "m³": "cubic_meter",
  m3: "cubic_meter",
  kg: "kilogram",
  kilogramme: "kilogram",
  litre: "liter",
  l: "liter",
  lot: "package",
  forfait: "package",
  package: "package",
};

function mapUnit(unit) {
  if (!unit) return "piece";
  const normalized = unit.toLowerCase().trim();
  return UNIT_MAP[normalized] || "piece";
}

/**
 * Appel HTTP vers l'API Pennylane avec gestion du rate limit et retry sur 500
 */
async function pennylaneRequest(
  apiToken,
  method,
  endpoint,
  body = null,
  retries = 3,
) {
  const url = `${PENNYLANE_API_BASE}${endpoint}`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    Accept: "application/json",
  };

  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }

  const options = { method, headers };
  if (body) {
    options.body = body instanceof FormData ? body : JSON.stringify(body);
  }

  const response = await fetch(url, options);

  // Rate limit (429) — retry avec backoff
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get("retry-after") || "5", 10);
    logger.warn(`[PENNYLANE] Rate limit 429, retry in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return pennylaneRequest(apiToken, method, endpoint, body, retries - 1);
  }

  // Server error (500) — retry automatique (API Pennylane peut avoir des erreurs transitoires)
  if (response.status === 500 && retries > 0) {
    logger.warn(
      `[PENNYLANE] Server error 500, retry in 1s... (${retries} left)`,
    );
    await new Promise((r) => setTimeout(r, 1000));
    return pennylaneRequest(apiToken, method, endpoint, body, retries - 1);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Pennylane API ${response.status}: ${errorBody}`);
  }

  // 204 No Content
  if (response.status === 204) return null;

  return response.json();
}

/**
 * Formate une date en YYYY-MM-DD pour l'API Pennylane
 */
function formatDate(date) {
  if (!date) return new Date().toISOString().split("T")[0];
  const d = new Date(date);
  return d.toISOString().split("T")[0];
}

/**
 * Calcule le HT d'une ligne de facture (même logique que calculateInvoiceTotals dans le resolver)
 * Tient compte de: quantity, unitPrice, progressPercentage, item discount
 */
function computeItemHT(item) {
  const quantity = item.quantity || 0;
  const unitPrice = item.unitPrice || 0;
  let itemHT = quantity * unitPrice;

  // Avancement (factures de situation)
  const progress =
    item.progressPercentage != null ? item.progressPercentage : 100;
  itemHT = itemHT * (progress / 100);

  // Remise par ligne
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

const pennylaneService = {
  /**
   * Teste la connexion avec un token API
   * Endpoint: GET /me
   */
  async testConnection(apiToken) {
    try {
      const data = await pennylaneRequest(apiToken, "GET", "/me");

      // Pennylane peut retourner 200 même si auth échoue — vérifier le body
      if (data?.status === 401 || data?.error) {
        return {
          success: false,
          message: `Échec de l'authentification: ${data.error || "Token invalide"}`,
        };
      }

      return {
        success: true,
        companyName: data?.company?.name || data?.current_company?.name || null,
        companyId: data?.company?.id
          ? String(data.company.id)
          : data?.current_company?.id
            ? String(data.current_company.id)
            : null,
        message: "Connexion à Pennylane réussie",
      };
    } catch (error) {
      logger.error("[PENNYLANE] testConnection failed:", error.message);
      return {
        success: false,
        message: `Échec de la connexion à Pennylane: ${error.message}`,
      };
    }
  },

  /**
   * Sync un client Newbi → Pennylane Customer
   * Endpoint: POST /company_customers ou POST /individual_customers
   */
  async syncCustomer(apiToken, client) {
    try {
      const isIndividual = client.type === "INDIVIDUAL";
      const endpoint = isIndividual
        ? "/individual_customers"
        : "/company_customers";

      let payload;
      if (isIndividual) {
        payload = {
          first_name: client.firstName || "",
          last_name: client.lastName || client.name || "",
          ...(client.email && { emails: [client.email] }),
          ...(client.phone && { phone: client.phone }),
        };
      } else {
        payload = {
          name: client.name || "Client inconnu",
          ...(client.email && { emails: [client.email] }),
          ...(client.phone && { phone: client.phone }),
          ...(client.vatNumber && { vat_number: client.vatNumber }),
          ...(client.siret && { external_reference: client.siret }),
        };
      }

      // Adresse de facturation (obligatoire pour Pennylane)
      const addr = client.address;
      payload.billing_address = {
        address: addr?.street || "Non renseignée",
        postal_code: addr?.postalCode || "00000",
        city: addr?.city || "Non renseignée",
        country_alpha2: mapCountryToAlpha2(addr?.country) || "FR",
      };

      const data = await pennylaneRequest(apiToken, "POST", endpoint, payload);
      return {
        success: true,
        pennylaneId: String(data?.id || ""),
        message: "Client synchronisé avec Pennylane",
      };
    } catch (error) {
      logger.error("[PENNYLANE] syncCustomer failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync une facture client Newbi → Pennylane Customer Invoice
   * Endpoint: POST /customer_invoices
   *
   * Utilise les totaux pré-calculés (finalTotalHT, finalTotalVAT, finalTotalTTC)
   * qui tiennent déjà compte des remises ligne, remise globale, shipping, etc.
   *
   * Stratégie: on envoie chaque ligne avec son HT réel (après remise ligne + avancement),
   * puis si remise globale, on ajoute une ligne négative de remise.
   * Pennylane calcule les totaux lui-même à partir des lignes.
   */
  async syncCustomerInvoice(apiToken, invoice) {
    try {
      const items = invoice.items || [];
      if (items.length === 0) {
        return {
          success: false,
          message: "La facture n'a aucun article à synchroniser",
        };
      }

      const isReverseCharge = invoice.isReverseCharge || false;

      // Construire les lignes — chaque ligne = HT réel après remise ligne + avancement
      const invoiceLines = items.map((item) => {
        const itemHT = computeItemHT(item);
        // On envoie quantity=1 avec le HT total comme prix unitaire
        // Ceci assure que le montant Pennylane = le montant sur notre PDF
        return {
          label: item.description || "Article",
          quantity: 1,
          unit: mapUnit(item.unit),
          raw_currency_unit_price: String(itemHT.toFixed(2)),
          vat_rate: isReverseCharge ? "exempt" : mapVatRate(item.vatRate),
        };
      });

      // Frais de livraison
      if (
        invoice.shipping?.billShipping &&
        invoice.shipping.shippingAmountHT > 0
      ) {
        invoiceLines.push({
          label: "Frais de livraison",
          quantity: 1,
          unit: "piece",
          raw_currency_unit_price: String(
            (invoice.shipping.shippingAmountHT || 0).toFixed(2),
          ),
          vat_rate: isReverseCharge
            ? "exempt"
            : mapVatRate(invoice.shipping.shippingVatRate || 20),
        });
      }

      // Remise globale → ligne négative
      if (invoice.discount && invoice.discount > 0) {
        // Calculer le sous-total HT (items + shipping) avant remise globale
        const subtotalHT = invoice.totalHT || 0;
        let discountAmount;
        if (invoice.discountType === "PERCENTAGE") {
          discountAmount = (subtotalHT * Math.min(invoice.discount, 100)) / 100;
        } else {
          discountAmount = invoice.discount;
        }

        if (discountAmount > 0) {
          // Déterminer le taux TVA principal (le plus courant dans les items)
          const mainVatRate = items.length > 0 ? items[0].vatRate || 20 : 20;
          invoiceLines.push({
            label:
              invoice.discountType === "PERCENTAGE"
                ? `Remise globale (-${invoice.discount}%)`
                : "Remise globale",
            quantity: 1,
            unit: "piece",
            raw_currency_unit_price: String((-discountAmount).toFixed(2)),
            vat_rate: isReverseCharge ? "exempt" : mapVatRate(mainVatRate),
          });
        }
      }

      const ref = `${invoice.prefix || ""}${invoice.number || ""}`.trim();

      // Trouver ou créer le customer Pennylane
      let customerId = null;
      if (invoice.client) {
        customerId = await this._findOrCreateCustomer(apiToken, invoice.client);
      }

      if (!customerId) {
        return {
          success: false,
          message: "Impossible de trouver ou créer le client dans Pennylane",
        };
      }

      // Stratégie : si un PDF Newbi est disponible, utiliser /import pour l'attacher
      // Sinon, créer classiquement en draft
      const hasPdf = invoice.cachedPdf?.url;
      let fileAttachmentId = null;

      if (hasPdf) {
        fileAttachmentId = await this.uploadFileAttachment(
          apiToken,
          invoice.cachedPdf.url,
          `facture-${ref || invoice._id}.pdf`,
        );
      }

      let data;

      if (fileAttachmentId) {
        // Import avec PDF attaché — la facture sera directement non-draft avec le PDF Newbi
        const importLines = invoiceLines.map((line) => {
          const ht =
            parseFloat(line.raw_currency_unit_price) * (line.quantity || 1);
          const vatRate =
            line.vat_rate === "exempt"
              ? 0
              : parseFloat(line.vat_rate?.replace(/[A-Z_]/g, "") || "0") / 10;
          const tax = ht * (vatRate / 100);
          return {
            ...line,
            currency_amount: String((ht + tax).toFixed(2)),
            currency_tax: String(tax.toFixed(2)),
          };
        });

        const importPayload = {
          file_attachment_id: fileAttachmentId,
          customer_id: customerId,
          date: formatDate(invoice.issueDate),
          deadline: formatDate(invoice.dueDate),
          currency: invoice.currency || "EUR",
          currency_amount_before_tax: String(
            (invoice.finalTotalHT || 0).toFixed(2),
          ),
          currency_amount: String((invoice.finalTotalTTC || 0).toFixed(2)),
          currency_tax: String((invoice.finalTotalVAT || 0).toFixed(2)),
          invoice_lines: importLines,
        };

        if (ref) importPayload.external_reference = ref;

        data = await pennylaneRequest(
          apiToken,
          "POST",
          "/customer_invoices/import",
          importPayload,
        );
        logger.info(
          `[PENNYLANE] Facture ${ref} importée avec PDF sur Pennylane`,
        );
      } else {
        // Création classique sans PDF
        const payload = {
          customer_id: customerId,
          date: formatDate(invoice.issueDate),
          deadline: formatDate(invoice.dueDate),
          draft: true,
          currency: invoice.currency || "EUR",
          invoice_lines: invoiceLines,
        };

        if (ref) {
          payload.external_reference = ref;
          payload.pdf_invoice_subject = `Facture ${ref}`;
        }

        if (isReverseCharge) {
          payload.special_mention =
            "Autoliquidation - TVA due par le preneur (art. 283-2 du CGI)";
        }

        data = await pennylaneRequest(
          apiToken,
          "POST",
          "/customer_invoices",
          payload,
        );

        // Tenter de finaliser
        if (data?.id && invoice.status !== "DRAFT") {
          try {
            await pennylaneRequest(
              apiToken,
              "POST",
              `/customer_invoices/${data.id}/finalize`,
            );
            if (invoice.status === "COMPLETED") {
              try {
                await pennylaneRequest(
                  apiToken,
                  "POST",
                  `/customer_invoices/${data.id}/mark_as_paid`,
                );
              } catch (_) {
                /* ignore */
              }
            }
          } catch (_) {
            /* numérotation non configurée */
          }
        }
      }

      return {
        success: true,
        pennylaneId: String(data?.id || ""),
        message: "Facture synchronisée avec Pennylane",
      };
    } catch (error) {
      // Si le document existe déjà sur Pennylane, on considère comme succès
      if (error.message.includes("already been taken")) {
        logger.info("[PENNYLANE] Facture déjà existante sur Pennylane");
        return {
          success: true,
          pennylaneId: "existing",
          message: "Facture déjà existante sur Pennylane",
        };
      }
      logger.error("[PENNYLANE] syncCustomerInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Cherche un customer Pennylane par nom, ou le crée s'il n'existe pas
   */
  async _findOrCreateCustomer(apiToken, client) {
    try {
      const searchName =
        client.name ||
        `${client.firstName || ""} ${client.lastName || ""}`.trim();
      if (!searchName) return null;

      // Chercher par nom
      const filter = encodeURIComponent(
        JSON.stringify([{ field: "name", operator: "eq", value: searchName }]),
      );
      const searchResult = await pennylaneRequest(
        apiToken,
        "GET",
        `/customers?filter=${filter}&limit=1`,
      );

      if (searchResult?.items?.length > 0) {
        return searchResult.items[0].id;
      }

      // Pas trouvé → créer
      const result = await this.syncCustomer(apiToken, client);
      if (result.success && result.pennylaneId) {
        return parseInt(result.pennylaneId, 10) || null;
      }

      return null;
    } catch (error) {
      logger.warn("[PENNYLANE] _findOrCreateCustomer failed:", error.message);
      return null;
    }
  },

  /**
   * Sync un devis accepté Newbi → Pennylane Quote
   * Endpoint: POST /quotes
   */
  async syncQuote(apiToken, quote) {
    try {
      const items = quote.items || [];
      if (items.length === 0) {
        return {
          success: false,
          message: "Le devis n'a aucun article à synchroniser",
        };
      }

      const isReverseCharge = quote.isReverseCharge || false;

      // Construire les lignes
      const quoteLines = items.map((item) => {
        const itemHT = computeItemHT(item);
        return {
          label: item.description || "Article",
          quantity: 1,
          unit: mapUnit(item.unit),
          raw_currency_unit_price: String(itemHT.toFixed(2)),
          vat_rate: isReverseCharge ? "exempt" : mapVatRate(item.vatRate),
        };
      });

      // Frais de livraison
      if (quote.shipping?.billShipping && quote.shipping.shippingAmountHT > 0) {
        quoteLines.push({
          label: "Frais de livraison",
          quantity: 1,
          unit: "piece",
          raw_currency_unit_price: String(
            (quote.shipping.shippingAmountHT || 0).toFixed(2),
          ),
          vat_rate: isReverseCharge
            ? "exempt"
            : mapVatRate(quote.shipping.shippingVatRate || 20),
        });
      }

      // Remise globale → ligne négative
      if (quote.discount && quote.discount > 0) {
        const subtotalHT = quote.totalHT || 0;
        let discountAmount;
        if (quote.discountType === "PERCENTAGE") {
          discountAmount = (subtotalHT * Math.min(quote.discount, 100)) / 100;
        } else {
          discountAmount = quote.discount;
        }
        if (discountAmount > 0) {
          const mainVatRate = items.length > 0 ? items[0].vatRate || 20 : 20;
          quoteLines.push({
            label:
              quote.discountType === "PERCENTAGE"
                ? `Remise globale (-${quote.discount}%)`
                : "Remise globale",
            quantity: 1,
            unit: "piece",
            raw_currency_unit_price: String((-discountAmount).toFixed(2)),
            vat_rate: isReverseCharge ? "exempt" : mapVatRate(mainVatRate),
          });
        }
      }

      // Trouver ou créer le customer
      let customerId = null;
      if (quote.client) {
        customerId = await this._findOrCreateCustomer(apiToken, quote.client);
      }
      if (!customerId) {
        return {
          success: false,
          message: "Impossible de trouver ou créer le client dans Pennylane",
        };
      }

      const ref = `${quote.prefix || ""}${quote.number || ""}`.trim();

      const payload = {
        customer_id: customerId,
        date: formatDate(quote.issueDate),
        deadline: formatDate(quote.validUntil || quote.dueDate),
        currency: quote.currency || "EUR",
        invoice_lines: quoteLines,
      };

      if (ref) {
        payload.external_reference = ref;
        payload.pdf_invoice_subject = `Devis ${ref}`;
      }

      const data = await pennylaneRequest(apiToken, "POST", "/quotes", payload);

      return {
        success: true,
        pennylaneId: String(data?.id || ""),
        message: "Devis synchronisé avec Pennylane",
      };
    } catch (error) {
      if (error.message.includes("already been taken")) {
        logger.info("[PENNYLANE] Devis déjà existant sur Pennylane");
        return {
          success: true,
          pennylaneId: "existing",
          message: "Devis déjà existant sur Pennylane",
        };
      }
      logger.error("[PENNYLANE] syncQuote failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync une dépense Newbi → Pennylane Supplier Invoice
   * Endpoint: POST /supplier_invoices/import (toujours via import)
   */
  async syncSupplierInvoice(apiToken, expense) {
    try {
      // Upload du PDF si disponible
      let fileAttachmentId = null;
      if (expense.files && expense.files.length > 0) {
        const pdfFile =
          expense.files.find((f) => f.mimetype === "application/pdf") ||
          expense.files[0];

        if (pdfFile?.url) {
          const filename = `facture-achat-${expense.invoiceNumber || expense.title || expense._id}.pdf`;
          fileAttachmentId = await this.uploadFileAttachment(
            apiToken,
            pdfFile.url,
            filename,
          );
        }
      }

      // Trouver ou créer le supplier
      let supplierId = null;
      if (expense.vendor) {
        supplierId = await this._findOrCreateSupplier(apiToken, expense);
      }

      const amountTTC = expense.amount || 0;
      const amountVAT = expense.vatAmount || 0;
      const amountHT = amountTTC - amountVAT;

      const ref = expense.invoiceNumber || expense.documentNumber || null;

      const payload = {
        date: formatDate(expense.date),
        ...(expense.paymentDate && {
          deadline: formatDate(expense.paymentDate),
        }),
        currency: expense.currency || "EUR",
        currency_amount_before_tax: String(amountHT.toFixed(2)),
        currency_amount: String(amountTTC.toFixed(2)),
        currency_tax: String(amountVAT.toFixed(2)),
        ...(supplierId && { supplier_id: supplierId }),
        ...(fileAttachmentId && { file_attachment_id: fileAttachmentId }),
        ...(ref && { external_reference: ref }),
        invoice_lines: [
          {
            label: expense.title || expense.description || "Dépense",
            currency_amount: String(amountTTC.toFixed(2)),
            currency_tax: String(amountVAT.toFixed(2)),
            vat_rate: mapVatRate(expense.vatRate),
          },
        ],
      };

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/supplier_invoices/import",
        payload,
      );

      return {
        success: true,
        pennylaneId: String(data?.id || ""),
        message: "Dépense synchronisée avec Pennylane",
      };
    } catch (error) {
      if (error.message.includes("already been taken")) {
        logger.info(
          "[PENNYLANE] Facture fournisseur déjà existante sur Pennylane",
        );
        return {
          success: true,
          pennylaneId: "existing",
          message: "Facture fournisseur déjà existante sur Pennylane",
        };
      }
      logger.error("[PENNYLANE] syncSupplierInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Cherche un supplier Pennylane par nom, ou le crée s'il n'existe pas
   */
  async _findOrCreateSupplier(apiToken, expense) {
    try {
      const name = expense.vendor;
      if (!name) return null;

      const filter = encodeURIComponent(
        JSON.stringify([{ field: "name", operator: "eq", value: name }]),
      );
      const searchResult = await pennylaneRequest(
        apiToken,
        "GET",
        `/suppliers?filter=${filter}&limit=1`,
      );

      if (searchResult?.items?.length > 0) {
        return searchResult.items[0].id;
      }

      // Créer le supplier
      const payload = {
        name,
        ...(expense.vendorVatNumber && { vat_number: expense.vendorVatNumber }),
        address: {
          address: "Non renseignée",
          postal_code: "00000",
          city: "Non renseignée",
          country_alpha2: "FR",
        },
      };

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/suppliers",
        payload,
      );
      return data?.id || null;
    } catch (error) {
      logger.warn("[PENNYLANE] _findOrCreateSupplier failed:", error.message);
      return null;
    }
  },

  /**
   * Upload un fichier (PDF) vers Pennylane
   * Endpoint: POST /file_attachments (multipart/form-data)
   */
  async uploadFileAttachment(apiToken, fileUrl, filename = "document.pdf") {
    try {
      // Télécharger le fichier depuis l'URL (R2/S3)
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        throw new Error(
          `Impossible de télécharger le fichier: ${fileResponse.status}`,
        );
      }

      const blob = await fileResponse.blob();
      const formData = new FormData();
      formData.append("file", blob, filename);

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/file_attachments",
        formData,
      );

      return data?.id || null;
    } catch (error) {
      logger.warn("[PENNYLANE] uploadFileAttachment failed:", error.message);
      return null;
    }
  },

  /**
   * Sync une facture d'achat (PurchaseInvoice) Newbi → Pennylane Supplier Invoice
   * Endpoint: POST /supplier_invoices/import
   */
  async syncPurchaseInvoice(apiToken, purchaseInvoice) {
    try {
      // Upload du PDF si disponible
      let fileAttachmentId = null;
      if (purchaseInvoice.files && purchaseInvoice.files.length > 0) {
        const pdfFile =
          purchaseInvoice.files.find((f) => f.mimetype === "application/pdf") ||
          purchaseInvoice.files[0];

        if (pdfFile?.url) {
          const filename = `facture-achat-${purchaseInvoice.invoiceNumber || purchaseInvoice._id}.pdf`;
          fileAttachmentId = await this.uploadFileAttachment(
            apiToken,
            pdfFile.url,
            filename,
          );
        }
      }

      // Trouver ou créer le supplier
      let supplierId = null;
      if (purchaseInvoice.supplierName) {
        try {
          const filter = encodeURIComponent(
            JSON.stringify([
              {
                field: "name",
                operator: "eq",
                value: purchaseInvoice.supplierName,
              },
            ]),
          );
          const searchResult = await pennylaneRequest(
            apiToken,
            "GET",
            `/suppliers?filter=${filter}&limit=1`,
          );

          if (searchResult?.items?.length > 0) {
            supplierId = searchResult.items[0].id;
          } else {
            const supplierPayload = {
              name: purchaseInvoice.supplierName,
              ...(purchaseInvoice.ocrMetadata?.supplierVatNumber && {
                vat_number: purchaseInvoice.ocrMetadata.supplierVatNumber,
              }),
              address: {
                address:
                  purchaseInvoice.ocrMetadata?.supplierAddress ||
                  "Non renseignée",
                postal_code: "00000",
                city: "Non renseignée",
                country_alpha2: "FR",
              },
            };
            const supplierData = await pennylaneRequest(
              apiToken,
              "POST",
              "/suppliers",
              supplierPayload,
            );
            supplierId = supplierData?.id || null;
          }
        } catch (err) {
          logger.warn(
            "[PENNYLANE] _findOrCreateSupplier (PI) failed:",
            err.message,
          );
        }
      }

      if (!supplierId) {
        return {
          success: false,
          message: "Impossible de créer le fournisseur sur Pennylane",
        };
      }

      const amountHT = purchaseInvoice.amountHT || 0;
      const amountTVA = purchaseInvoice.amountTVA || 0;
      const amountTTC = purchaseInvoice.amountTTC || 0;
      const ref = purchaseInvoice.invoiceNumber || null;

      const payload = {
        date: formatDate(purchaseInvoice.issueDate),
        ...(purchaseInvoice.dueDate && {
          deadline: formatDate(purchaseInvoice.dueDate),
        }),
        currency: purchaseInvoice.currency || "EUR",
        currency_amount_before_tax: String(amountHT.toFixed(2)),
        currency_amount: String(amountTTC.toFixed(2)),
        currency_tax: String(amountTVA.toFixed(2)),
        supplier_id: supplierId,
        ...(fileAttachmentId && { file_attachment_id: fileAttachmentId }),
        ...(ref && { external_reference: ref }),
        invoice_lines: [
          {
            label: purchaseInvoice.supplierName || "Facture d'achat",
            currency_amount: String(amountTTC.toFixed(2)),
            currency_tax: String(amountTVA.toFixed(2)),
            vat_rate: mapVatRate(purchaseInvoice.vatRate),
          },
        ],
      };

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/supplier_invoices/import",
        payload,
      );

      return {
        success: true,
        pennylaneId: String(data?.id || ""),
        message: "Facture d'achat synchronisée avec Pennylane",
      };
    } catch (error) {
      if (error.message.includes("already been taken")) {
        logger.info("[PENNYLANE] Facture d'achat déjà existante sur Pennylane");
        return {
          success: true,
          pennylaneId: "existing",
          message: "Facture d'achat déjà existante sur Pennylane",
        };
      }
      logger.error("[PENNYLANE] syncPurchaseInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync un produit Newbi → Pennylane Product
   * Endpoint: POST /products
   */
  async syncProduct(apiToken, product) {
    try {
      const payload = {
        label: product.name || product.description || "Produit",
        ...(product.description && { description: product.description }),
        unit: mapUnit(product.unit),
        raw_currency_unit_price: String(
          (product.price || product.unitPrice || 0).toFixed(2),
        ),
        vat_rate: mapVatRate(product.vatRate || product.tva),
        currency: product.currency || "EUR",
      };

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/products",
        payload,
      );
      return {
        success: true,
        pennylaneId: String(data?.id || ""),
        message: "Produit synchronisé avec Pennylane",
      };
    } catch (error) {
      logger.error("[PENNYLANE] syncProduct failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync complète : factures + dépenses + devis
   */
  async syncAll(organizationId, { Invoice, Expense, Quote, PurchaseInvoice }) {
    const account = await PennylaneAccount.findOne({ organizationId });
    if (!account || !account.isConnected) {
      return { success: false, message: "Compte Pennylane non connecté" };
    }

    const apiToken = account.apiToken;
    const results = {
      invoices: { synced: 0, errors: 0 },
      expenses: { synced: 0, errors: 0 },
      quotes: { synced: 0, errors: 0 },
    };

    // Mettre à jour le statut
    account.syncStatus = "IN_PROGRESS";
    await account.save();

    try {
      // 1. Sync des factures clients
      if (account.autoSync.invoices) {
        const invoices = await Invoice.find({
          workspaceId: organizationId,
          status: { $in: ["PENDING", "COMPLETED", "OVERDUE"] },
          pennylaneSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[PENNYLANE] syncAll: ${invoices.length} factures à synchroniser`,
        );

        for (const invoice of invoices) {
          const result = await this.syncCustomerInvoice(apiToken, invoice);
          if (result.success) {
            invoice.pennylaneSyncStatus = "SYNCED";
            invoice.pennylaneId = result.pennylaneId;
            await invoice.save();
            results.invoices.synced++;
          } else {
            invoice.pennylaneSyncStatus = "ERROR";
            await invoice.save();
            results.invoices.errors++;
            logger.warn(
              `[PENNYLANE] syncAll facture ${invoice.prefix || ""}${invoice.number || invoice._id}: ${result.message}`,
            );
          }
        }
      }

      // 2. Sync des factures fournisseurs (dépenses)
      if (account.autoSync.supplierInvoices) {
        const expenses = await Expense.find({
          workspaceId: organizationId,
          status: { $in: ["APPROVED", "PAID"] },
          pennylaneSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[PENNYLANE] syncAll: ${expenses.length} dépenses à synchroniser`,
        );

        for (const expense of expenses) {
          const result = await this.syncSupplierInvoice(apiToken, expense);
          if (result.success) {
            expense.pennylaneSyncStatus = "SYNCED";
            expense.pennylaneId = result.pennylaneId;
            await expense.save();
            results.expenses.synced++;
          } else {
            expense.pennylaneSyncStatus = "ERROR";
            await expense.save();
            results.expenses.errors++;
            logger.warn(
              `[PENNYLANE] syncAll dépense ${expense.title || expense._id}: ${result.message}`,
            );
          }
        }
      }

      // 3. Sync des devis acceptés
      if (account.autoSync.quotes && Quote) {
        const quotes = await Quote.find({
          workspaceId: organizationId,
          status: "COMPLETED",
          pennylaneSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[PENNYLANE] syncAll: ${quotes.length} devis à synchroniser`,
        );

        for (const quote of quotes) {
          const result = await this.syncQuote(apiToken, quote);
          if (result.success) {
            quote.pennylaneSyncStatus = "SYNCED";
            quote.pennylaneId = result.pennylaneId;
            await quote.save();
            results.quotes.synced++;
          } else {
            quote.pennylaneSyncStatus = "ERROR";
            await quote.save();
            results.quotes.errors++;
            logger.warn(
              `[PENNYLANE] syncAll devis ${quote.prefix || ""}${quote.number || quote._id}: ${result.message}`,
            );
          }
        }
      }

      // 4. Sync des factures d'achat (PurchaseInvoice)
      if (account.autoSync.supplierInvoices && PurchaseInvoice) {
        const purchaseInvoices = await PurchaseInvoice.find({
          workspaceId: organizationId,
          status: { $in: ["TO_PAY", "PENDING", "PAID", "OVERDUE"] },
          pennylaneSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

        logger.info(
          `[PENNYLANE] syncAll: ${purchaseInvoices.length} factures d'achat à synchroniser`,
        );

        for (const pi of purchaseInvoices) {
          const result = await this.syncPurchaseInvoice(apiToken, pi);
          if (result.success) {
            pi.pennylaneSyncStatus = "SYNCED";
            pi.pennylaneId = result.pennylaneId;
            await pi.save();
            results.expenses.synced++;
          } else {
            pi.pennylaneSyncStatus = "ERROR";
            await pi.save();
            results.expenses.errors++;
            logger.warn(
              `[PENNYLANE] syncAll facture d'achat ${pi.invoiceNumber || pi._id}: ${result.message}`,
            );
          }
        }
      }

      // Mettre à jour les stats
      account.syncStatus = "SUCCESS";
      account.lastSyncAt = new Date();
      account.syncError = null;
      account.stats.invoicesSynced += results.invoices.synced;
      account.stats.expensesSynced += results.expenses.synced;
      await account.save();

      const total =
        results.invoices.synced +
        results.expenses.synced +
        results.quotes.synced;
      const totalErrors =
        results.invoices.errors +
        results.expenses.errors +
        results.quotes.errors;

      return {
        success: true,
        results,
        message: `Synchronisation terminée: ${total} éléments synchronisés${totalErrors > 0 ? `, ${totalErrors} erreurs` : ""}`,
      };
    } catch (error) {
      account.syncStatus = "ERROR";
      account.syncError = error.message;
      await account.save();

      logger.error("[PENNYLANE] syncAll failed:", error.message);
      return { success: false, message: error.message, results };
    }
  },
};

/**
 * Convertit un nom de pays en code ISO alpha-2
 * Gère les cas courants français
 */
function mapCountryToAlpha2(country) {
  if (!country) return "FR";
  const upper = country.toUpperCase().trim();
  // Déjà un code alpha-2
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

export default pennylaneService;
