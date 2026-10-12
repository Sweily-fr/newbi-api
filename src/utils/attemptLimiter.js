import { getCacheClient } from "../config/redis.js";

/**
 * Compteur d'essais sur une fenêtre fixe (mots de passe saisis par des
 * visiteurs anonymes). Partagé entre les instances PM2 via Redis ; repli en
 * mémoire, propre à l'instance, si Redis est indisponible.
 */
const PREFIX = "attempts:";
const MEMORY_MAX_ENTRIES = 10000;
const memory = new Map();

function purgeMemory(now) {
  for (const [key, entry] of memory) {
    if (entry.resetAt <= now) memory.delete(key);
  }
}

/** Nombre d'essais enregistrés pour cette clé dans la fenêtre en cours. */
export async function getAttemptCount(key) {
  const client = getCacheClient();
  if (client) {
    try {
      return Number(await client.get(PREFIX + key)) || 0;
    } catch {
      // Redis indisponible : repli en mémoire
    }
  }
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    memory.delete(key);
    return 0;
  }
  return entry.count;
}

/**
 * Enregistre un essai ; la fenêtre démarre au premier essai.
 * @returns {Promise<number>} nombre d'essais dans la fenêtre
 */
export async function recordAttempt(key, windowSeconds) {
  const client = getCacheClient();
  if (client) {
    try {
      const count = await client.incr(PREFIX + key);
      if (count === 1) await client.expire(PREFIX + key, windowSeconds);
      return count;
    } catch {
      // Redis indisponible : repli en mémoire
    }
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    if (memory.size >= MEMORY_MAX_ENTRIES) purgeMemory(now);
    memory.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/** Tests uniquement : remet les compteurs en mémoire à zéro. */
export function resetMemoryAttempts() {
  memory.clear();
}
