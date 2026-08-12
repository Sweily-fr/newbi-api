/**
 * Fenêtre de dates du rapprochement bancaire (factures de vente).
 *
 * Un paiement ne peut pas précéder la facture qu'il solde : on ne propose que
 * les transactions datées après la date d'émission de la facture, avec une
 * marge de quelques jours pour absorber les écarts date d'opération / date de
 * valeur (même marge que la déduplication Bridge, cf. BridgeProvider).
 *
 * La fenêtre ne s'applique qu'aux propositions automatiques : une recherche
 * explicite de l'utilisateur (champ search) doit pouvoir retrouver une
 * transaction hors fenêtre (ex. acompte encaissé avant émission).
 */
export const RECONCILIATION_DATE_BUFFER_DAYS = 3;

const BUFFER_MS = RECONCILIATION_DATE_BUFFER_DAYS * 24 * 60 * 60 * 1000;

/**
 * Date de transaction la plus ancienne acceptable pour une facture donnée,
 * ou null si la facture n'a pas de date d'émission exploitable.
 */
export const earliestTransactionDateForInvoice = (invoice) => {
  if (!invoice?.issueDate) return null;
  const issueTime = new Date(invoice.issueDate).getTime();
  if (Number.isNaN(issueTime)) return null;
  return new Date(issueTime - BUFFER_MS);
};

/**
 * Date d'émission de facture la plus récente acceptable pour une transaction
 * donnée, ou null si la transaction n'a pas de date exploitable.
 */
export const latestInvoiceIssueDateForTransaction = (transaction) => {
  if (!transaction?.date) return null;
  const txTime = new Date(transaction.date).getTime();
  if (Number.isNaN(txTime)) return null;
  return new Date(txTime + BUFFER_MS);
};

/**
 * Vrai si la transaction peut correspondre à la facture au regard des dates.
 * Donnée manquante (facture sans issueDate, transaction sans date) : on
 * n'exclut pas, les autres critères tranchent.
 */
export const transactionDateMatchesInvoice = (transaction, invoice) => {
  const minDate = earliestTransactionDateForInvoice(invoice);
  if (!minDate || !transaction?.date) return true;
  const txTime = new Date(transaction.date).getTime();
  if (Number.isNaN(txTime)) return true;
  return txTime >= minDate.getTime();
};
