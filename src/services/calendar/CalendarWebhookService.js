import { google } from 'googleapis';
import { Client } from '@microsoft/microsoft-graph-client';
import crypto from 'crypto';
import CalendarConnection from '../../models/CalendarConnection.js';
import { ensureValidToken } from './utils/tokenRefresher.js';
import { getPubSub } from '../../config/redis.js';
import logger from '../../utils/logger.js';

const CALENDAR_EVENTS_CHANGED = 'CALENDAR_EVENTS_CHANGED';

// URL publique pour recevoir les webhooks Google/Microsoft
// Priorité: CALENDAR_WEBHOOK_URL > NEXT_PUBLIC_API_URL > localhost
const WEBHOOK_BASE_URL = (
  process.env.CALENDAR_WEBHOOK_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'http://localhost:4000'
).replace(/\/$/, ''); // Remove trailing slash

/**
 * Publish a calendarEventsChanged event via PubSub
 */
export function publishCalendarEventsChanged(userId) {
  try {
    const pubsub = getPubSub();
    const channel = `${CALENDAR_EVENTS_CHANGED}_${userId}`;
    pubsub.publish(channel, {
      calendarEventsChanged: {
        userId: userId.toString(),
        timestamp: new Date().toISOString(),
      },
    });
    logger.debug(`[CalendarWebhook] Published calendarEventsChanged for user ${userId}`);
  } catch (error) {
    logger.warn('[CalendarWebhook] Failed to publish calendarEventsChanged:', error.message);
  }
}

// ============================================
// GOOGLE WATCH
// ============================================

/**
 * Register Google Calendar push notification channels for all enabled calendars
 */
export async function registerGoogleWatch(connectionId) {
  const connection = await CalendarConnection.findById(connectionId);
  if (!connection || connection.provider !== 'google' || connection.status === 'disconnected') {
    logger.warn(`[CalendarWebhook] Cannot register Google watch: connection ${connectionId} invalid`);
    return null;
  }

  const accessToken = await ensureValidToken(connection);
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CALENDAR_CLIENT_ID,
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ access_token: accessToken });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const enabledCalendars = connection.selectedCalendars.filter(c => c.enabled);
  const calendarIds = enabledCalendars.length > 0
    ? enabledCalendars.map(c => c.calendarId)
    : ['primary'];

  // Google watch channels expire max ~7 days; use 6 days
  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000;
  const webhookChannels = [];
  let latestExpiration = null;

  for (const calendarId of calendarIds) {
    const channelId = crypto.randomUUID();
    try {
      const response = await calendar.events.watch({
        calendarId,
        requestBody: {
          id: channelId,
          type: 'web_hook',
          address: `${WEBHOOK_BASE_URL}/calendar-webhooks/google`,
          expiration: String(expiration),
        },
      });

      const channelExpiration = new Date(parseInt(response.data.expiration));
      webhookChannels.push({
        calendarId,
        channelId: response.data.id,
        resourceId: response.data.resourceId,
        expiration: channelExpiration,
      });

      if (!latestExpiration || channelExpiration > latestExpiration) {
        latestExpiration = channelExpiration;
      }

      logger.info(`[CalendarWebhook] Google watch registered for calendar ${calendarId} on connection ${connectionId} (channel: ${channelId})`);
    } catch (error) {
      logger.error(`[CalendarWebhook] Failed to register Google watch for calendar ${calendarId} on connection ${connectionId}:`, error.message);
    }
  }

  if (webhookChannels.length > 0) {
    // Keep first channel in legacy fields for backward compatibility
    connection.webhookChannelId = webhookChannels[0].channelId;
    connection.webhookResourceId = webhookChannels[0].resourceId;
    connection.webhookExpiration = latestExpiration;
    connection.webhookChannels = webhookChannels;
    await connection.save();

    logger.info(`[CalendarWebhook] ${webhookChannels.length} Google watch(es) registered for connection ${connectionId} (expires: ${latestExpiration.toISOString()})`);
    return connection;
  }

  logger.error(`[CalendarWebhook] No Google watches could be registered for connection ${connectionId}`);
  return null;
}

/**
 * Stop all Google Calendar push notification channels for a connection
 */
export async function stopGoogleWatch(connection) {
  const channels = connection.webhookChannels && connection.webhookChannels.length > 0
    ? connection.webhookChannels
    : (connection.webhookChannelId && connection.webhookResourceId
      ? [{ channelId: connection.webhookChannelId, resourceId: connection.webhookResourceId }]
      : []);

  if (channels.length === 0) return;

  try {
    const accessToken = await ensureValidToken(connection);
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    for (const channel of channels) {
      try {
        await calendar.channels.stop({
          requestBody: {
            id: channel.channelId,
            resourceId: channel.resourceId,
          },
        });
        logger.info(`[CalendarWebhook] Google watch stopped for connection ${connection._id} (channel: ${channel.channelId})`);
      } catch (error) {
        // 404 means channel already expired/stopped — not an error
        if (error.code !== 404) {
          logger.warn(`[CalendarWebhook] Failed to stop Google watch channel ${channel.channelId} for connection ${connection._id}:`, error.message);
        }
      }
    }
  } catch (error) {
    logger.warn(`[CalendarWebhook] Failed to get token to stop Google watches for connection ${connection._id}:`, error.message);
  }

  connection.webhookChannelId = null;
  connection.webhookResourceId = null;
  connection.webhookExpiration = null;
  connection.webhookChannels = [];
  await connection.save();
}

// ============================================
// MICROSOFT SUBSCRIPTION
// ============================================

function _getGraphClient(accessToken) {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    },
  });
}

/**
 * Register a Microsoft Graph change notification subscription
 */
export async function registerMicrosoftSubscription(connectionId) {
  const connection = await CalendarConnection.findById(connectionId);
  if (!connection || connection.provider !== 'microsoft' || connection.status === 'disconnected') {
    logger.warn(`[CalendarWebhook] Cannot register Microsoft subscription: connection ${connectionId} invalid`);
    return null;
  }

  const accessToken = await ensureValidToken(connection);
  const client = _getGraphClient(accessToken);

  // Microsoft calendar subscriptions max lifetime: 3 days (4230 minutes)
  const expirationDateTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const subscription = await client.api('/subscriptions').post({
      changeType: 'created,updated,deleted',
      notificationUrl: `${WEBHOOK_BASE_URL}/calendar-webhooks/microsoft`,
      resource: '/me/events',
      expirationDateTime,
      clientState: connection._id.toString(),
    });

    connection.graphSubscriptionId = subscription.id;
    connection.webhookExpiration = new Date(subscription.expirationDateTime);
    await connection.save();

    logger.info(`[CalendarWebhook] Microsoft subscription registered for connection ${connectionId} (sub: ${subscription.id}, expires: ${connection.webhookExpiration.toISOString()})`);
    return connection;
  } catch (error) {
    logger.error(`[CalendarWebhook] Failed to register Microsoft subscription for connection ${connectionId}:`, error.message);
    return null;
  }
}

/**
 * Renew a Microsoft Graph subscription by patching the expiration
 */
export async function renewMicrosoftSubscription(connection) {
  if (!connection.graphSubscriptionId) {
    return registerMicrosoftSubscription(connection._id);
  }

  const accessToken = await ensureValidToken(connection);
  const client = _getGraphClient(accessToken);
  const expirationDateTime = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const updated = await client.api(`/subscriptions/${connection.graphSubscriptionId}`).patch({
      expirationDateTime,
    });

    connection.webhookExpiration = new Date(updated.expirationDateTime);
    await connection.save();

    logger.info(`[CalendarWebhook] Microsoft subscription renewed for connection ${connection._id} (expires: ${connection.webhookExpiration.toISOString()})`);
    return connection;
  } catch (error) {
    // If subscription not found, re-register
    if (error.statusCode === 404) {
      logger.info(`[CalendarWebhook] Microsoft subscription expired/not found, re-registering for connection ${connection._id}`);
      return registerMicrosoftSubscription(connection._id);
    }
    logger.error(`[CalendarWebhook] Failed to renew Microsoft subscription for connection ${connection._id}:`, error.message);
    return null;
  }
}

/**
 * Delete a Microsoft Graph subscription
 */
export async function deleteMicrosoftSubscription(connection) {
  if (!connection.graphSubscriptionId) {
    return;
  }

  try {
    const accessToken = await ensureValidToken(connection);
    const client = _getGraphClient(accessToken);
    await client.api(`/subscriptions/${connection.graphSubscriptionId}`).delete();
    logger.info(`[CalendarWebhook] Microsoft subscription deleted for connection ${connection._id} (sub: ${connection.graphSubscriptionId})`);
  } catch (error) {
    if (error.statusCode !== 404) {
      logger.warn(`[CalendarWebhook] Failed to delete Microsoft subscription for connection ${connection._id}:`, error.message);
    }
  }

  connection.graphSubscriptionId = null;
  connection.webhookExpiration = null;
  await connection.save();
}

// ============================================
// GENERIC DISPATCHERS
// ============================================

/**
 * Register a webhook/subscription for a connection based on its provider
 */
export async function registerWebhookForConnection(connectionId) {
  const connection = await CalendarConnection.findById(connectionId);
  if (!connection || connection.status === 'disconnected') {
    return null;
  }

  switch (connection.provider) {
    case 'google':
      return registerGoogleWatch(connectionId);
    case 'microsoft':
      return registerMicrosoftSubscription(connectionId);
    case 'apple':
      // Apple CalDAV does not support webhooks — uses polling only
      return null;
    default:
      logger.warn(`[CalendarWebhook] Unknown provider: ${connection.provider}`);
      return null;
  }
}

/**
 * Cleanup webhook/subscription for a connection before disconnect
 */
export async function cleanupWebhookForConnection(connection) {
  switch (connection.provider) {
    case 'google':
      return stopGoogleWatch(connection);
    case 'microsoft':
      return deleteMicrosoftSubscription(connection);
    default:
      return;
  }
}
