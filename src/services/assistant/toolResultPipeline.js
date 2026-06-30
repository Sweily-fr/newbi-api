import { sanitizeDeep } from "./sanitize.js";

/**
 * Pipeline transformatif appliqué à TOUT résultat de tool AVANT envoi au LLM.
 *
 * Ordre :
 *   1. Sanitize (IBAN / SIRET / email / téléphone → placeholders).
 *      Définitif, pas de rehydration.
 *   2. La pseudonymisation client est DÉJÀ faite dans les handlers (via
 *      ctx.pseudo.client(...)), donc rien à faire ici de plus.
 *
 * Conçu pour être appelé par le runner de tool_use (Étape 4) :
 *
 *   const raw = await runTool(name, params, ctx);
 *   const safe = preparePayloadForLLM(raw);
 *   // ↓ safe est passé au LLM dans tool_result
 *
 * Le pipeline est volontairement minimal aujourd'hui. Si on ajoute des tools
 * qui exposent des champs texte libre (description, notes), ils passeront
 * automatiquement par sanitize sans changement de code.
 */
export function preparePayloadForLLM(toolResult) {
  return sanitizeDeep(toolResult);
}
