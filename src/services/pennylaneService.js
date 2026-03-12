import logger from "../utils/logger.js";
import PennylaneAccount from "../models/PennylaneAccount.js";

const PENNYLANE_API_BASE = "https://app.pennylane.com/api/external/v2";
const RATE_LIMIT_DELAY = 5000; // 5s on 429

/**
 * Mapping des taux de TVA Newbi → Pennylane
 */
const VAT_RATE_MAP = {
  20: "FR_200",
  10: "FR_100",
  5.5: "FR_055",
  2.1: "FR_021",
  0: "exempt",
};

function mapVatRate(rate) {
  if (rate == null || rate === 0) return "exempt";
  const key = parseFloat(rate);
  return VAT_RATE_MAP[key] || `FR_${String(Math.round(key * 10)).padStart(3, "0")}`;
}

/**
 * Appel HTTP vers l'API Pennylane avec gestion du rate limit
 */
async function pennylaneRequest(apiToken, method, endpoint, body = null, retries = 2) {
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

  // Rate limit — retry avec backoff
  if (response.status === 429 && retries > 0) {
    const retryAfter = parseInt(response.headers.get("retry-after") || "5", 10);
    logger.warn(`Pennylane rate limit hit, retrying in ${retryAfter}s...`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
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

const pennylaneService = {
  /**
   * Teste la connexion avec un token API
   */
  async testConnection(apiToken) {
    try {
      const data = await pennylaneRequest(apiToken, "GET", "/me");
      return {
        success: true,
        companyName: data?.company?.name || null,
        companyId: data?.company?.id ? String(data.company.id) : null,
        message: "Connexion à Pennylane réussie",
      };
    } catch (error) {
      logger.error("Pennylane testConnection failed:", error.message);
      return {
        success: false,
        message: `Échec de la connexion à Pennylane: ${error.message}`,
      };
    }
  },

  /**
   * Sync un client Newbi → Pennylane Customer
   */
  async syncCustomer(apiToken, client) {
    try {
      const payload = {
        customer: {
          name: client.name,
          ...(client.email && { emails: [client.email] }),
          ...(client.phone && { phone: client.phone }),
          ...(client.vatNumber && { vat_number: client.vatNumber }),
          ...(client.siret && { reg_no: client.siret }),
          ...(client.address && {
            address: client.address.street || "",
            city: client.address.city || "",
            postal_code: client.address.postalCode || "",
            country_alpha2: client.address.country?.toUpperCase()?.slice(0, 2) || "FR",
          }),
        },
      };

      const data = await pennylaneRequest(apiToken, "POST", "/customers", payload);
      return {
        success: true,
        pennylaneId: String(data?.customer?.source_id || data?.customer?.id || ""),
        message: "Client synchronisé avec Pennylane",
      };
    } catch (error) {
      logger.error("Pennylane syncCustomer failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync une facture client Newbi → Pennylane Customer Invoice
   */
  async syncCustomerInvoice(apiToken, invoice) {
    try {
      // Construire les lignes de facture
      const invoiceLines = (invoice.items || []).map((item) => ({
        label: item.description || item.name || "Article",
        quantity: item.quantity || 1,
        ...(item.unit && { unit: item.unit }),
        raw_currency_unit_price: String(item.unitPrice || item.price || 0),
        vat_rate: mapVatRate(item.vatRate || item.tva),
        ...(item.accountingAccount && { plan_item_number: item.accountingAccount }),
      }));

      if (invoiceLines.length === 0) {
        return { success: false, message: "La facture n'a aucun article à synchroniser" };
      }

      const payload = {
        create_customer: true,
        create_products: true,
        invoice: {
          date: formatDate(invoice.issueDate),
          deadline: formatDate(invoice.dueDate),
          draft: false,
          currency: invoice.currency || "EUR",
          invoice_lines: invoiceLines,
          ...(invoice.pennylaneCustomerId && {
            customer_id: invoice.pennylaneCustomerId,
          }),
          ...(!invoice.pennylaneCustomerId && invoice.client && {
            customer: {
              name: invoice.client.name || "Client inconnu",
              ...(invoice.client.email && { emails: [invoice.client.email] }),
              ...(invoice.client.vatNumber && { vat_number: invoice.client.vatNumber }),
              ...(invoice.client.siret && { reg_no: invoice.client.siret }),
            },
          }),
          ...(invoice.number && {
            external_reference: `${invoice.prefix || ""}${invoice.number}`,
          }),
        },
      };

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/customer_invoices",
        payload
      );

      return {
        success: true,
        pennylaneId: String(data?.invoice?.id || data?.invoice?.source_id || ""),
        message: "Facture synchronisée avec Pennylane",
      };
    } catch (error) {
      logger.error("Pennylane syncCustomerInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync une dépense Newbi → Pennylane Supplier Invoice (via PDF upload)
   */
  async syncSupplierInvoice(apiToken, expense) {
    try {
      // Si la dépense a un fichier PDF, on l'upload d'abord
      let fileAttachmentId = null;
      if (expense.files && expense.files.length > 0) {
        const pdfFile = expense.files.find(
          (f) => f.mimetype === "application/pdf"
        ) || expense.files[0];

        if (pdfFile?.url) {
          fileAttachmentId = await this.uploadFileAttachment(apiToken, pdfFile.url);
        }
      }

      const payload = {
        create_supplier: true,
        supplier_invoice: {
          date: formatDate(expense.date),
          ...(expense.paymentDate && {
            deadline: formatDate(expense.paymentDate),
          }),
          currency: expense.currency || "EUR",
          currency_amount: String(expense.amount || 0),
          currency_tax: String(expense.vatAmount || 0),
          currency_amount_before_tax: String(
            (expense.amount || 0) - (expense.vatAmount || 0)
          ),
          ...(fileAttachmentId && { file_attachment_id: fileAttachmentId }),
          ...(expense.vendor && {
            supplier: {
              name: expense.vendor,
              ...(expense.vendorVatNumber && {
                vat_number: expense.vendorVatNumber,
              }),
            },
          }),
          invoice_lines: [
            {
              currency_amount: String(expense.amount || 0),
              currency_tax: String(expense.vatAmount || 0),
              vat_rate: mapVatRate(expense.vatRate),
              label: expense.title || expense.description || "Dépense",
              ...(expense.accountingAccount && {
                plan_item_number: expense.accountingAccount,
              }),
            },
          ],
        },
      };

      const endpoint = fileAttachmentId
        ? "/supplier_invoices/import"
        : "/supplier_invoices";

      const data = await pennylaneRequest(apiToken, "POST", endpoint, payload);

      return {
        success: true,
        pennylaneId: String(data?.invoice?.id || data?.invoice?.source_id || ""),
        message: "Dépense synchronisée avec Pennylane",
      };
    } catch (error) {
      logger.error("Pennylane syncSupplierInvoice failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Upload un fichier (PDF) vers Pennylane et retourne le file_attachment_id
   */
  async uploadFileAttachment(apiToken, fileUrl) {
    try {
      // Télécharger le fichier depuis l'URL (R2/S3)
      const fileResponse = await fetch(fileUrl);
      if (!fileResponse.ok) {
        throw new Error(`Impossible de télécharger le fichier: ${fileResponse.status}`);
      }

      const blob = await fileResponse.blob();
      const formData = new FormData();
      formData.append("file", blob, "document.pdf");

      const data = await pennylaneRequest(
        apiToken,
        "POST",
        "/file_attachments",
        formData
      );

      return data?.file_attachment?.id || null;
    } catch (error) {
      logger.warn("Pennylane uploadFileAttachment failed:", error.message);
      return null;
    }
  },

  /**
   * Sync un produit Newbi → Pennylane Product
   */
  async syncProduct(apiToken, product) {
    try {
      const payload = {
        product: {
          label: product.name || product.description || "Produit",
          ...(product.description && { description: product.description }),
          unit: product.unit || "piece",
          price: String(product.price || product.unitPrice || 0),
          vat_rate: mapVatRate(product.vatRate || product.tva),
          currency: product.currency || "EUR",
        },
      };

      const data = await pennylaneRequest(apiToken, "POST", "/products", payload);
      return {
        success: true,
        pennylaneId: String(data?.product?.source_id || data?.product?.id || ""),
        message: "Produit synchronisé avec Pennylane",
      };
    } catch (error) {
      logger.error("Pennylane syncProduct failed:", error.message);
      return { success: false, message: error.message };
    }
  },

  /**
   * Sync complète : factures + dépenses + clients
   */
  async syncAll(organizationId, { Invoice, Expense, Client, Product }) {
    const account = await PennylaneAccount.findOne({ organizationId });
    if (!account || !account.isConnected) {
      return { success: false, message: "Compte Pennylane non connecté" };
    }

    const apiToken = account.apiToken;
    const results = {
      invoices: { synced: 0, errors: 0 },
      expenses: { synced: 0, errors: 0 },
      clients: { synced: 0, errors: 0 },
      products: { synced: 0, errors: 0 },
    };

    // Mettre à jour le statut
    account.syncStatus = "IN_PROGRESS";
    await account.save();

    try {
      // 1. Sync des factures non encore synchronisées
      if (account.autoSync.invoices) {
        const invoices = await Invoice.find({
          workspaceId: organizationId,
          status: { $in: ["SENT", "PAID", "OVERDUE"] },
          pennylaneSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

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
          }
        }
      }

      // 2. Sync des dépenses approuvées
      if (account.autoSync.expenses) {
        const expenses = await Expense.find({
          workspaceId: organizationId,
          status: { $in: ["APPROVED", "PAID"] },
          pennylaneSyncStatus: { $ne: "SYNCED" },
        }).limit(50);

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

      return {
        success: true,
        results,
        message: `Synchronisation terminée: ${results.invoices.synced} factures, ${results.expenses.synced} dépenses`,
      };
    } catch (error) {
      account.syncStatus = "ERROR";
      account.syncError = error.message;
      await account.save();

      logger.error("Pennylane syncAll failed:", error.message);
      return { success: false, message: error.message, results };
    }
  },
};

/**
 * Formate une date en YYYY-MM-DD pour l'API Pennylane
 */
function formatDate(date) {
  if (!date) return new Date().toISOString().split("T")[0];
  const d = new Date(date);
  return d.toISOString().split("T")[0];
}

export default pennylaneService;
