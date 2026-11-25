/**
 * Rythme d'envoi d'une boîte de prospection, en heure de Paris :
 *
 *   - plage : jours (1 = lundi … 7 = dimanche) et heures [début, fin[ ;
 *     jamais un jour férié français (fêtes légales, lundi de Pentecôte
 *     compris : services/calendar/fiscalDeadlines.js) ;
 *   - limite du jour avec montée progressive : 10 e-mails par jour les 7
 *     premiers jours après la connexion de la boîte, 20 du 8e au 14e, puis
 *     la limite choisie (bornée au plafond) ;
 *   - espacement de 3 à 8 minutes, au hasard, entre deux envois ;
 *   - estimation de la fin d'une prospection à ce rythme.
 *
 * Indépendant du fuseau du serveur (VPS en UTC).
 */
import crypto from "crypto";
import { frenchPublicHolidays } from "../calendar/fiscalDeadlines.js";
import { addDays, parisDay } from "../../utils/invoiceRecurrenceSchedule.js";
import { clampDailyLimit } from "./config.js";

export const MIN_SPACING_MS = 3 * 60 * 1000;
export const MAX_SPACING_MS = 8 * 60 * 1000;
// Espacement moyen : sert à estimer combien d'envois tiennent dans la plage
const AVERAGE_SPACING_MINUTES = 5.5;

export const RAMP_UP = Object.freeze([
  { untilDay: 7, limit: 10 },
  { untilDay: 14, limit: 20 },
]);

const PARIS = "Europe/Paris";
const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: PARIS,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  weekday: "short",
});
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const pad = (n) => String(n).padStart(2, "0");

/** Jour (AAAA-MM-JJ), jour de la semaine (1 = lundi), heure et minute à Paris. */
export function parisParts(date = new Date()) {
  const parts = Object.fromEntries(
    partsFormat.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return {
    day: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    weekday: WEEKDAYS[parts.weekday],
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Décalage Paris - UTC (ms) à un instant. */
function parisOffsetMs(date) {
  const p = parisParts(date);
  const [y, m, d] = p.day.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instant d'une heure de Paris un jour donné (AAAA-MM-JJ). */
export function parisInstant(day, hour = 0, minute = 0) {
  const [y, m, d] = day.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  let result = guess - parisOffsetMs(new Date(guess));
  // Changement d'heure entre l'estimation et le résultat : second calcul
  const corrected = guess - parisOffsetMs(new Date(result));
  if (corrected !== result) result = corrected;
  return new Date(result);
}

/** Jour de la semaine d'un jour AAAA-MM-JJ (1 = lundi … 7 = dimanche). */
export function weekdayOf(day) {
  const index = new Date(`${day}T12:00:00Z`).getUTCDay();
  return index === 0 ? 7 : index;
}

export function isFrenchHoliday(day) {
  return frenchPublicHolidays(Number(day.slice(0, 4))).has(day);
}

/** Plage utilisable : au moins un jour, début avant la fin. */
export function isValidSendWindow(window) {
  const days = Array.isArray(window?.days) ? window.days : [];
  const start = Number(window?.startHour);
  const end = Number(window?.endHour);
  return (
    days.some((d) => Number.isInteger(d) && d >= 1 && d <= 7) &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end <= 24 &&
    start < end
  );
}

/** Jour d'envoi : jour de la plage et pas férié. */
export function isSendDay(window, day) {
  return (window?.days || []).includes(weekdayOf(day)) && !isFrenchHoliday(day);
}

/** L'instant est-il dans la plage d'envoi (jour, heure, pas férié) ? */
export function isWithinSendWindow(window, now = new Date()) {
  if (!isValidSendWindow(window)) return false;
  const p = parisParts(now);
  return (
    isSendDay(window, p.day) &&
    p.hour >= window.startHour &&
    p.hour < window.endHour
  );
}

/** Début de la plage du prochain jour d'envoi après aujourd'hui (Paris). */
export function nextWindowStart(window, now = new Date()) {
  if (!isValidSendWindow(window)) return null;
  let day = parisDay(now);
  for (let i = 0; i < 400; i += 1) {
    day = addDays(day, 1);
    if (isSendDay(window, day)) return parisInstant(day, window.startHour);
  }
  return null;
}

/** Jours calendaires (Paris) écoulés entre deux instants. */
function daysBetween(from, to) {
  const a = Date.parse(`${parisDay(from)}T00:00:00Z`);
  const b = Date.parse(`${parisDay(to)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

/** Plafond de la montée progressive (jour 0 = jour de la connexion). */
export function rampUpCap(connectedAt, now = new Date()) {
  if (!connectedAt) return Infinity;
  const day = daysBetween(new Date(connectedAt), now);
  const step = RAMP_UP.find((s) => day < s.untilDay);
  return step ? step.limit : Infinity;
}

/** Limite du jour d'une boîte : sa limite bornée, montée progressive comprise. */
export function effectiveDailyLimit(mailbox, now = new Date()) {
  return Math.min(
    clampDailyLimit(mailbox?.dailyLimit),
    rampUpCap(mailbox?.connectedAt, now),
  );
}

/** Attente avant l'envoi suivant : 3 à 8 minutes au hasard. */
export function randomSpacingMs() {
  return crypto.randomInt(MIN_SPACING_MS, MAX_SPACING_MS + 1);
}

/** Envois qui tiennent dans une plage d'une journée (espacement moyen). */
function windowCapacity(window, fromMinute = null) {
  const start = window.startHour * 60;
  const end = window.endHour * 60;
  const from = fromMinute === null ? start : Math.max(start, fromMinute);
  return Math.max(0, Math.floor((end - from) / AVERAGE_SPACING_MINUTES));
}

/**
 * Jours d'envoi nécessaires pour `count` e-mails au rythme de la boîte, à
 * partir de maintenant (le reste du jour compte s'il est dans la plage) :
 * { days, endDate (AAAA-MM-JJ) }, ou null (plage invalide, rien à envoyer,
 * boîte qui ne peut plus rien envoyer).
 */
export function estimateSchedule({
  mailbox,
  count,
  sentToday = 0,
  now = new Date(),
}) {
  const window = mailbox?.sendWindow;
  if (!mailbox || !isValidSendWindow(window) || !(count > 0)) return null;
  let remaining = count;
  let days = 0;
  let endDate = null;
  const today = parisParts(now);
  let day = today.day;
  for (let i = 0; i < 3660 && remaining > 0; i += 1) {
    if (isSendDay(window, day)) {
      const instant = parisInstant(day, window.startHour);
      const limit = effectiveDailyLimit(mailbox, instant);
      const capacity =
        i === 0
          ? Math.min(
              limit - sentToday,
              windowCapacity(window, today.hour * 60 + today.minute),
            )
          : Math.min(limit, windowCapacity(window));
      if (capacity > 0) {
        remaining -= capacity;
        days += 1;
        endDate = day;
      }
    }
    day = addDays(day, 1);
  }
  return remaining > 0 ? null : { days, endDate };
}
