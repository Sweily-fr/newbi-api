// Cache LRU en mémoire pour User.findById — évite une query DB par requête
// authentifiée. Partagé entre le chemin JWT (better-auth-jwt.js) et le chemin
// cookie (better-auth.js) pour qu'une invalidation couvre les deux.
const USER_CACHE_TTL = 30_000; // 30 secondes
const USER_CACHE_MAX = 500;
const _userCache = new Map();

export function getCachedUser(userId) {
  const entry = _userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > USER_CACHE_TTL) {
    _userCache.delete(userId);
    return null;
  }
  return entry.user;
}

export function setCachedUser(userId, user) {
  // Eviction LRU simple : supprimer la plus ancienne entrée si la taille max est atteinte
  if (_userCache.size >= USER_CACHE_MAX) {
    const oldestKey = _userCache.keys().next().value;
    _userCache.delete(oldestKey);
  }
  _userCache.set(userId, { user, ts: Date.now() });
}

// Permet d'invalider le cache depuis l'extérieur (ex: après updateUser)
export function invalidateUserCache(userId) {
  if (userId) _userCache.delete(userId);
  else _userCache.clear();
}
