/**
 * Référentiel unique des catégories.
 *
 * Les pages Transactions, Factures d'achat et Prévision proposent toutes la
 * même liste : les sous-catégories fines du sélecteur de la page Transactions
 * (ex. "parking", "comptabilite", "dividendes"). Chaque collection conserve en
 * plus sa catégorie large (enum fermée) pour les regroupements, filtres et
 * analytics :
 *   - Transaction        : category = sous-catégorie fine, expenseCategory = large
 *   - PurchaseInvoice    : subcategory = fine, category = enum PurchaseInvoiceCategory
 *   - ManualCashflowEntry: subcategory = fine, category = enum ForecastCategory
 *   - DetectedRecurrence : subcategoryOverride = fine, categoryOverride = enum ForecastCategory
 *
 * Toute conversion fine → large passe par ce fichier : la sous-catégorie est
 * d'abord rabattue sur la catégorie large des transactions (enum
 * ExpenseCategory), puis sur l'enum de la collection cible. Une prévision
 * « telephone » et les transactions « telephone » tombent ainsi dans la même
 * ligne du tableau de prévision.
 */

// Sous-catégorie fine → catégorie large des transactions (enum ExpenseCategory
// du modèle Transaction). Même liste que le sélecteur front
// (lib/category-icons-config.js côté NewbiV2).
export const SUBCATEGORY_TO_EXPENSE_CATEGORY = {
  // Fournitures et équipement
  bureau: "OFFICE_SUPPLIES",
  materiel: "HARDWARE",
  mobilier: "OFFICE_SUPPLIES",
  equipement: "HARDWARE",
  // Transport et déplacements
  transport: "TRAVEL",
  carburant: "TRAVEL",
  parking: "TRAVEL",
  peage: "TRAVEL",
  taxi: "TRAVEL",
  train: "TRAVEL",
  avion: "TRAVEL",
  location_vehicule: "TRAVEL",
  // Repas et hébergement
  repas: "MEALS",
  restaurant: "MEALS",
  hotel: "ACCOMMODATION",
  // Communication et marketing
  marketing: "MARKETING",
  publicite: "MARKETING",
  communication: "MARKETING",
  telephone: "UTILITIES",
  internet: "UTILITIES",
  site_web: "SOFTWARE",
  reseaux_sociaux: "MARKETING",
  // Formation et développement
  formation: "TRAINING",
  conference: "TRAINING",
  livres: "TRAINING",
  abonnement: "SUBSCRIPTIONS",
  // Services professionnels
  comptabilite: "SERVICES",
  juridique: "SERVICES",
  assurance: "INSURANCE",
  banque: "SERVICES",
  conseil: "SERVICES",
  sous_traitance: "SERVICES",
  // Locaux et charges
  loyer: "RENT",
  electricite: "UTILITIES",
  eau: "UTILITIES",
  chauffage: "UTILITIES",
  entretien: "MAINTENANCE",
  // Logiciels et outils
  logiciel: "SOFTWARE",
  saas: "SOFTWARE",
  licence: "SOFTWARE",
  // Ressources humaines
  salaire: "SALARIES",
  charges_sociales: "SALARIES",
  recrutement: "SERVICES",
  // Fiscalité
  impots_taxes: "TAXES",
  tva: "TAXES",
  avoirs_remboursement: "OTHER",
  // Autres
  cadeaux: "OTHER",
  representation: "OTHER",
  poste: "OFFICE_SUPPLIES",
  impression: "OFFICE_SUPPLIES",
  autre: "OTHER",
  // Revenus
  ventes: "SALES",
  services: "SERVICES",
  honoraires: "SERVICES",
  commissions: "SERVICES",
  consulting: "SERVICES",
  abonnements_revenus: "SUBSCRIPTIONS",
  licences_revenus: "SOFTWARE",
  royalties: "OTHER",
  loyers_revenus: "RENT",
  interets: "OTHER",
  dividendes: "OTHER",
  plus_values: "OTHER",
  subventions: "GRANTS",
  remboursements_revenus: "OTHER",
  indemnites: "OTHER",
  cadeaux_recus: "OTHER",
  autre_revenu: "OTHER",
};

export const INCOME_SUBCATEGORIES = [
  "ventes",
  "services",
  "honoraires",
  "commissions",
  "consulting",
  "abonnements_revenus",
  "licences_revenus",
  "royalties",
  "loyers_revenus",
  "interets",
  "dividendes",
  "plus_values",
  "subventions",
  "remboursements_revenus",
  "indemnites",
  "cadeaux_recus",
  "autre_revenu",
];

// Enum ExpenseCategory du modèle Transaction.
export const EXPENSE_CATEGORIES = [
  "OFFICE_SUPPLIES",
  "TRAVEL",
  "MEALS",
  "ACCOMMODATION",
  "SOFTWARE",
  "HARDWARE",
  "SERVICES",
  "MARKETING",
  "TAXES",
  "RENT",
  "UTILITIES",
  "SALARIES",
  "INSURANCE",
  "MAINTENANCE",
  "TRAINING",
  "SUBSCRIPTIONS",
  "SALES",
  "GRANTS",
  "OTHER",
];

// Enum PurchaseInvoiceCategory.
export const PURCHASE_INVOICE_CATEGORIES = [
  "RENT",
  "SUBSCRIPTIONS",
  "OFFICE_SUPPLIES",
  "SERVICES",
  "TRANSPORT",
  "MEALS",
  "TELECOMMUNICATIONS",
  "INSURANCE",
  "ENERGY",
  "SOFTWARE",
  "HARDWARE",
  "MARKETING",
  "TRAINING",
  "MAINTENANCE",
  "TAXES",
  "UTILITIES",
  "OTHER",
];

// Enum ForecastCategory.
export const FORECAST_INCOME_CATEGORIES = [
  "SALES",
  "REFUNDS_RECEIVED",
  "OTHER_INCOME",
];
export const FORECAST_EXPENSE_CATEGORIES = [
  "RENT",
  "SUBSCRIPTIONS",
  "OFFICE_SUPPLIES",
  "SERVICES",
  "TRANSPORT",
  "MEALS",
  "TELECOMMUNICATIONS",
  "INSURANCE",
  "ENERGY",
  "SOFTWARE",
  "HARDWARE",
  "MARKETING",
  "TRAINING",
  "MAINTENANCE",
  "TAXES",
  "UTILITIES",
  "SALARIES",
  "OTHER_EXPENSE",
];

// Codes de l'enum facture d'achat sans équivalent direct côté transaction.
const PURCHASE_INVOICE_ONLY_TO_EXPENSE = {
  TRANSPORT: "TRAVEL",
  TELECOMMUNICATIONS: "UTILITIES",
  ENERGY: "UTILITIES",
};

// Codes de l'enum prévision sans équivalent direct côté transaction.
const FORECAST_ONLY_TO_EXPENSE = {
  ...PURCHASE_INVOICE_ONLY_TO_EXPENSE,
  OTHER_EXPENSE: "OTHER",
  REFUNDS_RECEIVED: "OTHER",
  OTHER_INCOME: "OTHER",
};

// category (PurchaseInvoice) -> expenseCategory (Transaction). Les valeurs
// communes aux deux enums se mappent 1:1, les autres vers la plus proche.
export const PI_TO_EXPENSE_CATEGORY = Object.fromEntries(
  PURCHASE_INVOICE_CATEGORIES.map((c) => [
    c,
    PURCHASE_INVOICE_ONLY_TO_EXPENSE[c] || c,
  ]),
);

// expenseCategory (Transaction) -> category (PurchaseInvoice).
const EXPENSE_TO_PI_CATEGORY = {
  TRAVEL: "TRANSPORT",
  ACCOMMODATION: "TRANSPORT",
  SALARIES: "SERVICES",
  SALES: "OTHER",
  GRANTS: "OTHER",
};

// expenseCategory (Transaction) -> category (ForecastCategory, dépenses).
const EXPENSE_TO_FORECAST_CATEGORY = {
  TRAVEL: "TRANSPORT",
  ACCOMMODATION: "OTHER_EXPENSE",
  OTHER: "OTHER_EXPENSE",
  SALES: "OTHER_EXPENSE",
  GRANTS: "OTHER_EXPENSE",
};

// Sous-catégorie fine de revenu -> ForecastCategory (revenus).
const INCOME_SUBCATEGORY_TO_FORECAST_CATEGORY = {
  ventes: "SALES",
  services: "SALES",
  honoraires: "SALES",
  commissions: "SALES",
  consulting: "SALES",
  abonnements_revenus: "SALES",
  licences_revenus: "SALES",
  royalties: "SALES",
  loyers_revenus: "SALES",
  remboursements_revenus: "REFUNDS_RECEIVED",
  avoirs_remboursement: "REFUNDS_RECEIVED",
};

export const isSubcategory = (code) =>
  typeof code === "string" &&
  Object.prototype.hasOwnProperty.call(SUBCATEGORY_TO_EXPENSE_CATEGORY, code);

export const isIncomeSubcategory = (code) =>
  INCOME_SUBCATEGORIES.includes(code);

/**
 * Catégorie large des transactions (enum ExpenseCategory) pour un code
 * quelconque : sous-catégorie fine, code déjà large, ou code propre à l'enum
 * facture d'achat / prévision. Inconnu → OTHER.
 */
export function toExpenseCategory(code) {
  if (!code) return "OTHER";
  if (EXPENSE_CATEGORIES.includes(code)) return code;
  if (isSubcategory(code)) return SUBCATEGORY_TO_EXPENSE_CATEGORY[code];
  return FORECAST_ONLY_TO_EXPENSE[code] || "OTHER";
}

/**
 * Catégorie de l'enum PurchaseInvoiceCategory pour un code quelconque.
 */
export function toPurchaseInvoiceCategory(code) {
  if (!code) return "OTHER";
  if (PURCHASE_INVOICE_CATEGORIES.includes(code)) return code;
  const expense = toExpenseCategory(code);
  return EXPENSE_TO_PI_CATEGORY[expense] || expense;
}

/**
 * Catégorie de l'enum ForecastCategory pour un code quelconque, selon le
 * sens (INCOME / EXPENSE) de la prévision.
 */
export function toForecastCategory(code, type = "EXPENSE") {
  if (!code) return null;
  if (type === "INCOME") {
    if (FORECAST_INCOME_CATEGORIES.includes(code)) return code;
    return INCOME_SUBCATEGORY_TO_FORECAST_CATEGORY[code] || "OTHER_INCOME";
  }
  if (FORECAST_EXPENSE_CATEGORIES.includes(code)) return code;
  const expense = toExpenseCategory(code);
  return EXPENSE_TO_FORECAST_CATEGORY[expense] || expense;
}

/**
 * Résout la saisie utilisateur (sous-catégorie fine ou code large) vers le
 * couple { category (enum de la collection), subcategory (fine ou null) }.
 * `subcategory` prime sur `category` quand les deux sont fournis.
 */
export function resolveForecastCategoryInput({ subcategory, category, type }) {
  const code = subcategory || category || null;
  if (!code) return { category: null, subcategory: null };
  return {
    category: toForecastCategory(code, type),
    subcategory: isSubcategory(code) ? code : null,
  };
}

export function resolvePurchaseInvoiceCategoryInput({ subcategory, category }) {
  const code = subcategory || category || null;
  if (!code) return { category: "OTHER", subcategory: null };
  return {
    category: toPurchaseInvoiceCategory(code),
    subcategory: isSubcategory(code) ? code : null,
  };
}
