import mongoose from "mongoose";
import { createDataLoaders } from "../../dataloaders/index.js";
import logger from "../../utils/logger.js";

/**
 * Construit un contexte GraphQL minimal compatible avec les résolveurs
 * Newbi (qui sont wrappés par `requireRead("...")` côté RBAC).
 *
 * Mode d'invocation : les handlers de tools appellent `resolvers.Query.xxx`
 * directement (pas via HTTP loopback). Il faut donc fournir manuellement
 * un context conforme à ce qui est construit dans server.js `context: async`.
 *
 * Champs reproduits :
 *   - user            : objet user déjà authentifié dans la route /chat
 *   - workspaceId     : alias historique
 *   - organizationId  : alias Better Auth, lu par requireRead via context
 *   - userRole        : rôle du user dans cette organization (lu en DB)
 *   - loaders         : DataLoaders par-requête (évite N+1)
 *
 * NOTE : `userRole` est requis pour que `requireRead("invoices")` ne rejette
 * pas l'appel. Sans rôle, RBAC considère l'utilisateur comme non autorisé.
 */
export async function buildResolverContext({ user, workspaceId }) {
  const userId = user._id || user.id;

  // Lecture du rôle dans la collection `member` (Better Auth organization).
  // Pattern strictement aligné sur `rbac.getMemberRole`.
  let userRole = null;
  try {
    const { ObjectId } = mongoose.Types;
    const member = await mongoose.connection.db.collection("member").findOne({
      organizationId: new ObjectId(workspaceId),
      userId: new ObjectId(userId),
    });
    if (member?.role) {
      // RBAC normalise en minuscules (cf. rbac.js commentaire).
      userRole = String(member.role).toLowerCase();
    }
  } catch (err) {
    logger.warn(
      `[assistant] buildResolverContext: lecture rôle membre échouée (${err.message})`,
    );
  }

  return {
    user,
    workspaceId: String(workspaceId),
    organizationId: String(workspaceId),
    userRole,
    loaders: createDataLoaders(),
  };
}
