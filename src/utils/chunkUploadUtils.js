import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { ensureDirectoryExists, integrateReconstructedFile } from './fileTransferUtils.js';

const writeFileAsync = promisify(fs.writeFile);
const appendFileAsync = promisify(fs.appendFile);
const readFileAsync = promisify(fs.readFile);
const unlinkAsync = promisify(fs.unlink);
const existsAsync = promisify(fs.exists);

// Taille de chunk définie à 2Mo
export const CHUNK_SIZE = 2 * 1024 * 1024;

// Dossier pour stocker les chunks temporaires
const TEMP_CHUNKS_DIR = path.join(process.cwd(), 'public', 'uploads', 'temp-chunks');

/**
 * Sauvegarde un chunk de fichier
 * @param {Object} chunk - Le fichier chunk uploadé
 * @param {String} fileId - Identifiant unique du fichier
 * @param {Number} chunkIndex - Index du chunk
 * @param {String} fileName - Nom du fichier
 * @returns {Promise<Object>} - Informations sur le chunk sauvegardé
 */
export const saveChunk = async (chunk, fileId, chunkIndex, fileName) => {
  try {
    const { createReadStream } = await chunk;
    const stream = createReadStream();
    
    // Créer le dossier temporaire pour ce fichier spécifique
    const fileChunksDir = path.join(TEMP_CHUNKS_DIR, fileId);
    ensureDirectoryExists(fileChunksDir);
    
    // Chemin du chunk
    const chunkPath = path.join(fileChunksDir, `chunk-${chunkIndex}`);
    
    // Écrire le chunk dans un fichier temporaire
    const writeStream = fs.createWriteStream(chunkPath);
    
    return new Promise((resolve, reject) => {
      stream.pipe(writeStream);
      
      writeStream.on('finish', () => {
        const chunkSize = fs.statSync(chunkPath).size;
        resolve({
          chunkPath,
          chunkSize,
          chunkIndex
        });
      });
      
      writeStream.on('error', (err) => {
        console.error(`Erreur lors de l'écriture du chunk ${chunkIndex} pour le fichier ${fileId}:`, err);
        reject(err);
      });
      
      stream.on('error', (err) => {
        console.error(`Erreur lors de la lecture du chunk ${chunkIndex} pour le fichier ${fileId}:`, err);
        reject(err);
      });
    });
  } catch (error) {
    console.error(`Erreur lors de la sauvegarde du chunk ${chunkIndex} pour le fichier ${fileId}:`, error);
    throw error;
  }
};

/**
 * Vérifie si tous les chunks d'un fichier ont été reçus
 * @param {String} fileId - Identifiant unique du fichier
 * @param {Number} totalChunks - Nombre total de chunks attendus
 * @returns {Promise<Boolean>} - True si tous les chunks sont présents
 */
export const areAllChunksReceived = async (fileId, totalChunks) => {
  const fileChunksDir = path.join(TEMP_CHUNKS_DIR, fileId);
  
  if (!fs.existsSync(fileChunksDir)) {
    return false;
  }
  
  // Vérifier si tous les chunks existent
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(fileChunksDir, `chunk-${i}`);
    if (!fs.existsSync(chunkPath)) {
      return false;
    }
  }
  
  return true;
};

/**
 * Reconstruit un fichier complet à partir de ses chunks
 * @param {String} fileId - Identifiant unique du fichier
 * @param {String} fileName - Nom du fichier
 * @param {Number} totalChunks - Nombre total de chunks
 * @param {String} userId - ID de l'utilisateur
 * @returns {Promise<Object>} - Informations sur le fichier reconstruit
 */
export const reconstructFile = async (fileId, fileName, totalChunks, userId) => {
  const fileChunksDir = path.join(TEMP_CHUNKS_DIR, fileId);
  
  // Créer le dossier d'upload pour l'utilisateur
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'file-transfers', userId);
  ensureDirectoryExists(uploadDir);
  
  // Générer un nom de fichier unique en préservant l'extension
  const originalExt = path.extname(fileName);
  const nameWithoutExt = path.basename(fileName, originalExt);
  const uniqueFilename = `${Date.now()}-${fileId.substring(0, 8)}-${nameWithoutExt.replace(/[^a-zA-Z0-9.-]/g, '_')}${originalExt}`;
  
  // Chemin complet du fichier final
  const filePath = path.join(uploadDir, uniqueFilename);
  
  // Chemin relatif pour l'accès via URL
  const fileUrl = `/uploads/file-transfers/${userId}/${uniqueFilename}`;
  
  try {
    // Créer un nouveau fichier vide
    await writeFileAsync(filePath, Buffer.alloc(0));
    
    // Ajouter chaque chunk au fichier dans l'ordre
    let totalSize = 0;
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(fileChunksDir, `chunk-${i}`);
      const chunkData = await readFileAsync(chunkPath);
      await appendFileAsync(filePath, chunkData);
      totalSize += chunkData.length;
      
      // Supprimer le chunk après l'avoir ajouté
      await unlinkAsync(chunkPath);
    }
    
    // Déterminer le type MIME à partir de l'extension
    let mimeType = 'application/octet-stream';
    const ext = originalExt.toLowerCase();
    if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
    else if (ext === '.png') mimeType = 'image/png';
    else if (ext === '.gif') mimeType = 'image/gif';
    else if (ext === '.pdf') mimeType = 'application/pdf';
    else if (['.doc', '.docx'].includes(ext)) mimeType = 'application/msword';
    else if (['.xls', '.xlsx'].includes(ext)) mimeType = 'application/vnd.ms-excel';
    else if (['.ppt', '.pptx'].includes(ext)) mimeType = 'application/vnd.ms-powerpoint';
    else if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.zip') mimeType = 'application/zip';
    else if (ext === '.rar') mimeType = 'application/x-rar-compressed';
    else if (ext === '.mp4') mimeType = 'video/mp4';
    else if (ext === '.mp3') mimeType = 'audio/mpeg';
    
    // Supprimer le dossier des chunks
    fs.rmSync(fileChunksDir, { recursive: true, force: true });
    
    // Créer l'objet d'informations du fichier
    // Stocker le fileId original dans originalName pour pouvoir le retrouver plus tard
    // et le nom réel du fichier dans un nouveau champ displayName
    const fileInfo = {
      originalName: fileId, // Utiliser fileId comme originalName pour la recherche
      displayName: fileName, // Stocker le nom réel du fichier
      fileName: uniqueFilename,
      filePath: fileUrl,
      mimeType,
      size: totalSize
    };
    
    console.log(`Fichier reconstruit - fileId: ${fileId}, fileName: ${fileName}, uniqueFilename: ${uniqueFilename}`);
    
    // Intégrer le fichier reconstruit dans le système de transfert de fichiers
    return integrateReconstructedFile(fileInfo, userId);
  } catch (error) {
    console.error(`Erreur lors de la reconstruction du fichier ${fileId}:`, error);
    throw error;
  }
};

/**
 * Nettoie les chunks temporaires d'un fichier en cas d'erreur
 * @param {String} fileId - Identifiant unique du fichier
 * @returns {Promise<Boolean>} - True si le nettoyage a réussi
 */
export const cleanupChunks = async (fileId) => {
  try {
    const fileChunksDir = path.join(TEMP_CHUNKS_DIR, fileId);
    
    if (await existsAsync(fileChunksDir)) {
      fs.rmSync(fileChunksDir, { recursive: true, force: true });
    }
    
    return true;
  } catch (error) {
    console.error(`Erreur lors du nettoyage des chunks pour le fichier ${fileId}:`, error);
    return false;
  }
};

// S'assurer que le dossier temporaire existe
ensureDirectoryExists(TEMP_CHUNKS_DIR);
