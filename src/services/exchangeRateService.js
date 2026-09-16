import logger from "../utils/logger.js";

/**
 * Taux de change BCE via Frankfurter (api.frankfurter.app) : gratuit, sans
 * clé, taux de référence quotidiens. Sert à ramener en devise de la facture
 * les montants lus sur un justificatif libellé dans une autre devise quand
 * aucun débit bancaire ne fait foi.
 *
 * Cache mémoire par (date, from, to) : les taux d'une date passée ne
 * changent plus, ceux du jour sont gardés 1 h.
 */

const BASE_URL =
  process.env.EXCHANGE_RATE_API_URL || "https://api.frankfurter.app";
const TIMEOUT_MS = 5000;
const TODAY_TTL_MS = 60 * 60 * 1000;

const cache = new Map();

function toDateKey(date) {
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  // Pas de taux futur : plafonné à aujourd'hui.
  const today = new Date().toISOString().slice(0, 10);
  const key = d.toISOString().slice(0, 10);
  return key > today ? today : key;
}

/**
 * @returns {Promise<{ rate: number, date: string, from: string, to: string } | null>}
 *   null si devises identiques, inconnues ou service indisponible.
 */
async function getRate(from, to, date) {
  if (!from || !to || from === to) return null;
  const dateKey = toDateKey(date);
  const cacheKey = `${dateKey}:${from}:${to}`;
  const cached = cache.get(cacheKey);
  if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
    return cached.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${BASE_URL}/${dateKey}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    const rate = data?.rates?.[to];
    if (typeof rate !== "number" || !(rate > 0)) {
      throw new Error("taux absent de la réponse");
    }
    // Frankfurter renvoie la date effective (dernier jour ouvré ≤ demandé).
    const value = { rate, date: data.date || dateKey, from, to };
    const isToday = dateKey === new Date().toISOString().slice(0, 10);
    cache.set(cacheKey, {
      value,
      expiresAt: isToday ? Date.now() + TODAY_TTL_MS : null,
    });
    return value;
  } catch (error) {
    logger.warn(
      `⚠️ [FX] Taux ${from}→${to} au ${dateKey} indisponible: ${error.message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default { getRate };
