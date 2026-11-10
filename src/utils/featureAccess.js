/**
 * Accès anticipé : fonctionnalités livrées en production mais réservées à
 * quelques espaces, le temps de les éprouver en conditions réelles avant de
 * les ouvrir à tous.
 *
 * BETA_FEATURES       fonctionnalités réservées, séparées par des virgules
 *                     (vat, appointments, documentShares, socialPublishing) ;
 *                     « none » = aucune. Absente ou vide : toutes réservées
 *                     en production, aucune ailleurs (local, CI, staging),
 *                     pour qu'un oubli de variable n'ouvre rien à tout le
 *                     monde.
 * BETA_WORKSPACE_IDS  espaces qui ont accès aux fonctionnalités réservées.
 *
 * Ouvrir une fonctionnalité à tous = la retirer de BETA_FEATURES puis
 * recharger l'API, sans nouvelle version.
 */
import { AppError, ERROR_CODES } from "./errors.js";

export const BETA_FEATURE_KEYS = Object.freeze([
  "vat",
  "appointments",
  "documentShares",
  "socialPublishing",
]);

export const FEATURE_NOT_AVAILABLE = "FEATURE_NOT_AVAILABLE";

const parseList = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function assertKnownFeature(feature) {
  if (!BETA_FEATURE_KEYS.includes(feature)) {
    throw new Error(`Fonctionnalité inconnue : ${feature}`);
  }
}

/** Fonctionnalités réservées aux espaces de BETA_WORKSPACE_IDS. */
export function restrictedFeatures(env = process.env) {
  const list = parseList(env.BETA_FEATURES);
  if (!list.length) {
    return new Set(env.NODE_ENV === "production" ? BETA_FEATURE_KEYS : []);
  }
  if (list.length === 1 && list[0].toLowerCase() === "none") return new Set();
  return new Set(list);
}

export function isFeatureRestricted(feature, env = process.env) {
  assertKnownFeature(feature);
  return restrictedFeatures(env).has(feature);
}

/** Vrai si l'espace a accès à la fonctionnalité. */
export function isFeatureEnabled(feature, workspaceId, env = process.env) {
  if (!isFeatureRestricted(feature, env)) return true;
  if (workspaceId == null || workspaceId === "") return false;
  return parseList(env.BETA_WORKSPACE_IDS).includes(String(workspaceId));
}

/** Accès de l'espace à chaque fonctionnalité, ex. { vat: true, … }. */
export function workspaceFeatures(workspaceId, env = process.env) {
  return Object.fromEntries(
    BETA_FEATURE_KEYS.map((feature) => [
      feature,
      isFeatureEnabled(feature, workspaceId, env),
    ]),
  );
}

export const featureUnavailableError = () =>
  new AppError(
    "Cette fonctionnalité n'est pas encore disponible pour votre espace.",
    ERROR_CODES.FORBIDDEN,
    { reason: FEATURE_NOT_AVAILABLE },
  );

/**
 * Tous les espaces qu'une requête GraphQL peut viser : withRBAC retient l'un
 * d'eux selon l'ordre propre au resolver (argument ou en-tête d'abord).
 */
function requestedWorkspaceIds(args, context) {
  const headers = context?.req?.headers || {};
  return [
    args?.workspaceId,
    args?.organizationId,
    headers["x-organization-id"],
    headers["x-workspace-id"],
  ]
    .filter((id) => id != null && id !== "")
    .map(String);
}

/**
 * Refuse la requête si l'un des espaces visés n'a pas accès : quel que soit
 * celui que withRBAC retient ensuite, il a donc accès. Sans espace visé,
 * withRBAC prendrait l'espace par défaut de l'utilisateur : refusé aussi.
 */
export function assertFeatureForRequest(feature, args, context) {
  if (!isFeatureRestricted(feature)) return;
  const ids = requestedWorkspaceIds(args, context);
  if (!ids.length || !ids.every((id) => isFeatureEnabled(feature, id))) {
    throw featureUnavailableError();
  }
}

/**
 * Enveloppe chaque champ Query et Mutation d'un jeu de resolvers (sauf
 * `except`) : la fonctionnalité doit être ouverte à l'espace visé.
 */
export function gateFeatureResolvers(feature, resolvers, { except = [] } = {}) {
  assertKnownFeature(feature);
  const wrapFields = (fields) =>
    Object.fromEntries(
      Object.entries(fields).map(([name, resolve]) => [
        name,
        typeof resolve !== "function" || except.includes(name)
          ? resolve
          : async (parent, args, context, info) => {
              assertFeatureForRequest(feature, args, context);
              return resolve(parent, args, context, info);
            },
      ]),
    );
  const gated = { ...resolvers };
  if (resolvers.Query) gated.Query = wrapFields(resolvers.Query);
  if (resolvers.Mutation) gated.Mutation = wrapFields(resolvers.Mutation);
  return gated;
}
