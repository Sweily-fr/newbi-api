/**
 * Script de migration pour nettoyer les noms de fichiers contenant des IDs
 * Ce script corrige les fichiers uploadés avant la correction du système de nommage
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import FileTransfer from "../models/FileTransfer.js";
import logger from "../utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger les variables d'environnement
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

/**
 * Nettoie un nom de fichier en retirant l'ID au début
 * Exemple: "4c87efaf-7e61-4632-9ad4-cd345372c820_Capture_d_e_cran_2025-11-19.png"
 * Devient: "Capture_d_e_cran_2025-11-19.png"
 */
function cleanFileName(fileName) {
  if (!fileName) return fileName;

  // Pattern pour détecter un UUID au début du nom
  // Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx_
  const uuidPattern =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_/i;

  if (uuidPattern.test(fileName)) {
    // Retirer l'UUID et l'underscore
    const cleanedName = fileName.replace(uuidPattern, "");
    logger.info(`🧹 Nettoyage: "${fileName}" → "${cleanedName}"`);
    return cleanedName;
  }

  return fileName;
}

/**
 * Fonction principale de migration
 */
async function fixFileNames() {
  try {
    logger.info("🚀 Démarrage de la migration des noms de fichiers");

    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info("✅ Connecté à MongoDB");

    // Récupérer tous les transferts de fichiers
    const transfers = await FileTransfer.find({});
    logger.info(`📊 ${transfers.length} transferts trouvés`);

    let totalFilesFixed = 0;
    let totalTransfersUpdated = 0;

    for (const transfer of transfers) {
      let transferModified = false;

      for (const file of transfer.files) {
        // Vérifier et nettoyer originalName
        const cleanedOriginalName = cleanFileName(file.originalName);
        if (cleanedOriginalName !== file.originalName) {
          file.originalName = cleanedOriginalName;
          transferModified = true;
          totalFilesFixed++;
        }

        // Vérifier et nettoyer displayName
        if (file.displayName) {
          const cleanedDisplayName = cleanFileName(file.displayName);
          if (cleanedDisplayName !== file.displayName) {
            file.displayName = cleanedDisplayName;
            transferModified = true;
          }
        } else {
          // Si displayName n'existe pas, le créer à partir de originalName
          file.displayName = file.originalName;
          transferModified = true;
        }
      }

      // Sauvegarder si modifié
      if (transferModified) {
        await transfer.save();
        totalTransfersUpdated++;
        logger.info(
          `✅ Transfert ${transfer._id} mis à jour (${transfer.files.length} fichiers)`
        );
      }
    }

    logger.info("");
    logger.info("🎉 Migration terminée avec succès !");
    logger.info(`📊 Statistiques:`);
    logger.info(`   - Transferts analysés: ${transfers.length}`);
    logger.info(`   - Transferts mis à jour: ${totalTransfersUpdated}`);
    logger.info(`   - Fichiers corrigés: ${totalFilesFixed}`);
  } catch (error) {
    logger.error("❌ Erreur lors de la migration:", error);
    throw error;
  } finally {
    // Fermer la connexion MongoDB
    await mongoose.connection.close();
    logger.info("👋 Connexion MongoDB fermée");
  }
}

// Exécuter la migration
fixFileNames()
  .then(() => {
    logger.info("✅ Script terminé avec succès");
    process.exit(0);
  })
  .catch((error) => {
    logger.error("❌ Script terminé avec erreur:", error);
    process.exit(1);
  });
