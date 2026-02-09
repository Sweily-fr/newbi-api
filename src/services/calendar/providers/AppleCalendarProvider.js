import { createDAVClient } from 'tsdav';
import ICAL from 'node-ical';
import { mapAppleEventToNewbi, mapNewbiToICalEvent } from '../utils/eventMapper.js';
import logger from '../../../utils/logger.js';

const DEFAULT_CALDAV_URL = 'https://caldav.icloud.com';

export default class AppleCalendarProvider {
  /**
   * Filter calendars to only include VEVENT calendars (exclude VTODO/reminders)
   */
  _isEventCalendar(cal) {
    return !cal.components || cal.components.length === 0 || cal.components.includes('VEVENT');
  }

  /**
   * Validate CalDAV credentials and return a client
   */
  async connect(username, password, calDavUrl) {
    const serverUrl = calDavUrl || DEFAULT_CALDAV_URL;

    const client = await createDAVClient({
      serverUrl,
      credentials: {
        username,
        password
      },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    });

    return client;
  }

  /**
   * Translate common CalDAV errors to French
   */
  _translateError(error) {
    const msg = error.message || '';
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('authentication')) {
      return 'Identifiant ou mot de passe d\'application incorrect. Vérifiez vos identifiants et utilisez un mot de passe d\'application (pas votre mot de passe Apple).';
    }
    if (msg.includes('403') || msg.includes('Forbidden')) {
      return 'Accès refusé par Apple. Vérifiez que CalDAV est activé sur votre compte iCloud.';
    }
    if (msg.includes('404') || msg.includes('Not Found')) {
      return 'Serveur CalDAV introuvable. Vérifiez l\'URL du serveur.';
    }
    if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('network') || msg.includes('fetch failed')) {
      return 'Impossible de joindre le serveur Apple. Vérifiez votre connexion internet.';
    }
    if (msg.includes('ETIMEDOUT') || msg.includes('timeout')) {
      return 'Le serveur Apple ne répond pas. Réessayez dans quelques instants.';
    }
    if (msg.includes('SSL') || msg.includes('certificate')) {
      return 'Erreur de certificat SSL avec le serveur Apple.';
    }
    return `Erreur de connexion au calendrier Apple : ${msg}`;
  }

  /**
   * Validate credentials by attempting connection
   */
  async validateCredentials(username, password, calDavUrl) {
    try {
      const client = await this.connect(username, password, calDavUrl);
      const calendars = await client.fetchCalendars();
      return {
        valid: true,
        email: username,
        name: username.split('@')[0],
        calendarsCount: calendars.length
      };
    } catch (error) {
      logger.error('Apple CalDAV validation failed:', error.message);
      return { valid: false, error: this._translateError(error) };
    }
  }

  /**
   * List calendars
   */
  async listCalendars(connection) {
    const client = await this.connect(
      connection.calDavUsername,
      connection.getDecryptedCalDavPassword(),
      connection.calDavUrl
    );

    const calendars = await client.fetchCalendars();

    // Filtrer : ne garder que les calendriers d'événements (VEVENT), pas les rappels (VTODO)
    const eventCalendars = calendars.filter(cal => this._isEventCalendar(cal));

    logger.info(`[Apple CalDAV] listCalendars: ${calendars.length} total, ${eventCalendars.length} calendrier(s) d'événements (VEVENT)`);

    return eventCalendars.map(cal => ({
      calendarId: cal.url,
      name: cal.displayName || 'Calendrier',
      color: cal.calendarColor || null,
      isPrimary: false
    }));
  }

  /**
   * Fetch events from Apple Calendar via CalDAV
   */
  async fetchEvents(connection, options = {}) {
    const client = await this.connect(
      connection.calDavUsername,
      connection.getDecryptedCalDavPassword(),
      connection.calDavUrl
    );

    const lookbackDays = parseInt(process.env.CALENDAR_SYNC_LOOKBACK_DAYS) || 30;
    const lookaheadDays = parseInt(process.env.CALENDAR_SYNC_LOOKAHEAD_DAYS) || 90;

    const timeRange = {
      start: options.timeMin || new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString(),
      end: options.timeMax || new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString()
    };

    logger.info(`[Apple CalDAV] Récupération des événements du ${timeRange.start} au ${timeRange.end}`);

    const allCalendars = await client.fetchCalendars();

    // Filtrer : ne garder que les calendriers d'événements (VEVENT), pas les rappels (VTODO)
    const calendars = allCalendars.filter(cal => this._isEventCalendar(cal));
    logger.info(`[Apple CalDAV] ${allCalendars.length} calendrier(s) sur le serveur, ${calendars.length} calendrier(s) d'événements (VEVENT)`);

    const enabledCalendars = connection.selectedCalendars.filter(c => c.enabled);

    // Matcher les calendriers sélectionnés avec ceux du serveur
    let calendarsToFetch = [];
    if (enabledCalendars.length > 0) {
      for (const enabled of enabledCalendars) {
        const match = calendars.find(c => c.url === enabled.calendarId);
        if (match) {
          calendarsToFetch.push(match);
        } else {
          logger.warn(`[Apple CalDAV] Calendrier sélectionné introuvable: ${enabled.calendarId} (peut-être un calendrier VTODO filtré)`);
        }
      }
    }

    // Si aucun calendrier sélectionné n'a été trouvé parmi les VEVENT, utiliser tous les calendriers VEVENT
    if (calendarsToFetch.length === 0) {
      logger.info(`[Apple CalDAV] Aucun calendrier sélectionné valide, utilisation de tous les ${calendars.length} calendrier(s) VEVENT`);
      calendarsToFetch = calendars;
    }

    logger.info(`[Apple CalDAV] Synchronisation de ${calendarsToFetch.length} calendrier(s)`);

    const allEvents = [];

    for (const calObj of calendarsToFetch) {
      try {
        // Récupérer la couleur du calendrier (depuis CalDAV ou selectedCalendars)
        const calColor = calObj.calendarColor ||
          enabledCalendars.find(c => c.calendarId === calObj.url)?.color || null;

        logger.info(`[Apple CalDAV] Récupération depuis: ${calObj.displayName || calObj.url}`);

        const objects = await client.fetchCalendarObjects({
          calendar: calObj,
          timeRange,
          expand: true
        });

        logger.info(`[Apple CalDAV] ${objects.length} objet(s) trouvé(s) dans "${calObj.displayName || 'Calendrier'}"`);

        for (const obj of objects) {
          try {
            if (!obj.data) {
              logger.warn(`[Apple CalDAV] Objet sans données ICS: ${obj.url}`);
              continue;
            }

            const parsed = ICAL.parseICS(obj.data);
            for (const key in parsed) {
              if (parsed[key].type === 'VEVENT') {
                const vevent = parsed[key];
                const newbiEvent = mapAppleEventToNewbi(
                  {
                    uid: vevent.uid,
                    summary: vevent.summary,
                    description: vevent.description,
                    start: vevent.start,
                    end: vevent.end,
                    location: vevent.location,
                    allDay: vevent.datetype === 'date',
                    url: obj.url
                  },
                  connection._id,
                  connection.userId,
                  calColor
                );
                allEvents.push(newbiEvent);
              }
            }
          } catch (parseError) {
            logger.warn(`[Apple CalDAV] Erreur parsing événement:`, parseError.message);
          }
        }
      } catch (error) {
        logger.warn(`[Apple CalDAV] Erreur récupération calendrier ${calObj.displayName || calObj.url}:`, error.message);
      }
    }

    logger.info(`[Apple CalDAV] Total: ${allEvents.length} événement(s) récupéré(s)`);
    return allEvents;
  }

  /**
   * Push a Newbi event to Apple Calendar via CalDAV
   */
  async pushEvent(connection, newbiEvent) {
    const client = await this.connect(
      connection.calDavUsername,
      connection.getDecryptedCalDavPassword(),
      connection.calDavUrl
    );

    const allCalendars = await client.fetchCalendars();

    // Filter to VEVENT calendars only (exclude VTODO/reminders)
    const eventCalendars = allCalendars.filter(cal => this._isEventCalendar(cal));

    // Try to match a selected/enabled calendar
    const enabledCalendars = connection.selectedCalendars?.filter(c => c.enabled) || [];
    let targetCalendar = null;

    if (enabledCalendars.length > 0) {
      for (const enabled of enabledCalendars) {
        const match = eventCalendars.find(c => c.url === enabled.calendarId);
        if (match) {
          targetCalendar = match;
          break;
        }
      }
    }

    // Fallback to first VEVENT calendar
    if (!targetCalendar) {
      targetCalendar = eventCalendars[0];
    }

    if (!targetCalendar) {
      throw new Error('Aucun calendrier Apple disponible');
    }

    logger.info(`[Apple CalDAV] Push vers: ${targetCalendar.displayName || targetCalendar.url}`);

    const icsData = mapNewbiToICalEvent(newbiEvent);
    const filename = `newbi-${newbiEvent._id || newbiEvent.id}.ics`;

    const result = await client.createCalendarObject({
      calendar: targetCalendar,
      filename,
      iCalString: icsData
    });

    const eventUrl = result?.url || `${targetCalendar.url}${filename}`;
    logger.info(`Event pushed to Apple Calendar: ${eventUrl}`);
    return eventUrl;
  }

  /**
   * Update a pushed event in Apple Calendar via CalDAV
   */
  async updateEvent(connection, externalEventId, newbiEvent) {
    const client = await this.connect(
      connection.calDavUsername,
      connection.getDecryptedCalDavPassword(),
      connection.calDavUrl
    );

    const icsData = mapNewbiToICalEvent(newbiEvent);

    await client.updateCalendarObject({
      calendarObject: {
        url: externalEventId,
        data: icsData
      }
    });

    logger.info(`Event updated in Apple Calendar: ${externalEventId}`);
  }

  /**
   * Delete a pushed event from Apple Calendar
   */
  async deleteEvent(connection, externalEventId) {
    const client = await this.connect(
      connection.calDavUsername,
      connection.getDecryptedCalDavPassword(),
      connection.calDavUrl
    );

    await client.deleteCalendarObject({ calendarObject: { url: externalEventId } });
    logger.info(`Event deleted from Apple Calendar: ${externalEventId}`);
  }
}
