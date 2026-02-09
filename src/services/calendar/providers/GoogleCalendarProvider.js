import { google } from 'googleapis';
import { ensureValidToken } from '../utils/tokenRefresher.js';
import { mapGoogleEventToNewbi, mapNewbiToGoogleEvent } from '../utils/eventMapper.js';
import logger from '../../../utils/logger.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

export function translateGoogleError(error) {
  const msg = error.message || '';
  const status = error.code || error.status;
  if (status === 401 || msg.includes('invalid_grant') || msg.includes('Token has been expired')) {
    return 'Session Google expirée. Veuillez reconnecter votre compte Google.';
  }
  if (status === 403 || msg.includes('insufficientPermissions')) {
    return 'Permissions insuffisantes. Veuillez reconnecter votre compte Google et autoriser l\'accès au calendrier.';
  }
  if (status === 404) {
    return 'Calendrier Google introuvable.';
  }
  if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('network')) {
    return 'Impossible de joindre les serveurs Google. Vérifiez votre connexion internet.';
  }
  if (msg.includes('Rate Limit') || status === 429) {
    return 'Trop de requêtes vers Google. Réessayez dans quelques instants.';
  }
  return `Erreur Google Calendar : ${msg}`;
}

export default class GoogleCalendarProvider {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
      `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000'}/calendar-connect/google/callback`
    );
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthUrl(state) {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code) {
    const response = await this.oauth2Client.getToken(code);
    const tokens = response.tokens;
    logger.info('Google OAuth tokens received:', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      tokenKeys: Object.keys(tokens),
      accessTokenPreview: tokens.access_token ? tokens.access_token.substring(0, 20) + '...' : 'MISSING',
    });
    this.oauth2Client.setCredentials(tokens);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null
    };
  }

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken) {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google userinfo failed: ${response.status}`);
    }
    const data = await response.json();
    return {
      email: data.email,
      name: data.name,
    };
  }

  /**
   * List all calendars for the connected account
   */
  async listCalendars(connection) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const { data } = await calendar.calendarList.list();

    return (data.items || []).map(cal => ({
      calendarId: cal.id,
      name: cal.summary,
      color: cal.backgroundColor || null,
      isPrimary: cal.primary || false
    }));
  }

  /**
   * Fetch events from Google Calendar
   */
  async fetchEvents(connection, options = {}) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const lookbackDays = parseInt(process.env.CALENDAR_SYNC_LOOKBACK_DAYS) || 30;
    const lookaheadDays = parseInt(process.env.CALENDAR_SYNC_LOOKAHEAD_DAYS) || 90;

    const timeMin = options.timeMin || new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const timeMax = options.timeMax || new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString();

    const enabledCalendars = connection.selectedCalendars.filter(c => c.enabled);
    const calendarIds = enabledCalendars.length > 0
      ? enabledCalendars.map(c => c.calendarId)
      : ['primary'];

    const allEvents = [];

    for (const calendarId of calendarIds) {
      try {
        // Trouver la couleur du calendrier depuis les selectedCalendars
        const calInfo = enabledCalendars.find(c => c.calendarId === calendarId);
        const calColor = calInfo?.color || null;

        const { data } = await calendar.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 500
        });

        const events = (data.items || []).map(event =>
          mapGoogleEventToNewbi(event, connection._id, connection.userId, calColor)
        );
        allEvents.push(...events);
      } catch (error) {
        logger.warn(`Failed to fetch events from Google calendar ${calendarId}:`, error.message);
      }
    }

    return allEvents;
  }

  /**
   * Push a Newbi event to Google Calendar
   */
  async pushEvent(connection, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const googleEvent = mapNewbiToGoogleEvent(newbiEvent);

    // Use first enabled selected calendar, fallback to 'primary'
    const enabledCalendars = connection.selectedCalendars?.filter(c => c.enabled) || [];
    const calendarId = enabledCalendars.length > 0 ? enabledCalendars[0].calendarId : 'primary';

    const { data } = await calendar.events.insert({
      calendarId,
      resource: googleEvent
    });

    logger.info(`Event pushed to Google Calendar (${calendarId}): ${data.id}`);
    return data.id;
  }

  /**
   * Update a pushed event in Google Calendar
   */
  async updateEvent(connection, externalEventId, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    const googleEvent = mapNewbiToGoogleEvent(newbiEvent);

    // Use first enabled selected calendar, fallback to 'primary'
    const enabledCalendars = connection.selectedCalendars?.filter(c => c.enabled) || [];
    const calendarId = enabledCalendars.length > 0 ? enabledCalendars[0].calendarId : 'primary';

    await calendar.events.update({
      calendarId,
      eventId: externalEventId,
      resource: googleEvent
    });

    logger.info(`Event updated in Google Calendar (${calendarId}): ${externalEventId}`);
  }

  /**
   * Delete a pushed event from Google Calendar
   */
  async deleteEvent(connection, externalEventId) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });

    // Use first enabled selected calendar, fallback to 'primary'
    const enabledCalendars = connection.selectedCalendars?.filter(c => c.enabled) || [];
    const calendarId = enabledCalendars.length > 0 ? enabledCalendars[0].calendarId : 'primary';

    await calendar.events.delete({
      calendarId,
      eventId: externalEventId
    });

    logger.info(`Event deleted from Google Calendar (${calendarId}): ${externalEventId}`);
  }
}
