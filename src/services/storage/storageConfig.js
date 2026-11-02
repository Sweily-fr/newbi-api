/**
 * Réglages du stockage par espace : quota de chaque offre, packs de
 * stockage supplémentaires et prix servant à comparer « ajouter des packs »
 * et « passer à l'offre supérieure ».
 *
 * Tout se règle ici, en une ligne. Les prix des offres sont le miroir de
 * NewbiV2/src/lib/plans-display.js (TTC) : les deux doivent bouger ensemble.
 *
 * Unités : 1 Go = 1 000 000 000 octets, 1 To = 1 000 Go (unités décimales,
 * comme les offres les annoncent).
 */

export const BYTES_PER_GB = 1_000_000_000;

// Quota de chaque offre, en Go, pour tout l'espace (aucun lien avec le
// nombre d'utilisateurs)
export const PLAN_STORAGE_GB = {
  freelance: 75,
  pme: 400,
  entreprise: 1000,
};

// Pack de stockage supplémentaire
export const STORAGE_PACK_GB = 50;
export const STORAGE_PACK_PRICES = {
  month: 2.99, // TTC par mois
  year: 29.9, // TTC par an
};

// Prix TTC des offres (miroir de plans-display.js). `year` = prix mensuel
// de l'abonnement annuel.
export const PLAN_PRICES = {
  freelance: { month: 17.99, year: 16.19 },
  pme: { month: 48.99, year: 44.09 },
  entreprise: { month: 94.99, year: 85.49 },
};

export const PLAN_LABELS = {
  freelance: "Freelance",
  pme: "TPE",
  entreprise: "Entreprise",
};

// Ordre des offres pour la montée en gamme
export const PLAN_ORDER = ["freelance", "pme", "entreprise"];

// L'offre supérieure est mise en avant si elle coûte au plus 10 % de plus
// que l'offre actuelle complétée par des packs
export const UPGRADE_TOLERANCE = 0.1;

// Seuils d'alerte (part du quota utilisée)
export const STORAGE_WARNING_RATIO = 0.8;
export const STORAGE_FULL_RATIO = 1;

export const DEFAULT_PLAN = "freelance";

/**
 * Clé d'offre normalisée : « pro » et « pme » = TPE, « enterprise » et
 * « entreprise » = Entreprise. Inconnue ou absente : Freelance.
 */
export function normalizePlan(plan) {
  const value = String(plan || "")
    .trim()
    .toLowerCase();
  if (value === "pro" || value === "pme" || value === "tpe") return "pme";
  if (value === "entreprise" || value === "enterprise") return "entreprise";
  if (value === "freelance") return "freelance";
  return DEFAULT_PLAN;
}

export function normalizeInterval(interval) {
  return interval === "year" || interval === "annual" || interval === "yearly"
    ? "year"
    : "month";
}

export function gbToBytes(gb) {
  return Math.round(Number(gb || 0) * BYTES_PER_GB);
}

export function planBaseQuotaBytes(plan) {
  return gbToBytes(PLAN_STORAGE_GB[normalizePlan(plan)]);
}

export const STORAGE_PACK_BYTES = gbToBytes(STORAGE_PACK_GB);

/**
 * Quota de l'espace : quota de l'offre + packs. Jamais moins que le quota
 * de base de l'offre.
 */
export function computeStorageQuota({ plan, packs = 0 } = {}) {
  const normalizedPlan = normalizePlan(plan);
  const baseBytes = planBaseQuotaBytes(normalizedPlan);
  const packCount = Math.max(0, Math.floor(Number(packs) || 0));
  const packBytes = packCount * STORAGE_PACK_BYTES;
  return {
    plan: normalizedPlan,
    baseBytes,
    packs: packCount,
    packBytes,
    quotaBytes: Math.max(baseBytes, baseBytes + packBytes),
  };
}

export function nextPlan(plan) {
  const index = PLAN_ORDER.indexOf(normalizePlan(plan));
  return index >= 0 && index < PLAN_ORDER.length - 1
    ? PLAN_ORDER[index + 1]
    : null;
}

/** Prix mensuel TTC équivalent d'un pack selon l'intervalle. */
export function packMonthlyPrice(interval) {
  return normalizeInterval(interval) === "year"
    ? STORAGE_PACK_PRICES.year / 12
    : STORAGE_PACK_PRICES.month;
}

/** Prix TTC facturé pour un pack, à l'intervalle de l'abonnement. */
export function packBilledPrice(interval) {
  return normalizeInterval(interval) === "year"
    ? STORAGE_PACK_PRICES.year
    : STORAGE_PACK_PRICES.month;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Packs nécessaires pour contenir `neededBytes` avec l'offre `plan`. */
export function packsNeededFor(plan, neededBytes) {
  const missing = Math.max(0, Number(neededBytes || 0)) - planBaseQuotaBytes(plan);
  return missing > 0 ? Math.ceil(missing / STORAGE_PACK_BYTES) : 0;
}

/**
 * Propositions quand l'espace manque de place : acheter des packs, ou passer
 * à l'offre supérieure (avec ses propres packs s'il en faut).
 *
 * @param {object} p
 * @param {string} p.plan offre actuelle
 * @param {string} [p.interval] "month" | "year"
 * @param {number} p.usedBytes espace utilisé
 * @param {number} [p.currentPacks] packs déjà actifs
 * @param {number} [p.incomingBytes] taille de l'envoi refusé
 * @returns {{
 *   neededBytes: number,
 *   packs: { additionalPacks: number, totalPacks: number, monthlyCost: number,
 *            extraMonthlyCost: number, billedPrice: number, interval: string } | null,
 *   upgrade: { plan: string, label: string, packs: number, monthlyCost: number,
 *              planMonthlyPrice: number } | null,
 *   recommended: "packs" | "upgrade" | null,
 *   currentMonthlyCost: number,
 * }}
 */
export function recommendStorageOptions({
  plan,
  interval = "month",
  usedBytes = 0,
  currentPacks = 0,
  incomingBytes = 0,
} = {}) {
  const normalizedPlan = normalizePlan(plan);
  const normalizedInterval = normalizeInterval(interval);
  const neededBytes =
    Math.max(0, Number(usedBytes) || 0) + Math.max(0, Number(incomingBytes) || 0);
  const packPrice = packMonthlyPrice(normalizedInterval);
  const planPrice = (key) => PLAN_PRICES[key][normalizedInterval];
  const owned = Math.max(0, Math.floor(Number(currentPacks) || 0));

  const currentMonthlyCost = round2(planPrice(normalizedPlan) + owned * packPrice);

  // Packs sur l'offre actuelle : au moins un de plus que ceux déjà actifs
  const requiredPacks = packsNeededFor(normalizedPlan, neededBytes);
  const totalPacks = Math.max(requiredPacks, owned + 1);
  const additionalPacks = totalPacks - owned;
  const packsOption = {
    additionalPacks,
    totalPacks,
    monthlyCost: round2(planPrice(normalizedPlan) + totalPacks * packPrice),
    extraMonthlyCost: round2(additionalPacks * packPrice),
    billedPrice: packBilledPrice(normalizedInterval),
    interval: normalizedInterval,
    addedBytes: additionalPacks * STORAGE_PACK_BYTES,
  };

  const upper = nextPlan(normalizedPlan);
  let upgrade = null;
  if (upper) {
    const upperPacks = packsNeededFor(upper, neededBytes);
    upgrade = {
      plan: upper,
      label: PLAN_LABELS[upper],
      packs: upperPacks,
      planMonthlyPrice: planPrice(upper),
      monthlyCost: round2(planPrice(upper) + upperPacks * packPrice),
      quotaBytes: planBaseQuotaBytes(upper) + upperPacks * STORAGE_PACK_BYTES,
    };
  }

  let recommended = "packs";
  if (
    upgrade &&
    upgrade.monthlyCost <= packsOption.monthlyCost * (1 + UPGRADE_TOLERANCE)
  ) {
    recommended = "upgrade";
  }

  return {
    neededBytes,
    currentMonthlyCost,
    packs: packsOption,
    upgrade,
    recommended,
  };
}

/** « 1,5 Go », « 400 Go », « 1 To », « 12 Mo ». */
export function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  const fmt = (n) => {
    const rounded = n >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
    return String(rounded).replace(".", ",");
  };
  if (value >= 1000 * BYTES_PER_GB) return `${fmt(value / (1000 * BYTES_PER_GB))} To`;
  if (value >= BYTES_PER_GB) return `${fmt(value / BYTES_PER_GB)} Go`;
  if (value >= 1_000_000) return `${fmt(value / 1_000_000)} Mo`;
  if (value >= 1000) return `${fmt(value / 1000)} Ko`;
  return `${Math.round(value)} octets`;
}

export function formatPrice(amount) {
  return `${Number(amount || 0)
    .toFixed(2)
    .replace(".", ",")} €`;
}
