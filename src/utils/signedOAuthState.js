import crypto from "crypto";
import { getCacheClient } from "../config/redis.js";
import logger from "./logger.js";

/**
 * Paramètre `state` signé des parcours OAuth qui reviennent sur un callback
 * public (redirection du fournisseur, sans session Newbi garantie).
 *
 * Le state Gmail était un simple JSON en base64 : n'importe qui pouvait en
 * fabriquer un avec l'utilisateur et l'espace d'un autre, puis terminer le
 * parcours avec sa propre boîte Gmail. Le callback rattachait alors cette
 * boîte à l'espace visé (en écrasant la connexion existante), et ses
 * factures y étaient importées. Le state est désormais signé (HMAC-SHA256,
 * secret serveur), daté, à usage dédié et de courte durée.
 *
 * Format : `<charge utile base64url>.<signature base64url>`.
 */

function getSecret() {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (ou JWT_SECRET) requis pour signer les states OAuth",
    );
  }
  return secret;
}

function sign(encodedPayload) {
  // Préfixe dédié : une signature d'une autre fonctionnalité ne vaut pas ici
  return crypto
    .createHmac("sha256", getSecret())
    .update(`oauth-state:${encodedPayload}`)
    .digest("base64url");
}

/**
 * @param {string} purpose - parcours (ex. "gmail-connect")
 * @param {object} payload - données à retrouver au callback
 * @param {number} ttlMs - durée de validité
 * @returns {string} state signé
 */
export function createSignedState(purpose, payload, ttlMs) {
  const issuedAt = Date.now();
  const encoded = Buffer.from(
    JSON.stringify({
      ...payload,
      purpose,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      nonce: crypto.randomBytes(16).toString("hex"),
    }),
  ).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

/**
 * Vérifie la signature, l'usage et l'expiration d'un state.
 * @returns {{ok: true, data: object}|{ok: false, reason: "invalid"|"expired"}}
 */
export function verifySignedState(purpose, state) {
  const invalid = { ok: false, reason: "invalid" };
  if (typeof state !== "string" || state.length > 4096) return invalid;
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra !== undefined) return invalid;

  let expected;
  try {
    expected = sign(encoded);
  } catch {
    return invalid;
  }
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return invalid;

  let data;
  try {
    data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return invalid;
  }
  if (!data || data.purpose !== purpose) return invalid;
  if (!Number.isFinite(data.expiresAt) || data.expiresAt < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, data };
}

// Repli hors production quand Redis n'est pas configuré (dev local) :
// clé -> échéance (ms), propre au processus
const memoryUsedStates = new Map();

/** REDIS_URL ou REDIS_HOST défini : Redis est attendu (voir config/redis.js). */
function isRedisConfigured() {
  return Boolean(process.env.REDIS_URL || process.env.REDIS_HOST);
}

// Vérification et écriture synchrones : atomiques dans le processus
function consumeInMemory(key, ttlMs) {
  const now = Date.now();
  for (const [usedKey, expiresAt] of memoryUsedStates) {
    if (expiresAt <= now) memoryUsedStates.delete(usedKey);
  }
  if (memoryUsedStates.has(key)) return "used";
  memoryUsedStates.set(key, now + ttlMs);
  return "ok";
}

/**
 * Consomme un state (usage unique) de façon atomique : SET NX dans Redis,
 * partagé entre les instances PM2. Seul le premier retour qui présente ce
 * nonce l'emporte ; l'ancien couple lecture puis écriture laissait passer
 * deux retours simultanés avec le même state.
 *
 * Sans client Redis :
 * - en production, ou si Redis est configuré (REDIS_URL / REDIS_HOST) mais
 *   n'a pas pu se connecter : refus, l'usage unique ne pouvant pas être
 *   garanti entre les instances (même choix que la connexion SuperPDP, dont
 *   le state n'existe que dans Redis) ;
 * - hors production sans Redis configuré (dev local) : repli en mémoire du
 *   processus, avec expiration.
 * Une erreur Redis (client présent, commande en échec) refuse toujours.
 *
 * @param {string} key - clé Redis propre au parcours et au nonce
 * @param {number} ttlMs - durée de conservation (durée de vie du state)
 * @returns {Promise<"ok"|"used"|"unavailable">}
 */
export async function consumeSignedStateOnce(key, ttlMs) {
  const client = getCacheClient();
  if (!client) {
    if (process.env.NODE_ENV !== "production" && !isRedisConfigured()) {
      return consumeInMemory(key, ttlMs);
    }
    logger.warn(
      "State OAuth refusé : Redis indisponible, usage unique non garanti",
    );
    return "unavailable";
  }
  try {
    const result = await client.set(key, "1", "PX", ttlMs, "NX");
    return result === "OK" ? "ok" : "used";
  } catch (error) {
    logger.warn(`State OAuth refusé : erreur Redis (${error.message})`);
    return "unavailable";
  }
}
