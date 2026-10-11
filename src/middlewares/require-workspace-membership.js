import { betterAuthJWTMiddleware } from "./better-auth-jwt.js";
import {
  userBelongsToWorkspace,
  userHasWorkspaceAction,
  userHasWorkspaceLevel,
} from "../utils/workspace-membership.js";
import logger from "../utils/logger.js";
import { isObjectIdString } from "../utils/objectIdString.js";

/**
 * Middleware Express : exige que l'utilisateur authentifié soit MEMBRE du
 * workspace demandé (header x-workspace-id / x-organization-id, query ou body).
 *
 * 🔐 Ferme l'IDOR des routes REST qui faisaient confiance à un workspaceId
 * fourni par le client sans vérifier l'appartenance (betterAuthJWTMiddleware
 * authentifie seulement). À placer AVANT les handlers concernés.
 *
 * Pose `req.user` et `req.workspaceId` (validé) pour les handlers en aval,
 * et réécrit l'en-tête x-workspace-id avec cet espace validé : les handlers
 * lisent `x-workspace-id || query.workspaceId` (ou `|| body.workspaceId`).
 * Sans cette réécriture, une requête avec x-organization-id = son espace et
 * ?workspaceId=<autre espace> (ou { "$ne": … }) passait le contrôle sur le
 * premier et le handler agissait sur le second.
 */
export async function requireWorkspaceMembership(req, res, next) {
  try {
    const user = await betterAuthJWTMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId =
      req.headers["x-workspace-id"] ||
      req.headers["x-organization-id"] ||
      req.query?.workspaceId ||
      req.body?.workspaceId;

    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Identifiant d'ObjectId seulement (objet, tableau, chaîne quelconque :
    // même refus qu'un non-membre)
    const isMember =
      isObjectIdString(workspaceId) &&
      (await userBelongsToWorkspace(String(user._id), workspaceId));
    if (!isMember) {
      return res.status(403).json({
        error: "Accès non autorisé à cet espace de travail",
      });
    }

    req.user = user;
    req.workspaceId = workspaceId;
    req.headers["x-workspace-id"] = workspaceId;
    return next();
  } catch (err) {
    logger.error("requireWorkspaceMembership:", err.message);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

/**
 * requireWorkspaceMembership puis contrôle du rôle (`check(userId,
 * workspaceId)`). Réponse 403 si le rôle ne le permet pas.
 */
function requireWorkspaceRoleCheck(check) {
  return (req, res, next) =>
    requireWorkspaceMembership(req, res, async () => {
      const allowed = await check(String(req.user._id), req.workspaceId);
      if (!allowed) {
        return res.status(403).json({
          error: "FORBIDDEN",
          message: "Vous n'avez pas la permission d'effectuer cette action.",
        });
      }
      return next();
    });
}

/**
 * requireWorkspaceMembership + niveau du rôle sur un module (grille des
 * rôles). Réponse 403 si le rôle ne le permet pas.
 */
export function requireWorkspacePermission(moduleKey, level) {
  return requireWorkspaceRoleCheck((userId, workspaceId) =>
    userHasWorkspaceLevel(userId, workspaceId, moduleKey, level),
  );
}

/**
 * requireWorkspaceMembership + action précise du rôle sur un module
 * (`reconcile`, `sync`…, une liste : l'une suffit). Réponse 403 sinon.
 */
export function requireWorkspaceActionPermission(moduleKey, action) {
  return requireWorkspaceRoleCheck((userId, workspaceId) =>
    userHasWorkspaceAction(userId, workspaceId, moduleKey, action),
  );
}
