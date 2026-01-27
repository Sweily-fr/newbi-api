/**
 * Planificateur de tâches pour les jobs récurrents
 */

import cron from 'node-cron';
import { cleanupExpiredFiles } from './cleanupExpiredFiles.js';
import { cleanupOrphanChunks } from './cleanupOrphanChunks.js';
import logger from '../utils/logger.js';

/**
 * Configure et démarre tous les jobs planifiés
 */
function setupScheduledJobs() {
  // Job de nettoyage des fichiers expirés - s'exécute tous les jours à 3h du matin
  // Format cron: minute heure jour_du_mois mois jour_de_la_semaine
  cron.schedule('0 3 * * *', async () => {
    try {
      logger.info('Exécution du job de nettoyage des fichiers expirés');
      await cleanupExpiredFiles();
    } catch (error) {
      logger.error('Erreur lors de l\'exécution du job de nettoyage:', error);
    }
  });

  // Job de nettoyage des chunks orphelins - s'exécute toutes les 6 heures
  // Supprime les chunks temporaires (uploads abandonnés) de plus de 24h
  cron.schedule('0 */6 * * *', async () => {
    try {
      logger.info('Exécution du job de nettoyage des chunks orphelins');
      await cleanupOrphanChunks(24); // Chunks > 24h
    } catch (error) {
      logger.error('Erreur lors de l\'exécution du job de nettoyage des chunks:', error);
    }
  });

  logger.info('Jobs planifiés configurés avec succès');
  logger.info('  - Nettoyage fichiers expirés: tous les jours à 3h UTC');
  logger.info('  - Nettoyage chunks orphelins: toutes les 6 heures');
}

export {
  setupScheduledJobs
};
