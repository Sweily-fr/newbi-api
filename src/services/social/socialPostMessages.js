import { AppError, ERROR_CODES } from "../../utils/errors.js";
import logger from "../../utils/logger.js";
import { DirectApiError } from "./direct/directHttp.js";
import { SocialProviderError } from "./providers/zernioProvider.js";
import { platformLabel } from "./socialPostRules.js";

/**
 * Messages français prêts à afficher (le site les montre tels quels dans un
 * toast) : erreurs métier, erreurs du fournisseur et échecs de publication
 * par réseau.
 */

export const FEATURE_UNAVAILABLE_MESSAGE =
  "La publication sur les réseaux sociaux n'est pas encore disponible";
export const PROVIDER_DOWN_MESSAGE =
  "Le service de publication ne répond pas. Réessayez dans quelques minutes.";
export const CONNECT_UNAVAILABLE_MESSAGE =
  "Connexion momentanément indisponible, contactez le support Newbi";
export const CANCEL_FAILED_MESSAGE =
  "Impossible d'annuler la publication programmée sur les réseaux sociaux. Réessayez dans quelques instants.";

// Refus métier (message affiché tel quel, journalisé discrètement)
export const userError = (message) =>
  new AppError(message, ERROR_CODES.VALIDATION_ERROR);
export const notFoundError = (message) =>
  new AppError(message, ERROR_CODES.NOT_FOUND);
// Fournisseur injoignable : refus attendu, pas un incident de l'API
const providerDownError = (message = PROVIDER_DOWN_MESSAGE) =>
  new AppError(message, "SOCIAL_PROVIDER_UNAVAILABLE");

/**
 * Échec d'une cible (traduit depuis errorCategory du fournisseur).
 * @returns {string|null}
 */
export function targetErrorMessage(target) {
  if (!target || target.status !== "failed") return null;
  const network = platformLabel(target.platform);
  switch (target.errorCategory) {
    case "auth_expired":
      return `La connexion à ${network} a expiré. Reconnectez le compte dans Paramètres > Intégrations.`;
    case "user_content":
      return `${network} a refusé le contenu : ${target.errorMessage || "contenu non conforme"}`;
    case "user_abuse":
    case "platform_rate_limit":
    case "quota_exhausted":
      return `${network} limite le nombre de publications. Réessayez plus tard.`;
    case "account_issue":
      return `Le compte ${network} n'est pas configuré pour publier (ex. Instagram doit être un compte professionnel).`;
    case "platform_rejected":
      return `${network} a refusé ce post.`;
    default:
      return `La publication sur ${network} a échoué. Réessayez dans quelques minutes.`;
  }
}

// Réseau d'une erreur de nos propres applis → nom affiché
const NETWORK_LABELS = {
  meta: "Facebook",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  x: "X",
  twitter: "X",
};

/** Erreur d'une API de réseau (publication directe) → erreur affichable. */
function directToUserError(error, action) {
  const label = NETWORK_LABELS[error.network] || "Le réseau social";
  const log = `[SocialPost] ${label} en direct (${action}) : ${error.message} [kind=${error.kind} status=${error.status} code=${error.code}]`;
  if (error.kind === "config") {
    logger.error(log);
    return userError(FEATURE_UNAVAILABLE_MESSAGE);
  }
  logger.warn(log);
  if (error.authInvalid) {
    return userError(
      `La connexion à ${label} a expiré. Reconnectez le compte dans Paramètres > Intégrations.`,
    );
  }
  if (error.transient) {
    return providerDownError(
      action === "cancel"
        ? CANCEL_FAILED_MESSAGE
        : `${label} ne répond pas. Réessayez dans quelques minutes.`,
    );
  }
  if (
    ["quota_exhausted", "platform_rate_limit", "user_abuse"].includes(
      error.category,
    )
  ) {
    return userError(
      `${label} limite le nombre de publications. Réessayez plus tard.`,
    );
  }
  if (action === "connect") {
    return userError(`Connexion à ${label} impossible. Réessayez.`);
  }
  return userError(`${label} a refusé la demande.`);
}

/**
 * Erreur du fournisseur → erreur affichable. Les autres erreurs (déjà des
 * AppError, ou bugs) sont renvoyées telles quelles.
 * @param {Error} error
 * @param {"connect"|"account"|"media"|"create"|"update"|"cancel"|"retry"|"read"} action
 */
export function toUserError(error, action) {
  if (error instanceof DirectApiError) return directToUserError(error, action);
  if (!(error instanceof SocialProviderError)) return error;

  const log = `[SocialPost] Zernio (${action}) : ${error.message} [kind=${error.kind} status=${error.status} code=${error.code}]`;
  if (error.kind === "config") return userError(FEATURE_UNAVAILABLE_MESSAGE);

  if (error.status === 401) {
    logger.error(`${log} : clé ZERNIO_API_KEY refusée`);
    return providerDownError(
      "La publication sur les réseaux sociaux est momentanément indisponible. Réessayez plus tard.",
    );
  }
  if (error.status === 402) {
    // Barrière de facturation chez Zernio (carte exigée pour X, offre
    // gratuite dépassée) : à régler par l'équipe Newbi
    logger.error(`${log} : barrière de facturation Zernio (${error.reason})`);
    return providerDownError(
      action === "connect"
        ? CONNECT_UNAVAILABLE_MESSAGE
        : "La publication est momentanément indisponible, contactez le support Newbi",
    );
  }
  if (error.status === 429) {
    logger.warn(log);
    return userError(
      "Trop de publications en peu de temps sur ce compte. Réessayez plus tard.",
    );
  }
  if (error.transient) {
    logger.warn(log);
    return providerDownError(
      action === "cancel" ? CANCEL_FAILED_MESSAGE : PROVIDER_DOWN_MESSAGE,
    );
  }

  logger.warn(log);
  if (error.status === 403) {
    return userError(
      error.code === "ACCOUNT_DISCONNECTED"
        ? "La connexion à un des comptes sélectionnés a expiré. Reconnectez-le dans Paramètres > Intégrations."
        : "Un des comptes sélectionnés n'est plus accessible. Reconnectez-le dans Paramètres > Intégrations.",
    );
  }
  if (error.status === 409) {
    if (error.code === "idempotency_conflict") {
      return userError(
        "La publication est déjà en cours de traitement. Réessayez dans quelques secondes.",
      );
    }
    if (action === "create") {
      return userError(
        "Ce contenu a déjà été programmé ou publié sur ce compte dans les dernières 24 heures. Modifiez le texte ou les images.",
      );
    }
    return userError(
      "Ce post ne peut plus être modifié : sa publication est en cours ou terminée.",
    );
  }
  if (error.status === 404) {
    return notFoundError(
      action === "connect"
        ? CONNECT_UNAVAILABLE_MESSAGE
        : "Ce post n'existe plus chez le service de publication.",
    );
  }
  if (action === "connect") {
    return userError(`Connexion impossible : ${error.message}`);
  }
  return userError(`Publication refusée : ${error.message}`);
}
