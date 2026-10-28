import { Client } from "@microsoft/microsoft-graph-client";
import { ConfidentialClientApplication } from "@azure/msal-node";
import { ensureValidToken } from "../utils/tokenRefresher.js";
import {
  mapMicrosoftEventToNewbi,
  mapNewbiToMicrosoftEvent,
} from "../utils/eventMapper.js";
import logger from "../../../utils/logger.js";

const SCOPES = ["Calendars.ReadWrite", "User.Read", "offline_access"];

export function translateMicrosoftError(error) {
  const msg = error.message || "";
  const status = error.statusCode || error.code;
  if (
    msg.includes("invalid_grant") ||
    msg.includes("AADSTS") ||
    msg.includes("token") ||
    status === 401
  ) {
    return "Session Microsoft expirée. Veuillez reconnecter votre compte Microsoft.";
  }
  if (status === 403 || msg.includes("Authorization_RequestDenied")) {
    return "Permissions insuffisantes. Veuillez reconnecter votre compte Microsoft et autoriser l'accès au calendrier.";
  }
  if (status === 404 || msg.includes("ResourceNotFound")) {
    return "Calendrier Microsoft introuvable.";
  }
  if (
    msg.includes("ENOTFOUND") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("network")
  ) {
    return "Impossible de joindre les serveurs Microsoft. Vérifiez votre connexion internet.";
  }
  if (status === 429 || msg.includes("throttled")) {
    return "Trop de requêtes vers Microsoft. Réessayez dans quelques instants.";
  }
  return `Erreur Microsoft Calendar : ${msg}`;
}

export default class MicrosoftCalendarProvider {
  constructor() {
    this.msalConfig = {
      auth: {
        clientId: process.env.MICROSOFT_CALENDAR_CLIENT_ID,
        clientSecret: process.env.MICROSOFT_CALENDAR_CLIENT_SECRET,
        authority: "https://login.microsoftonline.com/common",
      },
    };
    this.redirectUri = `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}/calendar-connect/microsoft/callback`;
  }

  /**
   * Generate OAuth authorization URL
   */
  async getAuthUrl(state) {
    const cca = new ConfidentialClientApplication(this.msalConfig);
    const authUrl = await cca.getAuthCodeUrl({
      scopes: SCOPES.map((s) =>
        s === "offline_access" ? s : `https://graph.microsoft.com/${s}`,
      ),
      redirectUri: this.redirectUri,
      state,
      prompt: "consent",
    });
    return authUrl;
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code) {
    const cca = new ConfidentialClientApplication(this.msalConfig);
    const result = await cca.acquireTokenByCode({
      code,
      scopes: SCOPES.map((s) =>
        s === "offline_access" ? s : `https://graph.microsoft.com/${s}`,
      ),
      redirectUri: this.redirectUri,
    });

    // Extract refresh token from MSAL cache
    const cache = cca.getTokenCache().serialize();
    const cacheData = JSON.parse(cache);
    const refreshTokens = Object.values(cacheData.RefreshToken || {});
    const refreshToken = refreshTokens[0]?.secret || null;

    return {
      accessToken: result.accessToken,
      refreshToken,
      expiresAt: result.expiresOn ? new Date(result.expiresOn) : null,
    };
  }

  /**
   * Get user info from Microsoft Graph
   */
  async getUserInfo(accessToken) {
    const client = this._getGraphClient(accessToken);
    const user = await client
      .api("/me")
      .select("displayName,mail,userPrincipalName")
      .get();
    return {
      email: user.mail || user.userPrincipalName,
      name: user.displayName,
    };
  }

  /**
   * List calendars
   */
  async listCalendars(connection) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);

    const { value: calendars } = await client.api("/me/calendars").get();

    return (calendars || []).map((cal) => ({
      calendarId: cal.id,
      name: cal.name,
      color: cal.hexColor || null,
      isPrimary: cal.isDefaultCalendar || false,
    }));
  }

  /**
   * Fetch events from Microsoft Calendar
   */
  async fetchEvents(connection, options = {}) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);

    const lookbackDays =
      parseInt(process.env.CALENDAR_SYNC_LOOKBACK_DAYS) || 30;
    const lookaheadDays =
      parseInt(process.env.CALENDAR_SYNC_LOOKAHEAD_DAYS) || 90;

    const startDateTime =
      options.timeMin ||
      new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const endDateTime =
      options.timeMax ||
      new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000).toISOString();

    const enabledCalendars = connection.selectedCalendars.filter(
      (c) => c.enabled,
    );

    const allEvents = [];

    if (enabledCalendars.length === 0) {
      // Fetch from default calendar
      const { value: events } = await client
        .api("/me/calendarview")
        .query({ startDateTime, endDateTime })
        .top(500)
        .get();

      allEvents.push(
        ...(events || []).map((event) =>
          mapMicrosoftEventToNewbi(event, connection._id, connection.userId),
        ),
      );
    } else {
      for (const cal of enabledCalendars) {
        try {
          const calColor = cal.color || null;
          const { value: events } = await client
            .api(`/me/calendars/${cal.calendarId}/calendarview`)
            .query({ startDateTime, endDateTime })
            .top(500)
            .get();

          allEvents.push(
            ...(events || []).map((event) =>
              mapMicrosoftEventToNewbi(
                event,
                connection._id,
                connection.userId,
                calColor,
              ),
            ),
          );
        } catch (error) {
          logger.warn(
            `Failed to fetch events from Microsoft calendar ${cal.calendarId}:`,
            error.message,
          );
        }
      }
    }

    return allEvents;
  }

  /**
   * Push a Newbi event to Microsoft Calendar
   */
  async pushEvent(connection, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);

    const msEvent = mapNewbiToMicrosoftEvent(newbiEvent);

    // Use first enabled selected calendar, fallback to default
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    let result;
    if (enabledCalendars.length > 0) {
      result = await client
        .api(`/me/calendars/${enabledCalendars[0].calendarId}/events`)
        .post(msEvent);
    } else {
      result = await client.api("/me/events").post(msEvent);
    }

    logger.info(`Event pushed to Microsoft Calendar: ${result.id}`);
    return result.id;
  }

  /**
   * Intervalles occupés des agendas activés pour la prise de rendez-vous
   * (calendarView en UTC). Ignorés : événements « disponible » (showAs
   * free), annulés, et journées entières.
   */
  async getBusyIntervals(connection, { timeMin, timeMax }) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    const paths =
      enabledCalendars.length > 0
        ? enabledCalendars.map(
            (c) => `/me/calendars/${c.calendarId}/calendarView`,
          )
        : ["/me/calendarView"];
    const query = {
      startDateTime: new Date(timeMin).toISOString(),
      endDateTime: new Date(timeMax).toISOString(),
    };

    const busy = [];
    let readable = 0;
    for (const path of paths) {
      try {
        let page = await client
          .api(path)
          .header("Prefer", 'outlook.timezone="UTC"')
          .query(query)
          .select("id,start,end,showAs,isAllDay,isCancelled")
          .top(500)
          .get();
        // Quelques pages au plus (500 événements chacune)
        for (let i = 0; page && i < 5; i += 1) {
          for (const event of page.value || []) {
            if (event.isCancelled || event.isAllDay || event.showAs === "free")
              continue;
            busy.push({
              start: graphUtcDate(event.start?.dateTime),
              end: graphUtcDate(event.end?.dateTime),
              externalEventId: event.id,
            });
          }
          const next = page["@odata.nextLink"];
          page = next
            ? await client
                .api(next)
                .header("Prefer", 'outlook.timezone="UTC"')
                .get()
            : null;
        }
        readable += 1;
      } catch (error) {
        logger.warn(
          `[Microsoft calendarView] agenda illisible (${path}) : ${error.message}`,
        );
      }
    }
    if (readable === 0) {
      throw new Error("Microsoft calendarView : aucun agenda lisible");
    }
    return busy.filter((b) => !isNaN(b.start) && !isNaN(b.end));
  }

  /**
   * Crée un rendez-vous dans l'agenda d'écriture, avec une réunion Teams si
   * demandé. Jamais de participant : Outlook enverrait sa propre
   * invitation, l'invité ne doit recevoir que les e-mails de Newbi.
   * Réunion impossible (compte Microsoft personnel…) : l'événement est créé
   * sans lien et `meetingError` explique pourquoi.
   *
   * @returns {Promise<{ externalEventId, meetingUrl, meetingError }>}
   */
  async pushEventDetailed(connection, newbiEvent, { conference = false } = {}) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);
    const enabledCalendars =
      connection.selectedCalendars?.filter((c) => c.enabled) || [];
    const path =
      enabledCalendars.length > 0
        ? `/me/calendars/${enabledCalendars[0].calendarId}/events`
        : "/me/events";
    const msEvent = mapNewbiToMicrosoftEvent(newbiEvent);

    let meetingError = null;
    if (conference) {
      try {
        const result = await client.api(path).post({
          ...msEvent,
          isOnlineMeeting: true,
          onlineMeetingProvider: "teamsForBusiness",
        });
        const meetingUrl =
          result.onlineMeeting?.joinUrl || result.onlineMeetingUrl || null;
        logger.info(
          `Rendez-vous créé dans Microsoft Calendar : ${result.id}${meetingUrl ? " avec lien Teams" : " sans lien Teams"}`,
        );
        return {
          externalEventId: result.id,
          meetingUrl,
          meetingError: meetingUrl
            ? null
            : "Microsoft n'a pas créé de réunion Teams pour ce compte (les comptes Microsoft personnels ne le permettent pas).",
        };
      } catch (error) {
        meetingError = translateMicrosoftError(error);
        logger.warn(
          `[Microsoft] réunion Teams impossible, rendez-vous créé sans lien : ${error.message}`,
        );
      }
    }

    const result = await client.api(path).post(msEvent);
    logger.info(`Rendez-vous créé dans Microsoft Calendar : ${result.id}`);
    return { externalEventId: result.id, meetingUrl: null, meetingError };
  }

  /** Déplace un rendez-vous (dates seules, la réunion Teams est conservée). */
  async rescheduleEvent(connection, externalEventId, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);
    const { start, end } = mapNewbiToMicrosoftEvent(newbiEvent);
    await client.api(`/me/events/${externalEventId}`).patch({ start, end });
    logger.info(
      `Rendez-vous déplacé dans Microsoft Calendar : ${externalEventId}`,
    );
  }

  /**
   * Update a pushed event in Microsoft Calendar
   */
  async updateEvent(connection, externalEventId, newbiEvent) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);

    const msEvent = mapNewbiToMicrosoftEvent(newbiEvent);

    await client.api(`/me/events/${externalEventId}`).patch(msEvent);
    logger.info(`Event updated in Microsoft Calendar: ${externalEventId}`);
  }

  /**
   * Delete a pushed event from Microsoft Calendar
   */
  async deleteEvent(connection, externalEventId) {
    const accessToken = await ensureValidToken(connection);
    const client = this._getGraphClient(accessToken);

    await client.api(`/me/events/${externalEventId}`).delete();
    logger.info(`Event deleted from Microsoft Calendar: ${externalEventId}`);
  }

  _getGraphClient(accessToken) {
    return Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      },
    });
  }
}

/** Date Graph lue en UTC (en-tête Prefer outlook.timezone="UTC"). */
function graphUtcDate(value) {
  if (!value) return new Date(NaN);
  return new Date(
    /(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`,
  );
}
