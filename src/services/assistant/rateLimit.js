/**
 * Rate limit DOUBLE par workspaceId :
 *   - 30 requêtes par HEURE glissante (protection burst)
 *   - 100 requêtes par JOUR glissant (protection coût LLM journalier)
 *
 * Les deux plafonds s'appliquent. Un workspace qui burst 30 fois sur 30
 * minutes est OK, MAIS s'il enchaîne ensuite 1 req toutes les 15 min pendant
 * 12h (donc 48 req/jour), il sera bloqué dès le plafond journalier atteint.
 *
 * Implémentation : Map en mémoire process, fenêtres glissantes via
 * filtration de timestamps. Suffisant pour la beta (1 process Express).
 *
 * Dette V1.1 : passer en Redis pour multi-process + persistance. Le SDK
 * `ioredis` est déjà dans le projet (utilisé par PubSub).
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RATE_LIMITS = {
  perHour: 30,
  perDay: 100,
};

/**
 * Map<workspaceId, { ts: number[] }> — timestamps Unix ms.
 * On ne stocke qu'une seule liste de timestamps et on filtre selon la
 * fenêtre. Plus simple que deux listes, et le coût (≤ 100 entrées par
 * workspace au max) est négligeable.
 */
const _buckets = new Map();

/**
 * Vérifie ET réserve un slot pour `workspaceId`. Atomique côté process :
 * si `allowed === true`, le slot est consommé immédiatement.
 *
 * @param {string} workspaceId
 * @param {number} [now] — pour tests (défaut Date.now()).
 * @returns {{
 *   allowed: boolean,
 *   scope?: "hour"|"day",
 *   limit?: number,
 *   used?: number,
 *   retryAfterSec?: number,
 * }}
 */
export function checkAndConsume(workspaceId, now = Date.now()) {
  const key = String(workspaceId);
  let entry = _buckets.get(key);
  if (!entry) {
    entry = { ts: [] };
    _buckets.set(key, entry);
  }

  // Purge tout ce qui est plus vieux que la fenêtre journalière (= la plus
  // grande). Les timestamps restants servent aussi au comptage horaire.
  entry.ts = entry.ts.filter((t) => now - t < DAY_MS);

  const hourCount = entry.ts.filter((t) => now - t < HOUR_MS).length;
  const dayCount = entry.ts.length;

  if (hourCount >= RATE_LIMITS.perHour) {
    // Reset = quand le plus ancien hit dans la fenêtre horaire sort.
    const oldestInHour = entry.ts.filter((t) => now - t < HOUR_MS)[0];
    return {
      allowed: false,
      scope: "hour",
      limit: RATE_LIMITS.perHour,
      used: hourCount,
      retryAfterSec: Math.ceil((HOUR_MS - (now - oldestInHour)) / 1000),
    };
  }

  if (dayCount >= RATE_LIMITS.perDay) {
    const oldest = entry.ts[0];
    return {
      allowed: false,
      scope: "day",
      limit: RATE_LIMITS.perDay,
      used: dayCount,
      retryAfterSec: Math.ceil((DAY_MS - (now - oldest)) / 1000),
    };
  }

  entry.ts.push(now);
  return { allowed: true };
}

/** Reset complet — utile pour tests. */
export function _resetAll() {
  _buckets.clear();
}

/** Snapshot état (debug / tests). */
export function _snapshot(workspaceId) {
  const e = _buckets.get(String(workspaceId));
  return e ? { count: e.ts.length } : { count: 0 };
}
