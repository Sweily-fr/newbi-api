/**
 * Job de nettoyage des chunks orphelins sur Cloudflare R2
 *
 * Ce job s'exécute périodiquement pour supprimer les chunks temporaires
 * qui n'ont pas été finalisés (uploads abandonnés ou échoués).
 *
 * Les chunks sont stockés dans temp/YYYY/MM/DD/t_xxx/f_xxx/chunk_x
 * et doivent être supprimés après 24h s'ils n'ont pas été reconstruits.
 */

import cloudflareTransferService from "../services/cloudflareTransferService.js";
import logger from "../utils/logger.js";

/**
 * Nettoie les chunks orphelins sur R2
 * @param {number} maxAgeHours - Âge maximum en heures (défaut: 24h)
 * @returns {Promise<{deleted: number, errors: number, freedBytes: number}>}
 */
async function cleanupOrphanChunks(maxAgeHours = 24) {
  try {
    logger.info(`🧹 Démarrage du job de nettoyage des chunks orphelins (> ${maxAgeHours}h)`);

    const result = await cloudflareTransferService.cleanupOrphanChunks(maxAgeHours);

    logger.info(
      `✅ Job de nettoyage des chunks terminé: ${result.deleted} chunks supprimés, ` +
      `${result.errors} erreurs, ${(result.freedBytes / 1024 / 1024).toFixed(2)} MB libérés`
    );

    return result;
  } catch (error) {
    logger.error("❌ Erreur lors du job de nettoyage des chunks orphelins:", error);
    throw error;
  }
}

export { cleanupOrphanChunks };
