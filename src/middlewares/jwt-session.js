import mongoose from "mongoose";
import logger from "../utils/logger.js";

/**
 * Un JWT émis par le site n'authentifie que si sa session existe encore.
 *
 * - Jeton avec le claim `sid` (id de la session Better Auth qui l'a émis) :
 *   cette session doit exister, appartenir au même utilisateur et ne pas
 *   être expirée. Une déconnexion, une révocation d'appareil ou une
 *   désactivation du compte ferment donc l'accès à l'API.
 * - Jeton sans `sid` (émis avant l'ajout du claim, valable 15 min au plus) :
 *   l'utilisateur doit avoir au moins une session valide.
 *
 * Résultat gardé quelques secondes par processus pour ne pas lire la base à
 * chaque requête d'une même page.
 */
const CACHE_TTL_MS = 15_000;
const CACHE_MAX = 2_000;
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return entry.active;
}

function cacheSet(key, active) {
  if (_cache.size >= CACHE_MAX) {
    _cache.delete(_cache.keys().next().value);
  }
  _cache.set(key, { active, ts: Date.now() });
}

export function clearJwtSessionCache() {
  _cache.clear();
}

function userIdValues(sub) {
  const values = [String(sub)];
  if (mongoose.Types.ObjectId.isValid(sub)) {
    values.push(new mongoose.Types.ObjectId(String(sub)));
  }
  return values;
}

export async function isJwtSessionActive(decoded) {
  if (!decoded?.sub) return false;
  const sid = decoded.sid;
  if (sid !== undefined && (typeof sid !== "string" || !sid)) return false;

  const key = sid ? `sid:${sid}:${decoded.sub}` : `user:${decoded.sub}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const db = mongoose.connection.db;
  if (!db) return false;

  const filter = {
    userId: { $in: userIdValues(decoded.sub) },
    expiresAt: { $gt: new Date() },
  };
  if (sid) {
    if (!mongoose.Types.ObjectId.isValid(sid)) {
      cacheSet(key, false);
      return false;
    }
    filter._id = new mongoose.Types.ObjectId(sid);
  }

  try {
    const session = await db
      .collection("session")
      .findOne(filter, { projection: { _id: 1 } });
    const active = Boolean(session);
    cacheSet(key, active);
    return active;
  } catch (error) {
    logger.error("Vérification de la session du JWT :", error.message);
    return false;
  }
}
