import axios from "axios";
import logger from "../../utils/logger.js";

/**
 * Compteur gratuit : nombre d'entreprises actives au registre public (API
 * Recherche d'entreprises) pour une activité NAF et une zone, avant toute
 * dépense chez Societeinfo. Sert à ne pas demander 50 prospects là où il
 * n'existe que 4 entreprises.
 *
 * C'est un ordre de grandeur : le registre ne connaît ni les téléphones ni
 * les emails (le nombre joignable est plus bas), ni les oppositions à la
 * prospection, et ne filtre pas par date de création.
 */
const http = axios.create({
  baseURL: "https://recherche-entreprises.api.gouv.fr",
  timeout: 10000,
  headers: {
    Accept: "application/json",
    "User-Agent": "Newbi-Business-App/1.0",
  },
});

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();
// Le registre plafonne ses totaux
export const REGISTRY_MAX_TOTAL = 10000;

// Tranches d'effectif Insee (code, effectif min, effectif max)
const STAFF_TRANCHES = [
  ["NN", 0, 0],
  ["00", 0, 0],
  ["01", 1, 2],
  ["02", 3, 5],
  ["03", 6, 9],
  ["11", 10, 19],
  ["12", 20, 49],
  ["21", 50, 99],
  ["22", 100, 199],
  ["31", 200, 249],
  ["32", 250, 499],
  ["41", 500, 999],
  ["42", 1000, 1999],
  ["51", 2000, 4999],
  ["52", 5000, 9999],
  ["53", 10000, Infinity],
];

/** Tranches Insee qui recoupent [minStaff, maxStaff], null sans filtre. */
export function staffTranches(minStaff, maxStaff) {
  const min = Number.isFinite(minStaff) ? minStaff : null;
  const max = Number.isFinite(maxStaff) ? maxStaff : null;
  if (min === null && max === null) return null;
  return STAFF_TRANCHES.filter(
    ([, low, high]) =>
      (min === null || high >= min) && (max === null || low <= max),
  ).map(([code]) => code);
}

/** « 4334Z » → « 43.34Z » (format du registre) ; les niveaux larges sont ignorés. */
export function toRegistryNaf(code) {
  const match = /^(\d{2})(\d{2}[A-Z])$/.exec(String(code || ""));
  return match ? `${match[1]}.${match[2]}` : null;
}

export function resetCountCache() {
  cache.clear();
}

async function totalFor(params) {
  const key = JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const { data } = await http.get("/search", { params });
  const value = Number(data?.total_results) || 0;
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Entreprises actives correspondant aux codes NAF et aux zones (un appel par
 * type de zone, totaux additionnés). null si le registre ne répond pas.
 */
export async function countRegistryCompanies({
  nafCodes = [],
  zones = {},
  minStaff,
  maxStaff,
}) {
  const naf = nafCodes.map(toRegistryNaf).filter(Boolean);
  if (!naf.length) return null;
  const base = {
    activite_principale: naf.join(","),
    etat_administratif: "A",
    per_page: 1,
    minimal: true,
  };
  const tranches = staffTranches(minStaff, maxStaff);
  if (tranches) base.tranche_effectif_salarie = tranches.join(",");

  const groups = Object.entries(zones)
    .map(([field, values]) => [field, [...values].sort()])
    .filter(([, values]) => values.length);

  try {
    let total = 0;
    if (!groups.length) total = await totalFor(base);
    for (const [field, values] of groups) {
      total += await totalFor({ ...base, [field]: values.join(",") });
    }
    return { total, capped: total >= REGISTRY_MAX_TOTAL };
  } catch (error) {
    logger.warn(`[Prospects] Compteur du registre : ${error.message}`);
    return null;
  }
}
