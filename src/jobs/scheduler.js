/**
 * Planificateur de tâches pour les jobs récurrents
 */

import cron from 'node-cron';
import { cleanupExpiredFiles } from './cleanupExpiredFiles.js';
import { processScheduledReferrals } from './processScheduledReferrals.js';
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

  // Job de traitement des paiements de parrainage programmés - s'exécute toutes les heures
  cron.schedule('0 * * * *', async () => {
    try {
      logger.info('Exécution du job de traitement des paiements de parrainage programmés');
      await processScheduledReferrals();
    } catch (error) {
      logger.error('Erreur lors de l\'exécution du job de parrainage:', error);
    }
  });
  
  logger.info('Jobs planifiés configurés avec succès');
}

export {
  setupScheduledJobs
};
