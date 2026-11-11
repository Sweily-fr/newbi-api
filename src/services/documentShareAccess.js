/**
 * Ce qu'un accès client laisse voir, relu à chaque visite : un dossier mis à
 * la corbeille, passé en privé ou déplacé sort de l'accès aussitôt.
 *
 * Plus strict que la visibilité entre membres (sharedFolderAccess.js) : un
 * dossier privé n'est jamais montré à l'extérieur, ni ce qu'il contient, même
 * si un sous-dossier est resté public.
 */
import SharedFolder from "../models/SharedFolder.js";
import SharedDocument from "../models/SharedDocument.js";
import DocumentShare, { shareFolderIds } from "../models/DocumentShare.js";

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

/** Le dossier `folder` est-il rangé (même indirectement) sous l'un des `ids` ? */
function isUnderOneOf(folder, ids, folderMap) {
  const visited = new Set([String(folder._id)]);
  let parentKey = folder.parentId ? String(folder.parentId) : null;
  while (parentKey && !visited.has(parentKey)) {
    if (ids.has(parentKey)) return true;
    visited.add(parentKey);
    const parent = folderMap.get(parentKey);
    parentKey = parent?.parentId ? String(parent.parentId) : null;
  }
  return false;
}

async function loadFolderMap(workspaceId) {
  const folders = await SharedFolder.find(
    { workspaceId },
    { name: 1, parentId: 1, visibility: 1, trashedAt: 1, order: 1, color: 1 },
  ).lean();
  return new Map(folders.map((folder) => [String(folder._id), folder]));
}

const isAvailableIn = (folderMap) => (folderId) => {
  const folder = folderMap.get(String(folderId));
  return Boolean(folder) && !hasClosedLineage(folder, folderMap);
};

/**
 * Dossiers de l'espace qui ne peuvent pas être partagés, parmi `folderIds`.
 * @returns {Promise<{missing: string[], closed: string[]}>}
 */
export async function folderShareBlocks(workspaceId, folderIds) {
  const folderMap = await loadFolderMap(workspaceId);
  const missing = [];
  const closed = [];
  for (const folderId of folderIds) {
    const folder = folderMap.get(String(folderId));
    if (!folder) missing.push(String(folderId));
    else if (hasClosedLineage(folder, folderMap)) closed.push(String(folderId));
  }
  return { missing, closed };
}

/**
 * Pour afficher plusieurs accès d'un coup : nom et disponibilité de chaque
 * dossier. Tous les dossiers de l'espace sont lus une seule fois.
 */
export async function loadFolderAvailability(workspaceId) {
  const folderMap = await loadFolderMap(workspaceId);
  const isAvailable = isAvailableIn(folderMap);
  return (folderId) => {
    const folder = folderMap.get(String(folderId));
    return {
      id: String(folderId),
      name: folder?.name || "Dossier supprimé",
      available: isAvailable(folderId),
    };
  };
}

/**
 * Dossiers visibles par un accès : les dossiers choisis encore ouverts
 * (« racines », sans ceux déjà rangés sous un autre dossier choisi) et leurs
 * sous-dossiers, sans les branches privées ou à la corbeille.
 * @returns {Promise<{roots: object[], folders: object[], folderIds: Set<string>}|null>}
 *   null si plus aucun dossier choisi n'est accessible
 */
export async function loadShareFolders(share) {
  const folderMap = await loadFolderMap(share.workspaceId);
  const isAvailable = isAvailableIn(folderMap);
  const chosen = shareFolderIds(share)
    .map((id) => folderMap.get(String(id)))
    .filter((folder) => folder && isAvailable(folder._id));
  if (chosen.length === 0) return null;

  const chosenIds = new Set(chosen.map((folder) => String(folder._id)));
  const roots = chosen.filter(
    (folder) => !isUnderOneOf(folder, chosenIds, folderMap),
  );

  const childrenOf = new Map();
  for (const folder of folderMap.values()) {
    if (!folder.parentId) continue;
    const parentKey = String(folder.parentId);
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    childrenOf.get(parentKey).push(folder);
  }

  const folders = [...roots];
  const folderIds = new Set(roots.map((folder) => String(folder._id)));
  for (const folder of folders) {
    for (const child of childrenOf.get(String(folder._id)) || []) {
      const key = String(child._id);
      if (folderIds.has(key) || isClosed(child)) continue;
      folderIds.add(key);
      folders.push(child);
    }
  }
  return { roots, folders, folderIds };
}

/** Document de la portée de l'accès, hors corbeille ; sinon null. */
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

/**
 * Après une suppression définitive de dossiers : ils sortent des accès, et un
 * accès qui n'a plus aucun dossier disparaît.
 */
export async function deleteOrphanDocumentShares(workspaceId) {
  const shares = await DocumentShare.find(
    { workspaceId },
    { folderIds: 1, folderId: 1 },
  ).lean();
  if (shares.length === 0) return;
  const referenced = shares.flatMap((share) => shareFolderIds(share));
  const existing = new Set(
    (
      await SharedFolder.distinct("_id", {
        workspaceId,
        _id: { $in: referenced },
      })
    ).map(String),
  );
  for (const share of shares) {
    const ids = shareFolderIds(share);
    const kept = ids.filter((id) => existing.has(String(id)));
    if (kept.length === ids.length) continue;
    if (kept.length === 0) {
      await DocumentShare.deleteOne({ _id: share._id });
    } else {
      await DocumentShare.updateOne(
        { _id: share._id },
        { $set: { folderIds: kept }, $unset: { folderId: "" } },
      );
    }
  }
}
