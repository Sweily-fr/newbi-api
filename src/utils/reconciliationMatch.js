import { invoiceReferenceMatches } from "./invoiceReferenceMatch.js";

/**
 * Logique de matching facture <-> transaction, partagée entre le resolver
 * GraphQL (reconciliationResolvers.js) et la route REST (routes/reconciliation.js)
 * pour qu'elles restent strictement identiques.
 *
 * Point clé : une facture en attente ne peut être liée qu'à UNE seule
 * transaction (relation 1:1, linkedTransactionId). On déduplique donc par
 * facture : chaque facture n'est proposée que dans la carte de la transaction
 * qui la matche le mieux. Sans cette dédup, un paiement récurrent (3 virements
 * de 2 500 € d'un même abonnement) faisait apparaître la même Facture 1002 dans
 * 3 cartes distinctes, et "Masquer" (indexé par transactionId) n'en cachait
 * qu'une à la fois.
 */

// Tolérance d'antériorité : un paiement peut légitimement tomber quelques jours
// avant l'émission (acompte, virement croisé), mais pas plusieurs mois avant.
// Au-delà de cette marge, la transaction est forcément étrangère à la facture.
const ANTERIORITY_TOLERANCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Garde-fou chronologique : une transaction survenue (au-delà de la tolérance)
 * AVANT l'émission de la facture ne peut pas la régler — la facture n'existait
 * pas encore. Ne bloque que si les deux dates sont connues.
 * Partagé entre le matching automatique et le scoring "transactions candidates
 * pour une facture" pour garder une règle unique.
 */
export const isTransactionBeforeInvoice = (transaction, invoice) => {
  if (!transaction?.date || !invoice?.issueDate) return false;
  const txTime = new Date(transaction.date).getTime();
  const issueTime = new Date(invoice.issueDate).getTime();
  return txTime < issueTime - ANTERIORITY_TOLERANCE_MS;
};

// Évalue la correspondance d'un couple (transaction, facture).
// Renvoie null si aucun critère ne matche, sinon un score de priorité :
//   référence (n° de facture dans le libellé brut) >> nom client >> montant.
const evaluateMatch = (transaction, invoice) => {
  if (isTransactionBeforeInvoice(transaction, invoice)) return null;

  const invoiceAmount = invoice.finalTotalTTC || invoice.totalTTC || 0;
  const tolerance = invoiceAmount * 0.01;
  const amountMatch =
    Math.abs(transaction.amount - invoiceAmount) <= tolerance;

  const clientName = invoice.client?.name || invoice.client?.firstName || "";
  const descriptionMatch = Boolean(
    clientName &&
      transaction.description
        ?.toLowerCase()
        .includes(clientName.toLowerCase()),
  );

  const referenceMatch = invoiceReferenceMatches(transaction, invoice);

  if (!amountMatch && !descriptionMatch && !referenceMatch) return null;

  let score = 0;
  if (referenceMatch) score += 100;
  if (descriptionMatch) score += 10;
  if (amountMatch) score += 1;

  // "high" = critère fiable seul (montant exact ou référence). Le nom du client
  // seul reste "medium" (homonymes possibles). Identique à l'ancienne logique.
  const high = amountMatch || referenceMatch;

  return { score, amountMatch, descriptionMatch, referenceMatch, high };
};

// Écart en millisecondes entre la date de la transaction et l'échéance de la
// facture. Sert de départage quand une facture matche plusieurs transactions
// uniquement par le montant : on retient le paiement le plus proche de
// l'échéance (un paiement arrive en général autour de la dueDate).
const dateDistance = (transaction, invoice) => {
  const txTime = transaction.date ? new Date(transaction.date).getTime() : 0;
  const dueTime = invoice.dueDate ? new Date(invoice.dueDate).getTime() : 0;
  return Math.abs(txTime - dueTime);
};

/**
 * Construit les suggestions dédupliquées.
 *
 * @param {Array} transactions  Transactions "à rapprocher", déjà triées (l'ordre
 *                              d'affichage est conservé).
 * @param {Array} invoices      Factures en attente (PENDING, non liées).
 * @returns {Map<string, {transaction, matches: Array<{invoice, match}>}>}
 *          Indexé par transactionId ; ne contient que les transactions ayant au
 *          moins une facture attribuée.
 */
export const buildReconciliationMatches = (transactions, invoices) => {
  // 1) Pour chaque facture, retenir la meilleure transaction (score le plus
  //    élevé ; à score égal, l'échéance la plus proche).
  const bestByInvoice = new Map(); // invoiceId -> { transaction, invoice, match }

  for (const transaction of transactions) {
    for (const invoice of invoices) {
      const match = evaluateMatch(transaction, invoice);
      if (!match) continue;

      const invId = invoice._id.toString();
      const prev = bestByInvoice.get(invId);
      if (
        !prev ||
        match.score > prev.match.score ||
        (match.score === prev.match.score &&
          dateDistance(transaction, invoice) <
            dateDistance(prev.transaction, invoice))
      ) {
        bestByInvoice.set(invId, { transaction, invoice, match });
      }
    }
  }

  // 2) Regrouper les factures gagnées par transaction.
  const byTransaction = new Map(); // transactionId -> { transaction, matches }
  for (const { transaction, invoice, match } of bestByInvoice.values()) {
    const tid = transaction._id.toString();
    if (!byTransaction.has(tid)) {
      byTransaction.set(tid, { transaction, matches: [] });
    }
    byTransaction.get(tid).matches.push({ invoice, match });
  }

  return byTransaction;
};
