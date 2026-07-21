import logger from "./logger.js";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import cloudflareTransferService from "../services/cloudflareTransferService.js";
import { v4 as uuidv4 } from "uuid";

const readFileAsync = promisify(fs.readFile);

// Taille de chunk définie à 10Mo (minimum S3 multipart = 5MB)
export const CHUNK_SIZE = 10 * 1024 * 1024;

// Dossier temporaire local pour les chunks (fallback)
const TEMP_CHUNKS_DIR = path.join(
  process.cwd(),
  "public",
  "uploads",
  "temp-chunks",
);

/**
 * Sauvegarde un chunk de fichier sur Cloudflare R2
 * @param {Object} chunk - Le fichier chunk uploadé
 * @param {String} fileId - Identifiant unique du fichier
 * @param {Number} chunkIndex - Index du chunk
 * @param {String} fileName - Nom du fichier
 * @param {String} transferId - ID du transfert (optionnel, généré si non fourni)
 * @returns {Promise<Object>} - Informations sur le chunk sauvegardé
 */
export const saveChunkToR2 = async (
  chunk,
  fileId,
  chunkIndex,
  fileName,
  transferId = null,
) => {
  try {
    const { createReadStream } = await chunk;
    const stream = createReadStream();

    // Générer un transferId temporaire si non fourni
    if (!transferId) {
      transferId = `temp_${uuidv4()}`;
    }

    // Lire le stream en buffer
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const chunkBuffer = Buffer.concat(chunks);

    logger.debug(
      `📤 Sauvegarde chunk ${chunkIndex} pour fichier ${fileId} (${chunkBuffer.length} octets)`,
    );

    // Upload du chunk vers R2
    const result = await cloudflareTransferService.uploadChunk(
      chunkBuffer,
      transferId,
      fileId,
      chunkIndex,
      fileName,
    );

    return {
      chunkKey: result.key,
      chunkSize: result.size,
      chunkIndex,
      transferId,
    };
  } catch (error) {
    console.error(
      `Erreur lors de la sauvegarde du chunk ${chunkIndex} pour le fichier ${fileId}:`,
      error,
    );
    throw error;
  }
};

/**
 * Vérifie si tous les chunks d'un fichier ont été uploadés sur R2
 * Utilise listObjects pour trouver les chunks quel que soit leur date d'upload
 * @param {String} transferId - ID du transfert
 * @param {String} fileId - Identifiant unique du fichier
 * @param {Number} totalChunks - Nombre total de chunks attendus
 * @returns {Promise<Boolean>} - True si tous les chunks sont présents
 */
export const areAllChunksReceivedOnR2 = async (
  transferId,
  fileId,
  totalChunks,
) => {
  try {
    // Utiliser listObjects pour trouver tous les chunks
    const prefix = "temp/";
    const objects = await cloudflareTransferService.listObjects(prefix);

    // Filtrer les chunks correspondant au transferId et fileId
    const pattern = new RegExp(`t_${transferId}/f_${fileId}/chunk_(\\d+)`);
    const matchingChunks = objects.filter((obj) => pattern.test(obj.key));

    // Vérifier si on a tous les chunks
    if (matchingChunks.length < totalChunks) {
      logger.debug(
        `❌ Chunks manquants pour fichier ${fileId}: ${matchingChunks.length}/${totalChunks}`,
      );
      return false;
    }

    // Vérifier que tous les indices de 0 à totalChunks-1 sont présents
    const foundIndices = new Set();
    for (const obj of matchingChunks) {
      const match = obj.key.match(pattern);
      if (match) {
        foundIndices.add(parseInt(match[1], 10));
      }
    }

    for (let i = 0; i < totalChunks; i++) {
      if (!foundIndices.has(i)) {
        logger.debug(`❌ Chunk ${i} manquant pour fichier ${fileId}`);
        return false;
      }
    }

    logger.debug(
      `✅ Tous les chunks (${totalChunks}) présents pour fichier ${fileId}`,
    );
    return true;
  } catch (error) {
    console.error(
      `Erreur lors de la vérification des chunks pour ${fileId}:`,
      error,
    );
    return false;
  }
};

/**
 * Reconstruit un fichier complet à partir de ses chunks sur R2
 * @param {String} transferId - ID du transfert
 * @param {String} fileId - Identifiant unique du fichier
 * @param {String} fileName - Nom du fichier
 * @param {Number} totalChunks - Nombre total de chunks
 * @param {String} mimeType - Type MIME du fichier
 * @returns {Promise<Object>} - Informations sur le fichier reconstruit
 */
export const reconstructFileFromR2 = async (
  transferId,
  fileId,
  fileName,
  totalChunks,
  mimeType,
) => {
  try {
    logger.debug(
      `🔧 Reconstruction du fichier ${fileName} (${fileId}) à partir de ${totalChunks} chunks`,
    );

    // Déterminer le type MIME si non fourni
    if (!mimeType) {
      const ext = path.extname(fileName).toLowerCase();
      mimeType = cloudflareTransferService.getContentType(ext);
    }

    // Reconstruire le fichier sur R2
    const result = await cloudflareTransferService.reconstructFileFromChunks(
      transferId,
      fileId,
      fileName,
      totalChunks,
      mimeType,
    );

    logger.debug(
      `✅ Fichier reconstruit: ${result.key} (${result.size} octets)`,
    );

    // ✅ CORRECTION #2: Séparer le nom original (sans ID) du nom de stockage (avec ID)
    // originalName et displayName = nom propre pour l'utilisateur
    // fileName = nom avec ID pour l'unicité en stockage (mais non utilisé pour le téléchargement)
    const sanitizedFileName =
      cloudflareTransferService.sanitizeFileName(fileName);

    // Retourner les informations du fichier dans le format attendu
    return {
      originalName: fileName, // Nom original sans ID (utilisé pour le téléchargement)
      displayName: fileName, // Nom affiché à l'utilisateur (sans ID)
      fileName: `${fileId}_${sanitizedFileName}`, // Nom de stockage avec ID (pour unicité)
      filePath: result.url, // URL d'accès au fichier
      r2Key: result.key, // Clé R2 pour référence
      mimeType: result.contentType,
      size: result.size,
      storageType: "r2", // Indicateur du type de stockage
    };
  } catch (error) {
    console.error(
      `Erreur lors de la reconstruction du fichier ${fileId}:`,
      error,
    );
    throw error;
  }
};

/**
 * Nettoie les chunks temporaires d'un fichier en cas d'erreur
 * @param {String} transferId - ID du transfert
 * @param {String} fileId - Identifiant unique du fichier
 * @param {Number} totalChunks - Nombre total de chunks
 * @returns {Promise<Boolean>} - True si le nettoyage a réussi
 */
export const cleanupChunksFromR2 = async (transferId, fileId, totalChunks) => {
  try {
    logger.debug(`🧹 Nettoyage des chunks pour fichier ${fileId}`);

    await cloudflareTransferService.cleanupChunks(
      transferId,
      fileId,
      totalChunks,
    );

    logger.debug(`✅ Nettoyage terminé pour fichier ${fileId}`);
    return true;
  } catch (error) {
    console.error(
      `Erreur lors du nettoyage des chunks pour le fichier ${fileId}:`,
      error,
    );
    return false;
  }
};

/**
 * Upload direct d'un fichier complet vers R2 (sans chunks)
 * @param {Object} file - Fichier uploadé
 * @param {String} transferId - ID du transfert
 * @param {String} fileId - ID du fichier
 * @returns {Promise<Object>} - Informations sur le fichier uploadé
 */
export const uploadFileDirectToR2 = async (file, transferId, fileId) => {
  try {
    const { createReadStream, filename, mimetype } = await file;
    const stream = createReadStream();

    // Lire le stream en buffer
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const fileBuffer = Buffer.concat(chunks);

    logger.debug(
      `📤 Upload direct du fichier ${filename} (${fileBuffer.length} octets)`,
    );

    // Vérifier la taille du fichier
    if (!cloudflareTransferService.isValidFileSize(fileBuffer)) {
      throw new Error("Fichier trop volumineux (limite: 10GB)");
    }

    // Upload vers R2
    const result = await cloudflareTransferService.uploadFile(
      fileBuffer,
      transferId,
      fileId,
      filename,
      mimetype,
    );

    return {
      originalName: filename,
      displayName: filename,
      fileName: `${fileId}_${cloudflareTransferService.sanitizeFileName(
        filename,
      )}`,
      filePath: result.url,
      r2Key: result.key,
      mimeType: result.contentType,
      size: result.size,
      storageType: "r2",
    };
  } catch (error) {
    console.error("Erreur lors de l'upload direct vers R2:", error);
    throw error;
  }
};

/**
 * Upload d'un fichier base64 vers R2
 * @param {Object} fileInput - Données du fichier en base64
 * @param {String} transferId - ID du transfert
 * @param {String} fileId - ID du fichier
 * @returns {Promise<Object>} - Informations sur le fichier uploadé
 */
export const uploadBase64FileToR2 = async (fileInput, transferId, fileId) => {
  try {
    const { name, type, size, base64 } = fileInput;

    logger.debug(
      `📤 Upload base64 du fichier ${name} (taille déclarée: ${size})`,
    );

    // Décoder le base64
    let base64Data = "";
    let contentType = type;

    // Vérifier si la chaîne contient un en-tête data URI
    if (base64.includes(";base64,")) {
      const parts = base64.split(";base64,");
      contentType = parts[0].replace("data:", "");
      base64Data = parts[1];
    } else if (base64.startsWith("data:") && base64.includes(",")) {
      const parts = base64.split(",");
      contentType = parts[0].replace("data:", "").replace(";", "");
      base64Data = parts[1];
    } else {
      base64Data = base64;
    }

    // Nettoyer la chaîne base64
    base64Data = base64Data.replace(/\s/g, "");

    // Vérifier la validité du base64
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    if (!base64Regex.test(base64Data)) {
      throw new Error("Chaîne base64 invalide");
    }

    // Décoder en buffer
    const fileBuffer = Buffer.from(base64Data, "base64");

    logger.debug(`📊 Fichier décodé: ${fileBuffer.length} octets`);

    // Vérifier la taille du fichier
    if (!cloudflareTransferService.isValidFileSize(fileBuffer)) {
      throw new Error("Fichier trop volumineux (limite: 10GB)");
    }

    // Upload vers R2
    const result = await cloudflareTransferService.uploadFile(
      fileBuffer,
      transferId,
      fileId,
      name,
      contentType,
    );

    return {
      originalName: name,
      displayName: name,
      fileName: `${fileId}_${cloudflareTransferService.sanitizeFileName(name)}`,
      filePath: result.url,
      r2Key: result.key,
      mimeType: result.contentType,
      size: result.size,
      storageType: "r2",
    };
  } catch (error) {
    console.error("Erreur lors de l'upload base64 vers R2:", error);
    throw error;
  }
};

/**
 * Supprime un fichier de R2
 * @param {String} r2Key - Clé R2 du fichier
 * @returns {Promise<Boolean>} - True si la suppression a réussi
 */
export const deleteFileFromR2 = async (r2Key) => {
  try {
    if (!r2Key) {
      console.warn("⚠️ Clé R2 manquante pour la suppression");
      return false;
    }

    await cloudflareTransferService.deleteFile(r2Key);
    logger.debug(`🗑️ Fichier supprimé de R2: ${r2Key}`);
    return true;
  } catch (error) {
    console.error(
      `Erreur lors de la suppression du fichier R2 ${r2Key}:`,
      error,
    );
    return false;
  }
};

/**
 * Génère une URL d'accès temporaire pour un fichier R2
 * @param {String} r2Key - Clé R2 du fichier
 * @param {Number} expiresIn - Durée de validité en secondes
 * @returns {Promise<String>} - URL d'accès temporaire
 */
export const generateFileAccessUrl = async (r2Key, expiresIn = 3600) => {
  try {
    if (!r2Key) {
      throw new Error("Clé R2 manquante");
    }

    return await cloudflareTransferService.getFileUrl(r2Key, expiresIn);
  } catch (error) {
    console.error(
      `Erreur lors de la génération de l'URL d'accès pour ${r2Key}:`,
      error,
    );
    throw error;
  }
};
