import { invalidateOrgCache, withOrganization } from "../middlewares/rbac.js";
import {
  DEFAULT_INVITE_ROLE,
  MODULE_GROUPS,
  catalogModules,
  levelsFromActions,
} from "../config/rolePermissions.js";
import {
  createOrganizationRole,
  deleteOrganizationRole,
  listOrganizationRoles,
  loadOrganizationRoles,
  resetOrganizationRole,
  roleLabel,
  transferOrganizationOwnership,
  updateOrganizationRole,
} from "../services/organizationRoleService.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";

function isOwner(context) {
  return String(context.userRole || "")
    .split(",")
    .map((r) => r.trim())
    .includes("owner");
}

/**
 * Définir les rôles (créer, ajuster, supprimer) et céder son rôle est
 * réservé au super admin. Inviter, retirer ou changer le rôle d'un membre
 * dépend du module « Membres » (routes Better Auth, contrôlées côté front).
 */
const requireOwner = (resolver) =>
  withOrganization((parent, args, context, info) => {
    if (!isOwner(context)) {
      throw new AppError(
        "Seul le super admin peut gérer les rôles de l'espace.",
        ERROR_CODES.FORBIDDEN,
      );
    }
    return resolver(parent, args, context, info);
  });

const catalog = {
  groups: MODULE_GROUPS,
  // kind / levels : champs des écrans d'avant les actions (compatibilité
  // pendant un déploiement API puis front)
  modules: catalogModules().map((m) => ({
    ...m,
    kind: "level",
    levels: ["none", "read", "write", "delete"],
  })),
  defaultInviteRole: DEFAULT_INVITE_ROLE,
};

const organizationRoleResolvers = {
  Query: {
    roleCatalog: withOrganization(() => catalog),

    // Lisible par tout membre : libellés des rôles affichés partout
    // (liste des membres, sélecteurs), la grille n'a rien de sensible
    organizationRoles: withOrganization((_, __, context) =>
      listOrganizationRoles(context.organizationId),
    ),

    myPermissions: withOrganization(async (_, __, context) => {
      const storedRoles = await loadOrganizationRoles(context.organizationId);
      const roles = String(context.userRole || "")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      return {
        organizationId: context.organizationId,
        role: context.userRole,
        roleName: roles.map((r) => roleLabel(r, storedRoles)).join(", "),
        isOwner: isOwner(context),
        actions: context.permissionLevels,
        levels: levelsFromActions(context.permissionLevels),
      };
    }),
  },

  Mutation: {
    createOrganizationRole: requireOwner((_, { input }, context) =>
      createOrganizationRole(
        context.organizationId,
        input,
        context.user._id.toString(),
      ),
    ),

    updateOrganizationRole: requireOwner((_, { key, input }, context) =>
      updateOrganizationRole(context.organizationId, key, input),
    ),

    resetOrganizationRole: requireOwner((_, { key }, context) =>
      resetOrganizationRole(context.organizationId, key),
    ),

    deleteOrganizationRole: requireOwner(
      async (_, { key, fallbackRole }, context) => {
        const result = await deleteOrganizationRole(
          context.organizationId,
          key,
          fallbackRole || DEFAULT_INVITE_ROLE,
        );
        // Les membres réaffectés changent de rôle : cache RBAC à rafraîchir
        if (result.reassignedMembers > 0) invalidateOrgCache();
        return { success: true, ...result };
      },
    ),

    transferOrganizationOwnership: requireOwner(
      async (_, { memberId }, context) => {
        const result = await transferOrganizationOwnership(
          context.organizationId,
          context.user._id.toString(),
          memberId,
        );
        invalidateOrgCache(String(result.previousOwnerUserId));
        invalidateOrgCache(String(result.newOwnerUserId));
        return { success: true };
      },
    ),
  },
};

export default organizationRoleResolvers;
