/**
 * Organization membership resolver.
 *
 * Extracted from rbac.js to break the circular dependency:
 *   rbac.js imports isAuthenticated from better-auth-jwt.js
 *   better-auth-jwt.js needs getActiveOrganization from rbac.js
 *
 * Both files now import from this neutral module instead.
 */

import mongoose from "mongoose";
import logger from "../utils/logger.js";

/**
 * Resolve the active organization for a user.
 * If requestedOrgId is provided, verify membership.
 * Otherwise, fall back to the user's default org (owner > admin > member).
 *
 * @param {string} userId
 * @param {string|null} requestedOrgId
 * @returns {Promise<{id, name, slug, metadata, createdAt, memberRole}|null>}
 */
export async function getActiveOrganization(userId, requestedOrgId = null) {
  try {
    const db = mongoose.connection.db;
    const memberCollection = db.collection("member");
    const { ObjectId } = mongoose.Types;

    const userObjectId =
      typeof userId === "string" ? new ObjectId(userId) : userId;

    let member;

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
