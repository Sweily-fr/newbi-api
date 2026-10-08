/**
 * ========================================
 * CATALOGUE DES DROITS PAR RÔLE
 * ========================================
 *
 * Source unique des droits d'un membre dans un espace. Le front lit ce
 * catalogue via GraphQL (`roleCatalog`, `organizationRoles`, `myPermissions`),
 * il n'en garde pas de copie.
 *
 * Modèle : pour chaque module (une page ou une fonctionnalité), un niveau
 * parmi `none` < `read` < `write` < `delete`.
 *   - read   : voir, exporter, télécharger
 *   - write  : read + créer, modifier, envoyer, importer, convertir…
 *   - delete : write + supprimer
 * Les modules du groupe « Compte » n'ont que none / read / write (« Gérer »),
 * et write y couvre aussi les suppressions. Les fonctionnalités
 * (`kind: "feature"`, ex. encaissement des factures) sont oui / non :
 * none / write.
 *
 * Rôles prédéfinis (clés techniques inchangées pour ne migrer aucun membre) :
 *   owner      → « Super admin »     : tout, non modifiable, unique
 *   admin      → « Administrateur »  : tout sauf membres et abonnement
 *   member     → « Éditeur »         : crée et modifie, ne supprime pas
 *   viewer     → « Membre »          : lecture seule
 *   accountant → « Comptable »       : droits d'avant les rôles
 *                                       personnalisés, siège gratuit
 * Le super admin peut ajuster les droits des rôles prédéfinis (sauf le sien)
 * et créer des rôles personnalisés (collection `organizationRole`, partagée
 * avec le plugin organisation de Better Auth côté front).
 */

export const LEVELS = ["none", "read", "write", "delete"];

const LEVEL_RANK = { none: 0, read: 1, write: 2, delete: 3 };

export const ACCOUNT_LEVELS = ["none", "read", "write"];

export const FEATURE_LEVELS = ["none", "write"];

export const MODULE_GROUPS = [
  { key: "sales", label: "Ventes" },
  { key: "clients", label: "Clients" },
  { key: "finances", label: "Finances" },
  { key: "purchases", label: "Achats" },
  { key: "tools", label: "Outils" },
  { key: "account", label: "Compte" },
];

export const MODULES = [
  // Ventes
  {
    key: "invoices",
    group: "sales",
    label: "Factures clients",
    description: "Factures, relances, facturation électronique",
  },
  {
    key: "invoicePayments",
    group: "sales",
    kind: "feature",
    label: "Encaissement des factures",
    description: "Marquer une facture comme payée",
  },
  {
    key: "creditNotes",
    group: "sales",
    label: "Avoirs",
    description: "Avoirs créés depuis une facture",
  },
  {
    key: "importedInvoices",
    group: "sales",
    label: "Factures importées",
    description: "Factures clients importées depuis un autre logiciel",
  },
  { key: "quotes", group: "sales", label: "Devis" },
  {
    key: "importedQuotes",
    group: "sales",
    label: "Devis importés",
    description: "Devis importés depuis un autre logiciel",
  },
  { key: "purchaseOrders", group: "sales", label: "Bons de commande" },
  {
    key: "importedPurchaseOrders",
    group: "sales",
    label: "Bons de commande importés",
    description: "Bons de commande importés depuis un autre logiciel",
  },
  { key: "deliveryNotes", group: "sales", label: "Bons de livraison" },
  {
    key: "products",
    group: "sales",
    label: "Catalogue",
    description: "Produits, services et leurs champs personnalisés",
  },
  // Clients
  {
    key: "clients",
    group: "clients",
    label: "Clients",
    description: "Fiches clients et segments",
  },
  {
    key: "clientLists",
    group: "clients",
    label: "Listes et champs personnalisés",
    description: "Listes de clients et champs personnalisés des fiches",
  },
  {
    key: "automations",
    group: "clients",
    label: "Automatisations",
    description: "Automatisations des listes et des e-mails clients",
  },
  // Finances
  {
    key: "banking",
    group: "finances",
    label: "Transactions",
    description: "Transactions bancaires, justificatifs et rapprochement",
  },
  {
    key: "analytics",
    group: "finances",
    label: "Analyses et prévisions",
    description: "Vue d'ensemble, analytiques et prévision de trésorerie",
  },
  // Achats
  {
    key: "purchaseInvoices",
    group: "purchases",
    label: "Factures d'achat",
    description: "Factures d'achat, dépenses et fournisseurs",
  },
  // Outils
  { key: "calendar", group: "tools", label: "Calendrier" },
  {
    key: "kanban",
    group: "tools",
    label: "Projets",
    description: "Tableaux kanban, tâches et partages publics",
  },
  { key: "fileTransfers", group: "tools", label: "Transferts de fichiers" },
  {
    key: "sharedDocuments",
    group: "tools",
    label: "Documents partagés",
    description: "Documents, dossiers et automatisations de classement",
  },
  { key: "signatures", group: "tools", label: "Signatures de mail" },
  // Compte
  {
    key: "team",
    group: "account",
    label: "Membres",
    description: "Inviter, retirer des membres et changer leur rôle",
  },
  {
    key: "billing",
    group: "account",
    label: "Abonnement Newbi",
    description: "Offre, moyens de paiement et factures Newbi",
  },
  {
    key: "orgSettings",
    group: "account",
    label: "Informations de l'entreprise",
    description:
      "Infos générales et légales, coordonnées bancaires, paramètres des documents et des e-mails",
  },
  {
    key: "integrations",
    group: "account",
    label: "Applications et banques",
    description:
      "Connexion des banques, Qonto, Stripe, Pennylane, Abby, facturation électronique",
  },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

const ACCOUNT_MODULES = new Set(
  MODULES.filter((m) => m.group === "account").map((m) => m.key),
);

const FEATURE_MODULES = new Set(
  MODULES.filter((m) => m.kind === "feature").map((m) => m.key),
);

/**
 * Anciens noms de ressources encore utilisés par les resolvers
 * (`requireWrite("expenses")`…) → module du catalogue.
 */
export const RESOURCE_ALIASES = {
  expenses: "purchaseInvoices",
  suppliers: "purchaseInvoices",
  payments: "banking",
  reports: "analytics",
};

/**
 * Actions portées par une fonctionnalité plutôt que par le niveau du module
 * (`requirePermission("invoices", "mark-paid")`).
 */
const ACTION_MODULES = {
  invoices: { "mark-paid": "invoicePayments" },
};

/**
 * Niveau minimal requis par action. Une action inconnue exige `write`
 * (fermé par défaut plutôt qu'ouvert).
 */
const ACTION_LEVEL = {
  view: "read",
  read: "read",
  export: "read",
  download: "read",
  delete: "delete",
  remove: "delete",
};

export function allowedLevels(moduleKey) {
  if (FEATURE_MODULES.has(moduleKey)) return FEATURE_LEVELS;
  return ACCOUNT_MODULES.has(moduleKey) ? ACCOUNT_LEVELS : LEVELS;
}

/** Ramène un niveau dans ceux autorisés pour le module. */
export function clampLevel(moduleKey, level) {
  if (!LEVEL_RANK[level] && level !== "none") return "none";
  if (FEATURE_MODULES.has(moduleKey)) {
    // Oui / non : la lecture seule d'une fonctionnalité n'existe pas
    return level === "write" || level === "delete" ? "write" : "none";
  }
  if (ACCOUNT_MODULES.has(moduleKey) && level === "delete") return "write";
  return level;
}

function fill(level, overrides = {}) {
  const levels = {};
  for (const key of MODULE_KEYS) {
    levels[key] = clampLevel(key, overrides[key] ?? level);
  }
  return levels;
}

const READ_ONLY = fill("read", {
  team: "read",
  billing: "none",
  orgSettings: "read",
  integrations: "none",
});

export const PREDEFINED_ROLES = {
  owner: {
    label: "Super admin",
    description:
      "Tous les droits, y compris les membres, les rôles et l'abonnement. Un seul par espace.",
    editable: false,
    levels: fill("delete"),
  },
  admin: {
    label: "Administrateur",
    description:
      "Crée, modifie et supprime partout. Ne gère ni les membres ni l'abonnement.",
    editable: true,
    levels: fill("delete", { team: "read", billing: "read" }),
  },
  member: {
    label: "Éditeur",
    description:
      "Crée et modifie les documents, sans pouvoir supprimer ni toucher au compte.",
    editable: true,
    levels: fill("write", {
      // Signatures de mail : documents personnels, chacun supprime les
      // siennes (les suppressions sont filtrées sur l'auteur)
      signatures: "delete",
      team: "read",
      billing: "none",
      orgSettings: "read",
      integrations: "none",
    }),
  },
  viewer: {
    label: "Membre",
    description: "Consulte tout, sans rien pouvoir modifier.",
    editable: true,
    levels: READ_ONLY,
  },
  accountant: {
    label: "Comptable",
    description:
      "Consulte les ventes, encaisse les factures, importe des documents, gère les transactions et les documents partagés. Siège gratuit, nombre limité selon l'offre.",
    editable: true,
    // Droits d'avant les rôles personnalisés, à l'identique (ancienne matrice
    // de rbac.js + ce que permettaient les resolvers sans contrôle de rôle) :
    // banque, rapprochement, calendrier, documents partagés et listes de
    // clients étaient ouverts à tout membre. Kanban et signatures lui étaient
    // fermés à l'écran. Transferts : création depuis les documents partagés.
    levels: fill("read", {
      invoicePayments: "write",
      importedInvoices: "write",
      importedQuotes: "write",
      importedPurchaseOrders: "write",
      clientLists: "delete",
      banking: "delete",
      calendar: "delete",
      kanban: "none",
      fileTransfers: "write",
      sharedDocuments: "delete",
      signatures: "none",
      team: "read",
      billing: "read",
      orgSettings: "read",
      integrations: "read",
    }),
  },
};

export const PREDEFINED_ROLE_KEYS = Object.keys(PREDEFINED_ROLES);

/** Rôle proposé par défaut à l'invitation. */
export const DEFAULT_INVITE_ROLE = "viewer";

export const CUSTOM_ROLE_PREFIX = "role_";

export function isCustomRoleKey(role) {
  return typeof role === "string" && role.startsWith(CUSTOM_ROLE_PREFIX);
}

export function resolveModule(resource) {
  if (!resource) return null;
  return RESOURCE_ALIASES[resource] || resource;
}

/**
 * Normalise une grille reçue (création/modification de rôle) : modules
 * inconnus ignorés, niveaux invalides ramenés à `none`, modules absents
 * complétés par `base` (ou `none`).
 */
export function normalizeLevels(input = {}, base = null) {
  const levels = {};
  for (const key of MODULE_KEYS) {
    const raw = input?.[key] ?? base?.[key] ?? "none";
    levels[key] = clampLevel(key, raw);
  }
  return levels;
}

/**
 * Grille effective d'un rôle (ou de plusieurs, séparés par des virgules
 * comme le permet Better Auth : on garde le niveau le plus haut).
 *
 * @param {string} role - clé du rôle (owner, admin, role_xxx…)
 * @param {Map<string, object>|object} storedRoles - documents
 *   `organizationRole` de l'espace, indexés par clé de rôle
 */
export function getEffectiveLevels(role, storedRoles = {}) {
  const get = (key) =>
    storedRoles instanceof Map ? storedRoles.get(key) : storedRoles[key];

  const keys = String(role || "")
    .toLowerCase()
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const result = fill("none");
  for (const key of keys) {
    let levels;
    if (key === "owner") {
      levels = PREDEFINED_ROLES.owner.levels;
    } else if (PREDEFINED_ROLES[key]) {
      const stored = get(key);
      levels = stored?.levels
        ? normalizeLevels(stored.levels, PREDEFINED_ROLES[key].levels)
        : PREDEFINED_ROLES[key].levels;
    } else {
      const stored = get(key);
      levels = stored?.levels ? normalizeLevels(stored.levels) : null;
    }
    if (!levels) continue;
    for (const moduleKey of MODULE_KEYS) {
      if (LEVEL_RANK[levels[moduleKey]] > LEVEL_RANK[result[moduleKey]]) {
        result[moduleKey] = levels[moduleKey];
      }
    }
  }
  return result;
}

export function levelAllows(granted, required) {
  return (LEVEL_RANK[granted] ?? 0) >= (LEVEL_RANK[required] ?? 99);
}

/** Niveau requis pour une action sur un module. */
export function requiredLevelForAction(moduleKey, action) {
  const level = ACTION_LEVEL[action] || "write";
  return clampLevel(moduleKey, level);
}

/**
 * Vérifie une action précise (`view`, `create`, `delete`, `mark-paid`…)
 * sur une ressource à partir d'une grille effective.
 */
export function levelsAllowAction(levels, resource, action) {
  const featureModule = ACTION_MODULES[resource]?.[action];
  if (featureModule) {
    return levelAllows(levels?.[featureModule], "write");
  }
  const moduleKey = resolveModule(resource);
  if (!moduleKey || !levels || !(moduleKey in levels)) return false;
  return levelAllows(
    levels[moduleKey],
    requiredLevelForAction(moduleKey, action),
  );
}

/**
 * Vérifie un niveau (`read`, `write`, `delete`, `admin`) sur une ressource.
 * `admin` = gestion (anciennement manage/approve/invite…) → write.
 */
export function levelsAllowLevel(levels, resource, level) {
  const moduleKey = resolveModule(resource);
  if (!moduleKey || !levels || !(moduleKey in levels)) return false;
  const required = level === "admin" ? "write" : level;
  if (!LEVEL_RANK[required]) return false;
  return levelAllows(levels[moduleKey], clampLevel(moduleKey, required));
}

/**
 * Permissions au format Better Auth (`organizationRole.permission`, JSON) :
 * seules les déclarations du plugin organisation comptent pour lui. Un rôle
 * qui peut gérer les membres doit pouvoir inviter, retirer et changer les
 * rôles via les routes Better Auth, et un rôle qui gère les informations de
 * l'entreprise doit pouvoir mettre à jour l'organisation (le front revérifie
 * `team` et `orgSettings` dans ses hooks).
 */
export function toBetterAuthPermission(levels) {
  const permission = {};
  if (levelAllows(levels?.team, "write")) {
    permission.member = ["create", "update", "delete"];
    permission.invitation = ["create", "cancel"];
  }
  if (levelAllows(levels?.orgSettings, "write")) {
    permission.organization = ["update"];
  }
  return permission;
}
