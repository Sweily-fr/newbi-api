/**
 * Visibilité des dossiers des documents partagés (`visibility` /
 * `allowedUserIds`), source unique pour les queries GraphQL du module, les
 * routes REST de téléchargement et d'aperçu, les ZIP et les transferts
 * créés depuis les documents partagés.
 *
 * Règle (inchangée, reprise du resolver) : un dossier sans visibilité
 * propre hérite de celle de son parent ; un dossier public est ouvert à tout
 * membre qui a « Voir » ; un dossier privé n'est ouvert qu'à son créateur, à
 * celui du dossier qui porte la visibilité et aux membres autorisés.
 */
import SharedFolder from "../models/SharedFolder.js";

export function getEffectiveVisibility(folder, folderMap) {
  // Remontée itérative des parents ; un parent déjà visité (cycle en base)
  // arrête la remontée comme un dossier racine.
  const visited = new Set();
  let current = folder;
  while (current) {
    if (current.visibility) {
      return {
        visibility: current.visibility,
        allowedUserIds: (current.allowedUserIds || []).map((id) =>
          id.toString(),
        ),
        createdBy: current.createdBy?.toString(),
      };
    }
    visited.add(String(current._id));
    const parentKey = current.parentId?.toString();
    if (!parentKey || visited.has(parentKey)) break;
    current = folderMap.get(parentKey);
  }
  return {
    visibility: "public",
    allowedUserIds: [],
    createdBy: folder.createdBy?.toString(),
  };
}

/**
 * Vrai si `candidateParentId` est le dossier `folderId` lui-même ou l'un de
 * ses descendants : le déplacer dessous créerait un cycle. Remonte les
 * parents de `candidateParentId` dans la carte des dossiers de l'espace.
 */
export function isFolderOrDescendant(folderMap, folderId, candidateParentId) {
  if (!folderId || !candidateParentId) return false;
  const target = String(folderId);
  const visited = new Set();
  let key = String(candidateParentId);
  while (key && !visited.has(key)) {
    if (key === target) return true;
    visited.add(key);
    key = folderMap.get(key)?.parentId?.toString();
  }
  // Un cycle déjà présent au-dessus du candidat : on refuse aussi
  return Boolean(key);
}

export function canAccessFolder(userId, folder, effectiveVis) {
  if (effectiveVis.visibility === "public") return true;
  if (folder.createdBy?.toString() === userId) return true;
  if (effectiveVis.createdBy === userId) return true;
  return effectiveVis.allowedUserIds.includes(userId);
}

/**
 * Accès d'un utilisateur aux dossiers d'un espace (tous les dossiers lus en
 * une fois, corbeille comprise : un document d'un dossier privé mis à la
 * corbeille reste protégé).
 *
 * - `canAccess(folderId)` : true pour la racine (« Documents à classer »,
 *   folderId null) et pour un dossier introuvable (document dont le dossier
 *   a disparu, que la liste GraphQL affiche aussi) ; sinon la règle
 *   ci-dessus ;
 * - `canAccessDocument(doc)` : dossier actuel et, pour un document mis à la
 *   corbeille, dossier d'origine tous deux accessibles ;
 * - `canTarget(folderId)` : dossier cible fourni par le client (dépôt,
 *   déplacement, dossier parent) : la racine, ou un dossier de l'espace
 *   accessible. Un dossier introuvable (d'un autre espace) est refusé ;
 * - `parentProblem(folderId, parentId)` : "CYCLE" si `parentId` est le
 *   dossier lui-même ou un de ses sous-dossiers, "TRASHED" s'il est en
 *   corbeille, null sinon ;
 * - `inaccessibleFolderIds` : ObjectId des dossiers inaccessibles, pour
 *   exclure leurs éléments d'un filtre ($nin).
 */
export async function loadSharedFolderAccess(workspaceId, userId) {
  const folders = await SharedFolder.find({ workspaceId });
  const folderMap = new Map(folders.map((f) => [f._id.toString(), f]));
  const uid = String(userId);
  const memo = new Map();

  const canAccess = (folderId) => {
    if (!folderId) return true;
    const key = String(folderId);
    const folder = folderMap.get(key);
    if (!folder) return true;
    if (!memo.has(key)) {
      memo.set(
        key,
        canAccessFolder(uid, folder, getEffectiveVisibility(folder, folderMap)),
      );
    }
    return memo.get(key);
  };

  const canAccessDocument = (doc) =>
    Boolean(doc) && canAccess(doc.folderId) && canAccess(doc.originalFolderId);

  const canTarget = (folderId) =>
    !folderId || (folderMap.has(String(folderId)) && canAccess(folderId));

  // Dossier parent proposé pour `folderId` : ni le dossier lui-même, ni un de
  // ses sous-dossiers, ni un dossier en corbeille.
  const parentProblem = (folderId, parentId) => {
    if (!parentId) return null;
    const parent = folderMap.get(String(parentId));
    if (parent?.trashedAt) return "TRASHED";
    if (folderId && isFolderOrDescendant(folderMap, folderId, parentId)) {
      return "CYCLE";
    }
    return null;
  };

  const inaccessibleFolderIds = folders
    .filter((folder) => !canAccess(folder._id))
    .map((folder) => folder._id);

  return {
    canAccess,
    canAccessDocument,
    canTarget,
    parentProblem,
    inaccessibleFolderIds,
  };
}

/**
 * Même chose, lue une seule fois par contexte de requête GraphQL et par
 * espace (les resolvers de champs d'une liste la partagent).
 */
export function sharedFolderAccessFor(context, workspaceId) {
  const user = context?.user;
  const userId = String(user?._id || user?.id || "");
  context._sharedFolderAccess ||= new Map();
  const key = `${workspaceId}:${userId}`;
  if (!context._sharedFolderAccess.has(key)) {
    context._sharedFolderAccess.set(
      key,
      loadSharedFolderAccess(workspaceId, userId),
    );
  }
  return context._sharedFolderAccess.get(key);
}
