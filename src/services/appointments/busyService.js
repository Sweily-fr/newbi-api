import AppointmentType from "../../models/AppointmentType.js";
import Booking from "../../models/Booking.js";
import CalendarConnection from "../../models/CalendarConnection.js";
import Event from "../../models/Event.js";
import { cacheGet, cacheSet } from "../../config/redis.js";
import { getCalendarProvider } from "../calendar/CalendarProviderFactory.js";
import { MAX_BUFFER_MINUTES } from "../../utils/appointmentValidation.js";
import logger from "../../utils/logger.js";

/**
 * Occupation d'un organisateur pour la prise de rendez-vous :
 *   - agendas connectés (Google freebusy, Microsoft calendarView, Apple
 *     CalDAV), lus en direct et gardés 60 s en cache ; panne d'un
 *     fournisseur : repli sur ses événements déjà synchronisés en base ;
 *   - événements Newbi de l'organisateur (hors journées entières, hors
 *     événements externes en lecture seule et hors rendez-vous, comptés via
 *     leurs réservations) ;
 *   - réservations confirmées de l'organisateur, toutes pages confondues,
 *     avec les marges de leur type.
 * Ne lève jamais d'erreur à cause d'un fournisseur : la page publique doit
 * toujours répondre.
 */

const BUSY_CACHE_SECONDS = 60;
const PROVIDER_TIMEOUT_MS = 8000;
const MAX_BUFFER_MS = MAX_BUFFER_MINUTES * 60 * 1000;
const EXTERNAL_SOURCES = ["google", "microsoft", "apple"];

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`délai de ${ms} ms dépassé`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const toInterval = (b) => ({
  start: new Date(b.start),
  end: new Date(b.end),
  externalEventId: b.externalEventId || null,
});

/**
 * Connexions lues pour l'occupation : celles choisies sur la page, sinon
 * toutes les connexions utilisables de l'organisateur.
 */
export async function busyConnectionsFor(page, hostUserId) {
  const filter = { userId: hostUserId, status: { $in: ["active", "error"] } };
  if (page?.busyConnectionIds?.length > 0) {
    filter._id = { $in: page.busyConnectionIds };
  }
  return CalendarConnection.find(filter);
}

/** Événements déjà synchronisés d'une connexion (repli en cas de panne). */
async function syncedBusy(connection, timeMin, timeMax) {
  const events = await Event.find({
    calendarConnectionId: connection._id,
    allDay: { $ne: true },
    start: { $lt: timeMax },
    end: { $gt: timeMin },
  })
    .select("start end externalEventId")
    .lean();
  return events.map(toInterval);
}

async function connectionBusy(connection, { timeMin, timeMax, useCache }) {
  const key = `booking-busy:${connection._id}:${timeMin.toISOString()}:${timeMax.toISOString()}`;
  if (useCache) {
    const cached = await cacheGet(key);
    if (Array.isArray(cached)) return cached.map(toInterval);
  }
  try {
    const provider = getCalendarProvider(connection.provider);
    const busy = await withTimeout(
      provider.getBusyIntervals(connection, { timeMin, timeMax }),
      PROVIDER_TIMEOUT_MS,
    );
    const intervals = busy.map(toInterval);
    await cacheSet(key, intervals, BUSY_CACHE_SECONDS);
    return intervals;
  } catch (error) {
    logger.warn(
      `[rendez-vous] occupation ${connection.provider} (${connection._id}) illisible, repli sur les événements synchronisés : ${error.message}`,
    );
    try {
      return await syncedBusy(connection, timeMin, timeMax);
    } catch (fallbackError) {
      logger.warn(
        `[rendez-vous] repli impossible pour ${connection._id} : ${fallbackError.message}`,
      );
      return [];
    }
  }
}

/** Événements Newbi de l'organisateur qui l'occupent. */
async function newbiBusy(hostUserId, timeMin, timeMax) {
  const events = await Event.find({
    userId: hostUserId,
    source: { $nin: EXTERNAL_SOURCES },
    allDay: { $ne: true },
    isReadOnly: { $ne: true },
    type: { $ne: "APPOINTMENT" },
    start: { $lt: timeMax },
    end: { $gt: timeMin },
  })
    .select("start end")
    .lean();
  return events.map(toInterval);
}

/** Réservations confirmées, avec les marges de leur type (si connu). */
async function hostBookings(hostUserId, timeMin, timeMax, excludeBookingId) {
  const filter = {
    hostUserId,
    status: "CONFIRMED",
    startAt: { $lt: new Date(timeMax.getTime() + MAX_BUFFER_MS) },
    endAt: { $gt: new Date(timeMin.getTime() - MAX_BUFFER_MS) },
  };
  if (excludeBookingId) filter._id = { $ne: excludeBookingId };
  const bookings = await Booking.find(filter)
    .select("startAt endAt appointmentTypeId status")
    .lean();
  const typeIds = [
    ...new Set(
      bookings
        .map((b) => b.appointmentTypeId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const types = typeIds.length
    ? await AppointmentType.find({ _id: { $in: typeIds } })
        .select("bufferBeforeMinutes bufferAfterMinutes")
        .lean()
    : [];
  const buffers = new Map(types.map((t) => [String(t._id), t]));
  return bookings.map((b) => {
    const type = b.appointmentTypeId
      ? buffers.get(String(b.appointmentTypeId))
      : null;
    return {
      ...b,
      bufferBeforeMinutes: type?.bufferBeforeMinutes,
      bufferAfterMinutes: type?.bufferAfterMinutes,
    };
  });
}

/**
 * Occupation de l'organisateur sur une période.
 *
 * @param {object} params
 * @param {object} params.page - page de réservation (connexions lues)
 * @param {*} params.hostUserId
 * @param {Date} params.timeMin
 * @param {Date} params.timeMax
 * @param {boolean} [params.useCache] - false à la réservation (lecture en direct)
 * @param {object} [params.excludeBooking] - réservation en cours de
 *   reprogrammation : ni elle ni son événement d'agenda ne bloquent
 * @returns {Promise<{ busy: Array<{start, end}>, bookings: Array<object> }>}
 */
export async function getHostOccupation({
  page,
  hostUserId,
  timeMin,
  timeMax,
  useCache = true,
  excludeBooking = null,
}) {
  const connections = await busyConnectionsFor(page, hostUserId);
  const [external, newbi, bookings] = await Promise.all([
    Promise.all(
      connections.map((connection) =>
        connectionBusy(connection, { timeMin, timeMax, useCache }),
      ),
    ),
    newbiBusy(hostUserId, timeMin, timeMax),
    hostBookings(hostUserId, timeMin, timeMax, excludeBooking?._id),
  ]);

  let busy = [...external.flat(), ...newbi];
  if (excludeBooking) {
    const start = new Date(excludeBooking.startAt).getTime();
    const end = new Date(excludeBooking.endAt).getTime();
    // Son événement d'agenda : par identifiant (Microsoft, Apple), sinon par
    // dates exactes (Google freebusy ne donne pas d'identifiant)
    busy = busy.filter(
      (b) =>
        !(
          (excludeBooking.externalEventId &&
            sameId(b.externalEventId, excludeBooking.externalEventId)) ||
          (!b.externalEventId &&
            b.start.getTime() === start &&
            b.end.getTime() === end)
        ),
    );
  }
  return { busy, bookings };
}
