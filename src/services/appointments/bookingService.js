import crypto from "crypto";
import mongoose from "mongoose";
import AppointmentType from "../../models/AppointmentType.js";
import Booking, {
  MANAGE_TOKEN_PATTERN,
  decryptManageToken,
  encryptManageToken,
  generateManageToken,
  hashManageToken,
} from "../../models/Booking.js";
import BookingPage from "../../models/BookingPage.js";
import CalendarConnection from "../../models/CalendarConnection.js";
import Client from "../../models/Client.js";
import Event from "../../models/Event.js";
import { getCacheClient } from "../../config/redis.js";
import {
  checkSubscriptionActive,
  hasPermission,
} from "../../middlewares/rbac.js";
import { getActiveOrganization } from "../../middlewares/org-resolver.js";
import { getEffectiveLevelsFor } from "../organizationRoleService.js";
import { getCalendarProvider } from "../calendar/CalendarProviderFactory.js";
import { publishCalendarEventsChanged } from "../calendar/CalendarWebhookService.js";
import { getHostOccupation } from "./busyService.js";
import {
  buildGuestCancelledEmail,
  buildGuestConfirmationEmail,
  buildGuestRescheduledEmail,
  buildHostCancelledEmail,
  buildHostNewBookingEmail,
  buildHostRescheduledEmail,
  deliverBookingEmail,
  manageUrlFor,
  publicPageUrl,
} from "./bookingEmails.js";
import {
  addDays,
  computeAvailableSlots,
  dayBounds,
  localDayOf,
} from "../../utils/appointmentSlots.js";
import {
  DEFAULT_TIMEZONE,
  MAX_BUFFER_MINUTES,
  SLUG_PATTERN,
  isValidTimezone,
  locationLabel,
  providerForLocation,
} from "../../utils/appointmentValidation.js";
import { escapeRegex } from "../../utils/escapeRegex.js";
import { PHONE_REGEX } from "../../utils/validators.js";
import logger from "../../utils/logger.js";

/**
 * Prise de rendez-vous côté invité : page publique, créneaux, réservation,
 * déplacement et annulation (routes /api/public/booking), plus l'annulation
 * par l'organisateur (GraphQL).
 *
 * Réservation, dans l'ordre :
 *   1. client CRM bloqué : refus (« UNAVAILABLE ») ;
 *   2. verrou Redis par organisateur (sans Redis : l'index unique partiel
 *      des réservations reste le dernier rempart) ;
 *   3. créneaux du jour recalculés en direct : l'heure demandée doit y être ;
 *   4. réservation enregistrée (doublon d'index = créneau pris) ;
 *   5. client CRM rattaché (fiche existante jamais modifiée) ou créé ;
 *   6. événement Newbi APPOINTMENT (Calendrier, privé à l'organisateur) ;
 *   7. événement dans l'agenda connecté, avec lien Meet ou Teams ;
 *   8. e-mails à l'invité et à l'organisateur, après le lien de visio.
 * Les étapes 5 à 8 n'annulent jamais la réservation : erreurs journalisées.
 */

export class BookingError extends Error {
  /**
   * @param {string} code - NOT_FOUND, SLOT_TAKEN, UNAVAILABLE, NOT_ALLOWED
   * @param {number} status - statut HTTP de la route publique
   */
  constructor(code, status, message = code) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.status = status;
  }
}

const MINUTE = 60 * 1000;
const LOCK_TTL_MS = 15000;
const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 200;
const LOCK_COMMAND_TIMEOUT_MS = 2000;
const MAX_BUFFER_MS = MAX_BUFFER_MINUTES * MINUTE;
const PROVIDER_ORDER = ["google", "microsoft", "apple"];

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const sameId = (a, b) => a != null && b != null && String(a) === String(b);
const idForms = (id) => {
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s) ? [toObjectId(s), s] : [s];
};

const pageZone = (page) =>
  isValidTimezone(page?.timezone) ? page.timezone : DEFAULT_TIMEZONE;

// ─── Page publique ────────────────────────────────────────────────────────

/** Nom affiché d'un utilisateur (nom complet, sans répéter le nom de famille). */
export function displayName(user) {
  if (!user) return "";
  const full = String(user.name || "").trim();
  const last = String(user.lastName || "").trim();
  if (last && !full.toLowerCase().endsWith(last.toLowerCase())) {
    return `${full} ${last}`.trim();
  }
  return full || user.email || "";
}

async function loadHost(userId) {
  const user = await mongoose.connection.db
    .collection("user")
    .findOne(
      { _id: { $in: idForms(userId) } },
      { projection: { name: 1, lastName: 1, email: 1 } },
    );
  return user
    ? {
        id: String(user._id),
        name: displayName(user),
        email: user.email || null,
      }
    : null;
}

async function loadOrganization(workspaceId) {
  return mongoose.connection.db
    .collection("organization")
    .findOne(
      { _id: { $in: idForms(workspaceId) } },
      { projection: { name: 1, companyName: 1, logo: 1 } },
    );
}

const organizationNameOf = (organization) =>
  String(organization?.companyName || organization?.name || "").trim();

/**
 * La page peut-elle être publiée ? Abonnement actif (ou essai en cours) et
 * organisateur toujours membre, avec le droit de voir la prise de
 * rendez-vous. Sinon : même 404 que pour une page inconnue.
 */
async function pageIsPublishable(page) {
  try {
    await checkSubscriptionActive({ workspaceId: String(page.workspaceId) });
  } catch {
    return false;
  }
  const organization = await getActiveOrganization(
    String(page.userId),
    String(page.workspaceId),
  );
  if (!organization) return false;
  const levels = await getEffectiveLevelsFor(
    organization.id,
    organization.memberRole,
  );
  return hasPermission(organization.memberRole, "appointments", "view", levels);
}

/**
 * Page active et publiable, avec son organisation et son organisateur.
 * @returns {Promise<{ page, organization, host }|null>}
 */
export async function loadPublicPage(slug) {
  const clean = String(slug || "").toLowerCase();
  if (!SLUG_PATTERN.test(clean)) return null;
  const page = await BookingPage.findOne({
    slug: clean,
    isActive: true,
  }).lean();
  if (!page || !(await pageIsPublishable(page))) return null;
  const [organization, host] = await Promise.all([
    loadOrganization(page.workspaceId),
    loadHost(page.userId),
  ]);
  if (!host) return null;
  return { page, organization, host };
}

/** Type actif d'une page. */
export async function loadPublicType(page, typeSlug) {
  const clean = String(typeSlug || "").toLowerCase();
  if (!SLUG_PATTERN.test(clean)) return null;
  return AppointmentType.findOne({
    bookingPageId: page._id,
    slug: clean,
    isActive: true,
  }).lean();
}

const httpUrl = (value) =>
  typeof value === "string" && /^https?:\/\//i.test(value) ? value : null;

/** En-tête de page publique (même forme pour toutes les routes). */
export function publicPagePayload({ page, organization }) {
  return {
    slug: page.slug,
    title: page.title,
    description: page.description || null,
    accentColor: page.accentColor || null,
    avatarUrl: httpUrl(page.avatarUrl) || httpUrl(organization?.logo) || null,
    timezone: pageZone(page),
    organizationName: organizationNameOf(organization) || null,
  };
}

// ─── Créneaux ─────────────────────────────────────────────────────────────

/**
 * Créneaux libres d'un type entre deux jours locaux de la page (bornés par
 * aujourd'hui et l'horizon du type).
 */
export async function availableSlots({
  page,
  type,
  from,
  to,
  now = new Date(),
  useCache = true,
  excludeBooking = null,
}) {
  const zone = pageZone(page);
  const today = localDayOf(now, zone);
  const lastDay = addDays(today, Number(type.maxDaysAhead ?? 60));
  const first = from > today ? from : today;
  const last = to < lastDay ? to : lastDay;
  if (first > last) return [];

  const timeMin = new Date(
    dayBounds(first, zone).start.getTime() - MAX_BUFFER_MS,
  );
  const timeMax = new Date(dayBounds(last, zone).end.getTime() + MAX_BUFFER_MS);
  const { busy, bookings } = await getHostOccupation({
    page,
    hostUserId: page.userId,
    timeMin,
    timeMax,
    useCache,
    excludeBooking,
  });
  return computeAvailableSlots({
    page,
    type,
    busy,
    bookings,
    now,
    from: first,
    to: last,
  });
}

async function assertSlotAvailable({ page, type, start, now, excludeBooking }) {
  const day = localDayOf(start, pageZone(page));
  const slots = await availableSlots({
    page,
    type,
    from: day,
    to: day,
    now,
    useCache: false,
    excludeBooking,
  });
  if (!slots.some((slot) => slot.start.getTime() === start.getTime())) {
    throw new BookingError("SLOT_TAKEN", 409);
  }
}

// ─── Verrou par organisateur ──────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Verrou Redis `booking-lock:<organisateur>` (SET NX PX 15000). Attend
 * jusqu'à 5 s qu'une réservation en cours se termine. Sans Redis : null
 * (l'index unique partiel protège encore l'heure de début).
 */
async function acquireHostLock(hostUserId) {
  const client = getCacheClient();
  if (!client) return null;
  const key = `booking-lock:${hostUserId}`;
  const value = crypto.randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    while (Date.now() <= deadline) {
      // Redis injoignable : la commande attendrait sa reconnexion
      const ok = await Promise.race([
        client.set(key, value, "PX", LOCK_TTL_MS, "NX"),
        sleep(LOCK_COMMAND_TIMEOUT_MS).then(() => {
          throw new Error("Redis ne répond pas");
        }),
      ]);
      if (ok) return { client, key, value };
      await sleep(LOCK_RETRY_MS);
    }
  } catch (error) {
    logger.warn(`[rendez-vous] verrou Redis indisponible : ${error.message}`);
    return null;
  }
  throw new BookingError("SLOT_TAKEN", 409);
}

async function releaseHostLock(lock) {
  if (!lock) return;
  try {
    if ((await lock.client.get(lock.key)) === lock.value) {
      await lock.client.del(lock.key);
    }
  } catch (error) {
    logger.warn(
      `[rendez-vous] verrou non libéré (expire seul) : ${error.message}`,
    );
  }
}

// ─── Client CRM ───────────────────────────────────────────────────────────

/** Client de l'espace à cette adresse (insensible à la casse). */
async function findClientByEmail(workspaceId, email) {
  return Client.findOne({
    workspaceId,
    email: { $regex: `^${escapeRegex(email, 320)}$`, $options: "i" },
  })
    .select("_id isBlocked")
    .lean();
}

// Lettres, espaces, apostrophes et tirets : format exigé par la fiche client
const clientNamePart = (value) =>
  String(value || "")
    .replace(/[^a-zA-ZÀ-ÿ\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 50)
    .trim();

const validNamePart = (value) => /^[a-zA-ZÀ-ÿ\s'-]{2,50}$/.test(value);

/** Téléphone au format de la fiche client, sinon null (gardé sur la réservation). */
function clientPhone(phone) {
  const compact = String(phone || "").replace(/[\s.()-]/g, "");
  return PHONE_REGEX.test(compact) ? compact : null;
}

function activityEntry({ booking, hostId, hostName, type, description }) {
  return {
    id: new mongoose.Types.ObjectId().toString(),
    type,
    description,
    userId: hostId,
    userName: hostName,
    metadata: {
      eventTitle: `${booking.typeName} avec ${booking.guest.firstName} ${booking.guest.lastName}`,
      eventDate: new Date(booking.startAt).toISOString(),
    },
    createdAt: new Date(),
  };
}

/**
 * Client CRM de l'invité : fiche existante rattachée (seule une ligne
 * d'activité est ajoutée, comme pour un rappel du Calendrier), sinon
 * particulier créé avec ses prénom, nom, e-mail et téléphone.
 * @returns {Promise<ObjectId|null>}
 */
async function attachClient({ booking, page, host }) {
  const workspaceId = page.workspaceId;
  const hostName = host?.name || "Prise de rendez-vous";
  const description = `a pris rendez-vous (« ${booking.typeName} »)`;
  const existing = await findClientByEmail(workspaceId, booking.guest.email);
  if (existing) {
    await Client.updateOne(
      { _id: existing._id, workspaceId },
      {
        $push: {
          activity: activityEntry({
            booking,
            hostId: page.userId,
            hostName,
            type: "reminder_created",
            description,
          }),
        },
      },
      // Seule la chronologie change : la fiche garde sa date de modification
      { timestamps: false },
    );
    return existing._id;
  }

  const firstName = clientNamePart(booking.guest.firstName);
  const lastName = clientNamePart(booking.guest.lastName);
  const fullName = clientNamePart(`${firstName} ${lastName}`);
  const name = validNamePart(fullName)
    ? fullName
    : clientNamePart(booking.guest.email.split("@")[0]);
  if (!validNamePart(name)) {
    logger.warn(
      `[rendez-vous] client non créé pour la réservation ${booking._id} : nom inutilisable`,
    );
    return null;
  }
  try {
    const client = await Client.create({
      type: "INDIVIDUAL",
      name,
      firstName: validNamePart(firstName) ? firstName : undefined,
      lastName: validNamePart(lastName) ? lastName : undefined,
      email: booking.guest.email,
      phone: clientPhone(booking.guest.phone) || undefined,
      address: {},
      createdBy: page.userId,
      workspaceId,
      activity: [
        activityEntry({
          booking,
          hostId: page.userId,
          hostName,
          type: "created",
          description: `Client créé par la prise de rendez-vous (« ${booking.typeName} »)`,
        }),
      ],
    });
    return client._id;
  } catch (error) {
    // Créé entre-temps par une autre réservation de la même adresse
    if (error?.code === 11000) {
      const again = await findClientByEmail(workspaceId, booking.guest.email);
      return again?._id || null;
    }
    throw error;
  }
}

// ─── Agendas ──────────────────────────────────────────────────────────────

/**
 * Agenda où écrire le rendez-vous : celui choisi sur la page, sauf si le
 * lieu exige un autre fournisseur (Meet → Google, Teams → Microsoft) ;
 * à défaut, première connexion active, Google puis Microsoft puis Apple.
 */
export async function resolveWriteConnection(page, locationKind) {
  const connections = await CalendarConnection.find({
    userId: page.userId,
    status: "active",
  });
  const needed = providerForLocation(locationKind);
  const chosen = page.writeConnectionId
    ? connections.find((c) => sameId(c._id, page.writeConnectionId))
    : null;
  if (chosen && (!needed || chosen.provider === needed)) return chosen;
  if (needed) {
    const match = connections.find((c) => c.provider === needed);
    if (match) return match;
  }
  if (chosen) return chosen;
  for (const provider of PROVIDER_ORDER) {
    const connection = connections.find((c) => c.provider === provider);
    if (connection) return connection;
  }
  return null;
}

const PROVIDER_LABEL = {
  google: "Google",
  microsoft: "Microsoft",
  apple: "Apple",
};

/** Description de l'événement d'agenda (vue par l'organisateur). */
function eventDescription(booking) {
  const guest = booking.guest;
  const lines = [
    "Rendez-vous pris sur votre page Newbi.",
    `Invité : ${guest.firstName} ${guest.lastName}`,
    `E-mail : ${guest.email}`,
  ];
  if (guest.phone) lines.push(`Téléphone : ${guest.phone}`);
  if (booking.location?.kind === "IN_PERSON") {
    lines.push(`Adresse : ${booking.location.value}`);
  } else if (booking.location?.kind === "PHONE") {
    lines.push("Appel téléphonique : vous appelez votre invité.");
  }
  if (booking.meetingUrl) lines.push(`Lien : ${booking.meetingUrl}`);
  if (guest.message) lines.push("", "Message :", guest.message);
  return lines.join("\n");
}

const eventLocation = (booking) =>
  booking.meetingUrl ||
  (booking.location?.kind === "IN_PERSON"
    ? booking.location.value
    : locationLabel(booking.location));

/** Événement Newbi du rendez-vous (Calendrier de l'organisateur). */
async function createNewbiEvent(booking, clientId) {
  return Event.create({
    title: `${booking.typeName} avec ${booking.guest.firstName} ${booking.guest.lastName}`,
    description: eventDescription(booking),
    start: booking.startAt,
    end: booking.endAt,
    allDay: false,
    color: "violet",
    location: eventLocation(booking),
    type: "APPOINTMENT",
    source: "newbi",
    // Coordonnées de l'invité : visibles de l'organisateur seulement
    visibility: "private",
    clientId: clientId || undefined,
    bookingId: booking._id,
    workspaceId: booking.workspaceId,
    userId: booking.hostUserId,
  });
}

/**
 * Écrit le rendez-vous dans l'agenda connecté et crée le lien de
 * visioconférence. Jamais d'erreur : un échec renseigne `meetingWarning`
 * (lien attendu) et laisse la réservation valide.
 */
async function pushToCalendar({ booking, page, eventLike }) {
  const kind = booking.location?.kind;
  const needed = providerForLocation(kind);
  const result = {
    calendarConnectionId: null,
    externalEventId: null,
    meetingUrl: null,
    meetingWarning: null,
    provider: null,
  };
  const connection = await resolveWriteConnection(page, kind);
  if (!connection) {
    if (needed) {
      result.meetingWarning = `Aucun agenda ${PROVIDER_LABEL[needed]} connecté : le lien ${locationLabel(booking.location)} n'a pas pu être créé.`;
    }
    return result;
  }
  const conference = Boolean(needed) && connection.provider === needed;
  try {
    const provider = getCalendarProvider(connection.provider);
    const pushed = await provider.pushEventDetailed(connection, eventLike, {
      conference,
      attendees:
        connection.provider === "google"
          ? [
              {
                email: booking.guest.email,
                name: `${booking.guest.firstName} ${booking.guest.lastName}`,
              },
            ]
          : [],
    });
    result.calendarConnectionId = connection._id;
    result.externalEventId = pushed.externalEventId;
    result.provider = connection.provider;
    if (needed) {
      result.meetingUrl = conference ? pushed.meetingUrl || null : null;
      if (!result.meetingUrl) {
        result.meetingWarning = conference
          ? pushed.meetingError ||
            `Le lien ${locationLabel(booking.location)} n'a pas pu être créé.`
          : `Aucun agenda ${PROVIDER_LABEL[needed]} connecté : le lien ${locationLabel(booking.location)} n'a pas pu être créé.`;
      }
    }
  } catch (error) {
    logger.error(
      `[rendez-vous] écriture dans l'agenda ${connection.provider} impossible pour la réservation ${booking._id} : ${error.message}`,
    );
    if (needed) {
      result.meetingWarning = `Le rendez-vous n'a pas pu être ajouté à votre agenda ${PROVIDER_LABEL[connection.provider]} : le lien ${locationLabel(booking.location)} n'a pas été créé.`;
    }
  }
  return result;
}

async function connectionOf(booking) {
  if (!booking.calendarConnectionId || !booking.externalEventId) return null;
  const connection = await CalendarConnection.findById(
    booking.calendarConnectionId,
  );
  return connection && connection.status !== "disconnected" ? connection : null;
}

// ─── E-mails ──────────────────────────────────────────────────────────────

async function sendBoth(
  guestEmail,
  hostEmail,
  { booking, host, organization },
) {
  const organizationName = organizationNameOf(organization) || host.name;
  const results = await Promise.all([
    guestEmail
      ? deliverBookingEmail({
          to: booking.guest.email,
          replyTo: host.email || undefined,
          organizationName,
          ...guestEmail,
        })
      : false,
    hostEmail && host.email
      ? deliverBookingEmail({
          to: host.email,
          replyTo: booking.guest.email,
          organizationName,
          ...hostEmail,
        })
      : false,
  ]);
  return { guest: results[0], host: results[1] };
}

// ─── Réservation ──────────────────────────────────────────────────────────

/** Réservation renvoyée à l'invité (confirmation, page de gestion). */
export function guestBookingPayload(booking, { host }) {
  return {
    startAt: new Date(booking.startAt).toISOString(),
    endAt: new Date(booking.endAt).toISOString(),
    typeName: booking.typeName,
    locationKind: booking.location?.kind || null,
    locationLabel: locationLabel(booking.location),
    meetingUrl:
      booking.status === "CANCELLED" ? null : booking.meetingUrl || null,
    hostName: host?.name || null,
    timezone: booking.guest?.timezone || null,
  };
}

/**
 * Réserve un créneau.
 *
 * @param {object} params
 * @param {object} params.context - { page, organization, host } (loadPublicPage)
 * @param {object} params.type - type de rendez-vous actif
 * @param {Date} params.start
 * @param {object} params.guest - { firstName, lastName, email, phone, message }
 * @param {string} params.timezone - fuseau de l'invité
 * @param {Date} [params.now]
 * @returns {Promise<{ booking, token, emails: Promise }>}
 * @throws {BookingError} UNAVAILABLE, SLOT_TAKEN
 */
export async function createBooking({
  context,
  type,
  start,
  guest,
  timezone,
  now = new Date(),
}) {
  const { page, organization, host } = context;

  // 1. Client bloqué dans le CRM : refus, sans rien enregistrer
  const existingClient = await findClientByEmail(page.workspaceId, guest.email);
  if (existingClient?.isBlocked) {
    throw new BookingError("UNAVAILABLE", 403);
  }

  const startAt = new Date(start);
  const endAt = new Date(startAt.getTime() + type.durationMinutes * MINUTE);
  const token = generateManageToken();

  // 2 à 4. Verrou, créneau recalculé en direct, enregistrement
  let booking;
  const lock = await acquireHostLock(page.userId);
  try {
    await assertSlotAvailable({ page, type, start: startAt, now });
    try {
      booking = await Booking.create({
        workspaceId: page.workspaceId,
        bookingPageId: page._id,
        appointmentTypeId: type._id,
        hostUserId: page.userId,
        startAt,
        endAt,
        typeName: type.name,
        durationMinutes: type.durationMinutes,
        location: {
          kind: type.location.kind,
          value: type.location.value || null,
        },
        guest: {
          firstName: guest.firstName,
          lastName: guest.lastName,
          email: guest.email,
          phone: guest.phone || null,
          message: guest.message || null,
          timezone: isValidTimezone(timezone) ? timezone : pageZone(page),
        },
        status: "CONFIRMED",
        manageTokenHash: hashManageToken(token),
        manageTokenEncrypted: encryptManageToken(token),
        // Lien fourni par l'organisateur : connu dès la réservation
        meetingUrl:
          type.location.kind === "CUSTOM_LINK" ? type.location.value : null,
      });
    } catch (error) {
      if (error?.code === 11000) throw new BookingError("SLOT_TAKEN", 409);
      throw error;
    }
  } finally {
    await releaseHostLock(lock);
  }

  logger.info(
    `[rendez-vous] réservation ${booking._id} (organisateur ${page.userId}, ${startAt.toISOString()})`,
  );

  // 5. Client CRM
  let clientId = null;
  try {
    clientId = await attachClient({ booking, page, host });
  } catch (error) {
    logger.error(
      `[rendez-vous] client CRM non rattaché à la réservation ${booking._id} : ${error.message}`,
    );
  }

  // 6. Événement Newbi
  let event = null;
  try {
    event = await createNewbiEvent(booking, clientId);
  } catch (error) {
    logger.error(
      `[rendez-vous] événement du Calendrier non créé pour la réservation ${booking._id} : ${error.message}`,
    );
  }

  // 7. Agenda connecté et lien de visioconférence
  const pushed = await pushToCalendar({
    booking,
    page,
    eventLike: event || {
      _id: booking._id,
      title: `${booking.typeName} avec ${booking.guest.firstName} ${booking.guest.lastName}`,
      description: eventDescription(booking),
      start: booking.startAt,
      end: booking.endAt,
      allDay: false,
      location: eventLocation(booking),
    },
  });

  const updates = {
    clientId,
    eventId: event?._id || null,
    calendarConnectionId: pushed.calendarConnectionId,
    externalEventId: pushed.externalEventId,
    meetingWarning: pushed.meetingWarning,
  };
  if (pushed.meetingUrl) updates.meetingUrl = pushed.meetingUrl;
  booking = await Booking.findByIdAndUpdate(
    booking._id,
    { $set: updates },
    { new: true },
  );

  if (event) {
    try {
      // Mêmes liens externes que pushEventToCalendar : la synchronisation
      // reconnaît l'événement et ne le réimporte pas
      if (pushed.externalEventId) {
        event.externalCalendarLinks = [
          {
            provider: pushed.provider,
            externalEventId: pushed.externalEventId,
            calendarConnectionId: pushed.calendarConnectionId,
          },
        ];
      }
      event.location = eventLocation(booking);
      event.description = eventDescription(booking);
      await event.save();
    } catch (error) {
      logger.error(
        `[rendez-vous] événement ${event._id} non complété : ${error.message}`,
      );
    }
    publishCalendarEventsChanged(String(page.userId));
  }

  // 8. E-mails, après le lien de visioconférence
  const organizationName = organizationNameOf(organization) || host.name;
  const emails = sendBoth(
    buildGuestConfirmationEmail({
      booking,
      host,
      organizationName,
      manageUrl: manageUrlFor(token),
    }),
    buildHostNewBookingEmail({
      booking,
      host,
      organizationName,
      pageTimezone: pageZone(page),
    }),
    { booking, host, organization },
  ).catch((error) => {
    logger.error(`[rendez-vous] e-mails de confirmation : ${error.message}`);
    return null;
  });

  return { booking, token, emails };
}

// ─── Gestion par l'invité ─────────────────────────────────────────────────

/** Réservation d'un jeton de gestion, ou null. */
export async function findBookingByToken(token) {
  if (typeof token !== "string" || !MANAGE_TOKEN_PATTERN.test(token))
    return null;
  return Booking.findOne({ manageTokenHash: hashManageToken(token) });
}

/** Jeton de gestion en clair (rappels), ou null si illisible. */
export const manageTokenOf = (booking) =>
  booking?.manageTokenEncrypted
    ? decryptManageToken(booking.manageTokenEncrypted)
    : null;

/**
 * Contexte d'une réservation pour sa page de gestion : page, type (si
 * encore actif), organisation, organisateur, droits de l'invité.
 */
export async function loadManageContext(booking, now = new Date()) {
  const [page, type, organization, host] = await Promise.all([
    BookingPage.findById(booking.bookingPageId).lean(),
    booking.appointmentTypeId
      ? AppointmentType.findById(booking.appointmentTypeId).lean()
      : null,
    loadOrganization(booking.workspaceId),
    loadHost(booking.hostUserId),
  ]);
  const upcoming =
    booking.status === "CONFIRMED" && new Date(booking.startAt) > now;
  const canReschedule =
    upcoming &&
    Boolean(page?.isActive) &&
    Boolean(type?.isActive) &&
    sameId(type?.bookingPageId, page?._id) &&
    (await pageIsPublishable(page));
  return {
    page,
    type: type?.isActive ? type : null,
    organization,
    host: host || { name: "", email: null },
    canCancel: upcoming,
    canReschedule,
  };
}

/** Réponse de la page de gestion (GET /manage/:token). */
export function managePayload(booking, context) {
  const { page, type, host, canCancel, canReschedule } = context;
  return {
    status: booking.status,
    ...guestBookingPayload(booking, { host }),
    page: page
      ? {
          slug: page.slug,
          title: page.title,
          accentColor: page.accentColor || null,
          timezone: pageZone(page),
        }
      : null,
    typeSlug: type?.slug || null,
    canCancel,
    canReschedule,
    cancelledAt: booking.cancelledAt
      ? new Date(booking.cancelledAt).toISOString()
      : null,
  };
}

/**
 * Déplace un rendez-vous (invité, avec son jeton) : mêmes contrôles qu'une
 * réservation, la réservation elle-même exclue de l'occupation. Rappels
 * remis à zéro, événements Newbi et externe déplacés, e-mails aux deux.
 */
export async function rescheduleBooking({
  booking,
  token,
  start,
  now = new Date(),
}) {
  const context = await loadManageContext(booking, now);
  if (!context.canReschedule) throw new BookingError("NOT_ALLOWED", 409);
  const { page, organization, host } = context;
  // Durée réservée conservée, règles du type actuel pour le reste
  const type = { ...context.type, durationMinutes: booking.durationMinutes };
  const startAt = new Date(start);
  const previousStartAt = new Date(booking.startAt);
  if (startAt.getTime() === previousStartAt.getTime()) {
    return { booking, emails: Promise.resolve(null) };
  }
  const endAt = new Date(startAt.getTime() + booking.durationMinutes * MINUTE);

  let updated;
  const lock = await acquireHostLock(page.userId);
  try {
    await assertSlotAvailable({
      page,
      type,
      start: startAt,
      now,
      excludeBooking: booking,
    });
    try {
      updated = await Booking.findOneAndUpdate(
        { _id: booking._id, status: "CONFIRMED", startAt: previousStartAt },
        {
          $set: {
            startAt,
            endAt,
            "reminders.h24SentAt": null,
            "reminders.h1SentAt": null,
          },
          $push: {
            rescheduleHistory: {
              fromStartAt: previousStartAt,
              toStartAt: startAt,
              at: now,
              by: "GUEST",
            },
          },
        },
        { new: true },
      );
    } catch (error) {
      if (error?.code === 11000) throw new BookingError("SLOT_TAKEN", 409);
      throw error;
    }
  } finally {
    await releaseHostLock(lock);
  }
  if (!updated) throw new BookingError("NOT_ALLOWED", 409);

  // Événement Newbi puis agenda connecté (dates seules : le lien est gardé)
  let event = null;
  if (updated.eventId) {
    event = await Event.findByIdAndUpdate(
      updated.eventId,
      { $set: { start: startAt, end: endAt } },
      { new: true },
    ).catch((error) => {
      logger.error(
        `[rendez-vous] événement ${updated.eventId} non déplacé : ${error.message}`,
      );
      return null;
    });
  }
  const connection = await connectionOf(updated);
  if (connection) {
    try {
      await getCalendarProvider(connection.provider).rescheduleEvent(
        connection,
        updated.externalEventId,
        event || {
          _id: updated._id,
          title: `${updated.typeName} avec ${updated.guest.firstName} ${updated.guest.lastName}`,
          description: eventDescription(updated),
          start: startAt,
          end: endAt,
          allDay: false,
          location: eventLocation(updated),
        },
      );
    } catch (error) {
      logger.error(
        `[rendez-vous] agenda ${connection.provider} non mis à jour pour la réservation ${updated._id} : ${error.message}`,
      );
    }
  }
  publishCalendarEventsChanged(String(updated.hostUserId));

  const organizationName = organizationNameOf(organization) || host.name;
  const manageToken = token || manageTokenOf(updated);
  const emails = sendBoth(
    buildGuestRescheduledEmail({
      booking: updated,
      host,
      organizationName,
      manageUrl: manageToken
        ? manageUrlFor(manageToken)
        : publicPageUrl(page.slug),
    }),
    buildHostRescheduledEmail({
      booking: updated,
      previousStartAt,
      pageTimezone: pageZone(page),
    }),
    { booking: updated, host, organization },
  ).catch((error) => {
    logger.error(`[rendez-vous] e-mails de déplacement : ${error.message}`);
    return null;
  });

  return { booking: updated, emails };
}

/**
 * Annule un rendez-vous confirmé (invité ou organisateur) : événement
 * externe et événement Newbi supprimés, e-mail à l'autre partie (.ics
 * METHOD:CANCEL pour l'invité quand l'organisateur annule).
 *
 * @param {object} params
 * @param {object} params.booking
 * @param {"GUEST"|"HOST"} params.by
 * @param {string} [params.reason]
 * @returns {Promise<{ booking, emails: Promise }>}
 */
export async function cancelBooking({
  booking,
  by,
  reason = null,
  now = new Date(),
}) {
  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id, status: "CONFIRMED" },
    {
      $set: {
        status: "CANCELLED",
        cancelledBy: by,
        cancelReason: reason || null,
        cancelledAt: now,
      },
    },
    { new: true },
  );
  // Déjà annulé (double clic, deux onglets) : rien de plus à faire
  if (!updated) {
    return {
      booking: await Booking.findById(booking._id),
      emails: Promise.resolve(null),
    };
  }

  const connection = await connectionOf(updated);
  if (connection) {
    try {
      await getCalendarProvider(connection.provider).deleteEvent(
        connection,
        updated.externalEventId,
      );
    } catch (error) {
      logger.error(
        `[rendez-vous] événement ${connection.provider} non supprimé pour la réservation ${updated._id} : ${error.message}`,
      );
    }
  }
  if (updated.eventId) {
    await Event.deleteOne({ _id: updated.eventId }).catch((error) =>
      logger.error(
        `[rendez-vous] événement ${updated.eventId} non supprimé : ${error.message}`,
      ),
    );
  }
  publishCalendarEventsChanged(String(updated.hostUserId));

  const [page, organization, host] = await Promise.all([
    BookingPage.findById(updated.bookingPageId).lean(),
    loadOrganization(updated.workspaceId),
    loadHost(updated.hostUserId),
  ]);
  const hostInfo = host || { name: "", email: null };
  const organizationName = organizationNameOf(organization) || hostInfo.name;
  let typeSlug = null;
  if (updated.appointmentTypeId) {
    const type = await AppointmentType.findById(updated.appointmentTypeId)
      .select("slug isActive")
      .lean();
    typeSlug = type?.isActive ? type.slug : null;
  }

  const emails = (
    by === "GUEST"
      ? sendBoth(
          null,
          buildHostCancelledEmail({
            booking: updated,
            pageTimezone: pageZone(page),
          }),
          {
            booking: updated,
            host: hostInfo,
            organization,
          },
        )
      : sendBoth(
          buildGuestCancelledEmail({
            booking: updated,
            host: hostInfo,
            organizationName,
            rebookUrl: page
              ? publicPageUrl(page.slug, typeSlug)
              : publicPageUrl(""),
          }),
          null,
          { booking: updated, host: hostInfo, organization },
        )
  ).catch((error) => {
    logger.error(`[rendez-vous] e-mail d'annulation : ${error.message}`);
    return null;
  });

  return { booking: updated, emails };
}

/** Organisation et organisateur d'une réservation (rappels, .ics). */
export async function loadBookingParties(booking) {
  const [organization, host] = await Promise.all([
    loadOrganization(booking.workspaceId),
    loadHost(booking.hostUserId),
  ]);
  return {
    organization,
    organizationName: organizationNameOf(organization) || host?.name || "",
    host: host || { name: "", email: null },
  };
}
