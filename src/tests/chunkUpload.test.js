import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createReadStream } from 'fs';
import { CHUNK_SIZE } from '../utils/chunkUploadUtils.js';

// Fonction pour diviser un fichier en chunks
export const splitFileIntoChunks = async (filePath) => {
  try {
    // Vérifier que le fichier existe
    if (!fs.existsSync(filePath)) {
      throw new Error(`Le fichier ${filePath} n'existe pas`);
    }
    
    // Obtenir les informations sur le fichier
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const fileName = path.basename(filePath);
    
    // Générer un identifiant unique pour le fichier
    const fileId = uuidv4();
    
    // Calculer le nombre total de chunks
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    
    console.log(`Fichier: ${fileName}`);
    console.log(`Taille: ${fileSize} octets`);
    console.log(`Nombre de chunks: ${totalChunks}`);
    console.log(`ID du fichier: ${fileId}`);
    
    // Préparer les chunks
    const chunks = [];
    
    // Lire le fichier et le diviser en chunks
    const fileBuffer = fs.readFileSync(filePath);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const chunkSize = end - start;
      
      // Créer un buffer pour le chunk
      const chunkBuffer = Buffer.alloc(chunkSize);
      fileBuffer.copy(chunkBuffer, 0, start, end);
      
      // Créer un fichier temporaire pour le chunk
      const chunkPath = path.join(process.cwd(), 'temp', `chunk-${i}-${fileId}`);
      
      // S'assurer que le dossier temp existe
      const tempDir = path.join(process.cwd(), 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      
      // Écrire le chunk dans un fichier temporaire
      fs.writeFileSync(chunkPath, chunkBuffer);
      
      // Ajouter les informations du chunk à la liste
      chunks.push({
        path: chunkPath,
        index: i,
        size: chunkSize
      });
    }
    
    return {
      fileId,
      fileName,
      fileSize,
      totalChunks,
      chunks
    };
  } catch (error) {
    console.error('Erreur lors de la division du fichier en chunks:', error);
    throw error;
  }
};

// Fonction pour simuler un upload de chunk via GraphQL
export const simulateChunkUpload = async (apolloClient, chunk, fileId, chunkIndex, totalChunks, fileName, fileSize) => {
  try {
    // Créer un stream à partir du fichier chunk
    const file = {
      createReadStream: () => createReadStream(chunk.path),
      filename: fileName,
      mimetype: 'application/octet-stream',
      encoding: '7bit'
    };
    
    // Appeler la mutation GraphQL
    const result = await apolloClient.mutate({
      mutation: `
        mutation UploadFileChunk(
          $chunk: Upload!
          $fileId: String!
          $chunkIndex: Int!
          $totalChunks: Int!
          $fileName: String!
          $fileSize: Int!
        ) {
          uploadFileChunk(
            chunk: $chunk
            fileId: $fileId
            chunkIndex: $chunkIndex
            totalChunks: $totalChunks
            fileName: $fileName
            fileSize: $fileSize
          ) {
            chunkReceived
            fileCompleted
            fileId
            fileName
            filePath
          }
        }
      `,
      variables: {
        chunk: file,
        fileId,
        chunkIndex,
        totalChunks,
        fileName,
        fileSize
      }
    });
    
    return result.data.uploadFileChunk;
  } catch (error) {
    console.error(`Erreur lors de l'upload du chunk ${chunkIndex}:`, error);
    throw error;
  }
};

// Fonction principale pour tester l'upload de fichiers en chunks
export const testChunkUpload = async (apolloClient, filePath) => {
  try {
    // Diviser le fichier en chunks
    const { fileId, fileName, fileSize, totalChunks, chunks } = await splitFileIntoChunks(filePath);
    
    console.log(`Début de l'upload du fichier ${fileName} en ${totalChunks} chunks...`);
    
    // Uploader chaque chunk
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`Upload du chunk ${i+1}/${totalChunks}...`);
      
      const result = await simulateChunkUpload(
        apolloClient,
        chunk,
        fileId,
        chunk.index,
        totalChunks,
        fileName,
        fileSize
      );
      
      console.log(`Chunk ${i+1}/${totalChunks} uploadé avec succès:`, result);
      
      // Si c'est le dernier chunk et que le fichier est complet
      if (result.fileCompleted) {
        console.log(`Fichier ${fileName} reconstruit avec succès!`);
        console.log(`Chemin du fichier: ${result.filePath}`);
      }
      
      // Supprimer le fichier temporaire du chunk
      fs.unlinkSync(chunk.path);
    }
    
    console.log(`Upload du fichier ${fileName} terminé avec succès!`);
  } catch (error) {
    console.error('Erreur lors du test d\'upload de fichiers en chunks:', error);
    throw error;
  }
};
