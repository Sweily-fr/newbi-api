// Fichiers d'une tâche kanban supprimée (tâche, colonne ou tableau) : les
// pièces jointes de la tâche et de ses commentaires restaient en accès
// public dans le bucket kanban, et l'état de l'éditeur collaboratif en base.
//
// Seuls sont effacés les fichiers rangés dans le dossier de la tâche
// (`<taskId>/…`) que plus rien ne référence : ni une autre tâche (pièce
// jointe, commentaire, image collée dans une description), ni un post de
// réseau social. Au moindre doute, le fichier est gardé. Toujours appelé
// après la suppression en base, sans jamais faire échouer la suppression.
import mongoose from "mongoose";
import { Task } from "../models/kanban.js";
import KanbanCollabDoc from "../models/KanbanCollabDoc.js";
import cloudflareService from "./cloudflareService.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import logger from "../utils/logger.js";

/** Pièces jointes à lire sur les tâches avant leur suppression. */
export const TASK_FILE_FIELDS = "_id images.key comments.images.key";

const ownKeys = (task) => {
  const prefix = `${String(task._id)}/`;
  const keys = [
    ...(task.images || []).map((image) => image?.key),
    ...(task.comments || []).flatMap((comment) =>
      (comment?.images || []).map((image) => image?.key),
    ),
  ];
  return [
    ...new Set(
      keys.filter(
        (key) =>
          typeof key === "string" &&
          key.startsWith(prefix) &&
          !key.includes(".."),
      ),
    ),
  ];
};

const stillReferenced = async (key) => {
  const pattern = new RegExp(escapeRegex(key, 1024));
  if (
    await Task.exists({
      $or: [
        { "images.key": key },
        { "comments.images.key": key },
        { description: pattern },
      ],
    })
  ) {
    return true;
  }
  const db = mongoose.connection.db;
  if (!db) return true;
  const [media, post] = await Promise.all([
    db
      .collection("socialpostmedias")
      .findOne({ key }, { projection: { _id: 1 } }),
    db
      .collection("socialposts")
      .findOne({ "media.url": pattern }, { projection: { _id: 1 } }),
  ]);
  return Boolean(media || post);
};

/**
 * @param {Array<{_id, images?, comments?}>} tasks tâches déjà supprimées
 *   (lues avec TASK_FILE_FIELDS avant la suppression)
 * @returns {Promise<{ deleted: number, kept: number }>}
 */
export async function cleanupDeletedTasksFiles(tasks) {
  const list = (tasks || []).filter((task) => task?._id);
  let deleted = 0;
  let kept = 0;
  for (const task of list) {
    for (const key of ownKeys(task)) {
      try {
        if (await stillReferenced(key)) {
          kept += 1;
          continue;
        }
        await cloudflareService.deleteTaskImage(key);
        deleted += 1;
      } catch (error) {
        kept += 1;
        logger.warn(
          `[Kanban] Fichier ${key} non effacé après suppression: ${error.message}`,
        );
      }
    }
  }
  if (list.length > 0) {
    try {
      await KanbanCollabDoc.deleteMany({
        taskId: { $in: list.map((task) => String(task._id)) },
      });
    } catch (error) {
      logger.warn(
        `[Kanban] État collaboratif non effacé après suppression: ${error.message}`,
      );
    }
  }
  return { deleted, kept };
}

/** Sans attendre ni jamais lever : la suppression en base est faite. */
export const cleanupDeletedTasksFilesLater = (tasks) => {
  cleanupDeletedTasksFiles(tasks).catch((error) =>
    logger.warn(`[Kanban] Nettoyage des fichiers impossible: ${error.message}`),
  );
};
