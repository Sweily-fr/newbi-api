/**
 * Job de nettoyage des fichiers de transfert expirés
 * Ce job s'exécute périodiquement pour :
 * 1. Marquer les transferts expirés comme tels dans la base de données
 * 2. Supprimer les fichiers physiques associés aux transferts expirés depuis plus de 48h
 */

import FileTransfer from "../models/FileTransfer.js";
import { deleteFile } from "../utils/fileTransferUtils.js";
import { deleteFileFromR2 } from "../utils/chunkUploadR2Utils.js";
import logger from "../utils/logger.js";

/**
 * Marque les transferts de fichiers expirés comme tels
 */
async function markExpiredTransfers() {
  try {
    const now = new Date();

    // Recherche tous les transferts actifs dont la date d'expiration est passée
    const expiredTransfers = await FileTransfer.find({
      status: "active",
      expiryDate: { $lt: now },
    });

    logger.info(`Marquage de ${expiredTransfers.length} transferts expirés`);

    // Marquer chaque transfert comme expiré
    for (const transfer of expiredTransfers) {
      transfer.status = "expired";
      await transfer.save();
      logger.info(`Transfert ${transfer._id} marqué comme expiré`);
    }

    return expiredTransfers.length;
  } catch (error) {
    logger.error("Erreur lors du marquage des transferts expirés:", error);
    throw error;
  }
}

/**
 * Supprime les fichiers physiques des transferts expirés
 */
async function deleteExpiredFiles() {
  try {
    const now = new Date();

    // Recherche tous les transferts expirés
    const expiredTransfers = await FileTransfer.find({
      status: "expired",
      // On ne supprime que les fichiers des transferts expirés depuis au moins 48h
      // pour laisser une marge de sécurité
      expiryDate: { $lt: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
    });

    logger.info(
      `🧹 Suppression des fichiers de ${expiredTransfers.length} transferts expirés (expirés depuis plus de 48h)`
    );

    let deletedFilesCount = 0;
    let deletedR2FilesCount = 0;
    let failedDeletions = 0;
    let totalSize = 0;

    // Supprimer les fichiers de chaque transfert
    for (const transfer of expiredTransfers) {
      logger.info(
        `📦 Traitement du transfert ${transfer._id} (${
          transfer.files.length
        } fichiers, expiré le ${transfer.expiryDate.toISOString()})`
      );

      for (const file of transfer.files) {
        // Vérifier le type de stockage du fichier
        if (file.storageType === "r2" && file.r2Key) {
          // Fichier stocké sur Cloudflare R2
          try {
            const r2DeleteResult = await deleteFileFromR2(file.r2Key);
            if (r2DeleteResult) {
              deletedR2FilesCount++;
              totalSize += file.size || 0;
              logger.info(
                `✅ Fichier R2 supprimé: ${file.r2Key} (${
                  file.originalName
                }) - ${(file.size / 1024 / 1024).toFixed(2)} MB`
              );
            } else {
              failedDeletions++;
              logger.warn(
                `⚠️ Échec de suppression R2: ${file.r2Key} (${file.originalName})`
              );
            }
          } catch (error) {
            failedDeletions++;
            logger.error(`❌ Erreur suppression R2 ${file.r2Key}:`, error);
          }
        } else if (file.filePath) {
          // Fichier stocké localement
          const localDeleteResult = deleteFile(file.filePath);
          if (localDeleteResult) {
            deletedFilesCount++;
            totalSize += file.size || 0;
            logger.info(
              `✅ Fichier local supprimé: ${file.filePath} (${
                file.originalName
              }) - ${(file.size / 1024 / 1024).toFixed(2)} MB`
            );
          } else {
            failedDeletions++;
            logger.warn(
              `⚠️ Échec de suppression locale: ${file.filePath} (${file.originalName})`
            );
          }
        }
      }

      // Marquer le transfert comme "deleted" après suppression des fichiers
      transfer.status = "deleted";
      await transfer.save();

      logger.info(`✅ Nettoyage terminé pour transfert ${transfer._id}`);
    }

    const totalSizeMB = (totalSize / 1024 / 1024).toFixed(2);
    logger.info(
      `🎉 Suppression terminée: ${deletedFilesCount} fichiers locaux, ${deletedR2FilesCount} fichiers R2, ${failedDeletions} échecs, ${totalSizeMB} MB libérés`
    );

    return {
      localFiles: deletedFilesCount,
      r2Files: deletedR2FilesCount,
      failed: failedDeletions,
      totalSizeMB,
      total: deletedFilesCount + deletedR2FilesCount,
    };
  } catch (error) {
    logger.error(
      "❌ Erreur lors de la suppression des fichiers expirés:",
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
    logger.info("Démarrage du job de nettoyage des fichiers expirés");

    // Marquer les transferts expirés
    const markedCount = await markExpiredTransfers();

    // Supprimer les fichiers physiques
    const deletedResult = await deleteExpiredFiles();

    logger.info(
      `Job de nettoyage terminé: ${markedCount} transferts marqués comme expirés, ${deletedResult.total} fichiers supprimés (${deletedResult.localFiles} locaux, ${deletedResult.r2Files} R2)`
    );

    return { markedCount, deletedResult };
  } catch (error) {
    logger.error(
      "Erreur lors du job de nettoyage des fichiers expirés:",
      error
    );
    throw error;
  }
}

export { cleanupExpiredFiles, markExpiredTransfers, deleteExpiredFiles };
