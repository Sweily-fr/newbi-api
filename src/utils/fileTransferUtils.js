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
  
  // Générer un nom de fichier unique
  const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  
  // Créer le dossier d'upload pour l'utilisateur
  const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'file-transfers', userId.toString());
  ensureDirectoryExists(uploadDir);
  
  // Chemin complet du fichier
  const filePath = path.join(uploadDir, uniqueFilename);
  
  // Chemin relatif pour l'accès via URL
  const fileUrl = `/uploads/file-transfers/${userId.toString()}/${uniqueFilename}`;
  
  // Décoder et écrire le fichier base64
  const base64Data = base64.split(';base64,').pop() || base64;
  fs.writeFileSync(filePath, base64Data, { encoding: 'base64' });
  
  return {
    originalName: name,
    fileName: uniqueFilename,
    filePath: fileUrl,
    mimeType: type,
    size: size || fs.statSync(filePath).size
  };
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
