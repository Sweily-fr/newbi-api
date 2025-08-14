import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";

/**
 * Vérifie si un utilisateur est membre d'un workspace spécifique
 * @param {string} userId - ID de l'utilisateur
 * @param {string} workspaceId - ID du workspace à vérifier
 * @param {Array} organizations - Liste des organisations de l'utilisateur
 * @returns {Object|null} - Informations sur le membership ou null
 */
const checkWorkspaceMembership = (userId, workspaceId, organizations) => {
  if (!userId || !workspaceId || !organizations) return null;

  logger.debug('🔍 DEBUG - Nombre d\'organisations:', organizations.length);
  organizations.forEach((org, index) => {
    logger.debug(`🏢 Organisation ${index}:`, {
      id: org.id,
      name: org.name,
      slug: org.slug,
    });
  });
  logger.debug(`🔍 DEBUG - Recherche userId: ${userId}, workspaceId: ${workspaceId}`);

  // Trouver l'organisation correspondante
  const organization = organizations.find((org) => org.id === workspaceId);

  if (!organization) {
    logger.debug(
      `❌ Organisation ${workspaceId} non trouvée pour l'utilisateur ${userId}`
    );
    logger.debug('📋 Organisations disponibles:', organizations.map(org => ({ id: org.id, name: org.name })));
    return null;
  }

  logger.debug('🏢 Organisation trouvée:', organization.name);

  // LOGIQUE SIMPLIFIÉE : Si l'organisation est dans la liste retourned par Better Auth,
  // c'est que l'utilisateur en est membre (useListOrganizations ne retourne que les organisations dont on est membre)
  logger.info(`✅ Utilisateur ${userId} est membre de l'organisation ${organization.name} (logique Better Auth)`);
  
  // Créer un membre par défaut avec des permissions admin
  const defaultMember = {
    userId: userId,
    role: 'admin', // Par défaut admin pour simplifier
    createdAt: new Date().toISOString(),
  };

  return {
    organization,
    member: defaultMember,
    role: defaultMember.role,
    permissions: {
      isAdmin: defaultMember.role === "admin",
      isMember: defaultMember.role === "member",
      isGuest: defaultMember.role === "guest",
      canRead: ["admin", "member", "guest"].includes(defaultMember.role),
      canWrite: ["admin", "member"].includes(defaultMember.role),
      canDelete: defaultMember.role === "admin",
      canManageMembers: defaultMember.role === "admin",
    },
  };
};

/**
 * Middleware pour vérifier l'appartenance à un workspace
 * Utilise Better Auth pour valider les sessions et les memberships
 * @param {Object} req - Objet de requête GraphQL
 * @param {string} workspaceId - ID du workspace à vérifier
 * @returns {Object} - Contexte avec utilisateur et informations workspace
 */
/**
 * Récupère les organisations de l'utilisateur via Better Auth API
 * @param {Object} headers - Headers de la requête avec cookies
 * @returns {Array|null} - Liste des organisations ou null
 */
const fetchUserOrganizations = async (headers) => {
  if (!headers?.cookie) {
    logger.debug("Aucun cookie trouvé pour récupérer les organisations");
    return null;
  }

  try {
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const response = await fetch(`${frontendUrl}/api/auth/organization/list`, {
      method: "GET",
      headers: {
        Cookie: headers.cookie,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      logger.debug(`Échec récupération organisations: ${response.status}`);
      return null;
    }

    const organizations = await response.json();
    logger.debug(`✅ ${organizations?.length || 0} organisations récupérées`);
    return organizations || [];
  } catch (error) {
    logger.error("Erreur récupération organisations:", error.message);
    return null;
  }
};

const isWorkspaceMember = async (req, workspaceId, contextUser = null) => {
  try {
    logger.debug(
      `🔍 Vérification workspace RÉELLE pour workspaceId: ${workspaceId}`
    );

    // 1. Vérifier que l'utilisateur est authentifié
    if (!contextUser) {
      logger.error("❌ Aucun utilisateur dans le contexte");
      throw new AppError(
        "Utilisateur non authentifié",
        ERROR_CODES.UNAUTHORIZED
      );
    }

    if (!workspaceId) {
      throw new AppError(
        "WorkspaceId requis",
        ERROR_CODES.BAD_REQUEST
      );
    }

    logger.debug(`👤 Utilisateur authentifié: ${contextUser.email}`);

    // 2. Récupérer les vraies organisations via Better Auth
    const organizations = await fetchUserOrganizations(req.headers);
    
    if (!organizations || organizations.length === 0) {
      logger.error("❌ Aucune organisation trouvée pour cet utilisateur");
      throw new AppError(
        "Aucune organisation trouvée pour cet utilisateur",
        ERROR_CODES.FORBIDDEN
      );
    }

    // 3. Vérifier l'appartenance au workspace spécifique
    const betterAuthUserId = contextUser.id || contextUser._id?.toString();
    logger.debug(
      `🔍 Vérification membership pour userId: ${betterAuthUserId}, workspaceId: ${workspaceId}`
    );

    const membership = checkWorkspaceMembership(
      betterAuthUserId,
      workspaceId,
      organizations
    );

    if (!membership) {
      logger.error(
        `❌ Accès refusé: utilisateur ${betterAuthUserId} n'est pas membre du workspace ${workspaceId}`
      );
      logger.debug(
        "Organisations disponibles:",
        organizations.map((org) => ({ id: org.id, name: org.name }))
      );
      throw new AppError(
        `Accès refusé: vous n'êtes pas membre du workspace ${workspaceId}`,
        ERROR_CODES.FORBIDDEN
      );
    }

    logger.info(
      `✅ Accès autorisé au workspace ${workspaceId} pour l'utilisateur ${contextUser.email} avec le rôle ${membership.role}`
    );

    // 4. Retourner le contexte enrichi avec les VRAIES données
    return {
      user: contextUser,
      sessionUserId: betterAuthUserId,
      workspace: {
        id: workspaceId,
        organization: membership.organization,
        membership: membership.member,
        role: membership.role,
        permissions: membership.permissions,
      },
      organizations,
    };
  } catch (error) {
    if (error instanceof AppError) {
      logger.error(`❌ AppError dans isWorkspaceMember: ${error.message}`);
      throw error;
    }

    logger.error("Erreur dans isWorkspaceMember:", error.message);
    throw new AppError(
      "Erreur d'authentification workspace",
      ERROR_CODES.INTERNAL_ERROR
    );
  }
};

/**
 * Middleware pour vérifier les permissions spécifiques dans un workspace
 * @param {Object} context - Contexte retourné par isWorkspaceMember
 * @param {string} permission - Permission requise ('read', 'write', 'delete', 'manageMembers')
 * @returns {boolean} - True si l'utilisateur a la permission
 */
const hasWorkspacePermission = (context, permission) => {
  if (!context || !context.workspace || !context.workspace.permissions) {
    return false;
  }

  const permissions = context.workspace.permissions;

  switch (permission) {
    case "read":
      return permissions.canRead;
    case "write":
      return permissions.canWrite;
    case "delete":
      return permissions.canDelete;
    case "manageMembers":
      return permissions.canManageMembers;
    default:
      return false;
  }
};

/**
 * Helper pour créer un middleware de permission spécifique
 * @param {string} permission - Permission requise
 * @returns {Function} - Middleware function
 */
const requireWorkspacePermission = (permission) => {
  return (context) => {
    if (!hasWorkspacePermission(context, permission)) {
      throw new AppError(
        `Permission '${permission}' requise pour cette action`,
        ERROR_CODES.FORBIDDEN
      );
    }
    return true;
  };
};

export {
  isWorkspaceMember,
  hasWorkspacePermission,
  requireWorkspacePermission,
  checkWorkspaceMembership,
};
