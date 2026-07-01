/**
 * System prompt FINAL + helpers de prompt caching pour l'assistant LLM
 * (V1 Étape 5 — version corrigée).
 *
 * Stratégie de cache (Anthropic) — CORRIGÉE après mesure réelle :
 *
 *   Le marqueur `cache_control: { type: "ephemeral" }` DOIT être posé sur
 *   le bloc SYSTEM (pas seulement sur le dernier tool comme je l'avais
 *   raisonné en Étape 5). Mesure empirique :
 *
 *     marqueur sur dernier tool SEUL    → cache_creation_input_tokens = 0
 *                                         (ignoré, on paie le plein tarif)
 *     marqueur sur system block         → cache_creation = full préfixe ✅
 *     marqueur sur system + dernier tool→ cache_creation = full préfixe ✅
 *                                         (équivalent au précédent en pratique)
 *
 *   Le mystère "deux markers = double cache write" que je craignais n'existe
 *   pas : un contenu identique cache_control'd plusieurs fois ne génère pas
 *   d'écriture supplémentaire (Anthropic dédup côté serveur).
 *
 *   On garde le marqueur sur le dernier tool en sécurité (no-op si le system
 *   marker fonctionne, filet en cas de variation comportementale).
 *
 *   Comment vérifier ? Voir `scripts/measure-assistant-cache.js`. Sur un
 *   compte chargé, le 1er appel renvoie `cache_creation_input_tokens > 0`
 *   et les suivants `cache_read_input_tokens > 0`.
 *
 * RAPPEL : le système prompt est répété à CHAQUE appel — même en cache hit,
 * le SDK Anthropic le passe par réseau. Chaque ligne inutile coûte de la
 * bande passante en aval. On le garde minimal et on ne duplique JAMAIS ce
 * qui est déjà exposé dans les schemas de tools (notamment l'enum des 17
 * catégories de dépenses, ou la liste des 6 périodes : déjà dans schemas.js).
 */

import { TOOL_SCHEMAS } from "./tools/schemas.js";

/**
 * System prompt V1 final. Couvre tous les invariants décidés au plan :
 *   1. Identité (assistant Newbi V1 beta) + mode (lecture seule).
 *   2. Langue (français) + concision (1 à 3 phrases courtes).
 *   3. JARGON INTERDIT — pas de fuite des noms d'enum/params/tools en
 *      réponse utilisateur. Apprentissage post-mortem du test "CA 2025" :
 *      le LLM disait "utilise last_year" à l'utilisateur final = jargon
 *      de tuyauterie qui s'échappe. INTERDIT.
 *   4. Refus de mutation → "Cette fonctionnalité arrive bientôt.".
 *   5. Refus de calcul → utiliser uniquement les valeurs des tools.
 *   6. Règle deltaPct null → ne pas mentionner d'évolution.
 *   7. NO-CONFIRM : si la période demandée est couverte, on appelle
 *      directement, on ne repose JAMAIS une question de confirmation.
 *      (Apprentissage post-mortem : "CA 2025" doit appeler last_year en
 *      un tour, pas reposer la question.)
 *   8. Recap des capacités sur refus — sert de garde-fou d'attentes en beta.
 *   9. Date courante injectée dans le message user (cf. routes/assistant.js)
 *      → règle de résolution année/mois côté schémas (descriptions period).
 *   10. Tokens "Client_N" utilisés tels quels — le serveur les hydrate.
 */
export const SYSTEM_PROMPT = `Tu es l'assistant Newbi (V1 beta), en LECTURE SEULE. Réponds en français, en 1 à 3 phrases courtes.

JARGON INTERDIT en réponse à l'utilisateur : noms d'enum (this_month, last_month, this_quarter, last_quarter, this_year, last_year), noms de paramètres (period, limit, category), noms de tools (get_revenue, list_overdue_invoices, get_top_clients, get_treasury_evolution, get_expenses). Parle uniquement en langage humain : "ce mois", "le mois dernier", "l'année dernière", "2025", "mai", "CA", "impayés", "trésorerie", etc.

RÈGLES :
- Mutation interdite : pour toute demande de créer / modifier / supprimer / envoyer / exporter, réponds exactement "Cette fonctionnalité arrive bientôt.".
- N'invente AUCUN chiffre. Utilise uniquement les valeurs renvoyées par les tools — ne calcule rien toi-même.
- ÉVOLUTION : si un tool renvoie le champ "deltaText", insère-le TEL QUEL dans ta réponse (ex. "+12 % vs avril", "forte hausse vs mai (×32, mois de référence très bas)", "chute quasi totale vs avril"). NE RECALCULE PAS, NE REFORMULE PAS, NE PARAPHRASE PAS ce qui est déjà dit dans deltaText. Mentionne l'évolution UNE seule fois et ne répète pas l'idée ailleurs dans la phrase. Si deltaText est null, NE MENTIONNE PAS d'évolution ni de comparaison.
- Si la période demandée EST couverte (cf. descriptions des tools), APPELLE DIRECTEMENT le tool puis réponds en un tour. NE DEMANDE JAMAIS confirmation à l'utilisateur ; ne repose une question que si la demande est vraiment hors périmètre.
- Si refus (hors périmètre), dis explicitement ce que tu sais faire : "Je peux te donner le CA, les impayés, le top clients, la trésorerie ou les dépenses, sur ce mois, le mois dernier, ce trimestre, le trimestre dernier, cette année ou l'année dernière.".
- La date courante est injectée en tête du message utilisateur sous la forme "[Date courante : YYYY-MM-DD]" — utilise-la pour résoudre les années et mois cités. NE LA MENTIONNE PAS dans ta réponse.
- Les noms de clients arrivent sous la forme "Client_N" (anonymisés). Réutilise-les tels quels — le serveur les remplace par les vrais noms avant affichage utilisateur.`;

/**
 * Renvoie une copie de `tools` avec `cache_control: { type: "ephemeral" }`
 * appliqué UNIQUEMENT sur le dernier élément. Le helper est PUR : il ne
 * mute pas l'entrée et ne touche pas aux tools intermédiaires.
 *
 * Validations :
 *   - Si `tools` n'est pas un tableau ou est vide, retourne tel quel
 *     (defensive : l'appel Anthropic explosera plus tard avec un message
 *     plus clair que si on bricolait sur null).
 */
export function withCacheControl(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return tools.map((tool, idx, arr) => {
    if (idx === arr.length - 1) {
      return { ...tool, cache_control: { type: "ephemeral" } };
    }
    return tool;
  });
}

/**
 * Bloc system prêt à l'emploi pour `anthropic.messages.stream({ system })`.
 * Format array (TextBlockParam) plutôt que string, NÉCESSAIRE pour porter
 * le marqueur `cache_control` (impossible sur une string brute).
 *
 * Le marqueur `ephemeral` ici EST le marqueur qui active réellement le
 * caching côté Anthropic — cf. doc en tête de fichier.
 */
export const SYSTEM_BLOCKS = [
  { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
];

/**
 * Tools prêts à l'emploi pour `anthropic.messages.stream({ tools })`,
 * avec marqueur cache_control sur le dernier (= get_expenses).
 *
 * Construit une seule fois à l'import du module. Toute mutation post-import
 * doit passer par un re-build explicite (ce qu'on ne fait pas en V1).
 */
export const TOOL_SCHEMAS_CACHED = withCacheControl(TOOL_SCHEMAS);
