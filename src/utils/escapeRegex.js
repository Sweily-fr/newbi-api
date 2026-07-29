/**
 * Échappe les métacaractères d'une chaîne pour une utilisation sûre dans un
 * `new RegExp(...)` ou un `$regex` MongoDB.
 *
 * Sans échappement, une entrée utilisateur comme `(a+)+$` provoque un
 * backtracking catastrophique (ReDoS) évalué par le worker Node ou par mongod,
 * saturant le CPU sur une API multi-tenant. On borne aussi la longueur.
 *
 * @param {string} str
 * @param {number} maxLen longueur maximale conservée (défaut 200)
 * @returns {string} chaîne échappée et bornée
 */
export function escapeRegex(str, maxLen = 200) {
  if (str == null) return "";
  return String(str)
    .slice(0, maxLen)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
