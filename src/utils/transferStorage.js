import FileTransfer from "../models/FileTransfer.js";
import cloudflareTransferService from "../services/cloudflareTransferService.js";
import logger from "./logger.js";

/** Aperçu JPEG persisté à côté d'un fichier (routes/fileDownload.js). */
export const transferPreviewKey = (r2Key) => `${r2Key}.preview.jpg`;

/**
 * Supprime de R2 les fichiers d'un transfert et leurs aperçus. Un fichier
 * repris par un autre transfert encore en ligne (reprise d'un envoi) est
 * gardé. Ne lève pas d'erreur : le transfert est déjà hors ligne.
 * @returns {Promise<string[]>} clés dont la suppression a été demandée
 */
export async function deleteTransferStorage(transfer) {
  try {
    const keys = [
      ...new Set(
        (transfer?.files || [])
          .filter((f) => f.storageType === "r2" && f.r2Key)
          .map((f) => f.r2Key),
      ),
    ];
    if (keys.length === 0) return [];

    const stillUsed = new Set(
      await FileTransfer.distinct("files.r2Key", {
        _id: { $ne: transfer._id },
        status: { $ne: "deleted" },
        "files.r2Key": { $in: keys },
      }),
    );
    const toDelete = keys
      .filter((key) => !stillUsed.has(key))
      .flatMap((key) => [key, transferPreviewKey(key)]);
    if (toDelete.length === 0) return [];

    await cloudflareTransferService.deleteFiles(toDelete);
    return toDelete;
  } catch (error) {
    logger.warn(
      `Suppression R2 du transfert ${transfer?._id} impossible : ${error.message}`,
    );
    return [];
  }
}
