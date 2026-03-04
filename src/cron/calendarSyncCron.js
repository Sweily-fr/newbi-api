import cron from 'node-cron';
import { syncAllActiveConnections } from '../services/calendar/CalendarSyncService.js';
import logger from '../utils/logger.js';

let generalTask = null;
let appleTask = null;

/**
 * Start the calendar sync cron jobs
 * - General (Google/Microsoft without active webhook): every 15 minutes
 * - Apple (CalDAV polling, no webhook support): every 3 minutes
 */
function startCalendarSyncCron() {
  // General cron: every 15 min — Google/Microsoft without active webhook, excludes Apple
  generalTask = cron.schedule('*/15 * * * *', async () => {
    logger.info('[Calendar Cron] Démarrage sync générale (Google/Microsoft sans webhook)');

    try {
      const result = await syncAllActiveConnections({ excludeWebhookActive: true, excludeProviders: ['apple'] });
      if (result.total > 0) {
        logger.info(`[Calendar Cron] Sync générale terminée: ${result.successCount}/${result.total} réussies, ${result.failCount} échouées`);
      }
    } catch (error) {
      logger.error('[Calendar Cron] Erreur sync générale:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris'
  });

  // Apple cron: every 3 min — Apple CalDAV only (no webhook support)
  appleTask = cron.schedule('*/3 * * * *', async () => {
    logger.info('[Calendar Cron] Démarrage sync Apple CalDAV');

    try {
      const result = await syncAllActiveConnections({ onlyProviders: ['apple'] });
      if (result.total > 0) {
        logger.info(`[Calendar Cron] Sync Apple terminée: ${result.successCount}/${result.total} réussies, ${result.failCount} échouées`);
      }
    } catch (error) {
      logger.error('[Calendar Cron] Erreur sync Apple:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris'
  });

  logger.info('[Calendar Cron] Jobs configurés — Général: 15 min, Apple: 3 min');
  return { generalTask, appleTask };
}

/**
 * Stop the calendar sync cron jobs
 */
function stopCalendarSyncCron() {
  if (generalTask) {
    generalTask.stop();
    generalTask = null;
  }
  if (appleTask) {
    appleTask.stop();
    appleTask = null;
  }
}

export { startCalendarSyncCron, stopCalendarSyncCron };
