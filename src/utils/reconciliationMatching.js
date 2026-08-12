/**
 * Logique partagée du rapprochement factures de vente ↔ transactions.
 *
 * Source de vérité unique pour le resolver GraphQL
 * (resolvers/reconciliationResolvers.js) et les routes REST legacy
 * (routes/reconciliation.js) : les deux chemins doivent produire exactement
 * les mêmes candidats, fenêtres de dates et scores. Toute évolution du
 * matching se fait ici, jamais dans les appelants.
 *
 * Renvoie des documents Mongoose bruts : chaque appelant mappe vers son
 * format de réponse (id côté GraphQL, _id côté REST).
 */
import Transaction from "../models/Transaction.js";
import Invoice from "../models/Invoice.js";
import { invoiceReferenceMatches } from "./invoiceReferenceMatch.js";
import {
  earliestTransactionDateForInvoice,
  latestInvoiceIssueDateForTransaction,
  transactionDateMatchesInvoice,
} from "./reconciliationDateWindow.js";

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "1 200,50" → 1200.5 ; null si la saisie n'est pas un montant.
const parseAmountSearch = (term) => {
  const normalized = term.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = parseFloat(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

// N↔N : "non liée" = array vide.
const UNLINKED_INVOICE_CLAUSE = {
  $or: [
    { linkedTransactionIds: { $exists: false } },
    { linkedTransactionIds: { $size: 0 } },
  ],
};

// Critères "à rapprocher" : une entrée d'argent (amount > 0) pas encore
// liée à une facture (linkedInvoiceIds vide), sans justificatif attaché
// (receiptFiles vide → un justificatif/ticket vaut justification, donc
// plus rien à rapprocher) et dont le statut n'est ni "matched" ni
// "ignored" (donc unmatched/suggested, ou vide pour données legacy).
// Doit rester identique au filtre "toReconcile" de la page Transactions
// (transaction-page-query.js).
export const buildReconcileTransactionQuery = (workspaceId) => ({
  workspaceId,
  deletedAt: null,
  reconciliationStatus: { $nin: ["matched", "ignored"] },
  amount: { $gt: 0 },
  $or: [
    { linkedInvoiceIds: { $exists: false } },
    { linkedInvoiceIds: { $size: 0 } },
  ],
  "receiptFiles.0": { $exists: false },
});

const invoiceAmountOf = (invoice) =>
  invoice.finalTotalTTC || invoice.totalTTC || 0;

const amountMatches = (transaction, invoice) => {
  const invoiceAmount = invoiceAmountOf(invoice);
  if (invoiceAmount <= 0) return false;
  return Math.abs(transaction.amount - invoiceAmount) <= invoiceAmount * 0.01;
};

const clientNameMatches = (transaction, invoice) => {
  const clientName = invoice.client?.name || invoice.client?.firstName || "";
  return Boolean(
    clientName &&
    transaction.description?.toLowerCase().includes(clientName.toLowerCase()),
  );
};

/**
 * Vrai si la facture peut être suggérée automatiquement pour cette
 * transaction.
 * - Fenêtre de dates : un paiement ne peut pas précéder la date d'émission
 *   de la facture (marge de 3 jours pour les écarts date d'opération / date
 *   de valeur).
 * - Facture PENDING : montant à ±1 %, nom du client dans le libellé, ou
 *   numéro de facture dans le libellé brut.
 * - Facture COMPLETED (marquée payée à la main, sans transaction liée) :
 *   numéro de facture dans le libellé brut UNIQUEMENT. Un montant égal ne
 *   suffit pas : une facture payée hors banque (espèces, autre compte)
 *   matcherait sinon indéfiniment toutes les transactions du même montant,
 *   sans aucun moyen de la rejeter côté facture.
 */
export const invoiceMatchesTransaction = (transaction, invoice) => {
  if (!transactionDateMatchesInvoice(transaction, invoice)) return false;
  const referenceMatch = invoiceReferenceMatches(transaction, invoice);
  if (invoice.status === "COMPLETED") return referenceMatch;
  return (
    amountMatches(transaction, invoice) ||
    clientNameMatches(transaction, invoice) ||
    referenceMatch
  );
};

/**
 * Suggestions automatiques : transactions à rapprocher × factures candidates.
 *
 * Deux requêtes factures séparées, chacune avec son propre plafond, pour que
 * l'historique COMPLETED (volumineux : tout l'existant d'avant la liaison
 * bancaire est non lié) ne puisse pas évincer les factures PENDING.
 */
export async function findReconciliationSuggestions(workspaceId) {
  const reconcileQuery = buildReconcileTransactionQuery(workspaceId);

  // Comptage complet, sans plafond (countDocuments) → le badge reflète le
  // vrai total. La génération de suggestions reste plafonnée (perf).
  const unmatchedCount = await Transaction.countDocuments(reconcileQuery);
  const unmatchedTransactions = await Transaction.find(reconcileQuery)
    .sort({ date: -1 })
    .limit(50);

  const pendingInvoices = await Invoice.find({
    workspaceId,
    status: "PENDING",
    ...UNLINKED_INVOICE_CLAUSE,
  })
    .sort({ dueDate: 1 })
    .limit(500);

  // Factures marquées payées à la main : candidates par référence uniquement
  // (cf. invoiceMatchesTransaction). Les plus récentes d'abord : ce sont
  // elles que les transactions récentes peuvent solder.
  const completedInvoices = await Invoice.find({
    workspaceId,
    status: "COMPLETED",
    ...UNLINKED_INVOICE_CLAUSE,
  })
    .sort({ issueDate: -1 })
    .limit(500);

  const candidateInvoices = [...pendingInvoices, ...completedInvoices];

  const suggestions = [];
  for (const transaction of unmatchedTransactions) {
    const matchingInvoices = candidateInvoices.filter((invoice) =>
      invoiceMatchesTransaction(transaction, invoice),
    );
    if (matchingInvoices.length > 0) {
      suggestions.push({
        transaction,
        matchingInvoices,
        confidence: matchingInvoices.some(
          (inv) =>
            amountMatches(transaction, inv) ||
            invoiceReferenceMatches(transaction, inv),
        )
          ? "high"
          : "medium",
      });
    }
  }

  return {
    suggestions,
    unmatchedCount,
    pendingInvoicesCount: pendingInvoices.length,
  };
}

/**
 * Transactions candidates pour une facture (rattachement manuel côté
 * facture). Par défaut la fenêtre de dates s'applique ; une recherche
 * explicite (search) la contourne (ex. acompte encaissé avant émission).
 */
export async function findTransactionsForInvoice(invoice, workspaceId, search) {
  const txQuery = {
    workspaceId,
    deletedAt: null,
    reconciliationStatus: { $in: ["unmatched", "suggested"] },
    amount: { $gt: 0 },
  };

  const term = (search || "").trim();

  const minTxDate = earliestTransactionDateForInvoice(invoice);
  if (!term && minTxDate) {
    txQuery.date = { $gte: minTxDate };
  }

  // Recherche serveur : description ou libellé brut (reference), et montant
  // à ±1 % si la saisie est numérique. Permet de retrouver une transaction
  // hors du top scoré ou hors fenêtre de dates.
  if (term) {
    const regex = { $regex: escapeRegex(term), $options: "i" };
    const or = [{ description: regex }, { reference: regex }];
    const searchAmount = parseAmountSearch(term);
    if (searchAmount !== null) {
      const tolerance = Math.max(searchAmount * 0.01, 0.01);
      or.push({
        amount: {
          $gte: searchAmount - tolerance,
          $lte: searchAmount + tolerance,
        },
      });
    }
    txQuery.$or = or;
  }

  const transactions = await Transaction.find(txQuery)
    .sort({ date: -1 })
    .limit(200);

  const invoiceAmount = invoiceAmountOf(invoice);

  const scored = transactions.map((tx) => {
    let score = 0;

    if (invoiceAmount > 0) {
      if (Math.abs(tx.amount - invoiceAmount) <= invoiceAmount * 0.01) {
        score += 100;
      } else if (Math.abs(tx.amount - invoiceAmount) <= invoiceAmount * 0.1) {
        score += 50;
      }
    }

    if (clientNameMatches(tx, invoice)) {
      score += 50;
    }

    // Numéro de facture dans le libellé brut : même poids que côté
    // invoicesForTransaction.
    if (invoiceReferenceMatches(tx, invoice)) {
      score += 100;
    }

    return { transaction: tx, score };
  });

  // Score décroissant, puis date décroissante à score égal
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      new Date(b.transaction.date) - new Date(a.transaction.date),
  );

  return { scored: scored.slice(0, 50), invoiceAmount };
}

/**
 * Factures candidates pour une transaction (rattachement manuel côté
 * transaction) : PENDING (plafond et tri historiques), plus les COMPLETED
 * non liées les plus récentes (plafond séparé pour ne pas évincer les
 * PENDING). La fenêtre de dates s'applique par défaut, contournée par une
 * recherche explicite.
 */
export async function findInvoicesForTransaction(
  transaction,
  workspaceId,
  search,
) {
  const term = (search || "").trim();

  // Clauses communes ($and pour composer plusieurs $or sans collision).
  const clauses = [];

  const maxIssueDate = latestInvoiceIssueDateForTransaction(transaction);
  if (!term && maxIssueDate) {
    clauses.push({
      $or: [{ issueDate: null }, { issueDate: { $lte: maxIssueDate } }],
    });
  }

  // Recherche serveur : numéro de facture, nom du client, et montant TTC à
  // ±1 % si la saisie est numérique.
  if (term) {
    const regex = { $regex: escapeRegex(term), $options: "i" };
    const or = [
      { number: regex },
      { "client.name": regex },
      { "client.firstName": regex },
      { "client.lastName": regex },
    ];
    const searchAmount = parseAmountSearch(term);
    if (searchAmount !== null) {
      const tolerance = Math.max(searchAmount * 0.01, 0.01);
      const range = {
        $gte: searchAmount - tolerance,
        $lte: searchAmount + tolerance,
      };
      or.push({ finalTotalTTC: range }, { totalTTC: range });
    }
    clauses.push({ $or: or });
  }

  const buildQuery = (statusClause) => ({
    workspaceId,
    _id: { $nin: transaction.linkedInvoiceIds || [] },
    $and: [statusClause, ...clauses],
  });

  const pendingInvoices = await Invoice.find(buildQuery({ status: "PENDING" }))
    .sort({ dueDate: 1 })
    .limit(200);

  // Factures marquées payées à la main : rattachables manuellement (c'est le
  // recours quand elles sont sorties du flux de suggestions), les plus
  // récentes d'abord.
  const completedInvoices = await Invoice.find(
    buildQuery({ status: "COMPLETED", ...UNLINKED_INVOICE_CLAUSE }),
  )
    .sort({ issueDate: -1 })
    .limit(100);

  const scored = [...pendingInvoices, ...completedInvoices].map((inv) => {
    const amount = invoiceAmountOf(inv);
    let score = 0;

    if (amount > 0) {
      if (Math.abs(transaction.amount - amount) <= amount * 0.01) {
        score += 100;
      } else if (Math.abs(transaction.amount - amount) <= amount * 0.1) {
        score += 50;
      }
    }

    if (clientNameMatches(transaction, inv)) {
      score += 50;
    }

    if (invoiceReferenceMatches(transaction, inv)) {
      score += 100;
    }

    return { invoice: inv, score };
  });

  // Score décroissant, puis échéance la plus proche à score égal
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      new Date(a.invoice.dueDate) - new Date(b.invoice.dueDate),
  );

  return { scored: scored.slice(0, 50), transactionAmount: transaction.amount };
}

/**
 * Bascule le statut d'ignorance du rapprochement (ignore ↔ unignore).
 * Le retour à "unmatched" ne s'applique qu'aux transactions effectivement
 * "ignored" : une "matched" ne doit pas repasser unmatched par ce chemin.
 * Renvoie le document mis à jour, ou null si introuvable / statut inattendu.
 */
export const setReconciliationIgnored = (transactionId, workspaceId, ignored) =>
  Transaction.findOneAndUpdate(
    {
      _id: transactionId,
      workspaceId,
      ...(ignored ? {} : { reconciliationStatus: "ignored" }),
    },
    { reconciliationStatus: ignored ? "ignored" : "unmatched" },
    { new: true },
  );
