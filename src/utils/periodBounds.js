import { createValidationError } from "./errors.js";

/**
 * Bornes des périodes personnalisées des tableaux de bord (courbe de
 * trésorerie, catégories) et du prévisionnel. Les dates viennent du client :
 * elles sont validées avant tout calcul (une plage sans borne ferait
 * construire un point par jour ou par mois sur des siècles).
 */
export const PERIOD_MIN_YEAR = 1990;
export const PERIOD_MAX_YEAR = 2100;
// 20 ans : bien au-delà des périodes proposées (presets, sélecteurs de dates)
export const MAX_PERIOD_DAYS = 7320;
export const MAX_FORECAST_MONTHS = 240;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MONTH_RE = /^(\d{4})-(\d{2})(?:-\d{2}(?:T.*)?)?$/;

const yearInRange = (year) =>
  year >= PERIOD_MIN_YEAR && year <= PERIOD_MAX_YEAR;

/**
 * Date d'un champ de période (AAAA-MM-JJ, heure ISO facultative), ou null
 * si le format, le jour calendaire ou l'année sont invalides.
 */
export function parsePeriodDate(value) {
  if (typeof value !== "string") return null;
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  if (!yearInRange(y)) return null;
  // Jour calendaire réel (pas de 31 février)
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (
    calendar.getUTCFullYear() !== y ||
    calendar.getUTCMonth() !== m - 1 ||
    calendar.getUTCDate() !== d
  ) {
    return null;
  }
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Valide une période personnalisée en jours et renvoie ses dates.
 * @throws AppError VALIDATION_ERROR (message en français)
 */
export function validateDayPeriod(startValue, endValue) {
  const startDate = parsePeriodDate(startValue);
  const endDate = parsePeriodDate(endValue);
  if (!startDate || !endDate) {
    throw createValidationError(
      `Période invalide : dates attendues au format AAAA-MM-JJ, entre ${PERIOD_MIN_YEAR} et ${PERIOD_MAX_YEAR}`,
    );
  }
  if (startDate > endDate) {
    throw createValidationError(
      "Période invalide : la date de début doit précéder la date de fin",
    );
  }
  if ((endDate - startDate) / DAY_MS > MAX_PERIOD_DAYS) {
    throw createValidationError("Période trop longue : 20 ans au maximum");
  }
  return { startDate, endDate };
}

/**
 * Valide une période en mois (AAAA-MM, ou une date dont on garde le mois)
 * et renvoie { startMonth, endMonth } au format AAAA-MM.
 * @throws AppError VALIDATION_ERROR (message en français)
 */
export function validateMonthPeriod(startValue, endValue) {
  const parse = (value) => {
    if (typeof value !== "string") return null;
    const match = MONTH_RE.exec(value.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!yearInRange(year) || month < 1 || month > 12) return null;
    return { year, month };
  };
  const start = parse(startValue);
  const end = parse(endValue);
  if (!start || !end) {
    throw createValidationError(
      `Période invalide : mois attendus au format AAAA-MM, entre ${PERIOD_MIN_YEAR} et ${PERIOD_MAX_YEAR}`,
    );
  }
  const span = (end.year - start.year) * 12 + (end.month - start.month) + 1;
  if (span < 1) {
    throw createValidationError(
      "Période invalide : le mois de début doit précéder le mois de fin",
    );
  }
  if (span > MAX_FORECAST_MONTHS) {
    throw createValidationError("Période trop longue : 20 ans au maximum");
  }
  const fmt = ({ year, month }) => `${year}-${String(month).padStart(2, "0")}`;
  return { startMonth: fmt(start), endMonth: fmt(end) };
}
