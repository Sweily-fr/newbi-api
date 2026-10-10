/**
 * Identifiants de navigation d'un document cité par une notification
 * (DOCUMENT_IMPORTED, PURCHASE_INVOICE_RECEIVED). Partagés entre le champ
 * `data` de la notification in-app et les données du push, pour que la
 * cloche et le tap sur le push ouvrent le même écran.
 */

// Clé d'identifiant propre au modèle du document : une facture importée
// n'est pas une facture Newbi, la fiche mobile factures/[id] ne l'ouvrirait
// pas
export const DOCUMENT_MODEL_ID_KEYS = {
  Invoice: "invoiceId",
  ImportedInvoice: "importedInvoiceId",
  Quote: "quoteId",
  ImportedQuote: "importedQuoteId",
  PurchaseInvoice: "purchaseInvoiceId",
};

const isSet = (value) => value !== undefined && value !== null && value !== "";

/**
 * Clés d'identifiant à ajouter pour un document : la clé propre à son modèle
 * (invoiceId, importedInvoiceId, quoteId, importedQuoteId, purchaseInvoiceId)
 * et, pour une facture d'achat, purchaseInvoiceId même sans modèle précisé
 * (le type suffit, il n'existe qu'un modèle).
 *
 * @param {object} params
 * @param {string} [params.documentType] - INVOICE | QUOTE | PURCHASE_INVOICE
 * @param {string} [params.documentModel] - Invoice, ImportedInvoice, Quote…
 * @param {*} [params.documentId]
 * @returns {Record<string, *>} clés à fusionner (valeur = documentId)
 */
export function documentNavigationIds({
  documentType,
  documentModel,
  documentId,
} = {}) {
  if (!isSet(documentId)) return {};
  const ids = {};
  const modelKey = DOCUMENT_MODEL_ID_KEYS[documentModel];
  if (modelKey) ids[modelKey] = documentId;
  if (documentType === "PURCHASE_INVOICE") ids.purchaseInvoiceId = documentId;
  return ids;
}

export default { DOCUMENT_MODEL_ID_KEYS, documentNavigationIds };
