/**
 * Génération de titre court pour une conversation (option B validée).
 *
 * Appelé UNE seule fois à la création de la conversation (1er tour), de
 * manière BLOQUANTE juste avant le done event du stream principal. On
 * accepte 200-500 ms supplémentaires en fin de stream pour avoir un titre
 * humain dès l'instant où le sub-sheet history s'ouvre.
 *
 * Coût (Haiku 4.5, mesure réelle plan) :
 *   - input  ~ 200-300 tok @ $0,80/Mtok ≈ $0,0002 / conv
 *   - output ~ 5-15 tok  @ $4/Mtok    ≈ $0,00006 / conv
 *   - total                          ≈ $0,0003 / conv
 *   - 1000 conversations             ≈ $0,30 / mois
 *
 * Garde-fous :
 *   - Pas de cache_control : le préfixe (system + content) est court et
 *     change par conversation → cache ineffective. On accepte le full prix.
 *   - max_tokens = 30  : titre court par contrat.
 *   - Pseudo-tokens : on insiste dans le prompt pour qu'aucun "Client_N"
 *     ne fuite dans le titre. Sanity check côté parseTitleOutput.
 *   - Échec silencieux : si l'appel rate ou que la sortie est inutilisable,
 *     on retourne null et le caller garde le titre auto-généré
 *     (formatConversationTitle = 60 premiers chars de la question).
 */

const TITLE_SYSTEM_PROMPT = `Tu génères un titre TRÈS COURT pour une conversation avec l'assistant comptable Newbi.

RÈGLES STRICTES :
- 3 à 5 mots MAXIMUM, en français.
- Maximum 30 caractères au total.
- Aucune ponctuation finale, aucun guillemet, aucun markdown.
- 1re lettre en majuscule, le reste en minuscule sauf noms propres.
- N'utilise JAMAIS de jeton technique : ni "Client_N", ni "this_month/last_year/period/get_revenue", ni aucune valeur d'enum. Si le texte contient "Client_N", utilise "un client" ou ne mentionne pas le client.
- Reste fidèle à la question utilisateur, ne reformule pas et n'invente rien.

Exemples :
- "CA de juin"
- "Impayés du mois"
- "Top clients 2025"
- "Trésorerie 6 mois"

Réponds UNIQUEMENT par le titre lui-même. Rien d'autre.`;

/**
 * Cap dur sur la longueur finale d'un titre. Réduit à 32 chars pour tenir
 * confortablement dans le header du SearchSheet (X gauche + pill droite +
 * padding → ~180 px disponibles à fontSize 17 = ~22-24 chars visibles).
 * On laisse une petite marge à 32 pour les diacritiques.
 * Le schema Mongo reste à maxlength: 60 (généreux) mais en pratique tout
 * passera par ce cap-ci.
 */
const MAX_TITLE_LENGTH = 32;

/**
 * Nettoie la sortie brute du LLM en un titre prêt à persister.
 * EXTRAIT (pas async, testable) :
 *   - Trim
 *   - Strip guillemets enrobants (" ' ' « » ')
 *   - Strip ponctuation finale (. ! ?)
 *   - Strip "Titre :" éventuel en préfixe (le LLM peut tomber dans le piège)
 *   - Coupe à 60 chars max
 *   - Sanity check anti-Client_N (on remplace par "client" si une fuite passe)
 *   - Retourne null si vide après nettoyage
 */
export function parseTitleOutput(rawText) {
  if (typeof rawText !== "string") return null;
  let s = rawText.trim();
  if (!s) return null;

  // Strip un préfixe "Titre:" / "Title:" éventuel
  s = s.replace(/^\s*(titre|title)\s*:\s*/i, "");

  // Strip guillemets enrobants (paire ouvrante/fermante)
  s = s.replace(/^["'«'']+/, "").replace(/["'»'']+$/, "");

  // Strip ponctuation finale
  s = s.replace(/[.!?…]+$/, "");

  // Re-trim après strip
  s = s.trim();
  if (!s) return null;

  // Garde-fou anti-fuite Client_N (le system prompt l'interdit mais le LLM
  // peut faillir). On remplace par "un client" pour rester lisible.
  s = s.replace(/\bClient_\d+\b/g, "un client");

  // Coupe au cap, préférence pour un mot entier si l'avant-dernier mot
  // démarre au-delà de la moitié du cap (sinon on coupe au cap pile + …).
  if (s.length > MAX_TITLE_LENGTH) {
    const cut = s.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    s = lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
    s = s.trimEnd() + "…";
  }

  return s;
}

/**
 * Appel Anthropic pour générer le titre. À utiliser comme :
 *
 *   const title = await generateConversationTitle({
 *     anthropic, model,
 *     userMessage, assistantText,
 *   });
 *   if (title) conversation.title = title;
 *
 * Volontairement défensif (try/catch) : tout échec → return null, le caller
 * garde son titre auto-généré.
 */
export async function generateConversationTitle({
  anthropic,
  model,
  userMessage,
  assistantText,
  maxTokens = 30,
}) {
  try {
    if (!anthropic || !userMessage) return null;
    const user = String(userMessage).trim();
    const assistant = String(assistantText || "")
      .trim()
      .slice(0, 500); // pas besoin du texte entier pour résumer
    if (!user) return null;

    const res = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: TITLE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Question utilisateur :\n${user}\n\nRéponse assistant :\n${assistant}`,
        },
      ],
    });

    const text = (res?.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    return parseTitleOutput(text);
  } catch {
    // Logs gérés côté caller — ici on swallow pour ne PAS faire échouer le
    // stream principal pour une feature accessoire.
    return null;
  }
}

export const _internals = {
  TITLE_SYSTEM_PROMPT,
  MAX_TITLE_LENGTH,
};
