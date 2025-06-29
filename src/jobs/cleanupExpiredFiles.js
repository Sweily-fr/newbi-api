/**
 * Job de nettoyage des fichiers de transfert expirés
 * Ce job s'exécute périodiquement pour :
 * 1. Marquer les transferts expirés comme tels dans la base de données
 * 2. Supprimer les fichiers physiques associés aux transferts expirés depuis plus de 48h
 */

import FileTransfer from "../models/FileTransfer.js";
import { deleteFile } from "../utils/fileTransferUtils.js";
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
      `Suppression des fichiers de ${expiredTransfers.length} transferts expirés`
    );

    let deletedFilesCount = 0;

    // Supprimer les fichiers de chaque transfert
    for (const transfer of expiredTransfers) {
      for (const file of transfer.files) {
        const result = deleteFile(file.filePath);
        if (result) {
          deletedFilesCount++;
        }
      }

      logger.info(`Fichiers du transfert ${transfer._id} supprimés`);
    }

    return deletedFilesCount;
  } catch (error) {
    logger.error("Erreur lors de la suppression des fichiers expirés:", error);
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
    const deletedCount = await deleteExpiredFiles();

    logger.info(
      `Job de nettoyage terminé: ${markedCount} transferts marqués comme expirés, ${deletedCount} fichiers supprimés`
    );

    return { markedCount, deletedCount };
  } catch (error) {
    logger.error(
      "Erreur lors du job de nettoyage des fichiers expirés:",
      error
    );
    throw error;
  }
}

export { cleanupExpiredFiles, markExpiredTransfers, deleteExpiredFiles };
