// Cache LRU en mémoire pour User.findById — évite une query DB par requête
// authentifiée. Partagé entre le chemin JWT (better-auth-jwt.js) et le chemin
// cookie (better-auth.js) pour qu'une invalidation couvre les deux.
const USER_CACHE_TTL = 30_000; // 30 secondes
const USER_CACHE_MAX = 500;
const _userCache = new Map();

// Un compte est refusé s'il est désactivé par l'un des deux mécanismes :
// - isDisabled : champ historique du modèle User ;
// - isActive === false : posé par le site lors de la désactivation du compte
//   (collection Better Auth « user »). Ce champ n'est pas déclaré dans le
//   schéma Mongoose (strict), d'où la lecture via get() qui renvoie aussi les
//   champs hors schéma. Un compte sans ce champ (undefined) reste accepté.
export function isUserAccessDenied(user) {
  if (!user) return true;
  if (user.isDisabled) return true;
  const isActive =
    typeof user.get === "function" ? user.get("isActive") : user.isActive;
  return isActive === false;
}

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

// Lecture d'un utilisateur via le cache, avec une seule lecture Mongo en vol
// par utilisateur : les requêtes simultanées d'une page (5 à 10 au premier
// chargement ou après 30 s d'inactivité) partagent la même lecture au lieu
// d'en lancer chacune une. Seul un utilisateur actif est mis en cache.
const _inFlight = new Map();

export function loadCachedUser(userId, load) {
  const cached = getCachedUser(userId);
  if (cached) return Promise.resolve(cached);
  let pending = _inFlight.get(userId);
  if (!pending) {
    pending = Promise.resolve()
      .then(load)
      .then((user) => {
        if (!isUserAccessDenied(user)) setCachedUser(userId, user);
        return user;
      })
      .finally(() => _inFlight.delete(userId));
    _inFlight.set(userId, pending);
  }
  return pending;
}

// Permet d'invalider le cache depuis l'extérieur (ex: après updateUser)
export function invalidateUserCache(userId) {
  if (userId) _userCache.delete(userId);
  else _userCache.clear();
}
