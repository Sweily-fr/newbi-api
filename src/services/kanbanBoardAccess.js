// Tableau kanban réservé à une liste de membres (board.members).
//
// Un tableau sans liste est ouvert à tout l'espace. Avec une liste, seuls y
// ont accès : son propriétaire (board.userId), les membres listés, et qui a
// le niveau « suppression » sur les projets dans l'espace du tableau (super
// admin et administrateur par défaut, ou rôle personnalisé équivalent).
// Même règle que les requêtes boards et board, appliquée à toutes les
// opérations qui lisent ou modifient le tableau, ses colonnes et ses tâches.
//
// Refus = « Board not found » (NOT_FOUND), comme un tableau inexistant : on
// ne révèle pas son existence.
import mongoose from "mongoose";
import { Board, Column, Task } from "../models/kanban.js";
import { getActiveOrganizationCached } from "../middlewares/org-cache.js";
import { getEffectiveLevelsFor } from "./organizationRoleService.js";
import { levelsAllowLevel } from "../config/rolePermissions.js";
import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";

export const boardAccessDeniedError = () =>
  new AppError("Board not found", ERROR_CODES.NOT_FOUND, { resource: "Board" });

const BOARD_FIELDS = "userId members workspaceId";

const userIdOf = (user) =>
  user?._id ? String(user._id) : user?.id ? String(user.id) : null;

const validId = (id) =>
  (typeof id === "string" || id instanceof mongoose.Types.ObjectId) &&
  mongoose.isValidObjectId(id);

/** Le tableau a une liste de membres et l'utilisateur n'en fait pas partie. */
export function isRestrictedFor(board, userId) {
  const members = (board?.members || [])
    .map((m) => (m ? String(m) : ""))
    .filter(Boolean);
  if (members.length === 0) return false;
  const uid = String(userId || "");
  if (!uid) return true;
  if (board.userId && String(board.userId) === uid) return false;
  return !members.includes(uid);
}

/** Niveau « suppression » sur les projets dans l'espace : voit tout tableau. */
export async function canSeeEveryBoard(userId, workspaceId) {
  if (!userId || !workspaceId) return false;
  const organization = await getActiveOrganizationCached(
    String(userId),
    String(workspaceId),
  );
  if (!organization) return false;
  const levels = await getEffectiveLevelsFor(
    organization.id,
    organization.memberRole,
  );
  return !!levels && levelsAllowLevel(levels, "kanban", "delete");
}

export async function canAccessBoard(board, userId) {
  if (!board) return true;
  if (!isRestrictedFor(board, userId)) return true;
  return canSeeEveryBoard(userId, board.workspaceId);
}

const loadBoard = (boardId) =>
  validId(boardId)
    ? Board.findById(boardId).select(BOARD_FIELDS).lean()
    : Promise.resolve(null);

/**
 * Refuse (NOT_FOUND) si l'utilisateur n'a pas accès au tableau. Tableau
 * absent ou identifiant invalide : rien à protéger, l'opération répondra
 * elle-même « introuvable ».
 */
export async function assertBoardAccess(boardId, user) {
  const board = await loadBoard(boardId);
  if (!board) return;
  if (!(await canAccessBoard(board, userIdOf(user)))) {
    logger.warn(
      `[Kanban] Tableau restreint ${boardId} refusé à ${userIdOf(user)}`,
    );
    throw boardAccessDeniedError();
  }
}

export async function boardIdOfTask(taskId) {
  if (!validId(taskId)) return null;
  const task = await Task.findById(taskId).select("boardId").lean();
  return task?.boardId ? String(task.boardId) : null;
}

export async function boardIdOfColumn(columnId) {
  if (!validId(columnId)) return null;
  const column = await Column.findById(columnId).select("boardId").lean();
  return column?.boardId ? String(column.boardId) : null;
}

/**
 * Tableaux de l'espace que l'utilisateur ne doit pas voir (pour filtrer les
 * recherches et les listes qui traversent plusieurs tableaux). Mis en cache
 * sur le contexte de la requête.
 */
export async function hiddenBoardIds(workspaceId, user, context = null) {
  const userId = userIdOf(user);
  if (!workspaceId) return [];
  const key = `${workspaceId}:${userId}`;
  const cache =
    context && typeof context === "object"
      ? (context._hiddenBoardIds ??= new Map())
      : null;
  if (cache?.has(key)) return cache.get(key);
  const pending = (async () => {
    if (await canSeeEveryBoard(userId, workspaceId)) return [];
    const restricted = await Board.find({
      workspaceId,
      "members.0": { $exists: true },
    })
      .select(BOARD_FIELDS)
      .lean();
    return restricted
      .filter((board) => isRestrictedFor(board, userId))
      .map((board) => String(board._id));
  })();
  cache?.set(key, pending);
  return pending;
}

/**
 * Enveloppe de resolver : `locate(args, context)` renvoie le ou les tableaux
 * visés (identifiants), chacun doit être accessible. À placer autour d'un
 * resolver déjà protégé par withRBAC : sans utilisateur, on laisse le
 * resolver refuser lui-même.
 */
export const withBoardAccess = (locate) => (resolver) =>
  async function boardAccessGuard(parent, args, context, info) {
    if (userIdOf(context?.user)) {
      const located = await locate(args || {}, context);
      const boardIds = [...new Set([].concat(located || []).filter(Boolean))];
      for (const boardId of boardIds) {
        await assertBoardAccess(String(boardId), context.user);
      }
    }
    return resolver(parent, args, context, info);
  };

// Localisateurs usuels
export const byBoardArg =
  (name = "boardId") =>
  (args) =>
    args[name];
export const byInputBoard = (args) => args.input?.boardId;
export const byInputId = (args) => args.input?.id;
export const byTaskArg =
  (name = "taskId") =>
  (args) =>
    boardIdOfTask(args[name]);
export const byInputTask = (args) => boardIdOfTask(args.input?.id);
export const byColumnArg =
  (name = "id") =>
  (args) =>
    boardIdOfColumn(args[name]);
export const byInputColumn = (args) => boardIdOfColumn(args.input?.id);
export const byColumnList = async (args) => {
  const ids = (Array.isArray(args.columns) ? args.columns : []).filter(validId);
  if (ids.length === 0) return [];
  const columns = await Column.find({ _id: { $in: ids } })
    .select("boardId")
    .lean();
  return columns.map((c) => String(c.boardId));
};
