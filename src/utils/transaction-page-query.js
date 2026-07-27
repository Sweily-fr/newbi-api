/**
 * Construction des requêtes Mongo de la liste paginée de transactions
 * (query GraphQL transactionsPage). Fonctions pures, testées unitairement.
 *
 * Les prédicats d'onglets reproduisent EXACTEMENT ceux historiquement
 * calculés côté client (TransactionTable.jsx) pour que la pagination serveur
 * ne change pas le contenu des onglets :
 * - TO_RECONCILE : entrée d'argent (amount > 0) non rapprochée (statut ni
 *   matched ni ignored), sans justificatif ni facture liée
 * - MISSING_RECEIPT : sortie d'argent bancaire (provider != manual,
 *   amount < 0) sans justificatif ni facture liée
 * - LAST_MONTH : transactions du dernier mois glissant
 */

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "1 200,50" → 1200.5 ; null si la saisie n'est pas un montant
const parseAmountSearch = (term) => {
  const normalized = term.replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const amount = parseFloat(normalized);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
};

const NO_LINKED_INVOICES = [
  {
    $or: [
      { linkedInvoiceIds: { $exists: false } },
      { linkedInvoiceIds: { $size: 0 } },
    ],
  },
  {
    $or: [
      { linkedPurchaseInvoiceIds: { $exists: false } },
      { linkedPurchaseInvoiceIds: { $size: 0 } },
    ],
  },
];

/**
 * Prédicat Mongo d'un onglet. `now` est injectable pour les tests.
 */
export function buildTabPredicate(tab, now = new Date()) {
  switch (tab) {
    case "LAST_MONTH": {
      const oneMonthAgo = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        now.getDate(),
      );
      return { date: { $gte: oneMonthAgo } };
    }
    case "TO_RECONCILE":
      return {
        amount: { $gt: 0 },
        reconciliationStatus: { $nin: ["matched", "ignored"] },
        "receiptFiles.0": { $exists: false },
        $and: NO_LINKED_INVOICES,
      };
    case "MISSING_RECEIPT":
      return {
        provider: { $ne: "manual" },
        amount: { $lt: 0 },
        "receiptFiles.0": { $exists: false },
        $and: NO_LINKED_INVOICES,
      };
    default:
      return {};
  }
}

/**
 * Filtre de base (hors onglet) : recherche texte, compte, source, catégorie,
 * moyen de paiement, plage de montants et de dates.
 */
export function buildBaseQuery(workspaceId, filters = {}) {
  const query = { workspaceId, deletedAt: null };

  if (filters.accountId) query.fromAccount = filters.accountId;

  if (filters.source === "MANUAL") query.provider = "manual";
  else if (filters.source === "BANK") query.provider = { $ne: "manual" };

  if (filters.category) {
    query.$or = [
      { category: filters.category },
      { expenseCategory: filters.category },
    ];
  }

  if (filters.paymentMethod) {
    query["metadata.paymentMethod"] = filters.paymentMethod;
  }

  if (filters.minAmount !== undefined && filters.minAmount !== null) {
    query.amount = { ...(query.amount || {}), $gte: filters.minAmount };
  }
  if (filters.maxAmount !== undefined && filters.maxAmount !== null) {
    query.amount = { ...(query.amount || {}), $lte: filters.maxAmount };
  }

  if (filters.startDate || filters.endDate) {
    query.date = {};
    if (filters.startDate) query.date.$gte = new Date(filters.startDate);
    if (filters.endDate) query.date.$lte = new Date(filters.endDate);
  }

  const term = (filters.search || "").trim();
  if (term) {
    const regex = { $regex: escapeRegex(term), $options: "i" };
    const searchOr = [
      { description: regex },
      { reference: regex },
      { "metadata.vendor": regex },
      { "metadata.notes": regex },
    ];
    const searchAmount = parseAmountSearch(term);
    if (searchAmount !== null) {
      const tolerance = Math.max(searchAmount * 0.01, 0.01);
      // Montants signés : une recherche "49,99" doit trouver la dépense -49,99
      searchOr.push({
        amount: {
          $gte: searchAmount - tolerance,
          $lte: searchAmount + tolerance,
        },
      });
      searchOr.push({
        amount: {
          $gte: -searchAmount - tolerance,
          $lte: -searchAmount + tolerance,
        },
      });
    }
    // $and pour ne pas écraser un éventuel $or de catégorie
    query.$and = [...(query.$and || []), { $or: searchOr }];
  }

  return query;
}

/**
 * Combine filtre de base + prédicat d'onglet en une requête Mongo unique.
 */
export function buildPageQuery(
  workspaceId,
  filters = {},
  tab,
  now = new Date(),
) {
  const base = buildBaseQuery(workspaceId, filters);
  const tabPredicate = buildTabPredicate(tab, now);

  const merged = { ...base };
  for (const [key, value] of Object.entries(tabPredicate)) {
    if (key === "$and") {
      merged.$and = [...(merged.$and || []), ...value];
    } else if (key in merged) {
      // Conflit (ex: amount déjà filtré par min/max ET par l'onglet) :
      // combiner via $and
      merged.$and = [...(merged.$and || []), { [key]: value }];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
