import { DateTime } from "luxon";
import {
  DEFAULT_SLOT_INTERVAL,
  DEFAULT_TIMEZONE,
  isValidDay,
  isValidTimezone,
} from "./appointmentValidation.js";

/**
 * Moteur de créneaux de la prise de rendez-vous. Fonctions pures, sans
 * accès à la base : l'occupation (agendas connectés, événements Newbi,
 * réservations) est fournie par l'appelant (services/appointments).
 *
 * Toutes les dates locales sont calculées par luxon dans le fuseau de la
 * page : jamais d'ajout d'heures « à la main », pour que les changements
 * d'heure (fin mars, fin octobre) tombent juste. Les pas entre créneaux et
 * les durées sont des minutes réelles : un jour de passage à l'heure d'été,
 * une plage 01:00-04:00 ne dure que deux heures et ne propose pas 02:30
 * (heure inexistante) ; un jour de retour à l'heure d'hiver, 02:00 et 02:30
 * apparaissent deux fois, une fois par décalage.
 */

const MINUTE = 60 * 1000;

const zoneOf = (page) =>
  isValidTimezone(page?.timezone) ? page.timezone : DEFAULT_TIMEZONE;

const toMillis = (value) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

/** Jour local « AAAA-MM-JJ » d'un instant dans un fuseau. */
export function localDayOf(value, zone = DEFAULT_TIMEZONE) {
  return DateTime.fromMillis(toMillis(value), { zone }).toISODate();
}

/** Jour local suivant (ou précédent) : « 2026-03-28 » + 1 = « 2026-03-29 ». */
export function addDays(day, count) {
  return DateTime.fromISO(day, { zone: "UTC" })
    .plus({ days: count })
    .toISODate();
}

/** Nombre de jours entre deux jours locaux (to - from). */
export function daysBetween(from, to) {
  return Math.round(
    DateTime.fromISO(to, { zone: "UTC" })
      .diff(DateTime.fromISO(from, { zone: "UTC" }), "days")
      .as("days"),
  );
}

/** Instant (ms) d'une heure locale « HH:mm » ; « 24:00 » = minuit suivant. */
export function localTimeMillis(day, time, zone = DEFAULT_TIMEZONE) {
  if (time === "24:00") {
    return DateTime.fromISO(day, { zone })
      .plus({ days: 1 })
      .startOf("day")
      .toMillis();
  }
  // Heure inexistante (passage à l'heure d'été) : luxon avance d'une heure
  return DateTime.fromISO(`${day}T${time}`, { zone }).toMillis();
}

/** Début et fin (exclue) d'un jour local, en instants. */
export function dayBounds(day, zone = DEFAULT_TIMEZONE) {
  const start = DateTime.fromISO(day, { zone }).startOf("day");
  return {
    start: start.toJSDate(),
    end: start.plus({ days: 1 }).toJSDate(),
  };
}

/** Plages d'un jour : exception de la date sinon semaine type. */
export function intervalsForDay(page, day) {
  const zone = zoneOf(page);
  const override = (page?.dateOverrides || []).find((o) => o.date === day);
  if (override) return override.intervals || [];
  const weekday = DateTime.fromISO(day, { zone }).weekday;
  const weekly = (page?.availability || []).find(
    (d) => Number(d.dayOfWeek) === weekday,
  );
  return weekly?.intervals || [];
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * Créneaux libres d'un type de rendez-vous entre deux jours locaux.
 *
 * @param {object} params
 * @param {object} params.page - { timezone, availability, dateOverrides }
 * @param {object} params.type - { _id, durationMinutes, slotIntervalMinutes,
 *   bufferBeforeMinutes, bufferAfterMinutes, minNoticeMinutes,
 *   maxDaysAhead, maxPerDay }
 * @param {Array<{start, end}>} [params.busy] - intervalles occupés
 *   (agendas connectés, événements Newbi)
 * @param {Array<object>} [params.bookings] - réservations de l'organisateur :
 *   { startAt, endAt, appointmentTypeId, status, bufferBeforeMinutes,
 *   bufferAfterMinutes } (marges de leur propre type si connues)
 * @param {Date} [params.now]
 * @param {string} params.from - premier jour local « AAAA-MM-JJ »
 * @param {string} params.to - dernier jour local (inclus)
 * @returns {Array<{start: Date, end: Date}>} créneaux triés
 */
export function computeAvailableSlots({
  page,
  type,
  busy = [],
  bookings = [],
  now = new Date(),
  from,
  to,
}) {
  if (!type || !isValidDay(from) || !isValidDay(to)) return [];
  const zone = zoneOf(page);
  const duration = Number(type.durationMinutes) * MINUTE;
  const step =
    (Number(type.slotIntervalMinutes) || DEFAULT_SLOT_INTERVAL) * MINUTE;
  if (!(duration > 0) || !(step > 0)) return [];
  const before = (Number(type.bufferBeforeMinutes) || 0) * MINUTE;
  const after = (Number(type.bufferAfterMinutes) || 0) * MINUTE;
  const nowMs = toMillis(now);
  const earliest = nowMs + (Number(type.minNoticeMinutes) || 0) * MINUTE;

  // Bornes : pas avant aujourd'hui, pas après l'horizon du type
  const today = localDayOf(nowMs, zone);
  const lastDay = addDays(today, Number(type.maxDaysAhead ?? 60));
  const firstDay = from > today ? from : today;
  const finalDay = to < lastDay ? to : lastDay;
  if (firstDay > finalDay) return [];

  const confirmed = bookings.filter(
    (b) => !b.status || b.status === "CONFIRMED",
  );

  // Occupé : agendas tels quels, réservations élargies de leurs propres
  // marges (celles du type courant quand le leur est inconnu)
  const blocked = [
    ...busy.map((b) => [toMillis(b.start), toMillis(b.end)]),
    ...confirmed.map((b) => [
      toMillis(b.startAt) - (b.bufferBeforeMinutes ?? before / MINUTE) * MINUTE,
      toMillis(b.endAt) + (b.bufferAfterMinutes ?? after / MINUTE) * MINUTE,
    ]),
  ].filter(
    ([start, end]) =>
      Number.isFinite(start) && Number.isFinite(end) && start < end,
  );

  // Plafond quotidien : réservations confirmées de ce type par jour local
  const maxPerDay = Number(type.maxPerDay) || null;
  const perDay = new Map();
  if (maxPerDay) {
    const typeId = type._id ?? type.id;
    for (const booking of confirmed) {
      if (!sameId(booking.appointmentTypeId, typeId)) continue;
      const day = localDayOf(booking.startAt, zone);
      perDay.set(day, (perDay.get(day) || 0) + 1);
    }
  }

  const slots = [];
  for (let day = firstDay; day <= finalDay; day = addDays(day, 1)) {
    if (maxPerDay && (perDay.get(day) || 0) >= maxPerDay) continue;
    for (const interval of intervalsForDay(page, day)) {
      const intervalStart = localTimeMillis(day, interval.start, zone);
      const intervalEnd = localTimeMillis(day, interval.end, zone);
      for (
        let start = intervalStart;
        start + duration <= intervalEnd;
        start += step
      ) {
        if (start < earliest) continue;
        const end = start + duration;
        const windowStart = start - before;
        const windowEnd = end + after;
        const taken = blocked.some(
          ([busyStart, busyEnd]) =>
            windowStart < busyEnd && busyStart < windowEnd,
        );
        if (!taken) slots.push({ start, end });
      }
    }
  }

  slots.sort((a, b) => a.start - b.start);
  return slots
    .filter(
      (slot, index) => index === 0 || slot.start !== slots[index - 1].start,
    )
    .map((slot) => ({ start: new Date(slot.start), end: new Date(slot.end) }));
}
