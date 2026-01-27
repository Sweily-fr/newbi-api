/**
 * Job de nettoyage des fichiers de transfert expirés
 * Ce job s'exécute périodiquement pour :
 * 1. Marquer les transferts expirés comme tels dans la base de données
 * 2. Supprimer IMMÉDIATEMENT les fichiers R2 dès l'expiration
 * 3. Supprimer les fichiers locaux avec une marge de 24h
 */

import FileTransfer from "../models/FileTransfer.js";
import { deleteFile } from "../utils/fileTransferUtils.js";
import { deleteFileFromR2 } from "../utils/chunkUploadR2Utils.js";
import logger from "../utils/logger.js";

/**
 * Marque les transferts de fichiers expirés et supprime immédiatement les fichiers R2
 * Les fichiers R2 sont supprimés dès l'expiration pour libérer l'espace de stockage
 */
async function markExpiredTransfersAndDeleteR2() {
  try {
    const now = new Date();

    // Recherche tous les transferts actifs dont la date d'expiration est passée
    const expiredTransfers = await FileTransfer.find({
      status: "active",
      expiryDate: { $lt: now },
    });

    if (expiredTransfers.length === 0) {
      logger.info("✅ Aucun transfert à marquer comme expiré");
      return { markedCount: 0, deletedR2Files: 0, freedBytes: 0 };
    }

    logger.info(`🔄 Traitement de ${expiredTransfers.length} transferts expirés`);

    let deletedR2FilesCount = 0;
    let freedBytes = 0;
    let failedDeletions = 0;

    // Marquer chaque transfert comme expiré ET supprimer les fichiers R2 immédiatement
    for (const transfer of expiredTransfers) {
      logger.info(
        `📦 Expiration du transfert ${transfer._id} (${transfer.files.length} fichiers)`
      );

      // Supprimer les fichiers R2 immédiatement
      for (const file of transfer.files) {
        if (file.storageType === "r2" && file.r2Key) {
          try {
            const r2DeleteResult = await deleteFileFromR2(file.r2Key);
            if (r2DeleteResult) {
              deletedR2FilesCount++;
              freedBytes += file.size || 0;
              logger.info(
                `✅ Fichier R2 supprimé: ${file.r2Key} (${file.originalName}) - ${(
                  file.size / 1024 / 1024
                ).toFixed(2)} MB`
              );
            } else {
              failedDeletions++;
              logger.warn(
                `⚠️ Échec de suppression R2: ${file.r2Key} (${file.originalName})`
              );
            }
          } catch (error) {
            failedDeletions++;
            logger.error(`❌ Erreur suppression R2 ${file.r2Key}:`, error.message);
          }
        }
      }

      // Marquer le transfert comme expiré
      // Si tous les fichiers sont sur R2 et ont été supprimés, marquer directement comme "deleted"
      const hasLocalFiles = transfer.files.some(
        (f) => f.storageType !== "r2" && f.filePath
      );

      if (hasLocalFiles) {
        transfer.status = "expired";
      } else {
        // Pas de fichiers locaux, le transfert peut être marqué comme "deleted"
        transfer.status = "deleted";
      }

      await transfer.save();
      logger.info(
        `✅ Transfert ${transfer._id} marqué comme ${transfer.status}`
      );
    }

    const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
    logger.info(
      `🎉 Expiration terminée: ${expiredTransfers.length} transferts traités, ` +
      `${deletedR2FilesCount} fichiers R2 supprimés, ${failedDeletions} échecs, ${freedMB} MB libérés`
    );

    return {
      markedCount: expiredTransfers.length,
      deletedR2Files: deletedR2FilesCount,
      failedDeletions,
      freedBytes,
    };
  } catch (error) {
    logger.error("Erreur lors du marquage des transferts expirés:", error);
    throw error;
  }
}

/**
 * Supprime les fichiers locaux des transferts expirés depuis plus de 24h
 * Les fichiers locaux ont une marge de sécurité de 24h avant suppression
 */
async function deleteExpiredLocalFiles() {
  try {
    const now = new Date();

    // Recherche tous les transferts expirés depuis plus de 24h avec des fichiers locaux
    const expiredTransfers = await FileTransfer.find({
      status: "expired",
      // Fichiers locaux supprimés après 24h de grâce
      expiryDate: { $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    });

    if (expiredTransfers.length === 0) {
      logger.info("✅ Aucun fichier local à supprimer");
      return { deletedFiles: 0, freedBytes: 0 };
    }

    logger.info(
      `🧹 Suppression des fichiers locaux de ${expiredTransfers.length} transferts (expirés depuis > 24h)`
    );

    let deletedFilesCount = 0;
    let freedBytes = 0;
    let failedDeletions = 0;

    // Supprimer les fichiers locaux de chaque transfert
    for (const transfer of expiredTransfers) {
      logger.info(
        `📦 Nettoyage local du transfert ${transfer._id} (${transfer.files.length} fichiers)`
      );

      for (const file of transfer.files) {
        // Supprimer uniquement les fichiers locaux (les R2 sont déjà supprimés)
        if (file.storageType !== "r2" && file.filePath) {
          const localDeleteResult = deleteFile(file.filePath);
          if (localDeleteResult) {
            deletedFilesCount++;
            freedBytes += file.size || 0;
            logger.info(
              `✅ Fichier local supprimé: ${file.filePath} (${file.originalName}) - ${(
                file.size / 1024 / 1024
              ).toFixed(2)} MB`
            );
          } else {
            failedDeletions++;
            logger.warn(
              `⚠️ Échec de suppression locale: ${file.filePath} (${file.originalName})`
            );
          }
        }
      }

      // Marquer le transfert comme "deleted" après suppression des fichiers locaux
      transfer.status = "deleted";
      await transfer.save();

      logger.info(`✅ Nettoyage local terminé pour transfert ${transfer._id}`);
    }

    const freedMB = (freedBytes / 1024 / 1024).toFixed(2);
    logger.info(
      `🎉 Nettoyage local terminé: ${deletedFilesCount} fichiers supprimés, ` +
      `${failedDeletions} échecs, ${freedMB} MB libérés`
    );

    return {
      deletedFiles: deletedFilesCount,
      failedDeletions,
      freedBytes,
    };
  } catch (error) {
    logger.error(
      "❌ Erreur lors de la suppression des fichiers locaux expirés:",
      error
    );
    throw error;
  }
}

/**
 * Fonction principale du job de nettoyage
 */
async function cleanupExpiredFiles() {
  try {
    logger.info("🚀 Démarrage du job de nettoyage des fichiers expirés");

    // Étape 1: Marquer les transferts expirés ET supprimer immédiatement les fichiers R2
    const expirationResult = await markExpiredTransfersAndDeleteR2();

    // Étape 2: Supprimer les fichiers locaux (après 24h de grâce)
    const localCleanupResult = await deleteExpiredLocalFiles();

    const totalDeleted =
      expirationResult.deletedR2Files + localCleanupResult.deletedFiles;
    const totalFreed =
      expirationResult.freedBytes + localCleanupResult.freedBytes;

    logger.info(
      `✅ Job de nettoyage terminé:\n` +
      `   - ${expirationResult.markedCount} transferts traités\n` +
      `   - ${expirationResult.deletedR2Files} fichiers R2 supprimés (immédiatement)\n` +
      `   - ${localCleanupResult.deletedFiles} fichiers locaux supprimés (après 24h)\n` +
      `   - ${(totalFreed / 1024 / 1024).toFixed(2)} MB libérés au total`
    );

    return {
      markedCount: expirationResult.markedCount,
      deletedR2Files: expirationResult.deletedR2Files,
      deletedLocalFiles: localCleanupResult.deletedFiles,
      totalDeleted,
      totalFreedMB: (totalFreed / 1024 / 1024).toFixed(2),
    };
  } catch (error) {
    logger.error(
      "Erreur lors du job de nettoyage des fichiers expirés:",
      error
    );
    throw error;
  }
}

// Exporter les fonctions individuelles pour les tests
export {
  cleanupExpiredFiles,
  markExpiredTransfersAndDeleteR2,
  deleteExpiredLocalFiles,
};
