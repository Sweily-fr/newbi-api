import cron from 'node-cron';
import CalendarConnection from '../models/CalendarConnection.js';
import {
  stopGoogleWatch,
  registerGoogleWatch,
  renewMicrosoftSubscription,
} from '../services/calendar/CalendarWebhookService.js';
import logger from '../utils/logger.js';

let task = null;

/**
 * Cron job to renew webhooks/subscriptions that are about to expire.
 * Runs every 2 hours. Targets connections whose webhookExpiration
 * is within the next 4 hours.
 */
function startCalendarWebhookRenewalCron() {
  // Every 2 hours
  task = cron.schedule('0 */2 * * *', async () => {
    logger.info('[WebhookRenewal Cron] Checking for webhooks to renew');

    try {
      const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000);

      const expiringConnections = await CalendarConnection.find({
        status: 'active',
        webhookExpiration: { $ne: null, $lt: fourHoursFromNow },
      });

      if (expiringConnections.length === 0) {
        logger.debug('[WebhookRenewal Cron] No webhooks need renewal');
        return;
      }

      logger.info(`[WebhookRenewal Cron] ${expiringConnections.length} webhook(s) to renew`);

      let renewed = 0;
      let failed = 0;

      for (const connection of expiringConnections) {
        try {
          if (connection.provider === 'google') {
            // Google: stop old channel, then re-register
            await stopGoogleWatch(connection);
            await registerGoogleWatch(connection._id);
            renewed++;
          } else if (connection.provider === 'microsoft') {
            // Microsoft: PATCH expiration or re-register
            await renewMicrosoftSubscription(connection);
            renewed++;
          }
        } catch (error) {
          failed++;
          logger.error(`[WebhookRenewal Cron] Failed to renew webhook for connection ${connection._id} (${connection.provider}):`, error.message);
        }
      }

      logger.info(`[WebhookRenewal Cron] Renewal complete: ${renewed} renewed, ${failed} failed`);
    } catch (error) {
      logger.error('[WebhookRenewal Cron] Error:', error.message);
    }
  }, {
    scheduled: true,
    timezone: 'Europe/Paris'
  });

  logger.info('[WebhookRenewal Cron] Configured (every 2 hours)');
  return task;
}

function stopCalendarWebhookRenewalCron() {
  if (task) {
    task.stop();
    task = null;
  }
}

export { startCalendarWebhookRenewalCron, stopCalendarWebhookRenewalCron };
