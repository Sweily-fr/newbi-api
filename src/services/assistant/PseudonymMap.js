/**
 * PseudonymMap — map stateful par requête utilisateur.
 *
 * Contrat :
 *   - Mêmes entrées (id) → même token pendant la durée de vie de l'instance.
 *   - Tokens stables et opaques : "Client_1", "Client_2"…
 *   - Reverse map tenue côté backend uniquement. Le front reçoit déjà les vrais
 *     noms (rehydration faite ici côté serveur).
 *   - Aucune fuite : la map n'est jamais sérialisée, jamais loggée, jamais
 *     retournée dans la réponse HTTP.
 *
 * Cas tordus pris en compte (cf. tests) :
 *   - Même client cité N fois → même token.
 *   - Client sans nom → token quand même, fallback hydrate vers un ID court.
 *   - 0 client à mapper → hydrate() = no-op.
 *   - Token au début / milieu / fin du texte.
 *   - Token splitté entre 2 chunks SSE : géré par createStreamHydrator()
 *     (Étape 4 streaming).
 */
export class PseudonymMap {
  constructor() {
    /** @type {Map<string, { token: string; name: string }>} id → entry */
    this._byId = new Map();
    /** @type {Map<string, string>} token → display name (vrai nom ou fallback) */
    this._byToken = new Map();
    this._nextClientId = 1;
  }

  /**
   * Retourne (ou crée) le token pseudonyme pour un client.
   *
   * @param {{ id?: string|number, name?: string|null }} input
   * @returns {string} token "Client_N"
   */
  client(input) {
    const id = input?.id != null ? String(input.id) : null;
    const rawName = typeof input?.name === "string" ? input.name.trim() : "";

    // Si pas d'ID exploitable : on génère un token volatil non mappé (chaque
    // appel crée un nouveau token). Cas rare mais on évite de le perdre.
    if (!id) {
      const token = `Client_${this._nextClientId++}`;
      const display = rawName || "(client sans nom)";
      this._byToken.set(token, display);
      return token;
    }

    // Même id → même token (idempotence).
    const existing = this._byId.get(id);
    if (existing) return existing.token;

    const token = `Client_${this._nextClientId++}`;
    // Fallback affiché à l'utilisateur si name vide : on garde un id court.
    const display = rawName || `Client #${id.slice(0, 8)}`;
    this._byId.set(id, { token, name: display });
    this._byToken.set(token, display);
    return token;
  }

  /**
   * Résout un token vers son display name (vrai nom). Retourne null si
   * inconnu (= le token n'a pas été émis par cette instance — possible
   * hallucination du LLM, on le laisse tel quel).
   *
   * @param {string} token
   * @returns {string|null}
   */
  resolve(token) {
    return this._byToken.get(token) || null;
  }

  /**
   * Remplace tous les tokens connus dans un texte par leur display name.
   * Synchrone — pour les textes COMPLETS (réponses non streamées, fin de
   * stream, tests).
   *
   * Implémentation : une seule regex globale `/Client_\d+/g` avec callback
   * qui lookup le token matché dans la map.
   *
   * Pourquoi pas split/join token-par-token : avec un compteur ≥ 10, le
   * token "Client_1" matcherait au DÉBUT de "Client_12" (split n'a pas de
   * frontière), provoquant une corruption "Client_12" → "N12" si Client_1
   * → "N". Le `\d+` greedy garantit qu'on match TOUT le suffixe numérique
   * d'un seul coup, donc on lookup le bon token.
   *
   * Si un token n'est pas dans la map (ex. Client_99 alors qu'on n'a émis
   * que Client_1..Client_3), on laisse le token brut — possible hallucination
   * du LLM, on ne réécrit pas ce qu'on n'a pas créé.
   *
   * @param {string} text
   * @returns {string}
   */
  hydrate(text) {
    if (typeof text !== "string" || text.length === 0) return text;
    if (this._byToken.size === 0) return text;

    return text.replace(/Client_\d+/g, (matched) => {
      return this._byToken.get(matched) || matched;
    });
  }

  /**
   * Nombre de pseudonymes émis par cette instance.
   * Utile pour les logs (sans fuiter la map elle-même).
   */
  get size() {
    return this._byToken.size;
  }

  /**
   * SEED la map avec un état pré-existant (V1 Étape 7.2 multi-turn) :
   *   - entries : Iterable<[clientId, token]> — issu de conversation.pseudoMap
   *   - initialCounter : valeur de conversation.pseudoCounter
   *   - idToName : Map<clientId, currentName> — pour que hydrate() retourne
   *     le nom courant (pas l'ancien) si le client a été renommé entre tours
   *
   * Invariants maintenus :
   *   - Les tokens déjà alloués gardent leur N (Client_3 reste Client_3)
   *   - Le prochain client.client() inconnu alloue Client_(initialCounter+1)
   *   - Les clients dont le nom est manquant restent mappés (fallback id court),
   *     ils seront affichés via la stratégie "Client supprimé" côté rehydration
   *     finale, mais en cours de session on garde un display name utilisable.
   *
   * Idempotent : seed deux fois la même entrée → même résultat (set écrase).
   */
  seed(entries, initialCounter, idToName) {
    if (typeof entries?.[Symbol.iterator] !== "function") return;
    let maxSeenN = 0;
    for (const [clientId, token] of entries) {
      const id = String(clientId);
      const match = /^Client_(\d+)$/.exec(token);
      if (!match) continue; // token mal formé → on saute
      const n = parseInt(match[1], 10);
      if (n > maxSeenN) maxSeenN = n;
      const lookedUpName =
        idToName instanceof Map ? idToName.get(id) : idToName?.[id];
      const display = lookedUpName || `Client #${id.slice(0, 8)}`;
      this._byId.set(id, { token, name: display });
      this._byToken.set(token, display);
    }
    // Le prochain token alloué doit être > tout token persisté ET >
    // initialCounter (sécurité si le counter est désynchronisé du map).
    const target = Math.max(initialCounter || 0, maxSeenN) + 1;
    if (target > this._nextClientId) this._nextClientId = target;
  }

  /**
   * Extrait l'état persistable de la session — à appeler en fin de tour
   * pour MERGE dans la conversation Mongo.
   *
   * Retour :
   *   - entries : Map<clientId, token> (uniquement les clients avec un id,
   *     les pseudonymes "anonymes" sans id ne sont PAS persistés — ils sont
   *     éphémères par design Étape 3).
   *   - counter : numéro d'allocation maximum atteint.
   */
  getState() {
    const entries = new Map();
    let maxN = 0;
    for (const [id, entry] of this._byId.entries()) {
      entries.set(id, entry.token);
      const match = /^Client_(\d+)$/.exec(entry.token);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxN) maxN = n;
      }
    }
    return {
      entries,
      counter: Math.max(maxN, this._nextClientId - 1),
    };
  }
}

/**
 * Factory PROD — remplace `createPseudoPassthrough()` dans le pipeline.
 *
 * Conserve le même contrat d'API que le passthrough Étape 2 → les handlers
 * écrits en Étape 2 marchent ici sans modif. C'est tout l'intérêt du point
 * d'injection unique.
 */
export function createPseudoMap() {
  const map = new PseudonymMap();
  return {
    /** Pseudonymise un client (id, name) → token. */
    client(input) {
      return map.client(input);
    },
    /** Identifiant facture (numéro = métier, pas PII). */
    invoice({ id, number }) {
      return { id, number };
    },
    /** Hydrate un texte complet. */
    hydrate(text) {
      return map.hydrate(text);
    },
    /** Résout un token unique vers son display name (ou null). */
    resolve(token) {
      return map.resolve(token);
    },
    /** Accès à l'instance interne — pour le stream hydrator d'Étape 4. */
    _map: map,
    isPseudonymous: true,
    /** SEED multi-turn (cf. PseudonymMap.seed). */
    seed(entries, initialCounter, idToName) {
      return map.seed(entries, initialCounter, idToName);
    },
    /** Extrait l'état persistable (cf. PseudonymMap.getState). */
    getState() {
      return map.getState();
    },
  };
}
