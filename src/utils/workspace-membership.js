import mongoose from "mongoose";
import logger from "./logger.js";
import {
  levelsAllowAction,
  levelsAllowLevel,
} from "../config/rolePermissions.js";
import { getEffectiveLevelsFor } from "../services/organizationRoleService.js";

/**
 * Vérifie que l'utilisateur fait partie du workspace cible. Pattern aligné
 * sur rbac.getMemberRole : query collection `member` (Better Auth orga plugin)
 * sur (organizationId, userId).
 *
 * Retourne `true` si membre, `false` sinon (et logge un warn en cas de
 * tentative cross-tenant — utile pour détecter un client mal configuré ou un
 * abus).
 */
export async function userBelongsToWorkspace(userId, workspaceId) {
  try {
    const { ObjectId } = mongoose.Types;
    const orgObjectId =
      typeof workspaceId === "string" ? new ObjectId(workspaceId) : workspaceId;
    const userObjectId =
      typeof userId === "string" ? new ObjectId(userId) : userId;
    const member = await mongoose.connection.db.collection("member").findOne({
      organizationId: orgObjectId,
      userId: userObjectId,
    });
    if (!member) {
      logger.warn(
        `userBelongsToWorkspace: accès refusé user=${userId} workspace=${workspaceId}`,
      );
    }
    return !!member;
  } catch (err) {
    // workspaceId/userId non-ObjectId valide → on traite comme non membre
    logger.warn(`userBelongsToWorkspace: validation failed (${err.message})`);
    return false;
  }
}

/**
 * Rôle (en minuscules) et grille effective de l'utilisateur dans le
 * workspace (rôles prédéfinis ou personnalisés), null s'il n'est pas membre.
 */
async function workspaceMemberGrid(userId, workspaceId) {
  const { ObjectId } = mongoose.Types;
  const member = await mongoose.connection.db.collection("member").findOne({
    organizationId:
      typeof workspaceId === "string" ? new ObjectId(workspaceId) : workspaceId,
    userId: typeof userId === "string" ? new ObjectId(userId) : userId,
  });
  if (!member) return null;
  const role = String(member.role || "").toLowerCase();
  const grid = await getEffectiveLevelsFor(String(workspaceId), role);
  return { role: member.role, grid };
}

/**
 * Le rôle de l'utilisateur dans le workspace donne-t-il ce niveau sur ce
 * module (grille des rôles, prédéfinis ou personnalisés) ? `false` si
 * l'utilisateur n'est pas membre. Pour les routes REST, qui ne passent pas
 * par withRBAC.
 */
export async function userHasWorkspaceLevel(
  userId,
  workspaceId,
  moduleKey,
  level,
) {
  try {
    const member = await workspaceMemberGrid(userId, workspaceId);
    if (!member) return false;
    const allowed = levelsAllowLevel(member.grid, moduleKey, level);
    if (!allowed) {
      logger.warn(
        `userHasWorkspaceLevel: refus user=${userId} workspace=${workspaceId} (${member.role}) ${level} sur ${moduleKey}`,
      );
    }
    return allowed;
  } catch (err) {
    logger.warn(`userHasWorkspaceLevel: validation failed (${err.message})`);
    return false;
  }
}

/**
 * Comme userHasWorkspaceLevel, pour une action précise de la page
 * (`create`, `reconcile`, `sync`…). Une liste d'actions : l'une suffit.
 */
export async function userHasWorkspaceAction(
  userId,
  workspaceId,
  moduleKey,
  action,
) {
  try {
    const member = await workspaceMemberGrid(userId, workspaceId);
    if (!member) return false;
    const actions = Array.isArray(action) ? action : [action];
    const allowed = actions.some((a) =>
      levelsAllowAction(member.grid, moduleKey, a),
    );
    if (!allowed) {
      logger.warn(
        `userHasWorkspaceAction: refus user=${userId} workspace=${workspaceId} (${member.role}) ${actions.join("|")} sur ${moduleKey}`,
      );
    }
    return allowed;
  } catch (err) {
    logger.warn(`userHasWorkspaceAction: validation failed (${err.message})`);
    return false;
  }
}
