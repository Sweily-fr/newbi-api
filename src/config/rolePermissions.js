/**
 * ========================================
 * CATALOGUE DES DROITS PAR RÔLE
 * ========================================
 *
 * Source unique des droits d'un membre dans un espace. Le front lit ce
 * catalogue via GraphQL (`roleCatalog`, `organizationRoles`, `myPermissions`),
 * il n'en garde pas de copie.
 *
 * Modèle : pour chaque page du menu (module), la liste des actions permises
 * (voir, créer, modifier, supprimer, envoyer, exporter…), chacune cochée
 * indépendamment dans l'éditeur de rôles. Une page sans « Voir »
 * n'apparaît pas du tout ; cocher une autre action ajoute « Voir ».
 *
 * Les contrôles par niveau encore utilisés (`requireRead/Write/Delete`)
 * sont dérivés des actions : lire = « view », écrire = action d'écriture du
 * module (« edit » par défaut), supprimer = « delete ».
 *
 * Rôles prédéfinis (clés techniques inchangées pour ne migrer aucun membre) :
 *   owner      → « Super admin »     : tout, non modifiable, unique
 *   admin      → « Administrateur »  : tout sauf membres et abonnement
 *   member     → « Éditeur »         : crée et modifie, ne supprime pas
 *   viewer     → « Membre »          : lecture seule
 *   accountant → « Comptable »       : droits d'avant les rôles
 *                                       personnalisés, siège gratuit
 * Leurs droits par défaut sont décrits par niveaux (none < read < write <
 * delete), convertis en actions : chaque action porte le niveau qui
 * l'accordait. Les rôles enregistrés avant les actions (champ `levels`)
 * sont convertis de la même façon.
 * Le super admin peut ajuster les droits des rôles prédéfinis (sauf le sien)
 * et créer des rôles personnalisés (collection `organizationRole`, partagée
 * avec le plugin organisation de Better Auth côté front).
 */

export const LEVELS = ["none", "read", "write", "delete"];

const LEVEL_RANK = { none: 0, read: 1, write: 2, delete: 3 };

const action = (key, label, level = "write", extra = {}) => ({
  key,
  label,
  level,
  ...extra,
});

// Actions communes : clé, libellé, niveau qui l'accordait avant les actions
const VIEW = action("view", "Voir", "read");
const EXPORT = action("export", "Exporter", "read");
const CREATE = action("create", "Créer");
const EDIT = action("edit", "Modifier");
const DELETE = action("delete", "Supprimer", "delete");
const SEND = action("send", "Envoyer par e-mail");
const IMPORT = action("import", "Importer");
const CRUD = [VIEW, CREATE, EDIT, DELETE];

// Sections du menu de l'application, dans le même ordre
export const MODULE_GROUPS = [
  { key: "pilotage", label: "Pilotage" },
  { key: "sales", label: "Ventes" },
  { key: "clients", label: "Clients" },
  { key: "purchases", label: "Achats" },
  { key: "organisation", label: "Organisation" },
  { key: "documents", label: "Documents" },
  { key: "communication", label: "Communication" },
  { key: "account", label: "Compte" },
];

/**
 * Une entrée par page du menu ; `parent` = partie d'une page, affichée
 * dans son menu déroulant. `writeAction` : action qui vaut « écrire » pour
 * les contrôles par niveau (« edit » par défaut).
 */
export const MODULES = [
  // Pilotage
  {
    key: "banking",
    group: "pilotage",
    label: "Transactions",
    actions: [
      VIEW,
      EXPORT,
      action("edit", "Modifier (catégorie, description)"),
      action("receipts", "Ajouter et retirer des justificatifs"),
      action("reconcile", "Rapprocher avec des factures"),
      action("sync", "Synchroniser les comptes bancaires"),
    ],
  },
  {
    key: "overview",
    group: "pilotage",
    label: "Vue d'ensemble",
    actions: [VIEW],
  },
  {
    key: "forecast",
    group: "pilotage",
    label: "Prévision",
    actions: [
      VIEW,
      action("create", "Ajouter des prévisions et des scénarios"),
      action("edit", "Modifier les prévisions et les récurrences"),
      DELETE,
    ],
  },
  {
    key: "analytics",
    group: "pilotage",
    label: "Analytiques",
    actions: [VIEW],
  },
  // Ventes
  {
    key: "invoices",
    group: "sales",
    label: "Factures clients",
    actions: [
      VIEW,
      CREATE,
      EDIT,
      DELETE,
      SEND,
      EXPORT,
      action("markPaid", "Marquer comme payée", "write", {
        // Fonctionnalité séparée avant les actions (module invoicePayments)
        legacyModule: "invoicePayments",
      }),
      action("status", "Annuler une facture"),
      action("recurring", "Programmer des factures récurrentes"),
      action("reminders", "Régler les relances automatiques"),
    ],
  },
  {
    key: "creditNotes",
    group: "sales",
    parent: "invoices",
    label: "Avoirs",
    actions: [VIEW, CREATE, EDIT, DELETE, SEND],
  },
  {
    key: "importedInvoices",
    group: "sales",
    parent: "invoices",
    label: "Factures importées",
    actions: [VIEW, IMPORT, EDIT, DELETE],
  },
  {
    key: "quotes",
    group: "sales",
    label: "Devis",
    actions: [
      VIEW,
      CREATE,
      EDIT,
      DELETE,
      SEND,
      EXPORT,
      action("status", "Accepter, refuser ou annuler"),
      action("convert", "Transformer en facture ou bon de commande"),
      action("sign", "Faire signer électroniquement"),
    ],
  },
  {
    key: "importedQuotes",
    group: "sales",
    parent: "quotes",
    label: "Devis importés",
    actions: [VIEW, IMPORT, EDIT, DELETE],
  },
  {
    key: "purchaseOrders",
    group: "sales",
    label: "Bons de commande",
    actions: [
      VIEW,
      CREATE,
      EDIT,
      DELETE,
      SEND,
      EXPORT,
      action("status", "Changer le statut"),
      action("convert", "Transformer en facture"),
    ],
  },
  {
    key: "importedPurchaseOrders",
    group: "sales",
    parent: "purchaseOrders",
    label: "Bons de commande importés",
    actions: [VIEW, IMPORT, EDIT, DELETE],
  },
  {
    key: "deliveryNotes",
    group: "sales",
    label: "Bons de livraison",
    actions: [
      VIEW,
      CREATE,
      EDIT,
      DELETE,
      SEND,
      EXPORT,
      action("status", "Changer le statut et noter la réception"),
      action("convert", "Facturer"),
    ],
  },
  {
    key: "products",
    group: "sales",
    label: "Catalogue",
    actions: [
      VIEW,
      CREATE,
      EDIT,
      DELETE,
      IMPORT,
      EXPORT,
      action("customFields", "Gérer les champs personnalisés"),
    ],
  },
  // Clients
  {
    key: "clients",
    group: "clients",
    label: "Mes clients",
    actions: [
      VIEW,
      CREATE,
      EDIT,
      DELETE,
      IMPORT,
      EXPORT,
      action("block", "Bloquer et débloquer"),
      action("assign", "Assigner des membres"),
      action("notes", "Ajouter des notes"),
    ],
  },
  {
    key: "clientCustomFields",
    group: "clients",
    parent: "clients",
    label: "Champs personnalisés",
    actions: CRUD,
  },
  {
    key: "clientLists",
    group: "clients",
    label: "Listes",
    actions: [
      VIEW,
      CREATE,
      action("edit", "Modifier et ajouter ou retirer des contacts"),
      DELETE,
    ],
  },
  {
    key: "automations",
    group: "clients",
    parent: "clientLists",
    label: "Automatisations",
    actions: CRUD,
  },
  {
    key: "clientSegments",
    group: "clients",
    label: "Segments",
    actions: CRUD,
  },
  // Achats
  {
    key: "purchaseInvoices",
    group: "purchases",
    label: "Factures d'achat",
    actions: [
      VIEW,
      action("create", "Ajouter (saisie, import, justificatif)"),
      EDIT,
      DELETE,
      EXPORT,
      action("markPaid", "Marquer comme payée"),
      action("reconcile", "Rapprocher avec une transaction"),
    ],
  },
  // Organisation
  {
    key: "calendar",
    group: "organisation",
    label: "Calendrier",
    actions: CRUD,
  },
  {
    key: "kanban",
    group: "organisation",
    label: "Kanban",
    actions: [
      VIEW,
      action("create", "Créer des tableaux, colonnes et tâches"),
      action("edit", "Modifier et déplacer"),
      DELETE,
      action("comment", "Commenter"),
      action("share", "Partager un tableau par lien public"),
    ],
  },
  // Documents
  {
    key: "fileTransfers",
    group: "documents",
    label: "Transfert de fichiers",
    actions: [VIEW, CREATE, action("edit", "Renommer"), DELETE],
  },
  {
    key: "sharedDocuments",
    group: "documents",
    label: "Documents partagés",
    actions: [
      VIEW,
      action("create", "Ajouter des documents et des dossiers"),
      action("edit", "Renommer, déplacer, classer"),
      DELETE,
    ],
  },
  // Communication
  {
    key: "signatures",
    group: "communication",
    label: "Signature de mail",
    actions: CRUD,
  },
  // Compte
  {
    key: "team",
    group: "account",
    label: "Membres",
    writeAction: "invite",
    actions: [
      action("view", "Voir les membres", "read"),
      action("invite", "Inviter des membres"),
      action("changeRole", "Changer les rôles"),
      action("remove", "Retirer des membres"),
    ],
  },
  {
    key: "billing",
    group: "account",
    label: "Abonnement Newbi",
    writeAction: "manage",
    actions: [
      action("view", "Voir l'abonnement", "read"),
      action("manage", "Gérer l'abonnement et les moyens de paiement"),
    ],
  },
  {
    key: "orgSettings",
    group: "account",
    label: "Informations de l'entreprise",
    actions: [
      action("view", "Voir les informations", "read"),
      action(
        "edit",
        "Modifier (infos, coordonnées bancaires, paramètres des documents)",
      ),
    ],
  },
  {
    key: "integrations",
    group: "account",
    label: "Applications et banques",
    writeAction: "manage",
    actions: [
      action("view", "Voir les applications", "read"),
      action("manage", "Connecter et configurer (banques, Qonto, Stripe…)"),
    ],
  },
];

export const MODULE_KEYS = MODULES.map((m) => m.key);

const MODULES_BY_KEY = new Map(MODULES.map((m) => [m.key, m]));

const ACCOUNT_MODULES = new Set(
  MODULES.filter((m) => m.group === "account").map((m) => m.key),
);

export function moduleActions(moduleKey) {
  return MODULES_BY_KEY.get(moduleKey)?.actions.map((a) => a.key) || [];
}

function writeActionOf(moduleKey) {
  return MODULES_BY_KEY.get(moduleKey)?.writeAction || "edit";
}

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
 * Ancienne fonctionnalité devenue action d'une page : `requireWrite(
 * "invoicePayments")` ou `can("invoicePayments", "write")` = marquer payé.
 */
const LEGACY_FEATURES = {
  invoicePayments: { module: "invoices", action: "markPaid" },
};

/** Anciens noms d'actions (`requirePermission`) → action du catalogue. */
const ACTION_ALIASES = {
  read: "view",
  download: "view",
  "mark-paid": "markPaid",
  "set-default": "edit",
  approve: "edit",
  ocr: "create",
  remove: "delete",
};

/** Niveaux permis pour un module (ancienne grille, rôles prédéfinis). */
function clampLevel(moduleKey, level) {
  if (!LEVEL_RANK[level] && level !== "none") return "none";
  if (ACCOUNT_MODULES.has(moduleKey) && level === "delete") return "write";
  return level;
}

function fill(level, overrides = {}) {
  const levels = {};
  for (const key of [...MODULE_KEYS, "invoicePayments"]) {
    levels[key] = clampLevel(key, overrides[key] ?? level);
  }
  return levels;
}

export function levelAllows(granted, required) {
  return (LEVEL_RANK[granted] ?? 0) >= (LEVEL_RANK[required] ?? 99);
}

/**
 * Pages séparées d'un module plus large dans une version précédente de la
 * grille : une grille enregistrée avant la séparation reprend le niveau de
 * l'ancien module.
 */
const LEGACY_LEVEL_KEYS = {
  overview: "analytics",
  forecast: "analytics",
  clientCustomFields: "clientLists",
  clientSegments: "clients",
};

/**
 * Grille par niveaux (rôles prédéfinis, rôles enregistrés avant les
 * actions) → grille d'actions : chaque action est accordée si le niveau de
 * son module (ou de son ancien module) atteint le niveau de l'action.
 * `base` complète les modules absents.
 */
export function actionsFromLevels(levels = {}, base = null) {
  const grid = {};
  for (const module of MODULES) {
    const legacyKey = LEGACY_LEVEL_KEYS[module.key];
    const moduleLevel =
      levels?.[module.key] ??
      (legacyKey ? levels?.[legacyKey] : undefined) ??
      base?.[module.key] ??
      "none";
    grid[module.key] = module.actions
      .filter((a) => {
        const source = a.legacyModule
          ? (levels?.[a.legacyModule] ?? base?.[a.legacyModule] ?? "none")
          : moduleLevel;
        return levelAllows(
          clampLevel(module.key, source),
          clampLevel(module.key, a.level),
        );
      })
      .map((a) => a.key);
  }
  return grid;
}

/**
 * Normalise une grille d'actions reçue (création/modification de rôle) :
 * actions inconnues ignorées, « Voir » ajouté dès qu'une autre action est
 * cochée, parties d'une page vidées si la page n'est pas visible. Modules
 * absents : repris de `base` (ou aucune action).
 */
export function normalizeActions(input = {}, base = null) {
  const grid = {};
  for (const module of MODULES) {
    const raw = Array.isArray(input?.[module.key])
      ? input[module.key]
      : base?.[module.key] || [];
    const kept = module.actions
      .map((a) => a.key)
      .filter((key) => raw.includes(key));
    if (kept.length && !kept.includes("view")) kept.unshift("view");
    grid[module.key] = kept;
  }
  for (const module of MODULES) {
    if (module.parent && !grid[module.parent]?.includes("view")) {
      grid[module.key] = [];
    }
  }
  return grid;
}

const READ_ONLY = fill("read", {
  team: "read",
  billing: "none",
  orgSettings: "read",
  integrations: "none",
  invoicePayments: "none",
});

const PREDEFINED_LEVELS = {
  owner: fill("delete"),
  admin: fill("delete", { team: "read", billing: "read" }),
  member: fill("write", {
    // Signatures de mail : documents personnels, chacun supprime les
    // siennes (les suppressions sont filtrées sur l'auteur)
    signatures: "delete",
    team: "read",
    billing: "none",
    orgSettings: "read",
    integrations: "none",
  }),
  viewer: READ_ONLY,
  // Droits d'avant les rôles personnalisés, à l'identique (ancienne matrice
  // de rbac.js + ce que permettaient les resolvers sans contrôle de rôle) :
  // banque, rapprochement, calendrier, documents partagés et listes de
  // clients étaient ouverts à tout membre. Kanban et signatures lui étaient
  // fermés à l'écran. Transferts : création depuis les documents partagés.
  accountant: fill("read", {
    invoicePayments: "write",
    importedInvoices: "write",
    importedQuotes: "write",
    importedPurchaseOrders: "write",
    clientLists: "delete",
    clientCustomFields: "delete",
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
};

const predefined = (key, label, description, editable = true) => ({
  label,
  description,
  editable,
  levels: PREDEFINED_LEVELS[key],
  actions: actionsFromLevels(PREDEFINED_LEVELS[key]),
});

export const PREDEFINED_ROLES = {
  owner: predefined(
    "owner",
    "Super admin",
    "Tous les droits, y compris les membres, les rôles et l'abonnement. Un seul par espace.",
    false,
  ),
  admin: predefined(
    "admin",
    "Administrateur",
    "Crée, modifie et supprime partout. Ne gère ni les membres ni l'abonnement.",
  ),
  member: predefined(
    "member",
    "Éditeur",
    "Crée et modifie les documents, sans pouvoir supprimer ni toucher au compte.",
  ),
  viewer: predefined(
    "viewer",
    "Membre",
    "Consulte tout, sans rien pouvoir modifier.",
  ),
  accountant: predefined(
    "accountant",
    "Comptable",
    "Consulte les ventes, encaisse les factures, importe des documents, gère les transactions et les documents partagés. Siège gratuit, nombre limité selon l'offre.",
  ),
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
 * Grille d'actions d'un document `organizationRole` : champ `actions`, ou
 * ancien champ `levels` converti. Rôle prédéfini ajusté : `defaults` (ses
 * droits par défaut) complète les modules absents.
 */
export function storedRoleActions(stored, defaults = null) {
  if (!stored) return null;
  if (stored.actions) {
    return normalizeActions(stored.actions, defaults?.actions);
  }
  if (stored.levels) {
    return normalizeActions(
      actionsFromLevels(stored.levels, defaults?.levels),
      defaults?.actions,
    );
  }
  return null;
}

/**
 * Grille effective d'un rôle (ou de plusieurs, séparés par des virgules
 * comme le permet Better Auth : union des actions).
 *
 * @param {string} role - clé du rôle (owner, admin, role_xxx…)
 * @param {Map<string, object>|object} storedRoles - documents
 *   `organizationRole` de l'espace, indexés par clé de rôle
 * @returns {Record<string, string[]>} module → actions permises
 */
export function getEffectivePermissions(role, storedRoles = {}) {
  const get = (key) =>
    storedRoles instanceof Map ? storedRoles.get(key) : storedRoles[key];

  const keys = String(role || "")
    .toLowerCase()
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  const result = Object.fromEntries(MODULE_KEYS.map((k) => [k, []]));
  for (const key of keys) {
    let grid;
    if (key === "owner") {
      grid = PREDEFINED_ROLES.owner.actions;
    } else if (PREDEFINED_ROLES[key]) {
      grid =
        storedRoleActions(get(key), PREDEFINED_ROLES[key]) ||
        PREDEFINED_ROLES[key].actions;
    } else {
      grid = storedRoleActions(get(key));
    }
    if (!grid) continue;
    for (const moduleKey of MODULE_KEYS) {
      const merged = new Set([
        ...result[moduleKey],
        ...(grid[moduleKey] || []),
      ]);
      result[moduleKey] = moduleActions(moduleKey).filter((a) => merged.has(a));
    }
  }
  return result;
}

/** Ancien nom : la « grille » d'un rôle est désormais sa grille d'actions. */
export const getEffectiveLevels = getEffectivePermissions;

/** Niveau équivalent d'un module (affichage, anciens contrôles du front). */
export function levelOf(grid, moduleKey) {
  const actions = grid?.[moduleKey] || [];
  if (!actions.includes("view")) return "none";
  const canWrite = actions.includes(writeActionOf(moduleKey));
  if (canWrite && actions.includes("delete")) return "delete";
  return canWrite ? "write" : "read";
}

export function levelsFromActions(grid) {
  return Object.fromEntries(MODULE_KEYS.map((k) => [k, levelOf(grid, k)]));
}

/** La grille permet-elle cette action (`view`, `create`, `markPaid`…) ? */
export function levelsAllowAction(grid, resource, actionKey) {
  const legacy = LEGACY_FEATURES[resource];
  const moduleKey = legacy ? legacy.module : resolveModule(resource);
  if (!moduleKey || !grid || !Array.isArray(grid[moduleKey])) return false;
  const wanted = legacy
    ? legacy.action
    : actionKey === "manage" || actionKey === "admin"
      ? writeActionOf(moduleKey)
      : ACTION_ALIASES[actionKey] || actionKey;
  return grid[moduleKey].includes(wanted);
}

/**
 * Contrôle par niveau (`read`, `write`, `delete`, `admin`) dérivé des
 * actions : lire = « view », écrire et `admin` = action d'écriture du
 * module (« edit » par défaut), supprimer = « delete ».
 */
export function levelsAllowLevel(grid, resource, level) {
  const legacy = LEGACY_FEATURES[resource];
  if (legacy) {
    const actions = grid?.[legacy.module] || [];
    return level === "read"
      ? actions.includes("view")
      : actions.includes(legacy.action);
  }
  const moduleKey = resolveModule(resource);
  if (!moduleKey || !grid || !Array.isArray(grid[moduleKey])) return false;
  const actions = grid[moduleKey];
  if (level === "read") return actions.includes("view");
  if (level === "write" || level === "admin") {
    return actions.includes(writeActionOf(moduleKey));
  }
  if (level === "delete") return actions.includes("delete");
  return false;
}

/**
 * Permissions au format Better Auth (`organizationRole.permission`, JSON) :
 * seules les déclarations du plugin organisation comptent pour lui. Inviter,
 * changer un rôle et retirer un membre passent par ses routes, comme la
 * mise à jour de l'organisation (le front revérifie chaque action dans ses
 * hooks).
 */
export function toBetterAuthPermission(grid) {
  const permission = {};
  const team = grid?.team || [];
  const member = [];
  if (team.includes("invite")) member.push("create");
  if (team.includes("changeRole")) member.push("update");
  if (team.includes("remove")) member.push("delete");
  if (member.length) permission.member = member;
  if (team.includes("invite")) permission.invitation = ["create", "cancel"];
  if (grid?.orgSettings?.includes("edit")) {
    permission.organization = ["update"];
  }
  return permission;
}

/** Catalogue servi au front (éditeur de rôles). */
export function catalogModules() {
  return MODULES.map((m) => ({
    key: m.key,
    group: m.group,
    parent: m.parent || null,
    label: m.label,
    description: m.description || null,
    actions: m.actions.map((a) => ({
      key: a.key,
      label: a.label,
      description: a.description || null,
    })),
  }));
}
