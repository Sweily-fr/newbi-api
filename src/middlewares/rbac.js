import { AppError, ERROR_CODES, publicErrorMessage } from "../utils/errors.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";
import { isAuthenticated } from "./better-auth-jwt.js";
import { getActiveOrganization } from "./org-resolver.js";
import { getActiveOrganizationCached } from "./org-cache.js";
import { isAppTrialEnabled } from "../utils/featureFlags.js";
import { isTrialAppActive } from "../utils/trialApp.js";
import {
  PREDEFINED_ROLES,
  getEffectiveLevels,
  levelsAllowAction,
  levelsAllowLevel,
} from "../config/rolePermissions.js";
import { getEffectiveLevelsFor } from "../services/organizationRoleService.js";
import { isObjectIdString, toObjectIdOrNull } from "../utils/objectIdString.js";

/**
 * ========================================
 * MIDDLEWARE RBAC (Role-Based Access Control)
 * ========================================
 *
 * Intégration complète avec Better Auth pour la gestion des permissions
 * basées sur les rôles d'organisation : rôles prédéfinis (owner, admin,
 * member, viewer, accountant), éventuellement ajustés par le super admin,
 * et rôles personnalisés (role_xxx) de la collection organizationRole
 */

// Cache org+member partagé avec withWorkspace (60 s, lecture en vol unique) :
// voir org-cache.js. invalidateOrgCache reste exporté d'ici pour les appelants.
export { invalidateOrgCache } from "./org-cache.js";

/**
 * Droits par rôle : voir src/config/rolePermissions.js (catalogue unique,
 * grilles par défaut des rôles prédéfinis, rôles personnalisés en base).
 */
const ROLE_PERMISSIONS = Object.fromEntries(
  Object.entries(PREDEFINED_ROLES).map(([key, role]) => [key, role.levels]),
);

// getActiveOrganization is imported from ./org-resolver.js (extracted to break circular dep)

/**
 * Récupère le rôle de l'utilisateur dans l'organisation
 * @param {string} organizationId - ID de l'organisation
 * @param {string} userId - ID de l'utilisateur
 * @returns {Object|null} - Membre avec son rôle ou null
 */
async function getMemberRole(organizationId, userId) {
  try {
    const db = mongoose.connection.db;
    const memberCollection = db.collection("member");

    // Identifiants d'ObjectId seulement (un objet serait un opérateur)
    const orgObjectId = toObjectIdOrNull(organizationId);
    const userObjectId = toObjectIdOrNull(userId);
    if (!orgObjectId || !userObjectId) return null;

    const member = await memberCollection.findOne({
      organizationId: orgObjectId,
      userId: userObjectId,
    });

    if (!member) {
      logger.debug(
        `Membre non trouvé pour org: ${organizationId}, user: ${userId}`,
      );
      return null;
    }

    // ✅ FIX: Normaliser la casse du rôle en minuscules
    // La BDD peut stocker "Owner" ou "Admin" avec majuscule
    const normalizedRole = (member.role || "member").toLowerCase();

    return {
      role: normalizedRole,
      userId: member.userId,
      organizationId: member.organizationId,
      createdAt: member.createdAt,
    };
  } catch (error) {
    logger.error("Erreur lors de la récupération du rôle:", error.message);
    return null;
  }
}

/**
 * Vérifie si un rôle a une permission spécifique sur une ressource
 * @param {string} role - Rôle de l'utilisateur (owner, admin, role_xxx…)
 * @param {string} resource - Ressource (invoices, expenses, etc.)
 * @param {string} action - Action (view, create, edit, delete, etc.)
 * @param {object} [levels] - Grille effective (rôles ajustés ou personnalisés) ;
 *   à défaut, grille par défaut du rôle prédéfini
 * @returns {boolean} - True si autorisé
 */
function hasPermission(role, resource, action, levels = null) {
  const grid = levels || defaultLevelsFor(role);
  if (!grid) return false;
  return levelsAllowAction(grid, resource, action);
}

/**
 * Vérifie si un rôle a un niveau de permission (read, write, delete, admin)
 * @param {string} role - Rôle de l'utilisateur
 * @param {string} resource - Ressource
 * @param {string} level - Niveau de permission (read, write, delete, admin)
 * @param {object} [levels] - Grille effective (voir hasPermission)
 * @returns {boolean} - True si autorisé
 */
function hasPermissionLevel(role, resource, level, levels = null) {
  const grid = levels || defaultLevelsFor(role);
  if (!grid) return false;
  return levelsAllowLevel(grid, resource, level);
}

function defaultLevelsFor(role) {
  const normalizedRole = role?.toLowerCase();
  if (!normalizedRole) {
    logger.warn("Rôle non défini ou null");
    return null;
  }
  const keys = normalizedRole.split(",").map((r) => r.trim());
  if (!keys.some((key) => ROLE_PERMISSIONS[key])) {
    logger.warn(`Rôle inconnu: ${role} (normalisé: ${normalizedRole})`);
    return null;
  }
  return getEffectiveLevels(normalizedRole);
}

/**
 * Middleware RBAC pour les resolvers GraphQL
 * Enrichit le contexte avec les informations d'organisation et de permissions
 *
 * @param {Function} resolver - Resolver GraphQL à exécuter
 * @param {Object} options - Options du middleware
 * @param {string|string[]} options.resource - Ressource concernée (invoices,
 *   expenses, etc.) ; une liste = l'une des ressources suffit
 * @param {string} options.action - Action requise (view, create, edit, delete, etc.)
 * @param {string} options.level - Niveau de permission (read, write, delete, admin)
 * @returns {Function} - Resolver avec vérification RBAC
 */
export const withRBAC = (resolver, options = {}) => {
  // Wrapper interne qui sera appelé après l'authentification
  const rbacResolver = async (parent, args, context, info) => {
    let enrichedContext;
    try {
      // L'authentification a déjà été vérifiée par isAuthenticated
      // context.user existe et est valide

      const userId = context.user._id.toString();

      // ✅ FIX: Récupérer l'organisation demandée depuis le header
      // Le frontend envoie x-organization-id pour indiquer quelle organisation est active
      // preferArgsWorkspace : même ordre que withWorkspace (argument d'abord),
      // pour les resolvers qui en viennent et lisent l'espace de cet ordre
      const requestedOrgId = options.preferArgsWorkspace
        ? args.workspaceId ||
          context.req?.headers?.["x-workspace-id"] ||
          context.req?.headers?.["x-organization-id"]
        : context.req?.headers?.["x-organization-id"] ||
          context.req?.headers?.["x-workspace-id"] ||
          args.workspaceId ||
          args.organizationId;

      // DEBUG: tracer l'origine du requestedOrgId pour diagnostiquer les fuites cross-compte
      if (requestedOrgId) {
        const source = options.preferArgsWorkspace
          ? "preferArgsWorkspace"
          : context.req?.headers?.["x-organization-id"]
            ? "header:x-organization-id"
            : context.req?.headers?.["x-workspace-id"]
              ? "header:x-workspace-id"
              : args.workspaceId
                ? "args.workspaceId"
                : "args.organizationId";
        logger.debug(
          `🔍 RBAC requestedOrgId=${requestedOrgId} source=${source} userId=${userId} op=${info?.fieldName || "?"}`,
        );
      }

      // 2. Organisation active (cache partagé 60 s, voir org-cache.js)
      const organization = await getActiveOrganizationCached(
        userId,
        requestedOrgId,
      );

      // Sécurité : si une organisation précise est demandée (header/args) mais
      // que l'utilisateur n'en est pas membre, on REFUSE. Le fallback silencieux
      // vers l'org par défaut laissait passer des accès cross-organisation et
      // empoisonnait le cache sous la clé de l'org non autorisée (null n'est
      // jamais mis en cache).
      if (!organization && requestedOrgId) {
        logger.warn(
          `⛔ RBAC: userId=${userId} n'est pas membre de org=${requestedOrgId} — accès refusé`,
        );
        throw new AppError(
          "Vous n'êtes pas membre de l'organisation demandée.",
          ERROR_CODES.FORBIDDEN,
        );
      }

      if (!organization) {
        throw new AppError(
          "Aucune organisation active trouvée. Veuillez rejoindre ou créer une organisation.",
          ERROR_CODES.FORBIDDEN,
        );
      }

      // 3. Utiliser le rôle déjà récupéré par getActiveOrganization (évite 1 query DB)
      const userRole = organization.memberRole;
      // Grille effective : rôle prédéfini (ajusté ou non) ou personnalisé
      const permissionLevels = await getEffectiveLevelsFor(
        organization.id,
        userRole,
      );

      logger.debug(
        `🔐 RBAC: User ${userId} accède à org ${organization.id} avec rôle ${userRole}`,
      );

      // 4. Vérifier les permissions si spécifiées
      if (options.resource && (options.action || options.level)) {
        let hasAccess = false;

        // Plusieurs ressources : l'une d'elles suffit. Sert aux données lues
        // par plusieurs pages (ex. les comptes bancaires, affichés par
        // Transactions, Vue d'ensemble et Prévision).
        const resources = Array.isArray(options.resource)
          ? options.resource
          : [options.resource];
        if (options.action) {
          // Vérification par action spécifique (une liste : l'une suffit)
          const actions = Array.isArray(options.action)
            ? options.action
            : [options.action];
          hasAccess = resources.some((resource) =>
            actions.some((action) =>
              hasPermission(userRole, resource, action, permissionLevels),
            ),
          );
        } else if (options.level) {
          // Vérification par niveau de permission
          hasAccess = resources.some((resource) =>
            hasPermissionLevel(
              userRole,
              resource,
              options.level,
              permissionLevels,
            ),
          );
        }

        if (!hasAccess) {
          const requiredPermission = options.action || options.level;
          logger.warn(
            `Accès refusé: ${userId} (${userRole}) n'a pas la permission ${requiredPermission} sur ${options.resource}`,
          );

          // Permission et ressource restent dans le journal ci-dessus : le
          // message est affiché tel quel par l'application
          throw new AppError(
            "Vous n'avez pas la permission d'effectuer cette action.",
            ERROR_CODES.FORBIDDEN,
          );
        }
      }

      // 5. Enrichir le contexte avec les informations RBAC
      enrichedContext = {
        ...context,
        workspaceId: organization.id,
        // Exposer l'org VALIDÉE par RBAC (et non le header client brut) pour tous
        // les resolvers qui lisent context.organizationId. Ferme les IDOR où un
        // resolver filtrait sur context.organizationId = x-organization-id non vérifié.
        organizationId: organization.id,
        organization,
        userRole,
        permissionLevels,
        permissions: {
          hasPermission: (resource, action) =>
            hasPermission(userRole, resource, action, permissionLevels),
          hasPermissionLevel: (resource, level) =>
            hasPermissionLevel(userRole, resource, level, permissionLevels),
          canRead: (resource) =>
            hasPermissionLevel(userRole, resource, "read", permissionLevels),
          canWrite: (resource) =>
            hasPermissionLevel(userRole, resource, "write", permissionLevels),
          canDelete: (resource) =>
            hasPermissionLevel(userRole, resource, "delete", permissionLevels),
          canAdmin: (resource) =>
            hasPermissionLevel(userRole, resource, "admin", permissionLevels),
        },
      };

      // Contrôle d'abonnement demandé par une enveloppe extérieure avant que
      // l'espace soit connu : refait ici sur l'espace validé
      const pendingSubscriptionCheck = context[PENDING_SUBSCRIPTION_CHECK];
      if (pendingSubscriptionCheck) {
        delete context[PENDING_SUBSCRIPTION_CHECK];
        delete enrichedContext[PENDING_SUBSCRIPTION_CHECK];
        await checkSubscriptionActive(
          enrichedContext,
          pendingSubscriptionCheck,
        );
      }

      logger.debug(
        `RBAC: ${context.user?.email || context.user?._id} (${userRole}) accède à ${options.resource || "ressource"} avec ${options.action || options.level || "aucune restriction"}`,
      );

      // 6. Exécuter le resolver avec le contexte enrichi (passthroughErrors :
      // hors du try, ses erreurs remontent telles quelles, comme avec withWorkspace)
      if (!options.passthroughErrors) {
        return await resolver(parent, args, enrichedContext, info);
      }
    } catch (error) {
      // Propager les erreurs d'authentification/autorisation
      if (error instanceof AppError) {
        throw error;
      }

      // Gérer les erreurs de validation Mongoose avec un message user-friendly
      if (error instanceof mongoose.Error.ValidationError) {
        const messages = Object.values(error.errors).map((e) => e.message);
        // Message interpolé : winston n'écrit pas les arguments supplémentaires
        // dans les fichiers, le détail (« Le prénom est requis… ») était perdu.
        logger.warn(
          `Erreur de validation dans ${resolver.name || "resolver"} (${info?.fieldName || "?"}): ${messages.join(", ")}`,
        );
        throw new AppError(
          messages.length === 1
            ? messages[0]
            : `Veuillez corriger les erreurs suivantes : ${messages.join(", ")}`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      // Logger les erreurs inattendues avec stack trace complète
      // (message interpolé : winston n'écrit pas les arguments supplémentaires
      // dans les fichiers, ce qui rendait ces erreurs illisibles)
      logger.error(
        `Erreur RBAC dans ${resolver.name || "resolver"}: ${error.message}`,
      );
      logger.error(`Stack trace: ${error.stack}`);
      // Message d'une erreur technique (base, identifiant mal formé, bug)
      // gardé dans le journal ci-dessus, jamais renvoyé au client
      throw new AppError(
        `Erreur lors de la vérification des permissions: ${publicErrorMessage(error)}`,
        ERROR_CODES.INTERNAL_ERROR,
      );
    }
    return resolver(parent, args, enrichedContext, info);
  };

  // Appliquer d'abord l'authentification, puis RBAC
  return isAuthenticated(rbacResolver);
};

/**
 * ========================================
 * SUBSCRIPTION CHECK MIDDLEWARE
 * ========================================
 *
 * Vérifie que l'abonnement de l'organisation est actif avant d'autoriser
 * les mutations write/delete. Les queries (read) et les exports restent
 * toujours accessibles (obligation légale FR 10 ans pour les factures).
 *
 * Statuts autorisés : active, trialing, past_due (grace period Stripe)
 * Statuts bloqués : canceled (period ended), unpaid, incomplete, expired, null
 *
 * Options:
 *   failClosed (default false) — Si true, bloque la mutation quand la DB
 *   est inaccessible au lieu de laisser passer. À utiliser pour les mutations
 *   qui appellent des services externes payants (banking, OCR, Pennylane).
 */
export const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

// ✅ Cache LRU pour le statut subscription — évite 1 query DB par mutation protégée
const SUB_CACHE_TTL = 30_000; // 30 secondes
const SUB_CACHE_MAX = 500;
const _subCache = new Map();

function getCachedSub(orgId) {
  const entry = _subCache.get(orgId);
  if (!entry) return undefined; // undefined = cache miss
  if (Date.now() - entry.ts > SUB_CACHE_TTL) {
    _subCache.delete(orgId);
    return undefined;
  }
  return entry.sub; // peut être null (= pas de subscription trouvée)
}

function setCachedSub(orgId, sub) {
  if (_subCache.size >= SUB_CACHE_MAX) {
    const oldestKey = _subCache.keys().next().value;
    _subCache.delete(oldestKey);
  }
  _subCache.set(orgId, { sub, ts: Date.now() });
}

// Permet d'invalider le cache subscription depuis l'extérieur (ex: webhook Stripe)
export function invalidateSubCache(orgId) {
  if (orgId) {
    _subCache.delete(orgId);
  } else {
    _subCache.clear();
  }
}

// ✅ Cache LRU pour le trial app-managed — séparé du sub cache pour permettre
// une invalidation indépendante (ex: cron de cleanup trial, souscription Stripe).
// Stocke un objet { isTrialActive, trialEndDate, stripeTrialActive } ou null.
const TRIAL_CACHE_TTL = 30_000;
const _trialCache = new Map();

function getCachedTrial(orgId) {
  const entry = _trialCache.get(orgId);
  if (!entry) return undefined; // undefined = cache miss
  if (Date.now() - entry.ts > TRIAL_CACHE_TTL) {
    _trialCache.delete(orgId);
    return undefined;
  }
  return entry.flags;
}

function setCachedTrial(orgId, flags) {
  if (_trialCache.size >= SUB_CACHE_MAX) {
    const oldestKey = _trialCache.keys().next().value;
    _trialCache.delete(oldestKey);
  }
  _trialCache.set(orgId, { flags, ts: Date.now() });
}

export function invalidateTrialCache(orgId) {
  if (orgId) {
    _trialCache.delete(orgId);
  } else {
    _trialCache.clear();
  }
}

// Contrôle d'abonnement demandé avant que l'espace soit validé (enveloppes
// posées autour de toutes les mutations d'un fichier, appelées avant le RBAC
// du resolver) : withRBAC le refait sur l'espace qu'il a validé, celui que lit
// le resolver. Remis à zéro au début de chaque mutation (resolvers/index.js).
const PENDING_SUBSCRIPTION_CHECK = Symbol("pendingSubscriptionCheck");

export function clearPendingSubscriptionCheck(context) {
  if (context && typeof context === "object") {
    delete context[PENDING_SUBSCRIPTION_CHECK];
  }
}

/**
 * Vérifie l'abonnement de l'espace sur lequel porte la requête.
 *
 * Espace établi côté serveur (context.workspaceId posé par withRBAC ou
 * withWorkspace après contrôle d'appartenance, context.organization, ou
 * l'espace passé par une route REST ou un service) : contrôlé directement.
 *
 * Sans espace établi (enveloppe extérieure, avant le RBAC du resolver) :
 * - le contrôle est différé : withRBAC le refait sur l'espace validé, quels
 *   que soient les en-têtes et l'argument workspaceId envoyés ;
 * - chaque espace nommé par les en-têtes x-workspace-id et x-organization-id
 *   est contrôlé dès maintenant (resolvers qui lisent ces en-têtes sans
 *   passer par le RBAC).
 */
export async function checkSubscriptionActive(
  context,
  { failClosed = false } = {},
) {
  const orgId = context.workspaceId || context.organization?.id;
  if (orgId) {
    return checkWorkspaceSubscription(String(orgId), { failClosed });
  }

  const pending = context[PENDING_SUBSCRIPTION_CHECK];
  context[PENDING_SUBSCRIPTION_CHECK] = {
    failClosed: failClosed || Boolean(pending?.failClosed),
  };

  const headerOrgIds = new Set(
    [
      context.req?.headers?.["x-workspace-id"],
      context.req?.headers?.["x-organization-id"],
    ].filter((value) => typeof value === "string" && value),
  );
  for (const headerOrgId of headerOrgIds) {
    await checkWorkspaceSubscription(headerOrgId, { failClosed });
  }
}

async function checkWorkspaceSubscription(orgId, { failClosed }) {
  logger.debug(`[SubCheck] orgId=${orgId}`);

  // App-managed trial check (feature-flagged). When ENABLE_APP_TRIAL is OFF
  // (default), this block is skipped entirely and the legacy Stripe-based
  // gating below runs unchanged — zero behavioural change for existing users.
  if (isAppTrialEnabled()) {
    let trialFlags = getCachedTrial(orgId);
    if (trialFlags === undefined) {
      try {
        const db = mongoose.connection.db;
        if (db) {
          const orgObjectId = mongoose.Types.ObjectId.isValid(orgId)
            ? new mongoose.Types.ObjectId(orgId)
            : null;
          const orgDoc = orgObjectId
            ? await db.collection("organization").findOne(
                { _id: orgObjectId },
                {
                  projection: {
                    isTrialActive: 1,
                    trialEndDate: 1,
                    stripeTrialActive: 1,
                  },
                },
              )
            : null;
          trialFlags = orgDoc
            ? {
                isTrialActive: orgDoc.isTrialActive,
                trialEndDate: orgDoc.trialEndDate,
                stripeTrialActive: orgDoc.stripeTrialActive,
              }
            : null;
          setCachedTrial(orgId, trialFlags);
        }
      } catch (err) {
        // Lookup failure is non-fatal — fall through to the Stripe check.
        logger.warn(
          `[SubCheck] trial lookup failed orgId=${orgId}: ${err.message}`,
        );
        trialFlags = null;
      }
    }
    if (isTrialAppActive(trialFlags)) {
      logger.debug(`[SubCheck] app-trial active orgId=${orgId}`);
      return; // Trial app-managed actif → accès complet, court-circuit Stripe
    }
  }

  try {
    // Vérifier le cache d'abord
    let sub = getCachedSub(orgId);
    if (sub === undefined) {
      // Cache miss → query via driver MongoDB natif (pas Mongoose model)
      // La collection "subscription" est gérée par Better Auth Stripe plugin,
      // pas de schéma Mongoose enregistré — mongoose.model("subscription") échoue.
      const db = mongoose.connection.db;
      if (!db) {
        throw new Error("MongoDB connection not ready");
      }
      sub = await db.collection("subscription").findOne({ referenceId: orgId });
      setCachedSub(orgId, sub); // Cache même si null
      logger.debug(
        `[SubCheck] MISS orgId=${orgId} status=${sub?.status || "null"}`,
      );
    } else {
      logger.debug(
        `[SubCheck] HIT orgId=${orgId} status=${sub?.status || "null"}`,
      );
    }

    if (!sub) {
      throw new AppError(
        "Votre abonnement est inactif. Renouvelez pour effectuer cette action.",
        ERROR_CODES.SUBSCRIPTION_READ_ONLY,
      );
    }

    // Canceled mais encore dans la période payée = OK
    if (sub.status === "canceled" && sub.periodEnd) {
      if (new Date(sub.periodEnd) > new Date()) return; // Encore valide
    }

    if (!ACTIVE_SUBSCRIPTION_STATUSES.includes(sub.status)) {
      throw new AppError(
        "Votre abonnement est inactif. Renouvelez pour effectuer cette action.",
        ERROR_CODES.SUBSCRIPTION_READ_ONLY,
      );
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error("Erreur vérification abonnement:", error.message);
    if (failClosed) {
      throw new AppError(
        "Impossible de vérifier l'abonnement. Réessayez.",
        ERROR_CODES.SUBSCRIPTION_READ_ONLY,
      );
    }
    // fail-open par défaut pour ne pas bloquer les users sur des erreurs DB transitoires
  }
}

/**
 * Middleware standalone pour les mutations qui n'utilisent pas requireWrite/requireDelete
 * Usage: requireActiveSubscription(withWorkspace(resolver))
 * Usage fail-closed: requireActiveSubscription(withWorkspace(resolver), { failClosed: true })
 */
export const requireActiveSubscription = (
  resolver,
  { failClosed = false } = {},
) => {
  return async (parent, args, context, info) => {
    await checkSubscriptionActive(context, { failClosed });
    return resolver(parent, args, context, info);
  };
};

/**
 * Espace dont l'abonnement est contrôlé : exactement celui que lira le
 * handler.
 *   1. `req.workspaceId`, posé par requireWorkspaceMembership /
 *      requireWorkspace(Action)Permission (espace validé, en-tête
 *      x-workspace-id réécrit) : routes banking, banking-cache,
 *      banking-sync, banking-connect ;
 *   2. sinon, l'ordre des handlers sans ce middleware (reconciliation :
 *      x-workspace-id puis ?workspaceId), le corps en dernier.
 * L'ancien ordre (x-workspace-id puis corps) contrôlait l'abonnement d'un
 * espace choisi dans le corps quand le handler lisait ?workspaceId : un
 * espace sans abonnement passait en citant celui d'un autre.
 */
export function subscriptionWorkspaceIdOf(req) {
  return (
    req.workspaceId ||
    req.headers["x-workspace-id"] ||
    req.query?.workspaceId ||
    req.body?.workspaceId
  );
}

/**
 * Middleware Express pour les routes REST qui nécessitent un abonnement actif.
 * Espace contrôlé : voir subscriptionWorkspaceIdOf (placer
 * requireWorkspaceMembership avant quand la route l'utilise).
 *
 * Usage: router.post("/route", requireActiveSubscriptionREST(), handler)
 * Usage fail-closed: router.post("/route", requireActiveSubscriptionREST({ failClosed: true }), handler)
 */
export const requireActiveSubscriptionREST = ({ failClosed = false } = {}) => {
  return async (req, res, next) => {
    try {
      const orgId = subscriptionWorkspaceIdOf(req);
      if (!orgId) {
        return res.status(400).json({ error: "Workspace ID requis" });
      }
      // Un objet ({ "$ne": null }) trouvait l'abonnement actif d'un autre
      // espace (filtre referenceId) : identifiant d'ObjectId exigé
      if (!isObjectIdString(orgId)) {
        return res.status(400).json({ error: "Identifiant d'espace invalide" });
      }
      // Build a minimal context object compatible with checkSubscriptionActive
      await checkSubscriptionActive({ workspaceId: orgId }, { failClosed });
      next();
    } catch (error) {
      if (error.code === ERROR_CODES.SUBSCRIPTION_READ_ONLY) {
        return res.status(403).json({
          error: "SUBSCRIPTION_READ_ONLY",
          message: error.message,
        });
      }
      return res.status(500).json({ error: "Erreur serveur" });
    }
  };
};

/**
 * Helpers pour les cas d'usage courants
 */

// Lecture seule (view) — PAS de check subscription
export const requireRead =
  (resource, options = {}) =>
  (resolver) =>
    withRBAC(resolver, {
      resource,
      level: "read",
      preferArgsWorkspace: options.preferArgsWorkspace,
    });

// Écriture (create, edit) — AVEC check subscription
export const requireWrite =
  (resource, options = {}) =>
  (resolver) => {
    const rbacOptions = {
      resource,
      level: "write",
      preferArgsWorkspace: options.preferArgsWorkspace,
    };
    if (options.skipSubscriptionCheck) return withRBAC(resolver, rbacOptions);
    return async (parent, args, context, info) => {
      // RBAC s'exécute d'abord (enrichit context avec workspaceId)
      // On intercale le check subscription dans le resolver wrappé
      const patchedResolver = async (p, a, ctx, i) => {
        await checkSubscriptionActive(ctx);
        return resolver(p, a, ctx, i);
      };
      return withRBAC(patchedResolver, rbacOptions)(
        parent,
        args,
        context,
        info,
      );
    };
  };

// Suppression — AVEC check subscription
export const requireDelete =
  (resource, options = {}) =>
  (resolver) => {
    const rbacOptions = {
      resource,
      level: "delete",
      preferArgsWorkspace: options.preferArgsWorkspace,
    };
    if (options.skipSubscriptionCheck) return withRBAC(resolver, rbacOptions);
    return async (parent, args, context, info) => {
      const patchedResolver = async (p, a, ctx, i) => {
        await checkSubscriptionActive(ctx);
        return resolver(p, a, ctx, i);
      };
      return withRBAC(patchedResolver, rbacOptions)(
        parent,
        args,
        context,
        info,
      );
    };
  };

// Administration — PAS de check subscription (gestion org/billing doit rester accessible)
export const requireAdmin = (resource) => (resolver) =>
  withRBAC(resolver, { resource, level: "admin" });

// Permission spécifique
export const requirePermission = (resource, action) => (resolver) =>
  withRBAC(resolver, { resource, action });

// Actions de simple consultation : pas de contrôle d'abonnement
const READ_ACTIONS = new Set(["view", "export", "read", "download"]);

/**
 * Action précise d'une page (case de l'éditeur de rôles) : `create`,
 * `edit`, `send`, `markPaid`… Une liste d'actions = l'une suffit. Les
 * actions d'écriture vérifient aussi l'abonnement, comme requireWrite.
 * Options : skipSubscriptionCheck, preferArgsWorkspace.
 */
export const requireAction =
  (resource, action, options = {}) =>
  (resolver) => {
    const actions = Array.isArray(action) ? action : [action];
    const rbacOptions = {
      resource,
      action: actions,
      preferArgsWorkspace: options.preferArgsWorkspace,
    };
    const readOnly = actions.every((a) => READ_ACTIONS.has(a));
    if (readOnly || options.skipSubscriptionCheck) {
      return withRBAC(resolver, rbacOptions);
    }
    return async (parent, args, context, info) => {
      const patchedResolver = async (p, a, ctx, i) => {
        await checkSubscriptionActive(ctx);
        return resolver(p, a, ctx, i);
      };
      return withRBAC(patchedResolver, rbacOptions)(
        parent,
        args,
        context,
        info,
      );
    };
  };

/**
 * Plusieurs droits exigés ENSEMBLE, sur des pages différentes : liste de
 * couples [page, action], tous requis. Ex. transformer un devis en facture :
 * « Transformer » sur les devis ET « Créer » sur les factures, comme l'écran
 * qui n'affiche l'action qu'avec les deux. Tous les droits sont vérifiés
 * avant l'abonnement (même contrôle que requireAction pour une écriture).
 * Options : skipSubscriptionCheck, preferArgsWorkspace.
 */
export const requireAllActions =
  (checks, options = {}) =>
  (resolver) => {
    const [[resource, action], ...others] = checks;
    const readOnly = checks.every(([, a]) => READ_ACTIONS.has(a));
    return withRBAC(
      async (parent, args, context, info) => {
        for (const [otherResource, otherAction] of others) {
          assertPermissionAction(context, otherResource, otherAction);
        }
        if (!readOnly && !options.skipSubscriptionCheck) {
          await checkSubscriptionActive(context);
        }
        return resolver(parent, args, context, info);
      },
      {
        resource,
        action: [action],
        preferArgsWorkspace: options.preferArgsWorkspace,
      },
    );
  };

/**
 * Comme requireWorkspaceLevel (remplaçant de withWorkspace : argument
 * workspaceId d'abord, erreurs non réécrites, pas de contrôle d'abonnement)
 * mais pour une action précise.
 */
export const requireWorkspaceAction = (resource, action) => (resolver) =>
  withRBAC(resolver, {
    resource,
    action: Array.isArray(action) ? action : [action],
    preferArgsWorkspace: true,
    passthroughErrors: true,
  });

/**
 * Remplaçant de withWorkspace (better-auth-jwt.js) avec contrôle du rôle :
 * même choix d'espace (args.workspaceId d'abord), même contexte
 * (context.workspaceId), erreurs du resolver non réécrites, et AUCUN
 * contrôle d'abonnement ajouté (ceux qui en avaient un le gardent via
 * requireActiveSubscription autour).
 */
export const requireWorkspaceLevel = (resource, level) => (resolver) =>
  withRBAC(resolver, {
    resource,
    level,
    preferArgsWorkspace: true,
    passthroughErrors: true,
  });

/**
 * Contrôle d'une action précise dans le corps d'un resolver déjà passé par
 * withRBAC / withOrganization / require* (ex. changer le statut d'une
 * facture : « status » pour annuler, « edit » sinon). Lève FORBIDDEN.
 */
export function assertPermissionAction(context, resource, action) {
  const allowed = context?.permissions?.hasPermission?.(resource, action);
  if (!allowed) {
    logger.warn(
      `Accès refusé: ${context?.user?._id} (${context?.userRole}) n'a pas l'action ${action} sur ${resource}`,
    );
    throw new AppError(
      "Vous n'avez pas la permission d'effectuer cette action.",
      ERROR_CODES.FORBIDDEN,
    );
  }
}

/**
 * Changement de statut d'un document : action exigée selon le statut visé.
 *   - valider un brouillon (`finalStatus`) : fait partie de la création, donc
 *     « Créer » ou « Modifier » ;
 *   - repasser en brouillon : « Modifier » ;
 *   - facture payée : « Marquer comme payée » ;
 *   - tout autre statut (accepter, refuser, annuler, expédier…) : « status ».
 */
export function assertStatusChangeAllowed(
  context,
  resource,
  status,
  finalStatus,
) {
  const actions =
    status === finalStatus
      ? ["create", "edit"]
      : status === "DRAFT"
        ? ["edit"]
        : resource === "invoices" && status === "COMPLETED"
          ? ["markPaid"]
          : ["status"];
  const allowed = actions.some((action) =>
    context?.permissions?.hasPermission?.(resource, action),
  );
  if (!allowed) {
    logger.warn(
      `Accès refusé: ${context?.user?._id} (${context?.userRole}) ne peut pas passer ${resource} au statut ${status}`,
    );
    throw new AppError(
      "Vous n'avez pas la permission d'effectuer cette action.",
      ERROR_CODES.FORBIDDEN,
    );
  }
}

// Actions qui peuvent ouvrir un changement de statut (contrôle précis ensuite)
export const STATUS_CHANGE_ACTIONS = ["create", "edit", "status", "markPaid"];

/**
 * Contrôle dans le corps d'un resolver déjà passé par withRBAC /
 * withOrganization (contexte enrichi) : lève FORBIDDEN si le niveau manque.
 */
export function assertPermissionLevel(context, resource, level) {
  const allowed = context?.permissions?.hasPermissionLevel?.(resource, level);
  if (!allowed) {
    logger.warn(
      `Accès refusé: ${context?.user?._id} (${context?.userRole}) n'a pas la permission ${level} sur ${resource}`,
    );
    throw new AppError(
      "Vous n'avez pas la permission d'effectuer cette action.",
      ERROR_CODES.FORBIDDEN,
    );
  }
}

/**
 * Middleware pour les resolvers qui nécessitent seulement l'authentification
 * et l'enrichissement du contexte avec l'organisation, sans vérification de permission
 */
export const withOrganization = (resolver) => {
  return withRBAC(resolver, {}); // Pas de vérification de permission
};

/**
 * Résout le workspaceId à utiliser dans un resolver.
 * En cas de mismatch entre input (args) et context (RBAC), privilégie le context
 * car il a déjà été validé par le middleware RBAC (appartenance confirmée).
 * Évite de throw lors d'un switch de compte où le frontend envoie un ID stale.
 */
export function resolveWorkspaceId(inputWorkspaceId, contextWorkspaceId) {
  if (
    inputWorkspaceId &&
    contextWorkspaceId &&
    inputWorkspaceId !== contextWorkspaceId
  ) {
    logger.warn(
      `⚠️ resolveWorkspaceId: mismatch input=${inputWorkspaceId} vs context=${contextWorkspaceId}, utilisation du context (validé par RBAC)`,
    );
    return contextWorkspaceId;
  }
  return inputWorkspaceId || contextWorkspaceId;
}

/**
 * Export des fonctions utilitaires pour usage externe
 */
export {
  getActiveOrganization,
  getMemberRole,
  hasPermission,
  hasPermissionLevel,
  ROLE_PERMISSIONS,
};
