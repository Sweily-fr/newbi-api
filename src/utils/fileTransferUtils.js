const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { createWriteStream, mkdirSync, existsSync } = require('fs');
const { promisify } = require('util');
const { pipeline } = require('stream');
const pipelineAsync = promisify(pipeline);

// Assurez-vous que le dossier existe
const ensureDirectoryExists = (dirPath) => {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
};

// Générer une clé d'accès aléatoire
const generateAccessKey = () => {
  return crypto.randomBytes(8).toString('hex');
};

// Générer un lien de partage unique
const generateShareLink = () => {
  return crypto.randomBytes(16).toString('hex');
};

// Calculer la date d'expiration (fixée à 48 heures)
const calculateExpiryDate = () => {
  const expiryDate = new Date();
  expiryDate.setHours(expiryDate.getHours() + 48);
  return expiryDate;
};

// Sauvegarder un fichier téléchargé
const saveUploadedFile = async (file, userId) => {
  const { createReadStream, filename, mimetype } = await file;
  const stream = createReadStream();
  
  // Générer un nom de fichier unique
  const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  
  // Créer le dossier d'upload pour l'utilisateur
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'file-transfers', userId.toString());
  ensureDirectoryExists(uploadDir);
  
  // Chemin complet du fichier
  const filePath = path.join(uploadDir, uniqueFilename);
  
  // Chemin relatif pour l'accès via URL
  const fileUrl = `/uploads/file-transfers/${userId.toString()}/${uniqueFilename}`;
  
  // Écrire le fichier
  const writeStream = createWriteStream(filePath);
  await pipelineAsync(stream, writeStream);
  
  return {
    originalName: filename,
    fileName: uniqueFilename,
    filePath: fileUrl,
    mimeType: mimetype,
    size: fs.statSync(filePath).size
  };
};

// Sauvegarder un fichier en base64
const saveBase64File = async (fileInput, userId) => {
  const { name, type, size, base64 } = fileInput;
  
  // Extraire l'extension du fichier original
  const originalExt = path.extname(name);
  const nameWithoutExt = path.basename(name, originalExt);
  
  // Générer un nom de fichier unique en préservant l'extension
  const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${nameWithoutExt.replace(/[^a-zA-Z0-9.-]/g, '_')}${originalExt}`;
  
  // Créer le dossier d'upload pour l'utilisateur
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'file-transfers', userId.toString());
  ensureDirectoryExists(uploadDir);
  
  // Chemin complet du fichier
  const filePath = path.join(uploadDir, uniqueFilename);
  
  // Chemin relatif pour l'accès via URL
  const fileUrl = `/uploads/file-transfers/${userId.toString()}/${uniqueFilename}`;
  
  try {
    // Déterminer le type MIME à partir de l'extension si non fourni
    let mimeType = type;
    if (!mimeType || mimeType === 'application/octet-stream') {
      // Déterminer le type MIME à partir de l'extension
      const ext = originalExt.toLowerCase();
      if (['.jpg', '.jpeg'].includes(ext)) mimeType = 'image/jpeg';
      else if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.pdf') mimeType = 'application/pdf';
      else if (['.doc', '.docx'].includes(ext)) mimeType = 'application/msword';
      else if (['.xls', '.xlsx'].includes(ext)) mimeType = 'application/vnd.ms-excel';
      else if (ext === '.zip') mimeType = 'application/zip';
      else mimeType = 'application/octet-stream';
    }
    
    // Décoder et écrire le fichier base64
    let base64Data;
    let contentType = '';
    
    // Vérifier si la chaîne contient un en-tête data URI (comme "data:image/jpeg;base64,")
    if (base64.includes(';base64,')) {
      // Extraire le type de contenu et les données base64
      const parts = base64.split(';base64,');
      contentType = parts[0].replace('data:', '');
      base64Data = parts[1];
    } else if (base64.startsWith('data:') && base64.includes(',')) {
      // Format alternatif possible
      const parts = base64.split(',');
      contentType = parts[0].replace('data:', '').replace(';', '');
      base64Data = parts[1];
    } else {
      // Supposer que c'est déjà une chaîne base64 pure
      base64Data = base64;
    }
    
    // S'assurer que base64Data n'est pas undefined
    if (!base64Data) {
      throw new Error('Format base64 invalide');
    }
    
    // Écrire le fichier décodé
    fs.writeFileSync(filePath, base64Data, { encoding: 'base64' });
    
    // Vérifier que le fichier a été correctement écrit
    if (!fs.existsSync(filePath)) {
      throw new Error('Échec de l\'écriture du fichier');
    }
    
    // Si le type MIME a été détecté à partir du data URI, l'utiliser
    if (contentType && !mimeType) {
      mimeType = contentType;
    }
    
    console.log(`Fichier sauvegardé avec succès: ${filePath} (type: ${mimeType})`);
    
    return {
      originalName: name,
      fileName: uniqueFilename,
      filePath: fileUrl,
      mimeType: mimeType,
      size: size || fs.statSync(filePath).size
    };
  } catch (error) {
    console.error('Erreur lors de la sauvegarde du fichier base64:', error);
    throw new Error(`Erreur lors de la sauvegarde du fichier: ${error.message}`);
  }
};

// Supprimer un fichier
const deleteFile = (filePath) => {
  try {
    // Convertir le chemin relatif en chemin absolu
    const absolutePath = path.join(process.cwd(), 'public', filePath);
    
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Erreur lors de la suppression du fichier:', error);
    return false;
  }
};

// Créer une archive ZIP des fichiers
const createZipArchive = async (files, userId) => {
  // Créer le dossier d'archives
  const archiveDir = path.join(process.cwd(), 'public', 'uploads', 'file-transfers', userId.toString(), 'archives');
  ensureDirectoryExists(archiveDir);
  
  // Nom de l'archive
  const archiveName = `archive-${Date.now()}.zip`;
  const archivePath = path.join(archiveDir, archiveName);
  
  // Créer l'archive
  const output = createWriteStream(archivePath);
  const archive = archiver('zip', {
    zlib: { level: 9 } // Niveau de compression maximum
  });
  
  // Gérer les événements
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      console.warn('Archive warning:', err);
    } else {
      throw err;
    }
  });
  
  archive.on('error', (err) => {
    throw err;
  });
  
  // Pipe l'archive vers le fichier de sortie
  archive.pipe(output);
  
  // Ajouter les fichiers à l'archive
  for (const file of files) {
    const filePath = path.join(process.cwd(), 'public', file.filePath);
    archive.file(filePath, { name: file.originalName });
  }
  
  // Finaliser l'archive
  await archive.finalize();
  
  // Retourner le chemin relatif de l'archive
  return `/uploads/file-transfers/${userId.toString()}/archives/${archiveName}`;
};

module.exports = {
  ensureDirectoryExists,
  generateAccessKey,
  generateShareLink,
  calculateExpiryDate,
  saveUploadedFile,
  saveBase64File,
  deleteFile,
  createZipArchive
};
