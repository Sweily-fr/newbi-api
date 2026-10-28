/**
 * Textes des échéances du calendrier (factures, devis, tâches…) hors de
 * l'application : abonnement iCal et récap du lundi par e-mail. Mêmes mots
 * que la fiche du calendrier (NewbiV2 linked-sources.js). Fonctions pures.
 *
 * Une source inconnue (ajoutée depuis au service des échéances) garde un
 * libellé générique plutôt que de disparaître.
 */

// Adresse de l'application (lien vers un élément ou vers le calendrier)
export const appBaseUrl = () =>
  String(process.env.FRONTEND_URL || "https://www.newbi.fr").replace(
    /\/+$/,
    "",
  );

export const LINKED_KIND_TEXT = {
  INVOICE: {
    source: "Encaissements",
    noun: "Facture de vente",
    party: "Client",
    states: {
      UPCOMING: "Facture à encaisser",
      OVERDUE: "Facture en retard",
      DONE: "Facture payée",
    },
  },
  PURCHASE_INVOICE: {
    source: "Paiements",
    noun: "Facture d'achat",
    party: "Fournisseur",
    states: {
      UPCOMING: "Facture à payer",
      OVERDUE: "Facture à payer en retard",
      DONE: "Facture d'achat payée",
    },
  },
  QUOTE: {
    source: "Devis",
    noun: "Devis",
    party: "Client",
    states: {
      UPCOMING: "Devis à relancer",
      OVERDUE: "Devis expiré",
      DONE: "Devis traité",
    },
  },
  RECURRING_INVOICE: {
    source: "Récurrences",
    noun: "Facture récurrente",
    party: "Client",
    states: {
      UPCOMING: "Facture récurrente",
      OVERDUE: "Facture récurrente en attente",
      DONE: "Facture récurrente émise",
    },
  },
  TASK: {
    source: "Tâches",
    noun: "Tâche",
    states: {
      UPCOMING: "Tâche",
      OVERDUE: "Tâche en retard",
      DONE: "Tâche terminée",
    },
  },
  FORECAST: {
    source: "Prévisions",
    noun: "Prévision",
    party: "Tiers",
    states: {
      UPCOMING: "Mouvement prévu",
      OVERDUE: "Mouvement prévu",
      DONE: "Prévision passée",
    },
  },
  REMINDER: {
    source: "Relances",
    noun: "Relance de la facture",
    party: "Client",
    states: {
      UPCOMING: "Relance prévue",
      OVERDUE: "Relance en échec",
      DONE: "Relance envoyée",
    },
  },
  DELIVERY: {
    source: "Livraisons",
    noun: "Livraison",
    party: "Client",
    states: {
      UPCOMING: "Livraison prévue",
      OVERDUE: "Livraison en retard",
      DONE: "Livraison effectuée",
    },
  },
  FILE_TRANSFER: {
    source: "Transferts",
    noun: "Transfert de fichiers",
    party: "Destinataire",
    states: {
      UPCOMING: "Fin du lien de transfert",
      OVERDUE: "Fin du lien de transfert",
      DONE: "Lien de transfert expiré",
    },
  },
  // Échéance calculée : jamais en retard, une date passée reste neutre
  FISCAL: {
    source: "Fiscal",
    noun: "Échéance fiscale",
    party: "Organisme",
    states: {
      UPCOMING: "Échéance fiscale",
      OVERDUE: "Échéance fiscale",
      DONE: "Échéance fiscale passée",
    },
  },
};

// Montants TTC de documents ; une prévision ou le prix d'un transfert n'en
// sont pas
const TTC_KINDS = new Set([
  "INVOICE",
  "PURCHASE_INVOICE",
  "QUOTE",
  "RECURRING_INVOICE",
  "REMINDER",
  "DELIVERY",
]);

// Sorties d'argent prévues : montant précédé d'un signe moins
const signedAmount = (item, options) => {
  const amount = formatAmount(item?.amount, item?.currency, options);
  if (!amount || item?.kind !== "FORECAST") return amount;
  return `${item.flowType === "EXPENSE" ? "- " : "+ "}${amount}`;
};

const GENERIC_TEXT = { source: "Échéances", noun: "Échéance", states: {} };

export const PRIORITY_TEXT = { high: "Haute", medium: "Moyenne", low: "Basse" };

export const kindText = (kind) => LINKED_KIND_TEXT[kind] || GENERIC_TEXT;

/** « Facture à encaisser », « Tâche en retard »… */
export function linkedItemLabel(item) {
  if (item?.kind === "FORECAST" && item.state !== "DONE") {
    return item.flowType === "INCOME" ? "Rentrée prévue" : "Sortie prévue";
  }
  if (item?.kind === "REMINDER" && item.reminderStatus === "NO_EMAIL") {
    return "Relance sans adresse e-mail";
  }
  const text = kindText(item?.kind);
  return text.states[item?.state] || text.noun;
}

const formatters = new Map();

/**
 * Montant en devise : « 1 200 € » pour un montant rond, « 59,99 € »
 * sinon ; `exact` garde toujours les centimes. Null sans montant.
 */
export function formatAmount(amount, currency = "EUR", { exact = false } = {}) {
  if (!Number.isFinite(amount)) return null;
  const digits = exact || !Number.isInteger(amount) ? 2 : 0;
  const code = currency || "EUR";
  const key = `${code}:${digits}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat("fr-FR", {
        style: "currency",
        currency: code,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      // Code devise inconnu : nombre suivi du code
      const number = new Intl.NumberFormat("fr-FR", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
      formatter = { format: (value) => `${number.format(value)} ${code}` };
    }
    formatters.set(key, formatter);
  }
  return formatter.format(amount);
}

/**
 * Résumé d'une ligne : « Facture à encaisser · Atelier Lumière · 1 200 € »,
 * « Tâche · Maquettes ».
 */
export function linkedItemSummary(item) {
  const label = linkedItemLabel(item);
  if (item?.kind === "TASK") {
    return [label, item.title].filter(Boolean).join(" · ");
  }
  // « Déclaration de TVA (CA3) · Octobre 2026 » : l'organisme est le même
  // pour presque toutes, le titre et la période disent de quoi il s'agit
  if (item?.kind === "FISCAL") {
    return [item.title || label, item.reference].filter(Boolean).join(" · ");
  }
  const known = Boolean(LINKED_KIND_TEXT[item?.kind]);
  const who =
    item?.counterparty || item?.reference || (known ? null : item?.title);
  return [label, who, signedAmount(item)].filter(Boolean).join(" · ");
}

/**
 * Page de l'application qui ouvre l'élément (mêmes chemins que
 * linkedItemHref du site), le calendrier à défaut.
 */
export function linkedItemPath(item) {
  switch (item?.kind) {
    case "INVOICE":
      return `/dashboard/outils/factures?id=${item.entityId}`;
    case "RECURRING_INVOICE":
      return item.sourceInvoiceId
        ? `/dashboard/outils/factures?id=${item.sourceInvoiceId}`
        : "/dashboard/outils/factures";
    case "QUOTE":
      return `/dashboard/outils/devis?id=${item.entityId}`;
    case "PURCHASE_INVOICE":
      return `/dashboard/outils/factures-achat?id=${item.entityId}`;
    case "TASK":
      return item.boardId
        ? `/dashboard/outils/kanban/${item.boardId}?task=${item.entityId}`
        : "/dashboard/outils/kanban";
    // La relance ouvre sa facture
    case "REMINDER":
      return `/dashboard/outils/factures?id=${item.entityId}`;
    case "FORECAST":
      return "/dashboard/outils/prevision";
    case "DELIVERY":
      return item.documentKind === "DELIVERY_NOTE"
        ? `/dashboard/outils/bons-de-livraison?id=${item.entityId}`
        : `/dashboard/outils/bons-commande?id=${item.entityId}`;
    case "FILE_TRANSFER":
      return "/dashboard/outils/transferts-fichiers";
    default:
      return "/dashboard/calendar";
  }
}

/** Détail sur plusieurs lignes (description d'un événement iCal). */
export function linkedItemDetails(item) {
  const text = kindText(item?.kind);
  const lines = [];
  // Échéance fiscale : période, organisme, règle et page officielle
  if (item?.kind === "FISCAL") {
    if (item.reference) lines.push(`Période : ${item.reference}`);
    if (item.counterparty) lines.push(`Organisme : ${item.counterparty}`);
    if (item.isIndicative) lines.push("Date indicative");
    if (item.note) lines.push(item.note);
    if (item.infoUrl) lines.push(`Page officielle : ${item.infoUrl}`);
    return lines;
  }
  if (item?.kind === "TASK") {
    if (item.boardTitle) lines.push(`Projet : ${item.boardTitle}`);
    if (item.columnTitle) lines.push(`Colonne : ${item.columnTitle}`);
    if (PRIORITY_TEXT[item.priority]) {
      lines.push(`Priorité : ${PRIORITY_TEXT[item.priority]}`);
    }
    return lines;
  }
  const noun =
    item?.kind === "DELIVERY"
      ? item.documentKind === "DELIVERY_NOTE"
        ? "Bon de livraison"
        : "Bon de commande"
      : text.noun;
  lines.push(item?.reference ? `${noun} ${item.reference}` : noun);
  if (item?.counterparty) {
    lines.push(`${text.party || "Contact"} : ${item.counterparty}`);
  } else if (!LINKED_KIND_TEXT[item?.kind] && item?.title) {
    lines.push(item.title);
  }
  const amount = signedAmount(item, { exact: true });
  // Montants TTC des documents ; rien de supposé pour les autres
  if (amount) {
    lines.push(`Montant : ${amount}${TTC_KINDS.has(item?.kind) ? " TTC" : ""}`);
  }
  return lines;
}
