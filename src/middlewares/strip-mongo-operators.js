/**
 * Retire des entrées HTTP (paramètres de requête, corps JSON ou formulaire)
 * toute clé qui commence par « $ ». L'analyseur de requête d'Express
 * transforme `?link[$ne]=x` en `{ link: { $ne: "x" } }` : passé tel quel à
 * une recherche Mongoose, l'objet devient un opérateur MongoDB et la
 * comparaison n'en est plus une. Aucune entrée légitime de l'API n'a de clé
 * de ce genre (les noms de variables GraphQL arrivent sans « $ »).
 */

// Garde-fou contre un corps très imbriqué : au-delà, on ne descend plus.
const MAX_DEPTH = 32;

export function stripOperatorKeys(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) {
    return value;
  }
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) stripOperatorKeys(item, depth + 1);
    return value;
  }
  for (const key of Object.keys(value)) {
    if (key.startsWith("$")) {
      delete value[key];
    } else {
      stripOperatorKeys(value[key], depth + 1);
    }
  }
  return value;
}

export function stripMongoOperators(req, _res, next) {
  stripOperatorKeys(req.query);
  stripOperatorKeys(req.body);
  next();
}

export default stripMongoOperators;
