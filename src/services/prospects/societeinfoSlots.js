import crypto from "node:crypto";
import { getCacheClient } from "../../config/redis.js";
import logger from "../../utils/logger.js";

/**
 * Appels simultanés à Societeinfo : leur API n'en accepte que 3 à la fois
 * pour une même clé. L'API Newbi tourne en plusieurs instances PM2, donc la
 * limite se tient dans Redis : un jeton par appel en cours, rangé par heure
 * de prise. Un jeton qu'une instance n'a pas rendu (arrêt brutal) expire
 * seul après SLOT_TTL_MS.
 *
 * Sans Redis (ou s'il répond mal) : file locale d'un appel à la fois par
 * instance. Les refus « trop de requêtes » qui passeraient quand même sont
 * repris une fois par societeinfoClient.
 */
export const MAX_CONCURRENT_CALLS = 3;
export const SLOTS_KEY = "societeinfo:inflight";
const SLOT_TTL_MS = 30_000; // plus long que le délai d'un appel (15 s)
const WAIT_STEP_MS = 150;
const MAX_WAIT_MS = 20_000;

// Libère les jetons expirés, puis en prend un s'il reste une place.
// ARGV : maintenant (ms), durée de vie d'un jeton (ms), places, jeton.
const ACQUIRE_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call("ZCARD", KEYS[1]) < tonumber(ARGV[3]) then
  redis.call("ZADD", KEYS[1], ARGV[1], ARGV[4])
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return 1
end
return 0
`;

export class SlotTimeoutError extends Error {
  constructor() {
    super("Trop d'appels Societeinfo en cours");
    this.name = "SlotTimeoutError";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Une libération ne compte qu'une fois, même appelée deux fois
function once(release) {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await release();
  };
}

// File locale : un appel à la fois, les suivants attendent leur tour
let localBusy = false;
const localQueue = [];

function releaseLocal() {
  const next = localQueue.shift();
  if (next) next();
  else localBusy = false;
}

function acquireLocal() {
  if (!localBusy) {
    localBusy = true;
    return Promise.resolve(once(releaseLocal));
  }
  return new Promise((resolve) => {
    localQueue.push(() => resolve(once(releaseLocal)));
  });
}

/**
 * Attend une place parmi les appels autorisés et rend la fonction qui la
 * libère (à appeler dans un finally). Lève SlotTimeoutError si aucune place
 * ne se libère à temps.
 */
export async function acquireSocieteinfoSlot({
  client = getCacheClient(),
  max = MAX_CONCURRENT_CALLS,
  ttlMs = SLOT_TTL_MS,
  stepMs = WAIT_STEP_MS,
  maxWaitMs = MAX_WAIT_MS,
  now = Date.now,
} = {}) {
  if (!client) return acquireLocal();

  const token = crypto.randomUUID();
  const start = now();
  for (;;) {
    let taken;
    try {
      taken = await client.eval(
        ACQUIRE_SCRIPT,
        1,
        SLOTS_KEY,
        now(),
        ttlMs,
        max,
        token,
      );
    } catch (error) {
      logger.warn(
        `[Societeinfo] file Redis indisponible, file locale : ${error.message}`,
      );
      return acquireLocal();
    }
    if (Number(taken) === 1) {
      return once(async () => {
        try {
          await client.zrem(SLOTS_KEY, token);
        } catch {
          // Le jeton expirera seul
        }
      });
    }
    if (now() - start >= maxWaitMs) throw new SlotTimeoutError();
    await sleep(stepMs);
  }
}
