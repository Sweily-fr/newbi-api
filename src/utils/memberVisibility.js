import { levelsAllowAction } from "../config/rolePermissions.js";
import { getEffectiveLevelsFor } from "../services/organizationRoleService.js";

/**
 * Visibilité des membres d'un espace, même règle que le site (route
 * /api/organizations/[id]/members et lectures du plugin organisation de
 * Better Auth) :
 *
 *   - avec « Voir les membres » (page Membres de la grille, celle que sert
 *     myPermissions), tout ;
 *   - sans, l'identité des autres membres (nom, e-mail, photo) et le rôle du
 *     seul super admin, sans effectifs par rôle ni invitations.
 *
 * L'appelant garde toujours sa propre adhésion entière.
 */

export const RESTRICTED_TEAM_VISIBILITY = Object.freeze({
  canViewTeam: false,
  canViewInvitations: false,
});

export function isOwnerRole(role) {
  return String(role || "")
    .toLowerCase()
    .split(",")
    .map((r) => r.trim())
    .includes("owner");
}

/**
 * Droits sur les membres d'après la grille effective de l'appelant
 * (`context.permissionLevels` après withRBAC). « Inviter des membres »
 * coche « Voir » d'office (normalizeActions) ; il est relu ici pour les
 * invitations par prudence.
 */
export function teamVisibilityFromGrid(grid) {
  if (!grid) return RESTRICTED_TEAM_VISIBILITY;
  const canViewTeam = levelsAllowAction(grid, "team", "view");
  return {
    canViewTeam,
    canViewInvitations:
      canViewTeam || levelsAllowAction(grid, "team", "invite"),
  };
}

/** Même calcul à partir du rôle de l'appelant dans l'espace. */
export async function teamVisibilityForRole(organizationId, role) {
  if (!organizationId || !role) return RESTRICTED_TEAM_VISIBILITY;
  return teamVisibilityFromGrid(
    await getEffectiveLevelsFor(organizationId, role),
  );
}

// Champs d'identité du type GraphQL OrganizationMember (liste blanche)
const IDENTITY_FIELDS = ["id", "userId", "name", "email", "image"];

/** Membre (type OrganizationMember) vu sans « Voir les membres ». */
export function organizationMemberIdentity(member) {
  const identity = {};
  for (const field of IDENTITY_FIELDS) {
    if (member && Object.prototype.hasOwnProperty.call(member, field)) {
      identity[field] = member[field];
    }
  }
  identity.role = isOwnerRole(member?.role) ? "owner" : null;
  return identity;
}

/**
 * Liste de membres (type OrganizationMember, `id` = utilisateur) vue par
 * l'appelant : inchangée avec « Voir les membres », sinon identité des
 * autres et sa propre entrée entière.
 */
export function filterOrganizationMembers(
  members,
  { callerUserId, canViewTeam },
) {
  if (canViewTeam || !Array.isArray(members)) return members;
  const caller = callerUserId ? String(callerUserId) : null;
  return members.map((member) =>
    caller && String(member?.userId ?? member?.id) === caller
      ? member
      : organizationMemberIdentity(member),
  );
}
