import { getActiveOrganization } from "./org-resolver.js";

/**
 * Organisation active d'un utilisateur (et son rôle de membre), mise en cache
 * par processus et partagée par withRBAC et withWorkspace. withWorkspace
 * relisait jusqu'ici member puis organization dans Mongo à chaque champ racine
 * protégé (~16 ms par requête mesurés le 08/10/2026).
 *
 * - 60 s, 500 entrées (même compromis que l'ancien cache de withRBAC : un
 *   retrait de membre prend effet au plus 60 s plus tard sur une instance) ;
 * - une seule lecture en vol par clé, pour les rafales de requêtes
 *   simultanées d'une page ;
 * - null n'est jamais mis en cache : un refus d'accès est toujours revérifié
 *   (protection anti-empoisonnement de rbac.js).
 *
 * Module à part pour garder org-resolver.js mockable seul dans les tests.
 */
const ORG_CACHE_TTL = 60_000;
const ORG_CACHE_MAX = 500;
const _orgCache = new Map(); // clé -> { org, ts }
const _inFlight = new Map(); // clé -> Promise

const cacheKey = (userId, requestedOrgId) =>
  `${userId}:${requestedOrgId || "default"}`;

export async function getActiveOrganizationCached(
  userId,
  requestedOrgId = null,
) {
  const key = cacheKey(userId, requestedOrgId);
  const entry = _orgCache.get(key);
  if (entry) {
    if (Date.now() - entry.ts <= ORG_CACHE_TTL) return entry.org;
    _orgCache.delete(key);
  }

  let pending = _inFlight.get(key);
  if (!pending) {
    pending = getActiveOrganization(userId, requestedOrgId)
      .then((org) => {
        if (org) {
          if (_orgCache.size >= ORG_CACHE_MAX) {
            _orgCache.delete(_orgCache.keys().next().value);
          }
          _orgCache.set(key, { org, ts: Date.now() });
        }
        return org;
      })
      .finally(() => _inFlight.delete(key));
    _inFlight.set(key, pending);
  }
  return pending;
}

// Invalide le cache d'un utilisateur (ou tout le cache sans argument).
export function invalidateOrgCache(userId) {
  if (userId) {
    for (const key of _orgCache.keys()) {
      if (key.startsWith(`${userId}:`)) _orgCache.delete(key);
    }
  } else {
    _orgCache.clear();
  }
}
