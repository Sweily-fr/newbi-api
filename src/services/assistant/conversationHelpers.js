/**
 * Helpers purs pour la gestion des conversations de l'assistant (V1 Étape 7).
 *
 * Tout ce qui ne touche pas Mongo : titre auto, fenêtre multi-turn,
 * allocation/rehydration des pseudo-tokens. Testable en isolation.
 *
 * Le multi-turn dans /chat/stream (Étape 7.2) consommera ces helpers.
 */

/**
 * Nombre de tours d'historique à renvoyer au LLM en multi-turn.
 * Override via env var pour pouvoir tuner sans rebuild.
 *
 * Chiffrage validé (cf. plan) : 5 tours = ~+1000 tokens d'entrée par requête
 * = ~+2,40 $/mois sur 100 req/jour. Au-delà de 10-15 tours, on perd
 * l'intérêt du caching statique.
 */
const parsed = parseInt(process.env.ASSISTANT_HISTORY_TURNS, 10);
export const ASSISTANT_HISTORY_TURNS =
  Number.isFinite(parsed) && parsed > 0 ? parsed : 5;

/**
 * Génère un titre court pour une conversation à partir de la première
 * question utilisateur. Stratégie :
 *   - Normalise les espaces (collapse + trim).
 *   - ≤ 60 chars : on garde tel quel.
 *   - > 60 chars : on coupe à 57 + "…" → garantit ≤ 60 chars total.
 *   - Vide / null : fallback "Nouvelle conversation".
 *
 * Acceptable en beta même si parfois moche ("donne moi le ca de l…").
 * Une V2 pourrait faire résumer par le LLM lui-même.
 */
export function formatConversationTitle(query) {
  const trimmed = (query || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "Nouvelle conversation";
  if (trimmed.length <= 60) return trimmed;
  // On coupe sur 57 (pas 59) car "…" est 1 char Unicode mais on garde de
  // la marge — et trimEnd évite "donne moi le ca de la …".
  return trimmed.slice(0, 57).trimEnd() + "…";
}

/**
 * Construit l'historique simplifié à renvoyer au LLM. Stratégie clé du
 * plan (validée) : on NE renvoie PAS les tool_use / tool_result précédents.
 * Uniquement le texte user + assistant des N derniers tours.
 *
 *   - Coût contrôlé : ~100 tokens/message × 2N messages → ~1000 tokens
 *     à 5 tours, vs ~10000 si on incluait les tool_result.
 *   - Pas de perte fonctionnelle : si l'utilisateur demande "et le mois
 *     d'avant ?", le LLM re-appellera get_revenue(last_month) lui-même.
 *
 * @param {Array} turns Tableau de turns (role, text, ...).
 * @param {number} windowTurns Fenêtre en NOMBRE DE TOURS (= 1 pair user+assistant).
 * @returns {Array<{role: "user"|"assistant", content: string}>}
 */
export function simplifyHistoryForLLM(
  turns,
  windowTurns = ASSISTANT_HISTORY_TURNS,
) {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  // Un "tour" = 1 user + 1 assistant. windowTurns tours → 2*windowTurns
  // entrées maximum. slice depuis la fin garantit la fenêtre glissante.
  const recent = turns.slice(-windowTurns * 2);
  return recent.map((t) => ({
    role: t.role,
    content: t.text,
  }));
}

/**
 * Alloue ou récupère un pseudo-token "Client_N" pour un clientId dans une
 * conversation. Idempotent : appel répété avec le même clientId → même token.
 *
 * Mute le doc Mongoose (incrémente le counter, ajoute au pseudoMap).
 * L'appelant doit `await conversation.save()` après.
 *
 * Important : on PASSE PAR clientId, pas par nom. Si "Sweily SAS" est
 * renommé "Sweily SARL" entre deux tours, le token reste stable
 * (Client_1 = même client). C'est le filet de sécurité contre les
 * renommages qu'on a noté dans le plan.
 */
export function allocatePseudoForClient(conversation, clientId) {
  if (!clientId) throw new Error("clientId requis");
  const id = String(clientId);
  // Mongoose Map : .get / .set ; objet brut : accès direct.
  const existing =
    typeof conversation.pseudoMap?.get === "function"
      ? conversation.pseudoMap.get(id)
      : conversation.pseudoMap?.[id];
  if (existing) return existing;
  conversation.pseudoCounter = (conversation.pseudoCounter || 0) + 1;
  const token = `Client_${conversation.pseudoCounter}`;
  if (typeof conversation.pseudoMap?.set === "function") {
    conversation.pseudoMap.set(id, token);
  } else {
    if (!conversation.pseudoMap) conversation.pseudoMap = {};
    conversation.pseudoMap[id] = token;
  }
  return token;
}

/**
 * Merge l'état runtime d'un PseudonymMap (issu de getState()) dans la
 * conversation Mongo. Mute le doc, l'appelant doit save() après.
 *
 *   - Nouvelles entrées (clientId pas dans conversation.pseudoMap) → ajoutées
 *   - Anciennes entrées → JAMAIS écrasées (stabilité Client_N cross-tour)
 *   - Counter : max des deux (jamais décrémenté)
 *
 * Cas tordu pris en compte : si un nouveau client a été alloué Client_3
 * en runtime mais que conversation.pseudoCounter=2, on bump à 3.
 */
export function mergePseudoStateIntoConversation(conversation, runtimeState) {
  if (!runtimeState || !runtimeState.entries) return;
  // pseudoMap peut être Map (Mongoose) ou objet brut (test).
  const pm = conversation.pseudoMap;
  const hasGet = typeof pm?.get === "function";
  const hasSet = typeof pm?.set === "function";

  for (const [clientId, token] of runtimeState.entries) {
    const existing = hasGet ? pm.get(clientId) : pm?.[clientId];
    if (existing) continue; // jamais écraser un token déjà persisté
    if (hasSet) pm.set(clientId, token);
    else {
      if (!conversation.pseudoMap) conversation.pseudoMap = {};
      conversation.pseudoMap[clientId] = token;
    }
  }
  conversation.pseudoCounter = Math.max(
    conversation.pseudoCounter || 0,
    runtimeState.counter || 0,
  );
}

/**
 * Reconstruit un PseudonymMap (Étape 3) à partir du mapping persisté.
 *
 * Au prochain tour de cette conversation, on aura besoin de re-créer un
 * PseudonymMap où "Client_1" pointe vers le bon nom. Cette fonction prend
 * le pseudoMap persisté (clientId → token) + un mapping fournisseur
 * (clientId → nom courant) et retourne le format attendu par
 * PseudonymMap.hydrate (token → nom).
 *
 * @returns {Map<string, string>} token ("Client_N") → nom client courant
 */
export function buildTokenToNameMap(pseudoMap, idToName) {
  const entries =
    pseudoMap instanceof Map
      ? [...pseudoMap.entries()]
      : Object.entries(pseudoMap || {});
  const out = new Map();
  for (const [id, token] of entries) {
    const name =
      idToName instanceof Map
        ? idToName.get(String(id))
        : idToName?.[String(id)];
    if (name) out.set(token, name);
  }
  return out;
}

/** Libellé affiché à la place d'un Client_N dont le client a été supprimé. */
export const DELETED_CLIENT_LABEL = "Client supprimé";

/**
 * Rehydrate les textes pseudonymisés d'un tableau de turns.
 *
 * Remplace chaque occurrence "Client_N" par le nom courant du client si
 * disponible, sinon par "Client supprimé" — décision Étape 7.1 (point 6
 * du fix UX "jargon interdit") : ne JAMAIS exposer un jeton interne
 * "Client_N" à l'utilisateur. Si on ne sait plus à qui ça correspond, on
 * l'écrit en clair et honnête.
 *
 * Cas où un token n'est PAS dans pseudoMap (pseudo-token brut sans mapping) :
 *   On laisse le jeton tel quel — c'est probablement une hallucination du
 *   LLM (Client_99 sans qu'on l'ait jamais alloué). Pas le même cas qu'un
 *   client supprimé : ici on n'a aucune raison de croire que c'était un
 *   vrai client.
 *
 * IMPORTANT : utilise une regex /Client_\d+/g avec callback (PAS de
 * split/join), même technique que PseudonymMap.hydrate, pour éviter qu'un
 * "Client_1" matche le préfixe de "Client_12".
 */
export function rehydrateTurnTexts(turns, pseudoMap, idToName) {
  if (!Array.isArray(turns) || turns.length === 0) return turns;
  // Construit l'ensemble des tokens connus (= alloués au moins une fois
  // dans cette conversation). Permet de distinguer "supprimé" (alloué
  // mais nom manquant) d'une hallucination (jamais alloué).
  const allTokens = new Set();
  const pmEntries =
    pseudoMap instanceof Map
      ? [...pseudoMap.values()]
      : Object.values(pseudoMap || {});
  for (const token of pmEntries) allTokens.add(token);

  const tokenToName = buildTokenToNameMap(pseudoMap, idToName);

  return turns.map((t) => ({
    ...t,
    text: t.text.replace(/Client_\d+/g, (match) => {
      const name = tokenToName.get(match);
      if (name) return name;
      // Token connu (alloué dans la conversation) mais sans nom → supprimé.
      if (allTokens.has(match)) return DELETED_CLIENT_LABEL;
      // Token inconnu (jamais alloué) → laisser tel quel (hallucination).
      return match;
    }),
  }));
}
