/**
 * Ce qu'un lien client laisse voir, relu à chaque visite : un dossier mis à la
 * corbeille, passé en privé ou déplacé sort du lien aussitôt.
 *
 * Plus strict que la visibilité entre membres (sharedFolderAccess.js) : un
 * dossier privé n'est jamais montré à l'extérieur, ni ce qu'il contient, même
 * si un sous-dossier est resté public.
 */
import SharedFolder from "../models/SharedFolder.js";
import SharedDocument from "../models/SharedDocument.js";
import DocumentShare from "../models/DocumentShare.js";

const isClosed = (folder) =>
  Boolean(folder.trashedAt) || folder.visibility === "private";

/** Le dossier ou l'un de ses parents est privé ou à la corbeille. */
function hasClosedLineage(folder, folderMap) {
  const visited = new Set();
  let current = folder;
  while (current && !visited.has(String(current._id))) {
    if (isClosed(current)) return true;
    visited.add(String(current._id));
    current = current.parentId ? folderMap.get(String(current.parentId)) : null;
  }
  return false;
}

async function loadFolderMap(workspaceId) {
  const folders = await SharedFolder.find(
    { workspaceId },
    { name: 1, parentId: 1, visibility: 1, trashedAt: 1, order: 1 },
  ).lean();
  return new Map(folders.map((folder) => [String(folder._id), folder]));
}

/**
 * Motif pour lequel ce dossier ne peut pas être partagé, null s'il le peut.
 * @returns {Promise<"NOT_FOUND"|"CLOSED"|null>}
 */
export async function folderShareBlock(workspaceId, folderId) {
  const folderMap = await loadFolderMap(workspaceId);
  const folder = folderMap.get(String(folderId));
  if (!folder) return "NOT_FOUND";
  return hasClosedLineage(folder, folderMap) ? "CLOSED" : null;
}

/**
 * Pour afficher plusieurs liens d'un coup : un dossier partagé est-il toujours
 * accessible ? Tous les dossiers de l'espace sont lus une seule fois.
 * @returns {Promise<(folderId: unknown) => boolean>}
 */
export async function loadFolderAvailability(workspaceId) {
  const folderMap = await loadFolderMap(workspaceId);
  return (folderId) => {
    const folder = folderMap.get(String(folderId));
    return Boolean(folder) && !hasClosedLineage(folder, folderMap);
  };
}

/**
 * Dossiers visibles par un lien : le dossier partagé et ses sous-dossiers,
 * sans les branches privées ou à la corbeille.
 * @returns {Promise<{root: object, folders: object[], folderIds: Set<string>}|null>}
 *   null si le dossier partagé n'est plus accessible
 */
export async function loadShareFolders(share) {
  const folderMap = await loadFolderMap(share.workspaceId);
  const root = folderMap.get(String(share.folderId));
  if (!root || hasClosedLineage(root, folderMap)) return null;

  const childrenOf = new Map();
  for (const folder of folderMap.values()) {
    const parentKey = folder.parentId ? String(folder.parentId) : null;
    if (!parentKey) continue;
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey).push(folder);
  }

  const folders = [root];
  const folderIds = new Set([String(root._id)]);
  for (const folder of folders) {
    for (const child of childrenOf.get(String(folder._id)) || []) {
      const key = String(child._id);
      if (folderIds.has(key) || isClosed(child)) continue;
      folderIds.add(key);
      folders.push(child);
    }
  }
  return { root, folders, folderIds };
}

/** Document de la portée du lien, hors corbeille ; sinon null. */
export async function findShareDocument(share, shareFolders, documentId) {
  const document = await SharedDocument.findOne({
    _id: documentId,
    workspaceId: share.workspaceId,
    trashedAt: null,
  });
  if (!document?.folderId) return null;
  return shareFolders.folderIds.has(String(document.folderId))
    ? document
    : null;
}

/** Documents de la portée, sans rien d'interne (clé de stockage, auteur…). */
export async function listShareDocuments(share, shareFolders) {
  return SharedDocument.find(
    {
      workspaceId: share.workspaceId,
      folderId: { $in: [...shareFolders.folderIds] },
      trashedAt: null,
    },
    { name: 1, mimeType: 1, fileSize: 1, folderId: 1, createdAt: 1 },
  )
    .sort({ name: 1 })
    .lean();
}

/** Après une suppression définitive de dossiers : leurs liens disparaissent. */
export async function deleteOrphanDocumentShares(workspaceId) {
  const shares = await DocumentShare.find(
    { workspaceId },
    { folderId: 1 },
  ).lean();
  if (shares.length === 0) return;
  const existing = await SharedFolder.distinct("_id", {
    workspaceId,
    _id: { $in: shares.map((share) => share.folderId) },
  });
  const existingIds = new Set(existing.map(String));
  await DocumentShare.deleteMany({
    _id: {
      $in: shares
        .filter((share) => !existingIds.has(String(share.folderId)))
        .map((share) => share._id),
    },
  });
}
