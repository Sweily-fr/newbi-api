import express from 'express';
import CalendarConnection from '../models/CalendarConnection.js';
import { syncConnection } from '../services/calendar/CalendarSyncService.js';
import { publishCalendarEventsChanged } from '../services/calendar/CalendarWebhookService.js';
import logger from '../utils/logger.js';

const router = express.Router();

// ============================================
// GOOGLE PUSH NOTIFICATIONS
// ============================================

/**
 * POST /calendar-webhooks/google
 * Receives Google Calendar push notifications
 * Google sends: X-Goog-Channel-ID, X-Goog-Resource-ID, X-Goog-Resource-State
 */
router.post('/google', async (req, res) => {
  const channelId = req.headers['x-goog-channel-id'];
  const resourceState = req.headers['x-goog-resource-state'];

  // Always respond 200 immediately to acknowledge receipt
  res.status(200).end();

  // Ignore the initial sync notification (handshake)
  if (resourceState === 'sync') {
    logger.debug(`[CalendarWebhook/Google] Handshake sync notification for channel ${channelId}`);
    return;
  }

  if (!channelId) {
    logger.warn('[CalendarWebhook/Google] Received notification without channel ID');
    return;
  }

  try {
    const connection = await CalendarConnection.findOne({
      webhookChannelId: channelId,
      status: { $ne: 'disconnected' }
    });

    if (!connection) {
      logger.warn(`[CalendarWebhook/Google] No connection found for channel ${channelId}`);
      return;
    }

    logger.info(`[CalendarWebhook/Google] Change notification for connection ${connection._id} (${connection.provider}, user: ${connection.userId})`);

    // Sync and publish (fire-and-forget, already responded 200)
    await syncConnection(connection._id);
    publishCalendarEventsChanged(connection.userId);
  } catch (error) {
    logger.error(`[CalendarWebhook/Google] Error processing notification for channel ${channelId}:`, error.message);
  }
});

// ============================================
// MICROSOFT CHANGE NOTIFICATIONS
// ============================================

/**
 * POST /calendar-webhooks/microsoft
 * Receives Microsoft Graph change notifications
 * Handles both validation requests and actual notifications
 */
router.post('/microsoft', async (req, res) => {
  // Microsoft validation: if validationToken is present, echo it back
  const validationToken = req.query.validationToken;
  if (validationToken) {
    logger.debug(`[CalendarWebhook/Microsoft] Validation request, echoing token`);
    res.status(200).contentType('text/plain').send(validationToken);
    return;
  }

  // Respond 202 immediately to acknowledge receipt
  res.status(202).end();

  const notifications = req.body?.value;
  if (!notifications || !Array.isArray(notifications)) {
    logger.warn('[CalendarWebhook/Microsoft] Received notification without value array');
    return;
  }

  for (const notification of notifications) {
    const subscriptionId = notification.subscriptionId;
    if (!subscriptionId) continue;

    try {
      const connection = await CalendarConnection.findOne({
        graphSubscriptionId: subscriptionId,
        status: { $ne: 'disconnected' }
      });

      if (!connection) {
        logger.warn(`[CalendarWebhook/Microsoft] No connection found for subscription ${subscriptionId}`);
        continue;
      }

      logger.info(`[CalendarWebhook/Microsoft] Change notification for connection ${connection._id} (user: ${connection.userId}, changeType: ${notification.changeType})`);

      // Sync and publish
      await syncConnection(connection._id);
      publishCalendarEventsChanged(connection.userId);
    } catch (error) {
      logger.error(`[CalendarWebhook/Microsoft] Error processing notification for subscription ${subscriptionId}:`, error.message);
    }
  }
});

export default router;
