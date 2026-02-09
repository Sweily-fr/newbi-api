import cron from 'node-cron';
import { syncAllActiveConnections } from '../services/calendar/CalendarSyncService.js';
import logger from '../utils/logger.js';

let task = null;

/**
 * Start the calendar sync cron job (every 15 minutes)
 */
function startCalendarSyncCron() {
  // Cron expression: '*/15 * * * *' = toutes les 15 minutes
  task = cron.schedule('*/15 * * * *', async () => {
    logger.info('[Calendar Cron] Démarrage de la synchronisation des calendriers');

    try {
      const result = await syncAllActiveConnections();
      if (result.total > 0) {
        logger.info(`[Calendar Cron] Synchronisation terminée: ${result.successCount}/${result.total} réussies, ${result.failCount} échouées`);
      }
    } catch (error) {
      logger.error('[Calendar Cron] Erreur lors de la synchronisation:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris'
  });

  logger.info('[Calendar Cron] Job de synchronisation configuré (toutes les 15 min)');
  return task;
}

/**
 * Stop the calendar sync cron job
 */
function stopCalendarSyncCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startCalendarSyncCron, stopCalendarSyncCron };
