import sharp from "sharp";
import heicConvert from "heic-convert";
import {
  AppointmentInputError,
  EVENT_DEFAULT_MAX_PER_ORDER,
  EVENT_DETAILS_MAX,
  EVENT_LOCATION_KINDS,
  EVENT_MAX_CAPACITY,
  EVENT_MAX_DURATION_MINUTES,
  EVENT_MAX_PER_ORDER,
  EVENT_MAX_PRICE,
  EVENT_MIN_PRICE,
  normalizeLocation,
} from "./appointmentValidation.js";

/**
 * Billetterie : contrôle des champs d'un événement (type de rendez-vous
 * `kind: EVENT`) et de ses images.
 */

// ─── Images ───────────────────────────────────────────────────────────────

export const EVENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// Côté le plus long : bandeau large, image de l'événement plus petite
export const EVENT_IMAGE_MAX_SIDE = { COVER: 2000, IMAGE: 1200 };
const EVENT_IMAGE_URL_MAX_LENGTH = 500;

const ACCEPTED_MIMETYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
];

const isHeic = (filename = "", mimetype = "") =>
  ["image/heic", "image/heif"].includes(mimetype) ||
  /\.hei[cf]$/i.test(filename);

export const isAcceptedEventImage = (filename = "", mimetype = "") =>
  ACCEPTED_MIMETYPES.includes(mimetype) ||
  /\.(jpe?g|png|webp|hei[cf])$/i.test(filename);

/** Orientation appliquée, redimensionnée (jamais agrandie), en WebP. */
export async function processEventImage(buffer, { filename, mimetype, kind }) {
  let input = buffer;
  if (isHeic(filename, mimetype)) {
    input = Buffer.from(await heicConvert({ buffer, format: "PNG" }));
  }
  const side = EVENT_IMAGE_MAX_SIDE[kind] || EVENT_IMAGE_MAX_SIDE.IMAGE;
  return sharp(input)
    .rotate()
    .resize(side, side, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer();
}

/**
 * Image d'événement acceptée : https, rangée dans les images d'événements
 * de l'espace (`/{workspaceId}/events/…`), sur le domaine des images
 * d'entreprise configuré (COMPANY_IMAGE_URL) ou un domaine public R2.
 */
export function isWorkspaceEventImageUrl(url, workspaceId) {
  if (typeof url !== "string" || !url || !workspaceId) return false;
  if (url.length > EVENT_IMAGE_URL_MAX_LENGTH) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const match = parsed.pathname.match(/^\/([^/]+)\/events\/[^/]+$/);
  if (!match || match[1] !== String(workspaceId)) return false;
  const configured = process.env.COMPANY_IMAGE_URL;
  if (configured) {
    try {
      if (parsed.host === new URL(configured).host) return true;
    } catch {
      // URL configurée invalide : domaines R2 seulement
    }
  }
  return parsed.hostname.endsWith(".r2.dev");
}

// ─── Champs ───────────────────────────────────────────────────────────────

const has = (input, key) => input[key] !== undefined;

function parseDate(value, field, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (value === null || value === "" || Number.isNaN(date.getTime())) {
    throw new AppointmentInputError(`${label} est invalide.`, field);
  }
  return date;
}

function integerIn(value, { min, max, field, message }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new AppointmentInputError(message, field);
  }
  return number;
}

/**
 * Champs d'événement saisis, contrôlés un à un (sans les règles qui
 * croisent plusieurs champs : voir assertEventConsistency).
 */
export function eventChanges(input, { workspaceId }) {
  const changes = {};
  if (has(input, "startAt")) {
    changes.startAt = parseDate(input.startAt, "startAt", "La date de début");
  }
  if (has(input, "endAt")) {
    changes.endAt = parseDate(input.endAt, "endAt", "La date de fin");
  }
  if (has(input, "details")) {
    const details =
      input.details == null ? "" : String(input.details).replace(/\r\n/g, "\n");
    if (details.length > EVENT_DETAILS_MAX) {
      throw new AppointmentInputError(
        "Les détails ne peuvent pas dépasser 10 000 caractères.",
        "details",
      );
    }
    changes.details = details.trim() ? details.trim() : null;
  }
  for (const field of ["coverImageUrl", "imageUrl"]) {
    if (has(input, field)) {
      if (!input[field]) {
        changes[field] = null;
      } else if (!isWorkspaceEventImageUrl(input[field], workspaceId)) {
        throw new AppointmentInputError(
          "Image invalide : envoyez-la depuis le formulaire de l'événement.",
          field,
        );
      } else {
        changes[field] = input[field];
      }
    }
  }
  if (has(input, "capacity")) {
    changes.capacity =
      input.capacity === null
        ? null
        : integerIn(input.capacity, {
            min: 1,
            max: EVENT_MAX_CAPACITY,
            field: "capacity",
            message:
              "Le nombre de places doit être compris entre 1 et 100 000.",
          });
  }
  if (has(input, "maxPerOrder")) {
    changes.maxPerOrder =
      input.maxPerOrder === null
        ? EVENT_DEFAULT_MAX_PER_ORDER
        : integerIn(input.maxPerOrder, {
            min: 1,
            max: EVENT_MAX_PER_ORDER,
            field: "maxPerOrder",
            message:
              "Le nombre de places par inscription doit être compris entre 1 et 10.",
          });
  }
  if (has(input, "registrationClosesAt")) {
    changes.registrationClosesAt =
      input.registrationClosesAt === null || input.registrationClosesAt === ""
        ? null
        : parseDate(
            input.registrationClosesAt,
            "registrationClosesAt",
            "La date de clôture des inscriptions",
          );
  }
  if (has(input, "price")) {
    const price = input.price;
    if (price === null || !price.amount) {
      changes.priceAmount = null;
      changes.currency = null;
    } else {
      const currency = String(price.currency || "EUR").toUpperCase();
      if (currency !== "EUR") {
        throw new AppointmentInputError(
          "Seuls les prix en euros sont pris en charge.",
          "price",
        );
      }
      changes.priceAmount = integerIn(price.amount, {
        min: EVENT_MIN_PRICE,
        max: EVENT_MAX_PRICE,
        field: "price",
        message: "Le prix doit être compris entre 0,50 € et 10 000 €.",
      });
      changes.currency = currency;
    }
  }
  if (has(input, "location") && input.location !== null) {
    if (!EVENT_LOCATION_KINDS.includes(input.location?.kind)) {
      throw new AppointmentInputError(
        "Un événement a lieu à une adresse ou en ligne (lien https).",
        "location",
      );
    }
    changes.location = normalizeLocation(input.location);
  }
  return changes;
}

/**
 * Règles qui croisent plusieurs champs, sur l'événement complet (champs
 * enregistrés + modifications).
 */
export function assertEventConsistency(
  event,
  { isCreation, now = new Date() },
) {
  if (!event.startAt) {
    throw new AppointmentInputError("Indiquez la date de début.", "startAt");
  }
  if (!event.endAt) {
    throw new AppointmentInputError("Indiquez la date de fin.", "endAt");
  }
  const start = new Date(event.startAt).getTime();
  const end = new Date(event.endAt).getTime();
  if (end <= start) {
    throw new AppointmentInputError(
      "La fin doit suivre le début de l'événement.",
      "endAt",
    );
  }
  if ((end - start) / 60000 > EVENT_MAX_DURATION_MINUTES) {
    throw new AppointmentInputError(
      "Un événement dure 30 jours au plus.",
      "endAt",
    );
  }
  if (isCreation && start <= now.getTime()) {
    throw new AppointmentInputError(
      "La date de début doit être dans le futur.",
      "startAt",
    );
  }
  if (
    event.registrationClosesAt &&
    new Date(event.registrationClosesAt).getTime() > start
  ) {
    throw new AppointmentInputError(
      "La clôture des inscriptions doit précéder le début de l'événement.",
      "registrationClosesAt",
    );
  }
  if (!event.location || !EVENT_LOCATION_KINDS.includes(event.location.kind)) {
    throw new AppointmentInputError(
      "Un événement a lieu à une adresse ou en ligne (lien https).",
      "location",
    );
  }
}

/** Durée de l'événement en minutes (champ durationMinutes du type). */
export const eventDurationMinutes = (event) =>
  Math.max(
    5,
    Math.round(
      (new Date(event.endAt).getTime() - new Date(event.startAt).getTime()) /
        60000,
    ),
  );
