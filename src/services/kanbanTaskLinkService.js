// services/kanbanTaskLinkService.js
//
// Tâches liées du kanban : lien purement informatif et SYMÉTRIQUE entre deux
// tâches du même workspace (même tableau ou tableaux différents). Si A est
// liée à B, B est liée à A : chaque écriture touche les deux documents avec
// des opérateurs atomiques ($addToSet / $pull) pour que deux liaisons
// concurrentes convergent au lieu de s'écraser.
import mongoose from "mongoose";
import { Board, Column, Task } from "../models/kanban.js";
import { escapeRegex } from "../utils/escapeRegex.js";

const { ObjectId } = mongoose.Types;

const isValidObjectId = (id) =>
  typeof id === "string"
    ? /^[0-9a-fA-F]{24}$/.test(id)
    : id instanceof ObjectId;

/**
 * Normalise une liste d'ids de tâches : chaînes valides, dédoublonnées,
 * sans l'id de la tâche elle-même (une tâche ne peut pas être liée à elle-même).
 */
export function normalizeLinkedTaskIds(ids, selfId = null) {
  if (!Array.isArray(ids)) return [];
  const self = selfId ? String(selfId) : null;
  const seen = new Set();
  const result = [];
  for (const raw of ids) {
    const id = raw?.toString?.() ?? raw;
    if (!id || !isValidObjectId(id) || id === self || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/** Résumé d'une tâche tel qu'exposé par le type GraphQL LinkedTaskInfo. */
export function toLinkedTaskInfo(task, boardsById = {}, columnsById = {}) {
  if (!task) return null;
  const id = task._id?.toString() || task.id;
  const boardId = task.boardId?.toString() || null;
  const columnId = task.columnId ? String(task.columnId) : "";
  return {
    id,
    title: task.title || "",
    boardId,
    boardTitle: boardsById[boardId]?.title || null,
    columnId,
    columnTitle: columnsById[columnId]?.title || null,
    columnColor: columnsById[columnId]?.color || null,
    status: task.status || columnId,
    priority: task.priority || null,
    dueDate: task.dueDate || null,
  };
}

/**
 * Charge les tableaux et colonnes d'une liste de tâches en deux requêtes
 * (une par collection) et renvoie les maps par id.
 */
async function loadBoardsAndColumns(tasks, workspaceId) {
  const boardIds = [
    ...new Set(tasks.map((t) => t.boardId?.toString()).filter(Boolean)),
  ];
  const columnIds = [
    ...new Set(
      tasks
        .map((t) => t.columnId)
        .filter((c) => c && isValidObjectId(String(c)))
        .map(String),
    ),
  ];
  const [boards, columns] = await Promise.all([
    boardIds.length > 0
      ? Board.find({ _id: { $in: boardIds }, workspaceId })
          .select("title")
          .lean()
      : [],
    columnIds.length > 0
      ? Column.find({ _id: { $in: columnIds }, workspaceId })
          .select("title color")
          .lean()
      : [],
  ]);
  return {
    boardsById: Object.fromEntries(boards.map((b) => [b._id.toString(), b])),
    columnsById: Object.fromEntries(
      columns.map((c) => [c._id.toString(), c]),
    ),
  };
}

/**
 * Résout des ids de tâches liées en LinkedTaskInfo, avec un cache par requête
 * GraphQL (context) pour que les resolvers Task.linkedTasks des N tâches d'un
 * tableau partagent un seul batch au lieu de N requêtes.
 *
 * Les tâches introuvables (supprimées, autre workspace) sont ignorées : le
 * lien orphelin n'est pas affiché, sans faire échouer la requête.
 */
export async function loadLinkedTaskInfos(context, taskIds, workspaceId) {
  const ids = normalizeLinkedTaskIds(taskIds);
  if (ids.length === 0 || !workspaceId) return [];

  const cache =
    context && typeof context === "object"
      ? (context._linkedTaskInfoCache ??= new Map())
      : new Map();

  // Pas d'await entre la détection des ids manquants et le remplissage du
  // cache : les resolvers concurrents du même tick partagent le batch.
  const missing = ids.filter((id) => !cache.has(id));
  if (missing.length > 0) {
    const batch = Task.find({
      _id: { $in: missing },
      workspaceId,
    })
      .select("title boardId columnId status priority dueDate")
      .lean()
      .then(async (tasks) => {
        const { boardsById, columnsById } = await loadBoardsAndColumns(
          tasks,
          workspaceId,
        );
        return new Map(
          tasks.map((t) => [
            t._id.toString(),
            toLinkedTaskInfo(t, boardsById, columnsById),
          ]),
        );
      });
    for (const id of missing) {
      cache.set(
        id,
        batch.then((m) => m.get(id) || null),
      );
    }
  }

  const infos = await Promise.all(ids.map((id) => cache.get(id)));
  return infos.filter(Boolean);
}

/**
 * Recherche de tâches candidates à la liaison.
 * - avec `columnId` : les tâches de cette colonne (étape), dans l'ordre du
 *   tableau, `search` optionnel pour affiner dans la colonne
 * - sinon sans `search` : les tâches du tableau `boardId`
 * - sinon avec `search` : toutes les tâches du workspace dont le titre
 *   contient le texte
 */
export async function searchLinkableTasks({
  workspaceId,
  search = "",
  boardId = null,
  columnId = null,
  excludeTaskId = null,
  limit = 20,
}) {
  if (!workspaceId) return [];
  const trimmed = (search || "").trim();
  const hasColumn = columnId && isValidObjectId(String(columnId));
  // Une colonne est bornée par nature : on remonte toute son étape (plafond
  // large) pour que le sélecteur par étape n'en cache aucune.
  const cappedLimit = Math.min(
    Math.max(Number(limit) || (hasColumn ? 200 : 20), 1),
    hasColumn ? 200 : 50,
  );

  const query = { workspaceId };
  if (excludeTaskId && isValidObjectId(String(excludeTaskId))) {
    query._id = { $ne: excludeTaskId };
  }
  if (trimmed) {
    query.title = { $regex: escapeRegex(trimmed, 100), $options: "i" };
  }
  if (hasColumn) {
    query.columnId = String(columnId);
    if (boardId && isValidObjectId(String(boardId))) query.boardId = boardId;
  } else if (!trimmed) {
    if (!boardId || !isValidObjectId(String(boardId))) return [];
    query.boardId = boardId;
  }

  const tasks = await Task.find(query)
    .select("title boardId columnId status priority dueDate updatedAt")
    .sort(trimmed && !hasColumn ? { updatedAt: -1 } : { position: 1 })
    .limit(cappedLimit)
    .lean();

  const { boardsById, columnsById } = await loadBoardsAndColumns(
    tasks,
    workspaceId,
  );
  return tasks.map((t) => toLinkedTaskInfo(t, boardsById, columnsById));
}

/**
 * Nombre de tâches par colonne pour un workspace, calculé en UNE agrégation
 * par requête GraphQL et mémorisé sur le contexte : le sélecteur de tâches
 * liées affiche le compteur de chaque colonne de chaque tableau, ce qui
 * ferait autant de countDocuments que de colonnes sans ce batch.
 */
export async function loadColumnTaskCounts(context, workspaceId) {
  if (!workspaceId) return {};
  const key = String(workspaceId);
  const cache =
    context && typeof context === "object"
      ? (context._columnTaskCountCache ??= new Map())
      : new Map();

  if (!cache.has(key)) {
    cache.set(
      key,
      Task.aggregate([
        { $match: { workspaceId: new ObjectId(key) } },
        { $group: { _id: "$columnId", count: { $sum: 1 } } },
      ])
        .then((rows) =>
          Object.fromEntries(rows.map((r) => [String(r._id), r.count])),
        )
        .catch(() => ({})),
    );
  }
  return cache.get(key);
}

const buildLinkActivity = ({ user, userName, userImage, verb, otherTask }) => ({
  userId: user?.id,
  userName,
  userImage,
  type: "updated",
  field: "linkedTasks",
  newValue: otherTask?._id?.toString() || null,
  description: `${verb} la tâche « ${otherTask?.title || "sans titre"} »`,
  createdAt: new Date(),
});

/**
 * Pose (ou retire) le lien entre deux tâches, des deux côtés, atomiquement.
 * Renvoie les deux tâches rechargées (ou null si introuvable côté lié).
 *
 * @param {"link"|"unlink"} action
 */
async function applyLink({
  action,
  taskId,
  linkedTaskId,
  workspaceId,
  user = null,
  userName = null,
  userImage = null,
}) {
  const [a, b] = [String(taskId), String(linkedTaskId)];
  if (!isValidObjectId(a) || !isValidObjectId(b)) {
    throw new Error("Identifiant de tâche invalide");
  }
  if (a === b) {
    throw new Error("Une tâche ne peut pas être liée à elle-même");
  }

  const [task, linkedTask] = await Promise.all([
    Task.findOne({ _id: a, workspaceId }).select("_id title linkedTasks"),
    Task.findOne({ _id: b, workspaceId }).select("_id title linkedTasks"),
  ]);
  if (!task) throw new Error("Task not found");
  if (!linkedTask) throw new Error("Tâche liée introuvable");

  const now = new Date();
  const verb = action === "link" ? "a lié" : "a délié";
  const alreadyLinked = (task.linkedTasks || []).some(
    (id) => id.toString() === b,
  );
  // Idempotent : lier deux fois ou délier un lien absent ne génère ni écriture
  // ni activité parasite.
  const changed = action === "link" ? !alreadyLinked : alreadyLinked;

  if (changed) {
    const opFor = (otherId) =>
      action === "link"
        ? { $addToSet: { linkedTasks: otherId } }
        : { $pull: { linkedTasks: otherId } };
    const activityFor = (otherTask) =>
      user
        ? {
            $push: {
              activity: buildLinkActivity({
                user,
                userName,
                userImage,
                verb,
                otherTask,
              }),
            },
          }
        : {};

    await Promise.all([
      Task.updateOne(
        { _id: a, workspaceId },
        {
          ...opFor(linkedTask._id),
          ...activityFor(linkedTask),
          $set: { updatedAt: now },
        },
      ),
      Task.updateOne(
        { _id: b, workspaceId },
        {
          ...opFor(task._id),
          ...activityFor(task),
          $set: { updatedAt: now },
        },
      ),
    ]);
  }

  const [freshTask, freshLinkedTask] = await Promise.all([
    Task.findOne({ _id: a, workspaceId }),
    Task.findOne({ _id: b, workspaceId }),
  ]);
  return { task: freshTask, linkedTask: freshLinkedTask, changed };
}

export const linkTasks = (params) => applyLink({ ...params, action: "link" });
export const unlinkTasks = (params) =>
  applyLink({ ...params, action: "unlink" });

/**
 * À la suppression d'une tâche : retire son id des `linkedTasks` des autres
 * tâches du workspace. Renvoie les tâches touchées (pour publier leur mise à
 * jour temps réel).
 */
export async function detachTaskLinks(taskId, workspaceId) {
  if (!isValidObjectId(String(taskId)) || !workspaceId) return [];
  const affected = await Task.find({ workspaceId, linkedTasks: taskId })
    .select("_id boardId")
    .lean();
  if (affected.length === 0) return [];
  await Task.updateMany(
    { workspaceId, linkedTasks: taskId },
    { $pull: { linkedTasks: taskId }, $set: { updatedAt: new Date() } },
  );
  return affected;
}
