/**
 * Rapprochement bancaire par numéro de facture.
 *
 * Bridge expose deux libellés par transaction :
 *  - `clean_description` (stocké dans Transaction.description) : nettoyé par
 *    Bridge, qui supprime chiffres/tirets et tronque donc les références de
 *    factures, ex. "F-202605-0016 F-202605-0013" → "F F".
 *  - `provider_description` (stocké dans Transaction.reference, et dans
 *    metadata.bridgeProviderDescription pour les transactions historiques) :
 *    libellé brut de la banque qui conserve les références saisies par le payeur.
 *
 * On compare donc le numéro complet de la facture (`prefix-number`) au libellé
 * brut de la transaction.
 */

// Normalise une chaîne pour comparaison robuste : majuscules, alphanumérique
// uniquement (supprime espaces, tirets, ponctuation). "F-202605-0016" → "F2026050016".
const normalizeRef = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/**
 * Numéro complet d'une facture sous forme normalisée.
 * - Facture standard : `${prefix}-${number}` (ex. "F-202605-0016").
 * - Facture importée (préfixe vide) : `number` conserve la référence d'origine.
 */
export const normalizedInvoiceReference = (invoice) => {
  if (!invoice?.number) return "";
  const full = invoice.prefix
    ? `${invoice.prefix}-${invoice.number}`
    : invoice.number;
  return normalizeRef(full);
};

/**
 * Libellé brut d'une transaction, en privilégiant la référence non tronquée.
 */
export const transactionReferenceText = (transaction) =>
  transaction?.reference ||
  transaction?.metadata?.bridgeProviderDescription ||
  transaction?.description ||
  "";

/**
 * Vrai si le numéro complet de la facture apparaît dans le libellé brut de la
 * transaction. Garde-fou : on ignore les références trop courtes (< 6 caractères
 * normalisés) pour éviter les correspondances triviales.
 */
export const invoiceReferenceMatches = (transaction, invoice) => {
  const fullRef = normalizedInvoiceReference(invoice);
  if (fullRef.length < 6) return false;
  const txRef = normalizeRef(transactionReferenceText(transaction));
  if (!txRef) return false;
  return txRef.includes(fullRef);
};
