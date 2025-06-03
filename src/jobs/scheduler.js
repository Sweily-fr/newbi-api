/**
 * Planificateur de tâches pour les jobs récurrents
 */

const cron = require('node-cron');
const { cleanupExpiredFiles } = require('./cleanupExpiredFiles');
const logger = require('../utils/logger');

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
  
  logger.info('Jobs planifiés configurés avec succès');
}

module.exports = {
  setupScheduledJobs
};
