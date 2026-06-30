/**
 * streamHydrator — réhydrate les tokens "Client_N" pendant un stream SSE,
 * sans jamais émettre un token brut visible à l'utilisateur.
 *
 * ─── Le problème ────────────────────────────────────────────────────────
 * Anthropic streame du texte par chunks de tailles arbitraires. Un token
 * "Client_1" peut arriver split en deux ("Cli" puis "ent_1"), trois
 * ("Cl" + "ient" + "_1") ou être collé à un autre ("Client_1Client_2").
 * Si on hydrate naïvement chaque chunk, on émet "Cli" → "ent_1" et le user
 * voit "Cli ent_1" — fuite ratée mais token mal formé visible.
 *
 * ─── Stratégie ──────────────────────────────────────────────────────────
 * Buffer-and-cut :
 *   1. Append le nouveau chunk au buffer.
 *   2. Identifier le point de coupe sûr : la dernière position du buffer à
 *      partir de laquelle on pourrait encore voir arriver des caractères
 *      qui compléteraient un token (préfixe partiel "Cl", "Client_", "Client_12"…).
 *   3. Émettre uniquement la partie AVANT ce point de coupe, après hydratation.
 *   4. Garder la partie AMBIGUË en buffer jusqu'au prochain chunk.
 *   5. À la fin du stream, `flush()` vide le buffer en l'hydratant.
 *
 * ─── Règle de sûreté actée avec l'équipe ────────────────────────────────
 * En cas de doute, RETENIR plutôt qu'émettre. Mieux vaut un délai d'affichage
 * d'un caractère qu'un Client_N brut qui s'échappe sur l'écran.
 *
 * ─── Format des tokens ──────────────────────────────────────────────────
 * Le PseudonymMap émet uniquement "Client_<digits>". La detection partielle
 * suit exactement ce pattern : préfixe imbriqué C → Cl → Cli → Clie → Clien
 * → Client → Client_ → Client_<digits>+. Si un autre type de token est ajouté
 * un jour, étendre PARTIAL_TOKEN_RE.
 */

// Préfixe partiel reconnaissable d'un token. La regex matche TOUT préfixe
// d'un token complet, à la FIN du buffer. `?` permet de matcher des préfixes
// très courts ("C", "Cl"). Le suffixe `\d*` après `_` autorise un token
// complet à être considéré comme partiel (cas "Client_12" qui pourrait
// devenir "Client_123" si un chunk arrive après).
const PARTIAL_TOKEN_RE = /C(?:l(?:i(?:e(?:n(?:t(?:_\d*)?)?)?)?)?)?$/;

/**
 * Crée un hydrator stateful pour un stream donné.
 *
 * @param {{ hydrate: (s: string) => string }} pseudo
 *        Instance de createPseudoMap() (ou compatible). hydrate(text) doit
 *        remplacer les tokens connus par les vrais noms.
 * @returns {{
 *   feed: (chunk: string) => string,
 *   flush: () => string,
 *   bufferSize: number,
 * }}
 */
export function createStreamHydrator(pseudo) {
  let buffer = "";

  return {
    /**
     * Ingère un chunk de texte streamé. Retourne le texte SÛR à émettre
     * (déjà hydraté). Le reste reste en buffer.
     */
    feed(chunk) {
      if (typeof chunk !== "string" || chunk.length === 0) return "";
      buffer += chunk;

      // Cherche le préfixe partiel à la fin. Si trouvé, on ne peut pas
      // encore émettre les caractères depuis cette position. Si pas trouvé,
      // tout est émettable.
      const match = buffer.match(PARTIAL_TOKEN_RE);
      const cut = match ? match.index : buffer.length;

      const emittable = buffer.slice(0, cut);
      buffer = buffer.slice(cut);

      // L'hydrate du buffer sûr remplace les tokens COMPLETS uniquement.
      return pseudo.hydrate(emittable);
    },

    /**
     * Flush final — OBLIGATOIRE à la fin d'un stream. Vide le buffer et
     * émet ce qui reste, hydraté. Sans flush, un token en toute fin de
     * stream resterait coincé dans le buffer et ne serait jamais émis.
     */
    flush() {
      const remaining = buffer;
      buffer = "";
      return pseudo.hydrate(remaining);
    },

    /** Taille actuelle du buffer (debug / monitoring uniquement). */
    get bufferSize() {
      return buffer.length;
    },
  };
}
