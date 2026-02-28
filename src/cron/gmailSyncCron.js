import cron from 'node-cron';
import { scanAllActiveConnections } from '../services/gmail/GmailScannerService.js';
import logger from '../utils/logger.js';

let task = null;

function startGmailSyncCron() {
  // Every 4 hours
  task = cron.schedule('0 */4 * * *', async () => {
    logger.info('[Gmail Cron] Démarrage de la synchronisation Gmail');
    try {
      const result = await scanAllActiveConnections();
      if (result.total > 0) {
        logger.info(`[Gmail Cron] Synchronisation terminée: ${result.successCount}/${result.total} réussies, ${result.failCount} échouées`);
      }
    } catch (error) {
      logger.error('[Gmail Cron] Erreur lors de la synchronisation:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris'
  });

  logger.info('[Gmail Cron] Job de synchronisation configuré (toutes les 4 heures)');
  return task;
}

function stopGmailSyncCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startGmailSyncCron, stopGmailSyncCron };
