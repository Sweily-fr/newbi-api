import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";
import { isAuthenticated } from "./better-auth-jwt.js";

/**
 * ========================================
 * MIDDLEWARE RBAC (Role-Based Access Control)
 * ========================================
 *
 * Intégration complète avec Better Auth pour la gestion des permissions
 * basées sur les rôles d'organisation (owner, admin, member, accountant)
 */

// ✅ Cache LRU pour org+member — évite 2-3 queries DB par resolver protégé
const ORG_CACHE_TTL = 60_000; // 60 secondes (org/member changent rarement)
const ORG_CACHE_MAX = 500;
const _orgCache = new Map();

function getCachedOrg(cacheKey) {
  const entry = _orgCache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() - entry.ts > ORG_CACHE_TTL) {
    _orgCache.delete(cacheKey);
    return null;
  }
  return entry.org;
}

function setCachedOrg(cacheKey, org) {
  if (_orgCache.size >= ORG_CACHE_MAX) {
    const oldestKey = _orgCache.keys().next().value;
    _orgCache.delete(oldestKey);
  }
  _orgCache.set(cacheKey, { org, ts: Date.now() });
}

// Permet d'invalider le cache org depuis l'extérieur
export function invalidateOrgCache(userId) {
  if (userId) {
    for (const key of _orgCache.keys()) {
      if (key.startsWith(`${userId}:`)) _orgCache.delete(key);
    }
  } else {
    _orgCache.clear();
  }
}

/**
 * Définition des permissions par rôle
 * Aligné avec /newbiv2/src/lib/permissions.js
 */
const ROLE_PERMISSIONS = {
  owner: {
    // Owner a tous les droits
    quotes: [
      "view",
      "create",
      "edit",
      "delete",
      "approve",
      "convert",
      "send",
      "export",
    ],
    purchaseOrders: [
      "view",
      "create",
      "edit",
      "delete",
      "approve",
      "convert",
      "send",
      "export",
    ],
    invoices: [
      "view",
      "create",
      "edit",
      "delete",
      "approve",
      "send",
      "export",
      "mark-paid",
      "import",
    ],
    creditNotes: ["view", "create", "edit", "delete", "approve", "send"],
    expenses: ["view", "create", "edit", "delete", "approve", "export", "ocr"],
    payments: ["view", "create", "edit", "delete", "export"],
    clients: ["view", "create", "edit", "delete", "export"],
    products: [
      "view",
      "create",
      "edit",
      "delete",
      "export",
      "manage-categories",
    ],
    suppliers: ["view", "create", "edit", "delete"],
    fileTransfers: ["view", "create", "delete", "download"],
    sharedDocuments: ["view", "create", "edit", "delete", "download"],
    kanban: ["view", "create", "edit", "delete", "assign"],
    signatures: ["view", "create", "edit", "delete", "set-default"],
    calendar: ["view", "create", "edit", "delete"],
    reports: ["view", "export"],
    analytics: ["view", "export"],
    team: ["view", "invite", "remove", "change-role"],
    orgSettings: ["view", "manage"],
    integrations: ["view", "manage"],
    billing: ["view", "manage"],
    auditLog: ["view", "export"],
  },

  admin: {
    // Admin a presque tous les droits sauf la gestion de la facturation
    quotes: [
      "view",
      "create",
      "edit",
      "delete",
      "approve",
      "convert",
      "send",
      "export",
    ],
    purchaseOrders: [
      "view",
      "create",
      "edit",
      "delete",
      "approve",
      "convert",
      "send",
      "export",
    ],
    invoices: [
      "view",
      "create",
      "edit",
      "delete",
      "approve",
      "send",
      "export",
      "mark-paid",
      "import",
    ],
    creditNotes: ["view", "create", "edit", "delete", "approve", "send"],
    expenses: ["view", "create", "edit", "delete", "approve", "export", "ocr"],
    payments: ["view", "create", "edit", "delete", "export"],
    clients: ["view", "create", "edit", "delete", "export"],
    products: [
      "view",
      "create",
      "edit",
      "delete",
      "export",
      "manage-categories",
    ],
    suppliers: ["view", "create", "edit", "delete"],
    fileTransfers: ["view", "create", "delete", "download"],
    sharedDocuments: ["view", "create", "edit", "delete", "download"],
    kanban: ["view", "create", "edit", "delete", "assign"],
    signatures: ["view", "create", "edit", "delete", "set-default"],
    calendar: ["view", "create", "edit", "delete"],
    reports: ["view", "export"],
    analytics: ["view", "export"],
    team: ["view", "invite", "remove", "change-role"],
    orgSettings: ["view", "manage"],
    integrations: ["view", "manage"],
    billing: ["view"], // ⚠️ Lecture seule
    auditLog: ["view", "export"],
  },

  member: {
    // Member peut créer et gérer ses propres documents + export
    quotes: ["view", "create", "send", "export"],
    purchaseOrders: ["view", "create", "send", "export"],
    invoices: ["view", "create", "send", "export", "import"],
    creditNotes: ["view", "create", "export"],
    expenses: ["view", "create", "ocr", "export"],
    payments: ["view", "create", "export"],
    clients: ["view", "create", "export"],
    products: ["view", "create", "export"],
    suppliers: ["view", "create"],
    fileTransfers: ["view", "create", "download"],
    sharedDocuments: ["view", "create", "edit", "download"],
    kanban: ["view", "create", "edit", "assign"],
    signatures: ["view", "create", "edit", "set-default"],
    calendar: ["view", "create", "edit"],
    reports: ["view", "export"],
    analytics: ["view", "export"],
    team: ["view"],
  },

  accountant: {
    // Accountant a accès aux documents financiers + validation + export
    quotes: ["view", "export"],
    purchaseOrders: ["view", "export"],
    invoices: ["view", "export", "mark-paid", "import"],
    creditNotes: ["view", "export"],
    expenses: ["view", "approve", "export"],
    payments: ["view", "export"],
    clients: ["view", "export"],
    products: ["view", "export"],
    suppliers: ["view"],
    sharedDocuments: ["view", "create", "edit", "delete", "download"],
    reports: ["view", "export"],
    analytics: ["view", "export"],
    team: ["view"],
    auditLog: ["view"],
  },

  viewer: {
    // Viewer a un accès en lecture seule à toutes les ressources
    // Idéal pour les consultants, auditeurs, ou parties prenantes externes
    quotes: ["view"],
    purchaseOrders: ["view"],
    invoices: ["view"],
    creditNotes: ["view"],
    expenses: ["view"],
    payments: ["view"],
    clients: ["view"],
    products: ["view"],
    suppliers: ["view"],
    fileTransfers: ["view", "download"],
    kanban: ["view"],
    signatures: ["view"],
    calendar: ["view"],
    reports: ["view"],
    analytics: ["view"],
    team: ["view"],
  },
};

/**
 * Mapping des permissions simplifiées pour les resolvers
 */
const PERMISSION_MAPPING = {
  read: ["view"],
  write: ["create", "edit"],
  delete: ["delete"],
  admin: ["manage", "approve", "change-role", "invite", "remove"],
};

/**
 * Récupère l'organisation active de l'utilisateur depuis Better Auth
 * @param {string} userId - ID de l'utilisateur
 * @param {string} [requestedOrgId] - ID de l'organisation demandée (depuis le header x-organization-id)
 * @returns {Object|null} - Organisation ou null
 */
async function getActiveOrganization(userId, requestedOrgId = null) {
  try {
    const db = mongoose.connection.db;
    const memberCollection = db.collection("member");
    const { ObjectId } = mongoose.Types;

    // Convertir userId en ObjectId si c'est une string
    const userObjectId =
      typeof userId === "string" ? new ObjectId(userId) : userId;

    let member;

    // ✅ FIX: Si une organisation spécifique est demandée, vérifier que l'utilisateur en est membre
    if (requestedOrgId) {
      const requestedOrgObjectId =
        typeof requestedOrgId === "string"
          ? new ObjectId(requestedOrgId)
          : requestedOrgId;

      member = await memberCollection.findOne({
        userId: userObjectId,
        organizationId: requestedOrgObjectId,
      });

      if (!member) {
        logger.warn(
          `Utilisateur ${userId} n'est pas membre de l'organisation demandée: ${requestedOrgId}`,
        );
        return null;
      }

      logger.debug(
        `✅ Utilisateur ${userId} est membre de l'organisation ${requestedOrgId} avec le rôle ${member.role}`,
      );
    } else {
      // Fallback: récupérer la première organisation (priorité: owner, puis admin, puis autres)
      member = await memberCollection.findOne({
        userId: userObjectId,
        role: "owner",
      });

      if (!member) {
        member = await memberCollection.findOne({
          userId: userObjectId,
          role: "admin",
        });
      }

      if (!member) {
        member = await memberCollection.findOne({
          userId: userObjectId,
        });
      }
    }

    if (!member) {
      logger.debug(`Aucune organisation trouvée pour l'utilisateur: ${userId}`);
      return null;
    }

    // Récupérer les détails de l'organisation
    const organizationCollection = db.collection("organization");
    const orgObjectId =
      typeof member.organizationId === "string"
        ? new ObjectId(member.organizationId)
        : member.organizationId;

    const organization = await organizationCollection.findOne({
      _id: orgObjectId,
    });

    if (!organization) {
      logger.warn(
        `Organisation ${member.organizationId} non trouvée pour le membre`,
      );
      return null;
    }

    // ✅ Retourner le rôle du member directement pour éviter une re-query dans getMemberRole
    const normalizedRole = (member.role || "member").toLowerCase();

    return {
      id: organization._id.toString(),
      name: organization.name,
      slug: organization.slug,
      metadata: organization.metadata,
      createdAt: organization.createdAt,
      memberRole: normalizedRole,
    };
  } catch (error) {
    logger.error(
      "Erreur lors de la récupération de l'organisation:",
      error.message,
    );
    return null;
  }
}

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
    const { ObjectId } = mongoose.Types;

    // Convertir les IDs en ObjectId si nécessaire
    const orgObjectId =
      typeof organizationId === "string"
        ? new ObjectId(organizationId)
        : organizationId;
    const userObjectId =
      typeof userId === "string" ? new ObjectId(userId) : userId;

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
 * @param {string} role - Rôle de l'utilisateur (owner, admin, member, accountant)
 * @param {string} resource - Ressource (invoices, expenses, etc.)
 * @param {string} action - Action (view, create, edit, delete, etc.)
 * @returns {boolean} - True si autorisé
 */
function hasPermission(role, resource, action) {
  // ✅ FIX: Normaliser la casse du rôle en minuscules pour éviter les erreurs
  // La BDD peut stocker "Owner" mais ROLE_PERMISSIONS utilise "owner"
  const normalizedRole = role?.toLowerCase();

  if (!normalizedRole) {
    logger.warn("Rôle non défini ou null");
    return false;
  }

  const rolePermissions = ROLE_PERMISSIONS[normalizedRole];

  if (!rolePermissions) {
    logger.warn(`Rôle inconnu: ${role} (normalisé: ${normalizedRole})`);
    return false;
  }

  const resourcePermissions = rolePermissions[resource];

  if (!resourcePermissions) {
    // Si la ressource n'est pas définie, pas d'accès
    return false;
  }

  return resourcePermissions.includes(action);
}

/**
 * Vérifie si un rôle a un niveau de permission (read, write, delete, admin)
 * @param {string} role - Rôle de l'utilisateur
 * @param {string} resource - Ressource
 * @param {string} level - Niveau de permission (read, write, delete, admin)
 * @returns {boolean} - True si autorisé
 */
function hasPermissionLevel(role, resource, level) {
  const actions = PERMISSION_MAPPING[level] || [];

  // Vérifier si au moins une action du niveau est autorisée
  return actions.some((action) => hasPermission(role, resource, action));
}

/**
 * Middleware RBAC pour les resolvers GraphQL
 * Enrichit le contexte avec les informations d'organisation et de permissions
 *
 * @param {Function} resolver - Resolver GraphQL à exécuter
 * @param {Object} options - Options du middleware
 * @param {string} options.resource - Ressource concernée (invoices, expenses, etc.)
 * @param {string} options.action - Action requise (view, create, edit, delete, etc.)
 * @param {string} options.level - Niveau de permission (read, write, delete, admin)
 * @returns {Function} - Resolver avec vérification RBAC
 */
export const withRBAC = (resolver, options = {}) => {
  // Wrapper interne qui sera appelé après l'authentification
  const rbacResolver = async (parent, args, context, info) => {
    try {
      // L'authentification a déjà été vérifiée par isAuthenticated
      // context.user existe et est valide

      const userId = context.user._id.toString();

      // ✅ FIX: Récupérer l'organisation demandée depuis le header
      // Le frontend envoie x-organization-id pour indiquer quelle organisation est active
      const requestedOrgId =
        context.req?.headers?.["x-organization-id"] ||
        context.req?.headers?.["x-workspace-id"] ||
        args.workspaceId ||
        args.organizationId;

      // DEBUG: tracer l'origine du requestedOrgId pour diagnostiquer les fuites cross-compte
      if (requestedOrgId) {
        const source = context.req?.headers?.["x-organization-id"]
          ? "header:x-organization-id"
          : context.req?.headers?.["x-workspace-id"]
            ? "header:x-workspace-id"
            : args.workspaceId
              ? "args.workspaceId"
              : "args.organizationId";
        logger.warn(
          `🔍 RBAC requestedOrgId=${requestedOrgId} source=${source} userId=${userId} op=${info?.fieldName || "?"}`,
        );
      }

      // 2. Récupérer l'organisation active (avec cache LRU 60s)
      const cacheKey = `${userId}:${requestedOrgId || "default"}`;
      let organization = getCachedOrg(cacheKey);

      if (!organization) {
        organization = await getActiveOrganization(userId, requestedOrgId);

        // Fallback sur l'org par défaut si l'org demandée n'est pas accessible
        if (!organization && requestedOrgId) {
          logger.warn(
            `⚠️ RBAC: userId=${userId} n'est pas membre de org=${requestedOrgId}, fallback sur org par défaut`,
          );
          organization = await getActiveOrganization(userId, null);
        }

        if (organization) {
          setCachedOrg(cacheKey, organization);
        }
      }

      if (!organization) {
        throw new AppError(
          "Aucune organisation active trouvée. Veuillez rejoindre ou créer une organisation.",
          ERROR_CODES.FORBIDDEN,
        );
      }

      // 3. Utiliser le rôle déjà récupéré par getActiveOrganization (évite 1 query DB)
      const userRole = organization.memberRole;

      logger.debug(
        `🔐 RBAC: User ${userId} accède à org ${organization.id} avec rôle ${userRole}`,
      );

      // 4. Vérifier les permissions si spécifiées
      if (options.resource && (options.action || options.level)) {
        let hasAccess = false;

        if (options.action) {
          // Vérification par action spécifique
          hasAccess = hasPermission(userRole, options.resource, options.action);
        } else if (options.level) {
          // Vérification par niveau de permission
          hasAccess = hasPermissionLevel(
            userRole,
            options.resource,
            options.level,
          );
        }

        if (!hasAccess) {
          const requiredPermission = options.action || options.level;
          logger.warn(
            `Accès refusé: ${userId} (${userRole}) n'a pas la permission ${requiredPermission} sur ${options.resource}`,
          );

          throw new AppError(
            `Vous n'avez pas la permission d'effectuer cette action (${requiredPermission} sur ${options.resource})`,
            ERROR_CODES.FORBIDDEN,
          );
        }
      }

      // 5. Enrichir le contexte avec les informations RBAC
      const enrichedContext = {
        ...context,
        workspaceId: organization.id,
        organization,
        userRole,
        permissions: {
          hasPermission: (resource, action) =>
            hasPermission(userRole, resource, action),
          hasPermissionLevel: (resource, level) =>
            hasPermissionLevel(userRole, resource, level),
          canRead: (resource) => hasPermissionLevel(userRole, resource, "read"),
          canWrite: (resource) =>
            hasPermissionLevel(userRole, resource, "write"),
          canDelete: (resource) =>
            hasPermissionLevel(userRole, resource, "delete"),
          canAdmin: (resource) =>
            hasPermissionLevel(userRole, resource, "admin"),
        },
      };

      logger.debug(
        `RBAC: ${context.user?.email || context.user?._id} (${userRole}) accède à ${options.resource || "ressource"} avec ${options.action || options.level || "aucune restriction"}`,
      );

      // 6. Exécuter le resolver avec le contexte enrichi
      return await resolver(parent, args, enrichedContext, info);
    } catch (error) {
      // Propager les erreurs d'authentification/autorisation
      if (error instanceof AppError) {
        throw error;
      }

      // Gérer les erreurs de validation Mongoose avec un message user-friendly
      if (error instanceof mongoose.Error.ValidationError) {
        const messages = Object.values(error.errors).map((e) => e.message);
        logger.warn(
          `Erreur de validation dans ${resolver.name || "resolver"}:`,
          messages.join(", "),
        );
        throw new AppError(
          messages.length === 1
            ? messages[0]
            : `Veuillez corriger les erreurs suivantes : ${messages.join(", ")}`,
          ERROR_CODES.VALIDATION_ERROR,
        );
      }

      // Logger les erreurs inattendues avec stack trace complète
      logger.error(
        `Erreur RBAC dans ${resolver.name || "resolver"}:`,
        error.message,
      );
      logger.error("Stack trace:", error.stack);
      throw new AppError(
        `Erreur lors de la vérification des permissions: ${error.message}`,
        ERROR_CODES.INTERNAL_ERROR,
      );
    }
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
const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due"];

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

export async function checkSubscriptionActive(
  context,
  { failClosed = false } = {},
) {
  const orgId = context.workspaceId || context.organization?.id;
  if (!orgId) return; // Pas d'org = pas de check (sera bloqué par RBAC)

  try {
    // Vérifier le cache d'abord
    let sub = getCachedSub(orgId);
    if (sub === undefined) {
      // Cache miss → query DB
      const Subscription = mongoose.model("subscription");
      sub = await Subscription.findOne({ referenceId: orgId }).lean();
      setCachedSub(orgId, sub); // Cache même si null
      logger.debug(
        `[SubCache] MISS org=${orgId} status=${sub?.status || "null"}`,
      );
    } else {
      logger.debug(
        `[SubCache] HIT org=${orgId} status=${sub?.status || "null"}`,
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
 * Middleware Express pour les routes REST qui nécessitent un abonnement actif.
 * À placer APRÈS betterAuthJWTMiddleware (qui set req.headers["x-workspace-id"]).
 *
 * Usage: router.post("/route", requireActiveSubscriptionREST(), handler)
 * Usage fail-closed: router.post("/route", requireActiveSubscriptionREST({ failClosed: true }), handler)
 */
export const requireActiveSubscriptionREST = ({ failClosed = false } = {}) => {
  return async (req, res, next) => {
    try {
      const orgId = req.headers["x-workspace-id"] || req.body?.workspaceId;
      if (!orgId) {
        return res.status(400).json({ error: "Workspace ID requis" });
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
export const requireRead = (resource) => (resolver) =>
  withRBAC(resolver, { resource, level: "read" });

// Écriture (create, edit) — AVEC check subscription
export const requireWrite =
  (resource, options = {}) =>
  (resolver) => {
    const rbacWrapped = withRBAC(resolver, { resource, level: "write" });
    if (options.skipSubscriptionCheck) return rbacWrapped;
    // Wrap pour ajouter le check subscription APRÈS RBAC (context enrichi nécessaire)
    const original = rbacWrapped;
    return async (parent, args, context, info) => {
      // RBAC s'exécute d'abord (enrichit context avec workspaceId)
      // On intercale le check subscription dans le resolver wrappé
      const patchedResolver = async (p, a, ctx, i) => {
        await checkSubscriptionActive(ctx);
        return resolver(p, a, ctx, i);
      };
      return withRBAC(patchedResolver, { resource, level: "write" })(
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
    if (options.skipSubscriptionCheck) {
      return withRBAC(resolver, { resource, level: "delete" });
    }
    return async (parent, args, context, info) => {
      const patchedResolver = async (p, a, ctx, i) => {
        await checkSubscriptionActive(ctx);
        return resolver(p, a, ctx, i);
      };
      return withRBAC(patchedResolver, { resource, level: "delete" })(
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
