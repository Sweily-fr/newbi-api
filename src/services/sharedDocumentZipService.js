/**
 * Service pour la génération de ZIP des dossiers partagés
 * Permet de télécharger un dossier complet avec ses sous-dossiers et fichiers
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import archiver from "archiver";
import mongoose from "mongoose";
import SharedDocument from "../models/SharedDocument.js";
import SharedFolder from "../models/SharedFolder.js";
import logger from "../utils/logger.js";

// Configuration R2
const s3Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_API_URL,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const SHARED_DOCUMENTS_BUCKET =
  process.env.SHARED_DOCUMENTS_BUCKET || "shared-documents-staging";

/**
 * Récupère récursivement tous les sous-dossiers d'un dossier
 * @param {string} folderId - ID du dossier parent
 * @param {string} workspaceId - ID du workspace
 * @returns {Promise<Array>} Liste des dossiers (incluant le parent et tous les enfants)
 */
async function getAllSubfolders(folderId, workspaceId) {
  const folders = [];
  // Cast to ObjectId to avoid string/ObjectId comparison issues
  const folderObjectId = new mongoose.Types.ObjectId(folderId);
  const workspaceObjectId = new mongoose.Types.ObjectId(workspaceId);

  async function fetchChildren(parentId) {
    const children = await SharedFolder.find({
      workspaceId: workspaceObjectId,
      parentId,
      trashedAt: null,
    });

    for (const child of children) {
      folders.push(child);
      await fetchChildren(child._id);
    }
  }

  // Ajouter le dossier principal
  const mainFolder = await SharedFolder.findOne({
    _id: folderObjectId,
    workspaceId: workspaceObjectId,
    trashedAt: null,
  });

  if (mainFolder) {
    folders.push(mainFolder);
    await fetchChildren(mainFolder._id);
  }

  return folders;
}

/**
 * Construit le chemin complet d'un dossier dans la hiérarchie
 * @param {Object} folder - Le dossier
 * @param {Map} folderMap - Map des dossiers par ID
 * @param {string} rootFolderId - ID du dossier racine
 * @returns {string} Chemin du dossier
 */
function buildFolderPath(folder, folderMap, rootFolderId) {
  const pathParts = [];
  let currentFolder = folder;

  while (currentFolder && currentFolder._id.toString() !== rootFolderId) {
    pathParts.unshift(sanitizeFileName(currentFolder.name));
    currentFolder = folderMap.get(currentFolder.parentId?.toString());
  }

  return pathParts.join("/");
}

/**
 * Nettoie un nom de fichier pour éviter les problèmes dans le ZIP
 * @param {string} name - Nom du fichier
 * @returns {string} Nom nettoyé
 */
function sanitizeFileName(name) {
  if (!name) return "unnamed";
  // Remplacer les caractères problématiques
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Récupère tous les documents d'un dossier et ses sous-dossiers
 * @param {string} folderId - ID du dossier
 * @param {string} workspaceId - ID du workspace
 * @returns {Promise<Object>} Documents organisés par dossier avec chemins
 */
async function getDocumentsWithPaths(folderId, workspaceId) {
  // Récupérer tous les sous-dossiers
  const folders = await getAllSubfolders(folderId, workspaceId);
  const folderIds = folders.map((f) => f._id);

  // Créer une map pour accès rapide
  const folderMap = new Map();
  folders.forEach((f) => folderMap.set(f._id.toString(), f));

  // Récupérer le nom du dossier racine
  const rootFolder = folderMap.get(folderId);
  const rootFolderName = rootFolder
    ? sanitizeFileName(rootFolder.name)
    : "documents";

  // Récupérer tous les documents dans ces dossiers (exclure la corbeille)
  const documents = await SharedDocument.find({
    workspaceId,
    folderId: { $in: folderIds },
    trashedAt: null,
  });

  // Organiser les documents avec leurs chemins (inclure le dossier parent racine)
  const documentsWithPaths = documents.map((doc) => {
    const folder = folderMap.get(doc.folderId?.toString());
    const folderPath = folder
      ? buildFolderPath(folder, folderMap, folderId)
      : "";

    return {
      document: doc,
      path: folderPath ? `${rootFolderName}/${folderPath}` : rootFolderName,
      fileName: sanitizeFileName(doc.originalName || doc.name),
    };
  });

  // Construire les chemins de tous les dossiers (pour inclure les dossiers vides)
  const allFolderPaths = folders.map((folder) => {
    const relativePath = buildFolderPath(folder, folderMap, folderId);
    return relativePath ? `${rootFolderName}/${relativePath}` : rootFolderName;
  });

  return {
    documents: documentsWithPaths,
    folderPaths: allFolderPaths,
    rootFolderName,
    totalSize: documents.reduce((sum, doc) => sum + (doc.fileSize || 0), 0),
    totalFiles: documents.length,
    totalFolders: folders.length,
  };
}

/**
 * Génère et stream un ZIP contenant tous les fichiers d'un dossier
 * @param {string} folderId - ID du dossier
 * @param {string} workspaceId - ID du workspace
 * @param {Object} res - Response Express pour le streaming
 */
async function streamFolderAsZip(folderId, workspaceId, res) {
  // Récupérer les documents avec leurs chemins
  const { documents, folderPaths, rootFolderName, totalFiles, totalFolders } =
    await getDocumentsWithPaths(folderId, workspaceId);

  if (totalFiles === 0 && totalFolders <= 1) {
    logger.warn(`⚠️ Dossier vide ${folderId}`, {
      folderId,
      workspaceId,
      rootFolderName,
    });
    throw new Error("Aucun document dans ce dossier");
  }

  logger.info(`📦 Création ZIP pour dossier ${folderId}`, {
    totalFiles,
    totalFolders,
    rootFolderName,
  });

  // Configurer les headers de réponse
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(rootFolderName)}.zip"`,
  );

  // Créer l'archive
  const archive = archiver("zip", {
    zlib: { level: 6 },
  });

  archive.on("error", (err) => {
    logger.error("❌ Erreur création ZIP:", err);
    throw err;
  });

  archive.on("warning", (err) => {
    if (err.code === "ENOENT") {
      logger.warn("⚠️ Fichier manquant dans ZIP:", err);
    } else {
      throw err;
    }
  });

  // Pipe vers la réponse
  archive.pipe(res);

  // Ajouter tous les dossiers (y compris les vides) comme entrées dans le ZIP
  for (const folderPath of folderPaths) {
    archive.append("", { name: `${folderPath}/` });
  }

  // Ajouter chaque fichier à l'archive
  let addedFiles = 0;
  const errors = [];

  for (const { document, path, fileName } of documents) {
    try {
      const command = new GetObjectCommand({
        Bucket: SHARED_DOCUMENTS_BUCKET,
        Key: document.fileKey,
      });

      const response = await s3Client.send(command);
      const zipPath = `${path}/${fileName}`;

      archive.append(response.Body, { name: zipPath });
      addedFiles++;

      logger.debug(`✅ Ajouté au ZIP: ${zipPath}`);
    } catch (error) {
      logger.error(`❌ Erreur ajout fichier ${document.name}:`, error.message);
      errors.push({ file: document.name, error: error.message });
    }
  }

  // Finaliser l'archive
  await archive.finalize();

  logger.info("📦 ZIP créé avec succès", {
    folderId,
    addedFiles,
    foldersAdded: folderPaths.length,
    errors: errors.length,
  });

  return { addedFiles, errors };
}

/**
 * Vérifie si un utilisateur a accès à un dossier
 * @param {string} folderId - ID du dossier
 * @param {string} workspaceId - ID du workspace
 * @returns {Promise<Object|null>} Le dossier si accès autorisé, null sinon
 */
async function verifyFolderAccess(folderId, workspaceId) {
  const folder = await SharedFolder.findOne({
    _id: folderId,
    workspaceId,
  });

  return folder;
}

/**
 * Génère et stream un ZIP contenant une sélection de dossiers et/ou documents
 * @param {Object} params
 * @param {string[]} params.folderIds - IDs des dossiers à inclure
 * @param {string[]} params.documentIds - IDs des documents individuels à inclure
 * @param {string[]} params.excludedFolderIds - IDs des sous-dossiers à exclure
 * @param {string} params.workspaceId - ID du workspace
 * @param {Object} res - Response Express pour le streaming
 */
async function streamSelectionAsZip(
  { folderIds = [], documentIds = [], excludedFolderIds = [], workspaceId },
  res,
) {
  const excludedSet = new Set(excludedFolderIds.map(String));
  const allDocumentsToZip = []; // { document, zipPath }
  const allFolderPaths = []; // chemins des dossiers (y compris vides)

  // 1. Process each selected folder
  for (const folderId of folderIds) {
    const folders = await getAllSubfolders(folderId, workspaceId);
    if (folders.length === 0) continue;

    // Filter out excluded subfolders and their descendants
    const filteredFolders = [];
    const excludedBranches = new Set();

    for (const folder of folders) {
      const fid = folder._id.toString();
      if (
        excludedSet.has(fid) ||
        excludedBranches.has(folder.parentId?.toString())
      ) {
        excludedBranches.add(fid);
        continue;
      }
      filteredFolders.push(folder);
    }

    const filteredFolderIds = filteredFolders.map((f) => f._id);
    const folderMap = new Map();
    filteredFolders.forEach((f) => folderMap.set(f._id.toString(), f));

    // Get documents in the filtered folders (exclure la corbeille)
    const docs = await SharedDocument.find({
      workspaceId,
      folderId: { $in: filteredFolderIds },
      trashedAt: null,
    });

    // Root folder name for this selection item
    const rootFolder = folderMap.get(folderId);
    const rootFolderName = rootFolder
      ? sanitizeFileName(rootFolder.name)
      : "dossier";

    // Ajouter tous les dossiers (y compris vides)
    for (const folder of filteredFolders) {
      const relativePath = buildFolderPath(folder, folderMap, folderId);
      const fullPath = relativePath
        ? `${rootFolderName}/${relativePath}`
        : rootFolderName;
      allFolderPaths.push(fullPath);
    }

    for (const doc of docs) {
      const folder = folderMap.get(doc.folderId?.toString());
      const folderPath = folder
        ? buildFolderPath(folder, folderMap, folderId)
        : "";
      const fileName = sanitizeFileName(doc.originalName || doc.name);
      const zipPath = folderPath
        ? `${rootFolderName}/${folderPath}/${fileName}`
        : `${rootFolderName}/${fileName}`;

      allDocumentsToZip.push({ document: doc, zipPath });
    }
  }

  // 2. Process individual documents
  if (documentIds.length > 0) {
    const individualDocs = await SharedDocument.find({
      _id: { $in: documentIds },
      workspaceId,
      trashedAt: null,
    });

    for (const doc of individualDocs) {
      const fileName = sanitizeFileName(doc.originalName || doc.name);
      allDocumentsToZip.push({ document: doc, zipPath: fileName });
    }
  }

  if (allDocumentsToZip.length === 0 && allFolderPaths.length === 0) {
    throw new Error("Aucun document dans la sélection");
  }

  logger.info("📦 Création ZIP pour sélection", {
    folderIds,
    documentIds,
    excludedFolderIds,
    totalFiles: allDocumentsToZip.length,
    totalFolders: allFolderPaths.length,
  });

  // Handle duplicate filenames in ZIP by appending (1), (2), etc.
  const usedPaths = new Map();
  for (const item of allDocumentsToZip) {
    let path = item.zipPath;
    if (usedPaths.has(path)) {
      const count = usedPaths.get(path) + 1;
      usedPaths.set(path, count);
      const ext = path.lastIndexOf(".");
      if (ext > 0) {
        path = `${path.substring(0, ext)} (${count})${path.substring(ext)}`;
      } else {
        path = `${path} (${count})`;
      }
      item.zipPath = path;
    } else {
      usedPaths.set(path, 0);
    }
  }

  // Configure response headers
  const zipName =
    folderIds.length === 1 && documentIds.length === 0
      ? `${allFolderPaths[0] || "documents"}.zip`
      : "documents.zip";

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(zipName)}"`,
  );

  // Create archive
  const archive = archiver("zip", { zlib: { level: 6 } });

  archive.on("error", (err) => {
    logger.error("❌ Erreur création ZIP sélection:", err);
    throw err;
  });

  archive.on("warning", (err) => {
    if (err.code === "ENOENT") {
      logger.warn("⚠️ Fichier manquant dans ZIP:", err);
    } else {
      throw err;
    }
  });

  archive.pipe(res);

  // Ajouter tous les dossiers (y compris les vides)
  for (const folderPath of allFolderPaths) {
    archive.append("", { name: `${folderPath}/` });
  }

  let addedFiles = 0;
  const errors = [];

  for (const { document, zipPath } of allDocumentsToZip) {
    try {
      const command = new GetObjectCommand({
        Bucket: SHARED_DOCUMENTS_BUCKET,
        Key: document.fileKey,
      });
      const response = await s3Client.send(command);
      archive.append(response.Body, { name: zipPath });
      addedFiles++;
    } catch (error) {
      logger.error(`❌ Erreur ajout fichier ${document.name}:`, error.message);
      errors.push({ file: document.name, error: error.message });
    }
  }

  await archive.finalize();

  logger.info("📦 ZIP sélection créé avec succès", {
    addedFiles,
    foldersAdded: allFolderPaths.length,
    errors: errors.length,
  });

  return { addedFiles, errors };
}

/**
 * Récupère les informations sur une sélection (sous-dossiers, taille, nombre de fichiers)
 * pour afficher dans le dialog de configuration avant téléchargement
 */
async function getSelectionInfo({
  folderIds = [],
  documentIds = [],
  workspaceId,
}) {
  const folderDetails = [];

  for (const folderId of folderIds) {
    const folders = await getAllSubfolders(folderId, workspaceId);
    if (folders.length === 0) continue;

    const rootFolder = folders.find((f) => f._id.toString() === folderId);
    const subfolders = folders.filter((f) => f._id.toString() !== folderId);
    const folderIdsInTree = folders.map((f) => f._id);

    const docs = await SharedDocument.find({
      workspaceId,
      folderId: { $in: folderIdsInTree },
      trashedAt: null,
    });

    const totalSize = docs.reduce((sum, d) => sum + (d.fileSize || 0), 0);

    // Build subfolder tree info
    const subfolderInfos = [];
    for (const sub of subfolders) {
      const subDocs = await SharedDocument.find({
        workspaceId,
        folderId: sub._id,
        trashedAt: null,
      });
      subfolderInfos.push({
        id: sub._id.toString(),
        name: sub.name,
        parentId: sub.parentId?.toString(),
        filesCount: subDocs.length,
        size: subDocs.reduce((sum, d) => sum + (d.fileSize || 0), 0),
      });
    }

    folderDetails.push({
      id: folderId,
      name: rootFolder?.name || "Dossier",
      filesCount: docs.length,
      totalSize,
      subfolders: subfolderInfos,
    });
  }

  // Individual documents info
  let individualDocs = [];
  if (documentIds.length > 0) {
    individualDocs = await SharedDocument.find({
      _id: { $in: documentIds },
      workspaceId,
      trashedAt: null,
    });
  }

  const individualDocsSize = individualDocs.reduce(
    (sum, d) => sum + (d.fileSize || 0),
    0,
  );
  const totalFoldersSize = folderDetails.reduce(
    (sum, f) => sum + f.totalSize,
    0,
  );

  return {
    folders: folderDetails,
    documents: individualDocs.map((d) => ({
      id: d._id.toString(),
      name: d.originalName || d.name,
      size: d.fileSize || 0,
    })),
    totalFiles:
      folderDetails.reduce((sum, f) => sum + f.filesCount, 0) +
      individualDocs.length,
    totalSize: totalFoldersSize + individualDocsSize,
  };
}

export {
  streamFolderAsZip,
  streamSelectionAsZip,
  getDocumentsWithPaths,
  getSelectionInfo,
  verifyFolderAccess,
  getAllSubfolders,
  sanitizeFileName,
  buildFolderPath,
  s3Client as sharedDocsS3Client,
  SHARED_DOCUMENTS_BUCKET,
};
