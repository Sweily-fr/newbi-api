/**
 * Liens documentaires d'une transaction bancaire (factures de vente, factures
 * d'achat, factures clients importées). Source unique des clauses "aucun
 * document lié", utilisées par :
 * - le filtre "à rapprocher" de la page Transactions (transaction-page-query),
 * - les suggestions de rapprochement (reconciliationMatching),
 * - les déliaisons et nettoyages (retour à "unmatched" seulement quand plus
 *   rien n'est lié).
 * Ajouter ici tout nouveau type de document rapprochable.
 */
export const TRANSACTION_LINK_FIELDS = [
  "linkedInvoiceIds",
  "linkedPurchaseInvoiceIds",
  "linkedImportedInvoiceIds",
];

const emptyArrayClause = (field) => ({
  $or: [{ [field]: { $exists: false } }, { [field]: { $size: 0 } }],
});

// À utiliser dans un `$and`.
export const NO_LINKED_DOCUMENTS_CLAUSES =
  TRANSACTION_LINK_FIELDS.map(emptyArrayClause);

// Vrai si le document (Mongoose ou lean) ne référence plus aucun document.
export const transactionHasNoLinks = (transaction) =>
  TRANSACTION_LINK_FIELDS.every(
    (field) => (transaction?.[field] || []).length === 0,
  );

// Filtre Mongo : la transaction n'a plus aucun lien (pour un updateOne/Many
// conditionnel vers "unmatched").
export const noLinkedDocumentsFilter = () => ({
  $and: NO_LINKED_DOCUMENTS_CLAUSES,
});
