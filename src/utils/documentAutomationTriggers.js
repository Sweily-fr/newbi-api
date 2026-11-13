/**
 * Automatisations des documents partagés : déclencheur qui correspond au
 * statut d'un document, contexte transmis au service, et lancement sans
 * attente depuis les chemins hors écran.
 *
 * Un même statut doit déclencher la même automatisation quel que soit le
 * chemin qui l'a posé (création déjà finalisée, brouillon validé dans
 * l'éditeur, rapprochement bancaire, justificatif, réception SuperPDP...).
 * Avant, seules certaines actions le faisaient : une facture créée
 * directement « envoyée » ou payée par rapprochement n'arrivait jamais dans
 * son dossier sans lancement manuel.
 */
import documentAutomationService from "../services/documentAutomationService.js";
import logger from "./logger.js";

const STATUS_TRIGGERS = {
  invoice: {
    DRAFT: "INVOICE_DRAFT",
    PENDING: "INVOICE_SENT",
    COMPLETED: "INVOICE_PAID",
    CANCELED: "INVOICE_CANCELED",
  },
  quote: {
    DRAFT: "QUOTE_DRAFT",
    PENDING: "QUOTE_SENT",
    COMPLETED: "QUOTE_ACCEPTED",
    CANCELED: "QUOTE_CANCELED",
  },
  purchaseOrder: {
    DRAFT: "PURCHASE_ORDER_DRAFT",
    CONFIRMED: "PURCHASE_ORDER_CONFIRMED",
    IN_PROGRESS: "PURCHASE_ORDER_IN_PROGRESS",
    DELIVERED: "PURCHASE_ORDER_DELIVERED",
    CANCELED: "PURCHASE_ORDER_CANCELED",
  },
  purchaseInvoice: {
    TO_PROCESS: "PURCHASE_INVOICE_TO_PROCESS",
    TO_PAY: "PURCHASE_INVOICE_TO_PAY",
    PENDING: "PURCHASE_INVOICE_PENDING",
    PAID: "PURCHASE_INVOICE_PAID",
    OVERDUE: "PURCHASE_INVOICE_OVERDUE",
    ARCHIVED: "PURCHASE_INVOICE_ARCHIVED",
  },
};

/**
 * @param {"invoice"|"quote"|"purchaseOrder"|"purchaseInvoice"} documentType
 * @param {string} status
 * @returns {string|null} déclencheur, ou null si ce statut n'en a pas
 */
export function statusTrigger(documentType, status) {
  return STATUS_TRIGGERS[documentType]?.[status] || null;
}

/** Contexte d'une facture, d'un devis ou d'un bon de commande */
export function salesDocumentContext(documentType, doc) {
  return {
    documentId: doc._id.toString(),
    documentType,
    documentNumber: doc.number,
    prefix: doc.prefix || "",
    clientName: doc.client?.name || "",
    issueDate: doc.issueDate || doc.createdAt,
    clientId: doc.client?._id || doc.clientId || null,
  };
}

/** Contexte d'une facture d'achat (le fichier est relu par le service) */
export function purchaseInvoiceContext(invoice) {
  return {
    documentId: invoice._id.toString(),
    documentType: "purchaseInvoice",
    documentNumber: invoice.invoiceNumber || "",
    supplierName: invoice.supplierName || "",
    clientName: invoice.supplierName || "",
    issueDate: invoice.issueDate || invoice.invoiceDate || invoice.createdAt,
    clientId: invoice.supplierId || null,
  };
}

/** Contexte d'une facture importée (le fichier est relu par le service) */
export function importedInvoiceContext(importedInvoice) {
  return {
    documentId: importedInvoice._id.toString(),
    documentType: "importedInvoice",
    documentNumber: importedInvoice.originalInvoiceNumber || "",
    clientName:
      importedInvoice.vendor?.name || importedInvoice.client?.name || "",
    issueDate: importedInvoice.invoiceDate || importedInvoice.createdAt,
    clientId: importedInvoice.client?._id || null,
  };
}

/**
 * Lance sans attendre. Aucune erreur (même immédiate) ne remonte : une
 * automatisation en échec ne doit jamais faire échouer l'action d'origine
 * (rapprochement, réception, synchronisation).
 */
function runInBackground(label, run) {
  Promise.resolve()
    .then(run)
    .catch((err) =>
      logger.error(`[DocumentAutomation] ${label} : ${err?.message || err}`),
    );
}

const userIdOf = (userId) => (userId ? String(userId) : null);

/**
 * Facture passée payée hors de ses écrans (rapprochement bancaire) :
 * automatisations « Facture payée ». Sans utilisateur, la copie est faite au
 * nom du créateur de l'automatisation.
 */
export function triggerInvoicePaidAutomations(invoice, workspaceId, userId) {
  runInBackground(`Facture ${invoice?._id}`, () =>
    documentAutomationService.executeAutomations(
      "INVOICE_PAID",
      String(workspaceId),
      salesDocumentContext("invoice", invoice),
      userIdOf(userId),
    ),
  );
}

/**
 * Facture d'achat créée ou passée à un autre statut hors des résolveurs
 * (justificatif de transaction, réception SuperPDP, synchronisation Qonto,
 * conversion d'une facture importée) : automatisations de ce statut.
 */
export function triggerPurchaseInvoiceAutomations(
  invoice,
  workspaceId,
  userId = null,
) {
  const trigger = statusTrigger("purchaseInvoice", invoice?.status);
  if (!trigger) return;
  runInBackground(`Facture d'achat ${invoice._id}`, () =>
    documentAutomationService.executeAutomationsForExpense(
      trigger,
      String(workspaceId),
      purchaseInvoiceContext(invoice),
      userIdOf(userId),
    ),
  );
}

/**
 * Facture importée validée après vérification (OCR, scan Gmail) :
 * automatisations « Facture importée » (sans effet si elle est déjà classée).
 */
export function triggerImportedInvoiceAutomations(
  importedInvoice,
  workspaceId,
  userId = null,
) {
  runInBackground(`Facture importée ${importedInvoice?._id}`, () =>
    documentAutomationService.executeAutomationsForExpense(
      "INVOICE_IMPORTED",
      String(workspaceId),
      importedInvoiceContext(importedInvoice),
      userIdOf(userId),
    ),
  );
}
