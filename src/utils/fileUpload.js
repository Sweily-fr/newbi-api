import fs from "fs";
import path from "path";
import crypto from "crypto";

// Assurez-vous que le dossier existe
const ensureDirectoryExists = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    // Dossier créé
  }
};

// Supprime un fichier à partir de son chemin relatif
const deleteFile = (relativePath) => {
  // Si le chemin est vide ou null, ne rien faire
  if (!relativePath) {
    // Chemin de fichier vide ou null, aucune suppression nécessaire
    return true; // Considérer comme un succès car il n'y a pas de fichier à supprimer
  }

  try {
    // Tentative de suppression du fichier

    // Le chemin relatif est de la forme /uploads/directory/filename.jpg
    // Nous devons extraire le répertoire et le nom du fichier
    const pathParts = relativePath.split("/");
    if (pathParts.length < 3) {
      // Format de chemin invalide
      return false;
    }

    const directory = pathParts[2]; // Le répertoire (company-logos, profile-pictures, etc.)
    const fileName = pathParts[3]; // Le nom du fichier

    if (!fileName) {
      // Impossible d'extraire le nom du fichier
      return false;
    }

    // Construire le chemin absolu vers le fichier
    const filePath = path.join(
      __dirname,
      `../../public/uploads/${directory}`,
      fileName
    );

    // Vérifier si le fichier existe
    if (fs.existsSync(filePath)) {
      // Supprimer le fichier
      fs.unlinkSync(filePath);
      return true;
    }

    return true; // Considérer comme un succès même si le fichier n'existe pas
  } catch (error) {
    // Erreur lors de la suppression du fichier
    return false;
  }
};

// Décode une image base64 et la sauvegarde dans le dossier spécifié
const saveBase64Image = (base64Image, directory = "company-logos") => {
  // Créer le dossier s'il n'existe pas
  const uploadDir = path.join(__dirname, `../../public/uploads/${directory}`);
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
  saveBase64Image,
  saveProfilePicture,
  saveEmailSignaturePhoto,
  deleteFile,
};
