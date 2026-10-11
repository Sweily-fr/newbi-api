import crypto from "crypto";
import logger from "../utils/logger.js";

/**
 * Secret interne partagé avec le site (en-tête x-internal-secret).
 *
 * Seule vérification du secret reçu dans l'API : toutes les routes appelées
 * par le site passent par ici.
 *
 * Rotation sans coupure : la réception accepte INTERNAL_API_SECRET OU
 * INTERNAL_API_SECRET_ALT (facultative, ignorée si vide). L'envoi utilise
 * toujours INTERNAL_API_SECRET. Procédure : docs/rotation-secret-interne.md.
 */

export const INTERNAL_SECRET_HEADER = "x-internal-secret";

const isUsable = (value) => typeof value === "string" && value.trim() !== "";

// Empreintes de longueur fixe : la comparaison ne dépend ni du contenu ni
// de la longueur des valeurs comparées.
const digest = (value) =>
  crypto.createHash("sha256").update(value, "utf8").digest();

/**
 * Secrets acceptés en réception : principal puis ALT, valeurs vides ignorées.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
export function getAcceptedInternalSecrets(env = process.env) {
  return [env.INTERNAL_API_SECRET, env.INTERNAL_API_SECRET_ALT].filter(
    isUsable,
  );
}

/**
 * Le secret reçu correspond-il à l'un des secrets acceptés ?
 * Chaque secret accepté est comparé (pas de sortie anticipée), en temps
 * constant.
 * @param {unknown} provided
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isAcceptedInternalSecret(provided, env = process.env) {
  if (typeof provided !== "string" || provided === "") return false;

  const providedDigest = digest(provided);
  let match = false;
  for (const secret of getAcceptedInternalSecrets(env)) {
    match = crypto.timingSafeEqual(providedDigest, digest(secret)) || match;
  }
  return match;
}

/**
 * La requête porte-t-elle un secret interne valide ? (sans répondre)
 * @param {import("express").Request} req
 * @returns {boolean}
 */
export function hasInternalSecret(req) {
  return isAcceptedInternalSecret(req?.headers?.[INTERNAL_SECRET_HEADER]);
}

/**
 * Middleware Express : exige un secret interne valide.
 * 500 si aucun secret n'est configuré, 401 si le secret reçu est absent ou
 * invalide.
 */
export function requireInternalSecret(req, res, next) {
  if (getAcceptedInternalSecrets().length === 0) {
    logger.error(
      "[internal-secret] INTERNAL_API_SECRET non défini : accès refusé",
    );
    return res
      .status(500)
      .json({ success: false, error: "Configuration serveur manquante" });
  }
  if (!hasInternalSecret(req)) {
    return res.status(401).json({ success: false, error: "Non autorisé" });
  }
  return next();
}
