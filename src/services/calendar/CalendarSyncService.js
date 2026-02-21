import CalendarConnection from '../../models/CalendarConnection.js';
import Event from '../../models/Event.js';
import { getCalendarProvider } from './CalendarProviderFactory.js';
import { translateGoogleError } from './providers/GoogleCalendarProvider.js';
import { translateMicrosoftError } from './providers/MicrosoftCalendarProvider.js';
import logger from '../../utils/logger.js';

/**
 * Traduit une erreur de synchronisation en message français selon le provider
 */
function translateSyncError(error, provider) {
  const msg = error.message || '';
  // Erreurs réseau communes
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
    return 'Impossible de joindre le serveur. Vérifiez votre connexion internet.';
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
    return 'Le serveur ne répond pas. Réessayez dans quelques instants.';
  }

  switch (provider) {
    case 'google':
      return translateGoogleError(error);
    case 'microsoft':
      return translateMicrosoftError(error);
    case 'apple': {
      if (msg.includes('401') || msg.includes('Unauthorized')) {
        return 'Identifiants Apple expirés ou invalides. Veuillez reconnecter votre calendrier Apple.';
      }
      if (msg.includes('403') || msg.includes('Forbidden')) {
        return 'Accès refusé par Apple. Vérifiez que CalDAV est activé sur votre compte iCloud.';
      }
      return `Erreur de synchronisation Apple Calendar : ${msg}`;
    }
    default:
      return `Erreur de synchronisation : ${msg}`;
  }
}

/**
 * Sync events from a single calendar connection (pull)
 */
export async function syncConnection(connectionId) {
  const connection = await CalendarConnection.findById(connectionId);
  if (!connection || connection.status === 'disconnected') {
    throw new Error('Connexion calendrier non trouvée ou déconnectée');
  }

  const provider = getCalendarProvider(connection.provider);

  try {
    // Fetch events from external provider
    logger.info(`[CalendarSync] Démarrage sync pour connexion ${connectionId} (${connection.provider})`);
    const externalEvents = await provider.fetchEvents(connection);
    logger.info(`[CalendarSync] ${externalEvents.length} événement(s) récupéré(s) depuis ${connection.provider}`);

    // Get existing external events for this connection
    const existingEvents = await Event.find({ calendarConnectionId: connection._id });
    const existingByExternalId = new Map(
      existingEvents.map(e => [e.externalEventId, e])
    );

    const externalIdsSeen = new Set();
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let skipped = 0;
    let errors = 0;

    // Load all Newbi events pushed to this connection to detect bounce-backs
    // (events pushed to external calendar that come back during pull)
    const pushedEvents = await Event.find({
      'externalCalendarLinks.calendarConnectionId': connection._id
    });
    const pushedExternalIds = new Set();
    for (const pe of pushedEvents) {
      for (const link of pe.externalCalendarLinks) {
        if (link.calendarConnectionId.toString() === connection._id.toString()) {
          pushedExternalIds.add(link.externalEventId);
        }
      }
    }

    // Upsert events
    for (const eventData of externalEvents) {
      try {
        externalIdsSeen.add(eventData.externalEventId);

        // Skip bounce-backs: events pushed from Newbi that return during pull
        if (pushedExternalIds.has(eventData.externalEventId)) {
          skipped++;
          continue;
        }

        const existing = existingByExternalId.get(eventData.externalEventId);

        if (existing) {
          // Update if changed
          let hasChanges = false;
          for (const field of ['title', 'description', 'location', 'allDay', 'color']) {
            if (existing[field] !== eventData[field]) {
              existing[field] = eventData[field];
              hasChanges = true;
            }
          }
          if (existing.start.getTime() !== eventData.start.getTime()) {
            existing.start = eventData.start;
            hasChanges = true;
          }
          if (existing.end.getTime() !== eventData.end.getTime()) {
            existing.end = eventData.end;
            hasChanges = true;
          }
          // Corriger visibility si manquant (migration legacy)
          if (!existing.visibility || existing.visibility !== 'private') {
            existing.visibility = 'private';
            hasChanges = true;
          }
          if (hasChanges) {
            await existing.save();
            updated++;
          }
        } else {
          // Create new
          await Event.create(eventData);
          created++;
        }
      } catch (eventError) {
        errors++;
        logger.warn(`[CalendarSync] Erreur upsert événement "${eventData.title}":`, eventError.message);
      }
    }

    // Delete events that no longer exist in the external calendar
    for (const [externalId, existingEvent] of existingByExternalId) {
      if (!externalIdsSeen.has(externalId)) {
        await Event.findByIdAndDelete(existingEvent._id);
        deleted++;
      }
    }

    // Clean up stale externalCalendarLinks: if a pushed Newbi event's
    // external counterpart was deleted from the external calendar, remove the link
    // (reuses pushedEvents already loaded above for bounce-back detection)
    let unlinked = 0;

    for (const pushedEvent of pushedEvents) {
      const staleLinks = pushedEvent.externalCalendarLinks.filter(
        link => link.calendarConnectionId.toString() === connection._id.toString()
          && !externalIdsSeen.has(link.externalEventId)
      );

      if (staleLinks.length > 0) {
        const staleIds = staleLinks.map(l => l.externalEventId);
        await Event.updateOne(
          { _id: pushedEvent._id },
          { $pull: { externalCalendarLinks: { calendarConnectionId: connection._id, externalEventId: { $in: staleIds } } } }
        );
        unlinked += staleLinks.length;
        logger.info(`[CalendarSync] Removed ${staleLinks.length} stale link(s) from event "${pushedEvent.title}" (${pushedEvent._id})`);
      }
    }

    if (unlinked > 0) {
      logger.info(`[CalendarSync] Cleaned up ${unlinked} stale externalCalendarLink(s) for connection ${connectionId}`);
    }

    // Update connection sync state
    connection.lastSyncAt = new Date();
    connection.lastSyncError = null;
    connection.status = 'active';
    await connection.save();

    logger.info(`[CalendarSync] Sync terminée pour ${connectionId}: +${created} ~${updated} -${deleted} ⊘${unlinked} ⤬${skipped} (${errors} erreur(s))`);

    return { created, updated, deleted, unlinked, skipped, errors, total: externalEvents.length };
  } catch (error) {
    logger.error(`Calendar sync failed for connection ${connectionId}:`, error.message);
    const frenchError = translateSyncError(error, connection.provider);
    connection.lastSyncError = frenchError;
    if (error.message.includes('Token expiré') || error.message.includes('invalid_grant') || error.message.includes('401') || error.message.includes('Unauthorized') || error.message.includes('AADSTS')) {
      connection.status = 'expired';
    } else {
      connection.status = 'error';
    }
    await connection.save();
    throw new Error(frenchError);
  }
}

/**
 * Sync all active connections for a given user
 */
export async function syncAllForUser(userId) {
  const connections = await CalendarConnection.find({
    userId,
    status: { $in: ['active', 'error'] }
  });

  const results = [];
  for (const connection of connections) {
    try {
      const result = await syncConnection(connection._id);
      results.push({ connectionId: connection._id, provider: connection.provider, success: true, ...result });
    } catch (error) {
      results.push({ connectionId: connection._id, provider: connection.provider, success: false, error: error.message });
    }
  }

  return results;
}

/**
 * Sync all active connections (for cron job)
 */
export async function syncAllActiveConnections() {
  const connections = await CalendarConnection.find({
    status: 'active'
  });

  logger.info(`Starting calendar sync for ${connections.length} active connections`);

  let successCount = 0;
  let failCount = 0;

  for (const connection of connections) {
    try {
      await syncConnection(connection._id);
      successCount++;
    } catch (error) {
      failCount++;
      logger.warn(`Sync failed for connection ${connection._id} (${connection.provider}): ${error.message}`);
    }
  }

  logger.info(`Calendar sync completed: ${successCount} succeeded, ${failCount} failed`);
  return { successCount, failCount, total: connections.length };
}

/**
 * Push a Newbi event to an external calendar
 */
export async function pushEventToCalendar(eventId, connectionId) {
  const [event, connection] = await Promise.all([
    Event.findById(eventId),
    CalendarConnection.findById(connectionId)
  ]);

  if (!event) throw new Error('Événement non trouvé');
  if (!connection || connection.status === 'disconnected') throw new Error('Connexion calendrier non trouvée');

  const provider = getCalendarProvider(connection.provider);
  const externalEventId = await provider.pushEvent(connection, event);

  // Save the link on the event
  if (!event.externalCalendarLinks) {
    event.externalCalendarLinks = [];
  }

  // Remove existing link for this connection if any
  event.externalCalendarLinks = event.externalCalendarLinks.filter(
    link => link.calendarConnectionId.toString() !== connectionId.toString()
  );

  event.externalCalendarLinks.push({
    provider: connection.provider,
    externalEventId,
    calendarConnectionId: connection._id
  });

  await event.save();

  logger.info(`Event ${eventId} pushed to ${connection.provider} calendar (${externalEventId})`);
  return event;
}

/**
 * Propagate event deletion to all linked external calendars (fire-and-forget)
 */
export async function deleteEventFromExternalCalendars(event) {
  const links = event.externalCalendarLinks;
  if (!links || links.length === 0) return;

  for (const link of links) {
    try {
      const connection = await CalendarConnection.findById(link.calendarConnectionId);
      if (!connection || connection.status === 'disconnected') {
        logger.warn(`[CalendarSync] Skipping delete propagation — connection ${link.calendarConnectionId} not found or disconnected`);
        continue;
      }

      const provider = getCalendarProvider(connection.provider);
      await provider.deleteEvent(connection, link.externalEventId);
      logger.info(`[CalendarSync] Propagated delete to ${connection.provider} (${link.externalEventId})`);
    } catch (error) {
      logger.error(`[CalendarSync] Failed to propagate delete to ${link.provider} (${link.externalEventId}):`, error.message);
    }
  }
}

/**
 * Propagate event update to all linked external calendars (fire-and-forget)
 */
export async function updateEventInExternalCalendars(event) {
  const links = event.externalCalendarLinks;
  if (!links || links.length === 0) return;

  for (const link of links) {
    try {
      const connection = await CalendarConnection.findById(link.calendarConnectionId);
      if (!connection || connection.status === 'disconnected') {
        logger.warn(`[CalendarSync] Skipping update propagation — connection ${link.calendarConnectionId} not found or disconnected`);
        continue;
      }

      const provider = getCalendarProvider(connection.provider);
      await provider.updateEvent(connection, link.externalEventId, event);
      logger.info(`[CalendarSync] Propagated update to ${connection.provider} (${link.externalEventId})`);
    } catch (error) {
      logger.error(`[CalendarSync] Failed to propagate update to ${link.provider} (${link.externalEventId}):`, error.message);
    }
  }
}

/**
 * Disconnect a calendar and clean up all associated external events
 */
export async function disconnectCalendar(connectionId) {
  const connection = await CalendarConnection.findById(connectionId);
  if (!connection) throw new Error('Connexion calendrier non trouvée');

  // Delete all external events linked to this connection
  const deleteResult = await Event.deleteMany({ calendarConnectionId: connection._id });
  logger.info(`Deleted ${deleteResult.deletedCount} external events for connection ${connectionId}`);

  // Remove external calendar links from Newbi events that were pushed to this connection
  await Event.updateMany(
    { 'externalCalendarLinks.calendarConnectionId': connection._id },
    { $pull: { externalCalendarLinks: { calendarConnectionId: connection._id } } }
  );

  // Mark connection as disconnected
  connection.status = 'disconnected';
  await connection.save();

  return connection;
}
