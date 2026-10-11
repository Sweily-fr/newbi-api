import mongoose from "mongoose";

/**
 * Identifiants (espace, utilisateur…) reçus d'une requête.
 *
 * Un identifiant lu dans un corps JSON ou une query string (parseur « qs »
 * d'Express 4) peut être un objet (`{ "$ne": null }`), un tableau ou une
 * chaîne quelconque. Placé tel quel dans un filtre MongoDB, un objet devient
 * un opérateur : `{ organizationId: { $ne: null } }` trouve n'importe quelle
 * adhésion de l'utilisateur, `{ workspaceId: { $ne: null } }` n'importe quel
 * espace. Seule la forme texte d'un ObjectId est donc acceptée.
 *
 * Note : mongoose.isObjectIdOrHexString accepte tout objet portant
 * `_bsontype: "ObjectId"` (fabricable en JSON) et ObjectId.isValid accepte
 * les chaînes de 12 caractères : ni l'un ni l'autre ne conviennent ici.
 */

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** Chaîne de 24 caractères hexadécimaux (forme texte d'un ObjectId). */
export function isObjectIdString(value) {
  return typeof value === "string" && OBJECT_ID_RE.test(value);
}

/** Chaîne d'ObjectId, ou ObjectId construit par le serveur. */
export function isObjectIdRef(value) {
  return value instanceof mongoose.Types.ObjectId || isObjectIdString(value);
}

/**
 * ObjectId d'un identifiant : chaîne de 24 caractères hexadécimaux, ou
 * ObjectId déjà construit par le serveur (une requête ne peut pas en
 * fournir). Tout le reste : null.
 */
export function toObjectIdOrNull(value) {
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (isObjectIdString(value)) return new mongoose.Types.ObjectId(value);
  return null;
}
