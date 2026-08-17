import mongoose from "mongoose";
import logger from "./logger.js";

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
