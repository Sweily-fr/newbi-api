import crypto from "crypto";
import { google } from "googleapis";
import { ensureValidToken } from "../utils/tokenRefresher.js";
import {
  mapGoogleEventToNewbi,
  mapNewbiToGoogleEvent,
} from "../utils/eventMapper.js";
import logger from "../../../utils/logger.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export function translateGoogleError(error) {
  const msg = error.message || "";
  const status = error.code || error.status;
  if (
    status === 401 ||
    msg.includes("invalid_grant") ||
    msg.includes("Token has been expired")
  ) {
    return "Session Google expirée. Veuillez reconnecter votre compte Google.";
  }
  if (status === 403 || msg.includes("insufficientPermissions")) {
    return "Permissions insuffisantes. Veuillez reconnecter votre compte Google et autoriser l'accès au calendrier.";
  }
  if (status === 404) {
    return "Calendrier Google introuvable.";
  }
  if (
    msg.includes("ENOTFOUND") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("network")
  ) {
    return "Impossible de joindre les serveurs Google. Vérifiez votre connexion internet.";
  }
  if (msg.includes("Rate Limit") || status === 429) {
    return "Trop de requêtes vers Google. Réessayez dans quelques instants.";
  }
  return `Erreur Google Calendar : ${msg}`;
}

export default class GoogleCalendarProvider {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
      `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/calendar-connect/google/callback`,
    );
  }

  /**
   * Generate OAuth authorization URL
   */
  getAuthUrl(state) {
    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
      state,
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code) {
    const response = await this.oauth2Client.getToken(code);
    const tokens = response.tokens;
    logger.info("Google OAuth tokens received:", {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      tokenKeys: Object.keys(tokens),
      accessTokenPreview: tokens.access_token
        ? tokens.access_token.substring(0, 20) + "..."
        : "MISSING",
    });
    this.oauth2Client.setCredentials(tokens);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };
  }

  /**
   * Get user info from Google
   */
  async getUserInfo(accessToken) {
    const response = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
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
    const calendar = google.calendar({
      version: "v3",
      auth: this.oauth2Client,
    });

    const { data } = await calendar.calendarList.list();

    return (data.items || []).map((cal) => ({
      calendarId: cal.id,
      name: cal.summary,
      color: cal.backgroundColor || null,
      isPrimary: cal.primary || false,
    }));
  }

  /**
   * Fetch events from Google Calendar
   */
  async fetchEvents(connection, options = {}) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({
      version: "v3",
      auth: this.oauth2Client,
    });

    const lookbackDays =
      parseInt(process.env.CALENDAR_SYNC_LOOKBACK_DAYS) || 30;
    const lookaheadDays =
      parseInt(process.env.CALENDAR_SYNC_LOOKAHEAD_DAYS) || 90;

    const timeMin =
      options.timeMin ||
      new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const timeMax =
      options.timeMax ||
      new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString();

    const enabledCalendars = connection.selectedCalendars.filter(
      (c) => c.enabled,
    );
    const calendarIds =
      enabledCalendars.length > 0
        ? enabledCalendars.map((c) => c.calendarId)
        : ["primary"];

    const allEvents = [];

    for (const calendarId of calendarIds) {
      try {
        // Trouver la couleur du calendrier depuis les selectedCalendars
        const calInfo = enabledCalendars.find(
          (c) => c.calendarId === calendarId,
        );
        const calColor = calInfo?.color || null;

        const { data } = await calendar.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 500,
        });

        const events = (data.items || []).map((event) =>
          mapGoogleEventToNewbi(
            event,
            connection._id,
            connection.userId,
            calColor,
          ),
        );
        allEvents.push(...events);
      } catch (error) {
        logger.warn(
          `Failed to fetch events from Google calendar ${calendarId}:`,
          error.message,
        );
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
    const calendar = google.calendar({
      version: "v3",
      auth: this.oauth2Client,
    });

    const googleEvent = mapNewbiToGoogleEvent(newbiEvent);

    // Use first enabled selected calendar, fallback to 'primary'
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    const calendarId =
      enabledCalendars.length > 0 ? enabledCalendars[0].calendarId : "primary";

    const { data } = await calendar.events.insert({
      calendarId,
      resource: googleEvent,
    });

    logger.info(`Event pushed to Google Calendar (${calendarId}): ${data.id}`);
    return data.id;
  }

  /**
   * Client Calendar avec son propre jeton : le client OAuth partagé par
   * l'instance (setCredentials) serait écrasé par une autre requête en vol
   * (pages publiques de prise de rendez-vous lues en parallèle).
   */
  _calendarFor(accessToken) {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CALENDAR_CLIENT_ID,
      process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    );
    auth.setCredentials({ access_token: accessToken });
    return google.calendar({ version: "v3", auth });
  }

  // Agenda d'écriture : premier agenda activé, sinon l'agenda principal
  _writeCalendarId(connection) {
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    return enabledCalendars.length > 0
      ? enabledCalendars[0].calendarId
      : "primary";
  }

  /**
   * Intervalles occupés des agendas activés (freebusy, portée
   * calendar.readonly) pour la prise de rendez-vous. Les événements
   * « disponible » et les journées entières non bloquantes sont déjà exclus
   * par Google. Lève une erreur si aucun agenda n'a pu être lu.
   */
  async getBusyIntervals(connection, { timeMin, timeMax }) {
    const accessToken = await ensureValidToken(connection);
    const calendar = this._calendarFor(accessToken);
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    const ids =
      enabledCalendars.length > 0
        ? enabledCalendars.map((c) => c.calendarId)
        : ["primary"];

    const { data } = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        items: ids.map((id) => ({ id })),
      },
    });

    const entries = Object.entries(data.calendars || {});
    const readable = entries.filter(([, entry]) => !(entry.errors?.length > 0));
    for (const [id, entry] of entries) {
      if (entry.errors?.length > 0) {
        logger.warn(
          `[Google freebusy] agenda ${id} illisible : ${entry.errors.map((e) => e.reason).join(", ")}`,
        );
      }
    }
    if (readable.length === 0) {
      throw new Error("Google freebusy : aucun agenda lisible");
    }

    return readable.flatMap(([, entry]) =>
      (entry.busy || []).map((b) => ({
        start: new Date(b.start),
        end: new Date(b.end),
      })),
    );
  }

  /**
   * Crée un rendez-vous dans l'agenda d'écriture, avec un lien Google Meet
   * si demandé. L'invité est ajouté aux participants SANS notification de
   * Google (sendUpdates « none ») : il ne reçoit que les e-mails de Newbi.
   * Lien impossible (compte sans Meet…) : l'événement est créé sans lien et
   * `meetingError` explique pourquoi.
   *
   * @returns {Promise<{ externalEventId, meetingUrl, meetingError }>}
   */
  async pushEventDetailed(
    connection,
    newbiEvent,
    { conference = false, attendees = [] } = {},
  ) {
    const accessToken = await ensureValidToken(connection);
    const calendar = this._calendarFor(accessToken);
    const calendarId = this._writeCalendarId(connection);

    const requestBody = mapNewbiToGoogleEvent(newbiEvent);
    if (attendees.length > 0) {
      requestBody.attendees = attendees.map((a) => ({
        email: a.email,
        displayName: a.name || undefined,
      }));
    }

    let meetingError = null;
    if (conference) {
      try {
        const { data } = await calendar.events.insert({
          calendarId,
          conferenceDataVersion: 1,
          sendUpdates: "none",
          requestBody: {
            ...requestBody,
            conferenceData: {
              createRequest: {
                requestId: crypto.randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            },
          },
        });
        let event = data;
        // Lien parfois créé en différé : une relecture suffit en général
        for (
          let i = 0;
          i < 2 &&
          !googleMeetingUrl(event) &&
          event.conferenceData?.createRequest?.status?.statusCode === "pending";
          i += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          ({ data: event } = await calendar.events.get({
            calendarId,
            eventId: data.id,
          }));
        }
        const meetingUrl = googleMeetingUrl(event);
        logger.info(
          `Rendez-vous créé dans Google Calendar (${calendarId}) : ${data.id}${meetingUrl ? " avec lien Meet" : " sans lien Meet"}`,
        );
        return {
          externalEventId: data.id,
          meetingUrl,
          meetingError: meetingUrl
            ? null
            : "Google n'a pas créé de lien Google Meet pour ce compte.",
        };
      } catch (error) {
        meetingError = translateGoogleError(error);
        logger.warn(
          `[Google] lien Meet impossible, rendez-vous créé sans lien : ${error.message}`,
        );
      }
    }

    const { data } = await calendar.events.insert({
      calendarId,
      sendUpdates: "none",
      requestBody,
    });
    logger.info(
      `Rendez-vous créé dans Google Calendar (${calendarId}) : ${data.id}`,
    );
    return { externalEventId: data.id, meetingUrl: null, meetingError };
  }

  /**
   * Déplace un rendez-vous (dates seules) : un remplacement complet
   * (events.update) effacerait le lien Meet et les participants.
   */
  async rescheduleEvent(connection, externalEventId, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    const calendar = this._calendarFor(accessToken);
    const calendarId = this._writeCalendarId(connection);
    const { start, end } = mapNewbiToGoogleEvent(newbiEvent);

    await calendar.events.patch({
      calendarId,
      eventId: externalEventId,
      sendUpdates: "none",
      requestBody: { start, end },
    });
    logger.info(
      `Rendez-vous déplacé dans Google Calendar (${calendarId}) : ${externalEventId}`,
    );
  }

  /**
   * Update a pushed event in Google Calendar
   */
  async updateEvent(connection, externalEventId, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({
      version: "v3",
      auth: this.oauth2Client,
    });

    const googleEvent = mapNewbiToGoogleEvent(newbiEvent);

    // Use first enabled selected calendar, fallback to 'primary'
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    const calendarId =
      enabledCalendars.length > 0 ? enabledCalendars[0].calendarId : "primary";

    await calendar.events.update({
      calendarId,
      eventId: externalEventId,
      resource: googleEvent,
    });

    logger.info(
      `Event updated in Google Calendar (${calendarId}): ${externalEventId}`,
    );
  }

  /**
   * Delete a pushed event from Google Calendar
   */
  async deleteEvent(connection, externalEventId) {
    const accessToken = await ensureValidToken(connection);
    this.oauth2Client.setCredentials({ access_token: accessToken });
    const calendar = google.calendar({
      version: "v3",
      auth: this.oauth2Client,
    });

    // Use first enabled selected calendar, fallback to 'primary'
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    const calendarId =
      enabledCalendars.length > 0 ? enabledCalendars[0].calendarId : "primary";

    await calendar.events.delete({
      calendarId,
      eventId: externalEventId,
      // Participants (invité d'un rendez-vous) : aucun e-mail de Google,
      // Newbi envoie le sien
      sendUpdates: "none",
    });

    logger.info(
      `Event deleted from Google Calendar (${calendarId}): ${externalEventId}`,
    );
  }
}

/** Lien de visioconférence d'un événement Google (Meet). */
export function googleMeetingUrl(event) {
  if (!event) return null;
  return (
    event.hangoutLink ||
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")
      ?.uri ||
    null
  );
}
