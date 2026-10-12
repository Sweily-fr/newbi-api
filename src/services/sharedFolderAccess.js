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
  if (folder.visibility) {
    return {
      visibility: folder.visibility,
      allowedUserIds: (folder.allowedUserIds || []).map((id) => id.toString()),
      createdBy: folder.createdBy?.toString(),
    };
  }
  if (folder.parentId) {
    const parent = folderMap.get(folder.parentId.toString());
    if (parent) return getEffectiveVisibility(parent, folderMap);
  }
  return {
    visibility: "public",
    allowedUserIds: [],
    createdBy: folder.createdBy?.toString(),
  };
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

  const inaccessibleFolderIds = folders
    .filter((folder) => !canAccess(folder._id))
    .map((folder) => folder._id);

  return { canAccess, canAccessDocument, canTarget, inaccessibleFolderIds };
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
