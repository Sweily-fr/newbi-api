import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
const { createWriteStream, mkdirSync, existsSync } = fs;
import { promisify } from "util";
import { pipeline } from "stream";
const pipelineAsync = promisify(pipeline);

// Assurez-vous que le dossier existe
const ensureDirectoryExists = (dirPath) => {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
};

// Générer une clé d'accès aléatoire
const generateAccessKey = () => {
  return crypto.randomBytes(8).toString("hex");
};

// Générer un lien de partage unique
const generateShareLink = () => {
  return crypto.randomBytes(16).toString("hex");
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
  const uniqueFilename = `${Date.now()}-${crypto
    .randomBytes(8)
    .toString("hex")}-${filename.replace(/[^a-zA-Z0-9.-]/g, "_")}`;

  // Créer le dossier d'upload pour l'utilisateur
  const uploadDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "file-transfers",
    userId.toString()
  );
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
    size: fs.statSync(filePath).size,
  };
};

// Sauvegarder un fichier en base64
const saveBase64File = async (fileInput, userId) => {
  const { name, type, size, base64 } = fileInput;

  // Debug: Afficher les informations du fichier reçu
  if (global.logger) {
    global.logger.info(
      `Sauvegarde du fichier: ${name}, type: ${type}, taille déclarée: ${size}`
    );
    global.logger.info(`Longueur de la chaîne base64: ${base64.length}`);
    global.logger.info(
      `Début de la chaîne base64: ${base64.substring(0, 50)}...`
    );
  }

  // Vérifier que la chaîne base64 est valide
  if (!base64 || typeof base64 !== "string") {
    throw new Error("Données base64 invalides ou manquantes");
  }

  // Extraire l'extension du fichier original
  const originalExt = path.extname(name);
  const nameWithoutExt = path.basename(name, originalExt);

  // Générer un nom de fichier unique en préservant l'extension
  const uniqueFilename = `${Date.now()}-${crypto
    .randomBytes(8)
    .toString("hex")}-${nameWithoutExt.replace(
    /[^a-zA-Z0-9.-]/g,
    "_"
  )}${originalExt}`;

  // Créer le dossier d'upload pour l'utilisateur
  const uploadDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "file-transfers",
    userId.toString()
  );
  ensureDirectoryExists(uploadDir);

  // Chemin complet du fichier
  const filePath = path.join(uploadDir, uniqueFilename);

  // Chemin relatif pour l'accès via URL
  const fileUrl = `/uploads/file-transfers/${userId.toString()}/${uniqueFilename}`;

  try {
    // Déterminer le type MIME à partir de l'extension si non fourni
    let mimeType = type;
    if (!mimeType || mimeType === "application/octet-stream") {
      // Déterminer le type MIME à partir de l'extension
      const ext = originalExt.toLowerCase();
      if ([".jpg", ".jpeg"].includes(ext)) mimeType = "image/jpeg";
      else if (ext === ".png") mimeType = "image/png";
      else if (ext === ".gif") mimeType = "image/gif";
      else if (ext === ".pdf") mimeType = "application/pdf";
      else if ([".doc", ".docx"].includes(ext)) mimeType = "application/msword";
      else if ([".xls", ".xlsx"].includes(ext))
        mimeType = "application/vnd.ms-excel";
      else if (ext === ".zip") mimeType = "application/zip";
      else mimeType = "application/octet-stream";
    }

    // Décoder et écrire le fichier base64
    let base64Data = "";
    let contentType = "";

    // Vérifier si la chaîne contient un en-tête data URI (comme "data:image/jpeg;base64,")
    if (base64.includes(";base64,")) {
      // Format standard: data:image/jpeg;base64,/9j/4AAQSkZJRg...
      const parts = base64.split(";base64,");
      contentType = parts[0].replace("data:", "");
      base64Data = parts[1];

      if (global.logger) {
        global.logger.info(`En-tête MIME standard détecté: ${contentType}`);
        global.logger.info(
          `Longueur des données base64 après extraction: ${base64Data.length}`
        );
      }
    } else if (base64.startsWith("data:") && base64.includes(",")) {
      // Format alternatif: data:image/jpeg,/9j/4AAQSkZJRg...
      const parts = base64.split(",");
      contentType = parts[0].replace("data:", "").replace(";", "");
      base64Data = parts[1];

      if (global.logger) {
        global.logger.info(`En-tête MIME alternatif détecté: ${contentType}`);
        global.logger.info(
          `Longueur des données base64 après extraction: ${base64Data.length}`
        );
      }
    } else {
      // Aucun en-tête détecté, considérer comme des données brutes
      if (global.logger) {
        global.logger.warn(
          "Aucun en-tête MIME détecté dans la chaîne base64, traitement comme données brutes"
        );
      }
      base64Data = base64;
    }

    // S'assurer que base64Data n'est pas undefined ou vide
    if (!base64Data) {
      throw new Error(
        "Format base64 invalide: données manquantes après extraction"
      );
    }

    // Nettoyer la chaîne base64 (retirer les espaces, retours à la ligne, etc.)
    base64Data = base64Data.replace(/\s/g, "");

    // Vérifier si la chaîne base64 contient des caractères non valides
    const base64Regex = /^[A-Za-z0-9+/=]+$/;
    if (!base64Regex.test(base64Data)) {
      if (global.logger) {
        global.logger.error(
          "La chaîne base64 contient des caractères non valides"
        );
        // Afficher les premiers caractères non valides pour le débogage
        const invalidChars = [];
        for (let i = 0; i < Math.min(base64Data.length, 1000); i++) {
          const char = base64Data[i];
          if (!/[A-Za-z0-9+/=]/.test(char)) {
            invalidChars.push(
              `Position ${i}: '${char}' (code ${char.charCodeAt(0)})`
            );
            if (invalidChars.length >= 10) break;
          }
        }
        global.logger.error(
          `Caractères non valides: ${invalidChars.join(", ")}`
        );
      }
      throw new Error("La chaîne base64 contient des caractères non valides");
    }

    // Décoder les données base64 en buffer
    const buffer = Buffer.from(base64Data, "base64");

    if (global.logger) {
      global.logger.info(
        `Taille du buffer après décodage: ${buffer.length} octets`
      );
      global.logger.info(
        `Taille déclarée vs taille réelle: ${size} vs ${buffer.length} octets`
      );

      // Vérifier si la taille du buffer est cohérente avec la taille déclarée
      // Une différence de taille peut indiquer un problème d'encodage/décodage
      const sizeDiff = Math.abs(buffer.length - size);
      const sizeRatio = buffer.length / size;

      if (sizeDiff > 1024 && (sizeRatio < 0.9 || sizeRatio > 1.1)) {
        global.logger.warn(
          `Différence de taille importante détectée: ${sizeDiff} octets (ratio: ${sizeRatio.toFixed(
            2
          )})`
        );
      }
    }

    // Écrire le fichier sur le disque
    fs.writeFileSync(filePath, buffer);

    // Vérifier la taille du fichier écrit
    const stats = fs.statSync(filePath);

    // Si le type MIME a été détecté à partir du data URI, l'utiliser
    if (contentType && !mimeType) {
      mimeType = contentType;
    }

    // Utiliser la taille réelle du fichier écrit
    const actualSize = stats.size;

    if (global.logger) {
      global.logger.info(`Fichier sauvegardé: ${filePath}`);
      global.logger.info(
        `Taille déclarée: ${size}, taille réelle: ${actualSize}`
      );
    }

    return {
      originalName: name,
      fileName: uniqueFilename,
      filePath: fileUrl,
      mimeType: mimeType,
      size: actualSize,
    };
  } catch (error) {
    // Utiliser logger au lieu de console.error
    if (global.logger) {
      global.logger.error(
        "Erreur lors de la sauvegarde du fichier base64:",
        error
      );
    }
    throw new Error(
      `Erreur lors de la sauvegarde du fichier: ${error.message}`
    );
  }
};

// Supprimer un fichier
const deleteFile = (filePath) => {
  try {
    // Convertir le chemin relatif en chemin absolu
    const absolutePath = path.join(process.cwd(), "public", filePath);

    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error("Erreur lors de la suppression du fichier:", error);
    return false;
  }
};

// Créer une archive ZIP des fichiers
const createZipArchive = async (files, userId) => {
  // Créer le dossier d'archives
  const archiveDir = path.join(
    process.cwd(),
    "public",
    "uploads",
    "file-transfers",
    userId.toString(),
    "archives"
  );
  ensureDirectoryExists(archiveDir);

  // Nom de l'archive
  const archiveName = `archive-${Date.now()}.zip`;
  const archivePath = path.join(archiveDir, archiveName);

  // Vérifier si des fichiers existent
  if (!files || files.length === 0) {
    throw new Error("Aucun fichier à archiver");
  }

  // Vérifier que tous les fichiers existent physiquement
  const missingFiles = [];
  for (const file of files) {
    const filePath = path.join(process.cwd(), "public", file.filePath);
    if (!fs.existsSync(filePath)) {
      missingFiles.push(file.originalName);
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `Certains fichiers sont manquants: ${missingFiles.join(", ")}`
    );
  }

  // Créer l'archive
  const output = createWriteStream(archivePath);
  const archive = archiver("zip", {
    zlib: { level: 6 }, // Niveau de compression équilibré (performance/taille)
  });

  // Créer une promesse pour attendre la fin de l'écriture
  const archivePromise = new Promise((resolve, reject) => {
    // Gérer les événements
    output.on("close", () => {
      if (global.logger) {
        global.logger.info(
          `Archive créée avec succès: ${archivePath}, taille: ${archive.pointer()} octets`
        );
      }
      resolve();
    });

    output.on("error", (err) => {
      if (global.logger) {
        global.logger.error("Erreur lors de la création de l'archive:", err);
      }
      reject(err);
    });

    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        console.warn("Archive warning:", err);
      } else {
        reject(err);
      }
    });

    archive.on("error", (err) => {
      if (global.logger) {
        global.logger.error("Erreur d'archivage:", err);
      }
      reject(err);
    });
  });

  // Pipe l'archive vers le fichier de sortie
  archive.pipe(output);

  // Ajouter les fichiers à l'archive
  for (const file of files) {
    try {
      const filePath = path.join(process.cwd(), "public", file.filePath);
      // Utiliser un nom de fichier sécurisé pour l'archive
      const safeFileName = file.originalName.replace(/[\\/:*?"<>|]/g, "_");
      if (global.logger) {
        global.logger.info(
          `Ajout du fichier à l'archive: ${filePath} -> ${safeFileName}`
        );
      }
      archive.file(filePath, { name: safeFileName });
    } catch (error) {
      if (global.logger) {
        global.logger.error(
          `Erreur lors de l'ajout du fichier ${file.originalName} à l'archive:`,
          error
        );
      }
      // Continuer avec les autres fichiers
    }
  }

  // Finaliser l'archive et attendre la fin de l'écriture
  await archive.finalize();
  await archivePromise;

  // Vérifier que l'archive a bien été créée
  if (!fs.existsSync(archivePath)) {
    throw new Error("L'archive n'a pas été créée correctement");
  }

  const archiveStats = fs.statSync(archivePath);
  if (archiveStats.size === 0) {
    throw new Error("L'archive créée est vide");
  }

  if (global.logger) {
    global.logger.info(
      `Archive finalisée: ${archivePath}, taille: ${archiveStats.size} octets`
    );
  }

  // Retourner le chemin relatif de l'archive
  return `/uploads/file-transfers/${userId.toString()}/archives/${archiveName}`;
};

export {
  ensureDirectoryExists,
  generateAccessKey,
  generateShareLink,
  calculateExpiryDate,
  saveUploadedFile,
  saveBase64File,
  deleteFile,
  createZipArchive,
};
