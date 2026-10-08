/**
 * Calendrier des factures récurrentes. Toutes les dates sont des jours
 * calendaires « AAAA-MM-JJ » (heure de Paris), manipulés en UTC pour que
 * l'arithmétique ne dépende jamais du fuseau du serveur.
 */

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n, size = 2) => String(n).padStart(size, "0");

export const isDayString = (value) => {
  if (typeof value !== "string") return false;
  const m = value.match(DAY_PATTERN);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

const toUtcDate = (day) => {
  const [, y, m, d] = day.match(DAY_PATTERN);
  return new Date(Date.UTC(+y, +m - 1, +d));
};

const fromUtcDate = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

/** Jour calendaire à Paris pour un instant donné (par défaut maintenant). */
export function parisDay(now = new Date()) {
  // en-CA formate en AAAA-MM-JJ
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function addDays(day, days) {
  const d = toUtcDate(day);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtcDate(d);
}

/**
 * Ajoute des mois en restant sur le jour d'ancrage quand il existe, sinon sur
 * le dernier jour du mois (31 janvier + 1 mois = 28/29 février, + 2 mois =
 * 31 mars).
 */
export function addMonths(day, months) {
  const [, y, m, d] = day.match(DAY_PATTERN);
  const target = new Date(Date.UTC(+y, +m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(+d, lastDay));
  return fromUtcDate(target);
}

/** k-ième échéance (k = 0 → startDate). */
export function occurrenceDate({ startDate, frequency, interval = 1 }, k) {
  const step = Math.max(1, interval || 1) * k;
  switch (frequency) {
    case "DAILY":
      return addDays(startDate, step);
    case "WEEKLY":
      return addDays(startDate, 7 * step);
    case "MONTHLY":
      return addMonths(startDate, step);
    default:
      throw new Error(`Fréquence de récurrence inconnue : ${frequency}`);
  }
}

const daysBetween = (from, to) =>
  Math.round((toUtcDate(to) - toUtcDate(from)) / 86400000);

/**
 * Première échéance ≥ `day` (ou > `day` si `strict`), en respectant la date
 * de fin. Retourne null quand il n'y en a plus.
 */
export function nextOccurrenceFrom(recurrence, day, { strict = false } = {}) {
  const { startDate, frequency, endDate } = recurrence;
  const interval = Math.max(1, recurrence.interval || 1);

  let k = 0;
  if (day > startDate) {
    // Estimation directe de l'indice, puis ajustement : évite de boucler sur
    // des années d'échéances quotidiennes. Un mois compte pour 31 jours pour
    // que l'estimation reste en deçà de la bonne échéance, jamais au-delà.
    const elapsed = daysBetween(startDate, day);
    const periodDays =
      frequency === "DAILY" ? 1 : frequency === "WEEKLY" ? 7 : 31;
    k = Math.max(0, Math.floor(elapsed / (periodDays * interval)) - 1);
  }

  let candidate = occurrenceDate(recurrence, k);
  while (candidate < day || (strict && candidate === day)) {
    k += 1;
    candidate = occurrenceDate(recurrence, k);
  }

  if (endDate && candidate > endDate) return null;
  return candidate;
}

/**
 * Recale la partie date en fin de préfixe (AAAAMM, MMAAAA, AAAA-MM, MM-AAAA
 * ou AAAA seule) sur le jour donné. Miroir de `refreshPrefixDate` côté front
 * (NewbiV2/src/utils/invoiceUtils.js) : une facture générée prend le même
 * préfixe qu'une nouvelle facture créée ce jour-là dans l'éditeur.
 */
export function refreshPrefixDate(prefix, day) {
  if (!prefix) return prefix;
  const [, yyyy, mm] = day.match(DAY_PATTERN);

  const isValidMonth = (v) => +v >= 1 && +v <= 12;
  const isValidYear = (v) => +v >= 2000 && +v <= 2099;

  let m = prefix.match(/^(.*?)(\d{4})([-/]?)(\d{2})$/);
  if (m && isValidYear(m[2]) && isValidMonth(m[4])) {
    return `${m[1]}${yyyy}${m[3]}${mm}`;
  }

  m = prefix.match(/^(.*?)(\d{2})([-/]?)(\d{4})$/);
  if (m && isValidMonth(m[2]) && isValidYear(m[4])) {
    return `${m[1]}${mm}${m[3]}${yyyy}`;
  }

  m = prefix.match(/^(.*?)(\d{4})$/);
  if (m && isValidYear(m[2])) {
    return `${m[1]}${yyyy}`;
  }

  return prefix;
}

/** Écart en jours entre deux dates (émission → échéance de paiement). */
export function paymentDelayDays(issueDate, dueDate) {
  if (!issueDate || !dueDate) return 30;
  const diff = Math.round(
    (new Date(dueDate).getTime() - new Date(issueDate).getTime()) / 86400000,
  );
  return diff >= 0 ? diff : 30;
}
