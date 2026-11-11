import { DateTime, IANAZone } from "luxon";

/**
 * Règles de la prise de rendez-vous partagées par les resolvers, les routes
 * publiques et le moteur de créneaux. Fonctions pures, sans accès à la base.
 */

export const DEFAULT_TIMEZONE = "Europe/Paris";
// Violet Newbi (boutons des e-mails, couleur de marque du site)
export const DEFAULT_ACCENT_COLOR = "#5b50ff";

// Lundi au vendredi, 9 h - 12 h et 14 h - 18 h
export const DEFAULT_AVAILABILITY = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  intervals: [
    { start: "09:00", end: "12:00" },
    { start: "14:00", end: "18:00" },
  ],
}));

export const LOCATION_KINDS = [
  "GOOGLE_MEET",
  "TEAMS",
  "CUSTOM_LINK",
  "PHONE",
  "IN_PERSON",
];
export const SLOT_INTERVALS = [5, 10, 15, 20, 30, 60];
export const DEFAULT_SLOT_INTERVAL = 30;
export const MAX_BUFFER_MINUTES = 240;
export const MAX_NOTICE_MINUTES = 60 * 24 * 60;
export const MAX_DAYS_AHEAD = 365;
export const MAX_PER_DAY = 100;
const MAX_INTERVALS_PER_DAY = 12;
const MAX_DATE_OVERRIDES = 400;

// 3 à 40 caractères : minuscules, chiffres, tirets (ni au début ni à la fin)
export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// Adresses de pages du site ou trompeuses (« gerer » sert à la gestion d'un
// rendez-vous : /rdv/gerer/<jeton>)
export const RESERVED_SLUGS = new Set([
  "admin",
  "administrateur",
  "api",
  "new",
  "nouveau",
  "gerer",
  "manage",
  "embed",
  "dashboard",
  "newbi",
  "sweily",
  "support",
  "aide",
  "help",
  "www",
  "app",
  "login",
  "connexion",
  "inscription",
  "signup",
  "rdv",
  "rendez-vous",
  "booking",
  "public",
  "static",
  "assets",
  "contact",
  "settings",
  "parametres",
  "compte",
  "account",
  "test",
]);

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Erreur de saisie : message affiché tel quel, champ concerné. */
export class AppointmentInputError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "AppointmentInputError";
    this.field = field;
  }
}

export function isValidTimezone(zone) {
  return (
    typeof zone === "string" && zone.length > 0 && IANAZone.isValidZone(zone)
  );
}

/** Jour « AAAA-MM-JJ » existant (pas de 31 février). */
export function isValidDay(day) {
  if (typeof day !== "string" || !DAY_PATTERN.test(day)) return false;
  return DateTime.fromISO(day, { zone: "UTC" }).isValid;
}

/** « HH:mm » ; « 24:00 » accepté comme fin de journée seulement. */
export function isValidTime(value, { allowEndOfDay = false } = {}) {
  if (typeof value !== "string") return false;
  if (allowEndOfDay && value === "24:00") return true;
  return TIME_PATTERN.test(value);
}

export function minutesOfTime(value) {
  if (value === "24:00") return 24 * 60;
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * Plages d'une journée : heures valides, début avant la fin, triées, sans
 * chevauchement (deux plages qui se touchent sont permises).
 * @returns {Array<{start, end}>} plages triées
 * @throws {AppointmentInputError}
 */
export function normalizeIntervals(intervals, field = "intervals") {
  if (!Array.isArray(intervals)) {
    throw new AppointmentInputError("Plages horaires invalides.", field);
  }
  if (intervals.length > MAX_INTERVALS_PER_DAY) {
    throw new AppointmentInputError(
      `${MAX_INTERVALS_PER_DAY} plages au plus par jour.`,
      field,
    );
  }
  const cleaned = intervals.map((interval) => {
    const start = String(interval?.start ?? "").trim();
    const end = String(interval?.end ?? "").trim();
    if (!isValidTime(start) || !isValidTime(end, { allowEndOfDay: true })) {
      throw new AppointmentInputError(
        "Les heures doivent être au format HH:mm.",
        field,
      );
    }
    if (minutesOfTime(start) >= minutesOfTime(end)) {
      throw new AppointmentInputError(
        "Chaque plage doit se terminer après son début.",
        field,
      );
    }
    return { start, end };
  });
  cleaned.sort((a, b) => minutesOfTime(a.start) - minutesOfTime(b.start));
  for (let i = 1; i < cleaned.length; i += 1) {
    if (minutesOfTime(cleaned[i].start) < minutesOfTime(cleaned[i - 1].end)) {
      throw new AppointmentInputError(
        "Les plages horaires d'une même journée ne doivent pas se chevaucher.",
        field,
      );
    }
  }
  return cleaned;
}

/** Semaine type : un jour ISO (1 = lundi … 7 = dimanche) au plus une fois. */
export function normalizeAvailability(days) {
  if (!Array.isArray(days)) {
    throw new AppointmentInputError(
      "Disponibilités invalides.",
      "availability",
    );
  }
  const seen = new Set();
  const result = days.map((day) => {
    const dayOfWeek = Number(day?.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      throw new AppointmentInputError(
        "Jour de la semaine invalide (1 = lundi, 7 = dimanche).",
        "availability",
      );
    }
    if (seen.has(dayOfWeek)) {
      throw new AppointmentInputError(
        "Chaque jour de la semaine ne peut apparaître qu'une fois.",
        "availability",
      );
    }
    seen.add(dayOfWeek);
    return {
      dayOfWeek,
      intervals: normalizeIntervals(day?.intervals, "availability"),
    };
  });
  return result.sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}

/** Exceptions par date : une par jour, liste vide = jour fermé. */
export function normalizeDateOverrides(overrides) {
  if (!Array.isArray(overrides)) {
    throw new AppointmentInputError("Exceptions invalides.", "dateOverrides");
  }
  if (overrides.length > MAX_DATE_OVERRIDES) {
    throw new AppointmentInputError(
      `${MAX_DATE_OVERRIDES} exceptions au plus.`,
      "dateOverrides",
    );
  }
  const seen = new Set();
  const result = overrides.map((override) => {
    const date = String(override?.date ?? "").trim();
    if (!isValidDay(date)) {
      throw new AppointmentInputError(
        "Date d'exception invalide (format AAAA-MM-JJ).",
        "dateOverrides",
      );
    }
    if (seen.has(date)) {
      throw new AppointmentInputError(
        "Une seule exception par date.",
        "dateOverrides",
      );
    }
    seen.add(date);
    return {
      date,
      intervals: normalizeIntervals(override?.intervals, "dateOverrides"),
    };
  });
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Adresse de page ou de type de rendez-vous.
 * @param {object} [options]
 * @param {boolean} [options.checkReserved] - refuser les adresses réservées
 *   (pages seulement : les types vivent sous l'adresse de leur page)
 */
export function normalizeSlug(
  value,
  { checkReserved = true, field = "slug" } = {},
) {
  const slug = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new AppointmentInputError(
      "L'adresse doit contenir de 3 à 40 caractères : lettres minuscules sans accent, chiffres et tirets (ni au début ni à la fin).",
      field,
    );
  }
  if (checkReserved && RESERVED_SLUGS.has(slug)) {
    throw new AppointmentInputError(
      "Cette adresse est réservée, choisissez-en une autre.",
      field,
    );
  }
  return slug;
}

/** Adresse proposée à partir d'un texte (« Rendez-vous de 30 min » → « rendez-vous-de-30-min »). */
export function slugify(text, fallback = "rendez-vous") {
  const slug = String(text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return SLUG_PATTERN.test(slug) ? slug : fallback;
}

export function normalizeHexColor(value, field = "accentColor") {
  const color = String(value ?? "").trim();
  if (!HEX_COLOR.test(color)) {
    throw new AppointmentInputError(
      "La couleur doit être au format hexadécimal (#5b50ff).",
      field,
    );
  }
  return color.toLowerCase();
}

/** Adresse https, sinon erreur. */
export function normalizeHttpsUrl(value, field, message) {
  const raw = String(value ?? "").trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppointmentInputError(message, field);
  }
  if (url.protocol !== "https:" || raw.length > 2048) {
    throw new AppointmentInputError(message, field);
  }
  return url.toString();
}

/** Texte libre facultatif : espaces retirés, longueur bornée, vide = null. */
export function optionalText(value, max, field, label) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) {
    throw new AppointmentInputError(
      `${label} ne doit pas dépasser ${max} caractères.`,
      field,
    );
  }
  return text;
}

export function boundedInteger(value, { min, max, field, label }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppointmentInputError(
      `${label} doit être un nombre entier entre ${min} et ${max}.`,
      field,
    );
  }
  return number;
}

/**
 * Lieu d'un type de rendez-vous. Les visioconférences exigent un agenda
 * connecté du bon fournisseur (lien créé avec le compte de l'organisateur).
 * @param {object} location - { kind, value }
 * @param {object} activeProviders - { google: bool, microsoft: bool }
 */
export function normalizeLocation(location, activeProviders = {}) {
  const kind = location?.kind;
  if (!LOCATION_KINDS.includes(kind)) {
    throw new AppointmentInputError(
      "Lieu du rendez-vous invalide.",
      "location",
    );
  }
  switch (kind) {
    case "GOOGLE_MEET":
      if (!activeProviders.google) {
        throw new AppointmentInputError(
          "Connectez un agenda Google dans le Calendrier pour proposer Google Meet.",
          "location",
        );
      }
      return { kind, value: null };
    case "TEAMS":
      if (!activeProviders.microsoft) {
        throw new AppointmentInputError(
          "Connectez un agenda Microsoft dans le Calendrier pour proposer Microsoft Teams.",
          "location",
        );
      }
      return { kind, value: null };
    case "CUSTOM_LINK":
      return {
        kind,
        value: normalizeHttpsUrl(
          location.value,
          "location",
          "Indiquez le lien de visioconférence (adresse en https://).",
        ),
      };
    case "IN_PERSON": {
      const address = optionalText(
        location.value,
        300,
        "location",
        "L'adresse",
      );
      if (!address) {
        throw new AppointmentInputError(
          "Indiquez l'adresse du rendez-vous.",
          "location",
        );
      }
      return { kind, value: address };
    }
    default:
      // PHONE : l'organisateur appelle l'invité (numéro demandé à la réservation)
      return {
        kind,
        value: optionalText(location.value, 300, "location", "La précision"),
      };
  }
}

/** Libellé du lieu affiché à l'invité. */
export function locationLabel(location) {
  switch (location?.kind) {
    case "GOOGLE_MEET":
      return "Google Meet";
    case "TEAMS":
      return "Microsoft Teams";
    case "CUSTOM_LINK":
      return "Visioconférence";
    case "PHONE":
      return "Appel téléphonique";
    case "IN_PERSON":
      return location.value || "En personne";
    default:
      return "";
  }
}

/** Le téléphone de l'invité est-il obligatoire pour ce type ? */
export function phoneRequired(type) {
  return Boolean(type?.requirePhone) || type?.location?.kind === "PHONE";
}

/** Fournisseur d'agenda nécessaire pour créer le lien de visioconférence. */
export function providerForLocation(kind) {
  if (kind === "GOOGLE_MEET") return "google";
  if (kind === "TEAMS") return "microsoft";
  return null;
}
