import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

// Assurez-vous que le dossier existe
const ensureDirectoryExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    // Dossier créé
  }
};

// Racine des fichiers envoyés (<racine du dépôt>/public/uploads). Module ES :
// __dirname n'existe pas, il se déduit de import.meta.url.
const UPLOADS_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/uploads",
);

// Dossiers d'envoi connus : aucun autre dossier n'est lu ni écrit
const UPLOAD_DIRECTORIES = [
  "company-logos",
  "profile-pictures",
  "email-signatures",
];

const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Chemin absolu d'un fichier envoyé, à partir de son chemin relatif
 * « /uploads/<dossier>/<fichier> », ou null s'il n'a pas exactement cette
 * forme : dossier hors de la liste (ou différent de expectedDirectory),
 * segment « .. », sous-dossier, nom de fichier inattendu, ou chemin qui
 * sortirait du dossier une fois résolu.
 */
const resolveUploadPath = (relativePath, expectedDirectory) => {
  if (typeof relativePath !== "string") return null;
  const parts = relativePath.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "uploads") {
    return null;
  }
  const [, , directory, fileName] = parts;
  if (!UPLOAD_DIRECTORIES.includes(directory)) return null;
  if (expectedDirectory && directory !== expectedDirectory) return null;
  if (!SAFE_FILE_NAME.test(fileName) || fileName.includes("..")) return null;

  const directoryPath = path.resolve(UPLOADS_ROOT, directory);
  const filePath = path.resolve(directoryPath, fileName);
  if (!filePath.startsWith(directoryPath + path.sep)) return null;
  return filePath;
};

// Supprime un fichier à partir de son chemin relatif (« /uploads/<dossier>/
// <fichier> »). Tout autre chemin est refusé (false) sans rien supprimer.
// options.directory restreint la suppression à un seul dossier.
const deleteFile = (relativePath, { directory } = {}) => {
  // Si le chemin est vide ou null, ne rien faire
  if (!relativePath) {
    return true; // Rien à supprimer
  }

  try {
    const filePath = resolveUploadPath(relativePath, directory);
    if (!filePath) return false;

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return true; // Succès même si le fichier n'existe pas
  } catch {
    // Erreur lors de la suppression du fichier
    return false;
  }
};

// Décode une image base64 et la sauvegarde dans le dossier spécifié
const saveBase64Image = (base64Image, directory = "company-logos") => {
  if (!UPLOAD_DIRECTORIES.includes(directory)) {
    throw new Error("Dossier d'envoi inconnu");
  }
  // Créer le dossier s'il n'existe pas
  const uploadDir = path.join(UPLOADS_ROOT, directory);
  ensureDirectoryExists(uploadDir);

  // Extraire les données de l'image du string base64
  const matches = base64Image.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);

  if (!matches || matches.length !== 3) {
    throw new Error("Format d'image base64 invalide");
  }

  // Extraire le type de contenu et les données
  const contentType = matches[1];
  const imageData = matches[2];
  const buffer = Buffer.from(imageData, "base64");

  // Déterminer l'extension de fichier
  let extension;
  switch (contentType) {
    case "image/jpeg":
      extension = ".jpg";
      break;
    case "image/png":
      extension = ".png";
      break;
    case "image/gif":
      extension = ".gif";
      break;
    case "image/svg+xml":
      extension = ".svg";
      break;
    default:
      extension = ".jpg"; // Par défaut
  }

  // Générer un nom de fichier unique
  const fileName = `${crypto.randomBytes(16).toString("hex")}${extension}`;
  const filePath = path.join(uploadDir, fileName);
  const relativePath = `/uploads/${directory}/${fileName}`;

  // Écrire le fichier
  fs.writeFileSync(filePath, buffer);

  // Retourner le chemin relatif du fichier
  return relativePath;
};

// Décode une image base64 et la sauvegarde dans le dossier profile-pictures
const saveProfilePicture = (base64Image) => {
  return saveBase64Image(base64Image, "profile-pictures");
};

// Décode une image base64 et la sauvegarde dans le dossier email-signatures
const saveEmailSignaturePhoto = (base64Image) => {
  return saveBase64Image(base64Image, "email-signatures");
};

export {
  UPLOADS_ROOT,
  resolveUploadPath,
  saveBase64Image,
  saveProfilePicture,
  saveEmailSignaturePhoto,
  deleteFile,
};
