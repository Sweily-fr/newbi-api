/**
 * Resolvers de la prise de rendez-vous (Communication > Prise de
 * rendez-vous) côté tableau de bord.
 *
 * Périmètre : une page de réservation appartient à un utilisateur dans un
 * espace (userId + workspaceId), comme une signature de mail ; ses types et
 * ses réservations aussi. Un membre ne voit et ne modifie que les siens.
 * Les routes publiques (invités) sont dans routes/publicBooking.js.
 */
import mongoose from "mongoose";
import AppointmentType from "../models/AppointmentType.js";
import Booking from "../models/Booking.js";
import BookingPage from "../models/BookingPage.js";
import CalendarConnection from "../models/CalendarConnection.js";
import {
  assertPermissionAction,
  checkSubscriptionActive,
  requireWorkspaceAction,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES, createNotFoundError } from "../utils/errors.js";
import {
  AppointmentInputError,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_SLOT_INTERVAL,
  MAX_BUFFER_MINUTES,
  MAX_DAYS_AHEAD,
  MAX_NOTICE_MINUTES,
  MAX_PER_DAY,
  SLOT_INTERVALS,
  boundedInteger,
  isValidTimezone,
  normalizeAvailability,
  normalizeDateOverrides,
  normalizeHexColor,
  normalizeHttpsUrl,
  normalizeLocation,
  normalizeSlug,
  optionalText,
  PAYMENT_METHOD_CHOICE_MESSAGE,
  PAYMENT_METHOD_REQUIRED_MESSAGE,
  appointmentPaymentModeOf,
  slotDepositAmountOf,
  slotPaymentModeOf,
  slugify,
} from "../utils/appointmentValidation.js";
import { cancelBooking } from "../services/appointments/bookingService.js";
import {
  markBookingPaidByHost,
  markBookingPaidOnSite,
} from "../services/appointments/bookingPaymentService.js";
import EventRegistration from "../models/EventRegistration.js";
import {
  APPOINTMENT_PAYMENT_METHODS,
  appointmentPaymentMethods,
  chosenPaymentMethodsOf,
  eventPaymentMethods,
  notifyEventChanged,
  refreshRegistrationSnapshots,
  seatsLeftOf,
  syncEventCalendarEntry,
} from "../services/appointments/eventRegistrationService.js";
import {
  assertEventConsistency,
  assertEventPayment,
  eventDepositAmountOf,
  eventPaymentModeOf,
  eventChanges,
  eventDurationMinutes,
} from "../utils/eventValidation.js";
import { publicPageUrl } from "../services/appointments/bookingEmails.js";
import { isObjectIdString } from "../utils/objectIdString.js";
import logger from "../utils/logger.js";

const DEFAULT_TYPE = {
  slug: "rendez-vous-30-min",
  name: "Rendez-vous de 30 min",
  durationMinutes: 30,
};
const BOOKINGS_DEFAULT_LIMIT = 50;
const BOOKINGS_MAX_LIMIT = 200;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const userIdOf = (ctx) => String(ctx.user?._id || ctx.user?.id);

/** Page, types : ceux de l'utilisateur dans l'espace actif. */
const ownerScope = (ctx) => ({
  workspaceId: toObjectId(ctx.workspaceId),
  userId: toObjectId(userIdOf(ctx)),
});

/** Réservations : celles dont l'utilisateur est l'organisateur. */
const hostScope = (ctx) => ({
  workspaceId: toObjectId(ctx.workspaceId),
  hostUserId: toObjectId(userIdOf(ctx)),
});

function inputError(error) {
  if (error instanceof AppointmentInputError) {
    return new AppError(error.message, ERROR_CODES.VALIDATION_ERROR, {
      field: error.field,
    });
  }
  return error;
}

const slugTakenError = () =>
  new AppError(
    "Cette adresse est déjà prise, choisissez-en une autre.",
    ERROR_CODES.ALREADY_EXISTS,
    { field: "slug" },
  );

/** Fournisseurs d'agenda connectés et actifs de l'utilisateur. */
async function activeProvidersOf(userId) {
  const providers = await CalendarConnection.distinct("provider", {
    userId: toObjectId(userId),
    status: "active",
  });
  return {
    google: providers.includes("google"),
    microsoft: providers.includes("microsoft"),
    apple: providers.includes("apple"),
  };
}

/** Connexion d'agenda de l'utilisateur (sinon erreur de saisie). */
async function ownConnectionIds(userId, ids, field) {
  const unique = [...new Set(ids.map(String))];
  if (unique.some((id) => !isObjectIdString(id))) {
    throw new AppointmentInputError("Agenda inconnu.", field);
  }
  if (unique.length === 0) return [];
  const found = await CalendarConnection.find({
    _id: { $in: unique.map(toObjectId) },
    userId: toObjectId(userId),
    status: { $ne: "disconnected" },
  }).select("_id");
  if (found.length !== unique.length) {
    throw new AppointmentInputError("Agenda inconnu.", field);
  }
  return unique.map(toObjectId);
}

const has = (input, key) => input[key] !== undefined;

/** Champs de page à enregistrer, contrôlés. */
async function pageChanges(input, userId) {
  const changes = {};
  if (has(input, "slug") && input.slug !== null && input.slug !== "") {
    changes.slug = normalizeSlug(input.slug);
  }
  if (has(input, "title") && input.title !== null) {
    const title = String(input.title).trim();
    if (!title || title.length > 120) {
      throw new AppointmentInputError(
        "Le titre doit contenir de 1 à 120 caractères.",
        "title",
      );
    }
    changes.title = title;
  }
  if (has(input, "description")) {
    changes.description = optionalText(
      input.description,
      1000,
      "description",
      "La description",
    );
  }
  if (has(input, "accentColor")) {
    changes.accentColor = input.accentColor
      ? normalizeHexColor(input.accentColor)
      : DEFAULT_ACCENT_COLOR;
  }
  if (has(input, "avatarUrl")) {
    changes.avatarUrl = input.avatarUrl
      ? normalizeHttpsUrl(
          input.avatarUrl,
          "avatarUrl",
          "L'image doit être une adresse en https://.",
        )
      : null;
  }
  if (has(input, "timezone") && input.timezone !== null) {
    if (!isValidTimezone(input.timezone)) {
      throw new AppointmentInputError("Fuseau horaire inconnu.", "timezone");
    }
    changes.timezone = input.timezone;
  }
  if (has(input, "isActive") && input.isActive !== null) {
    changes.isActive = Boolean(input.isActive);
  }
  if (has(input, "availability") && input.availability !== null) {
    changes.availability = normalizeAvailability(input.availability);
  }
  if (has(input, "dateOverrides") && input.dateOverrides !== null) {
    changes.dateOverrides = normalizeDateOverrides(input.dateOverrides);
  }
  if (has(input, "writeConnectionId")) {
    changes.writeConnectionId = input.writeConnectionId
      ? (
          await ownConnectionIds(
            userId,
            [input.writeConnectionId],
            "writeConnectionId",
          )
        )[0]
      : null;
  }
  if (has(input, "busyConnectionIds") && input.busyConnectionIds !== null) {
    changes.busyConnectionIds = await ownConnectionIds(
      userId,
      input.busyConnectionIds,
      "busyConnectionIds",
    );
  }
  return changes;
}

/** Champs de type de rendez-vous à enregistrer, contrôlés. */
async function typeChanges(input, userId, { event = false } = {}) {
  const changes = {};
  if (has(input, "name") && input.name !== null) {
    const name = String(input.name).trim();
    if (!name || name.length > 120) {
      throw new AppointmentInputError(
        "Le nom doit contenir de 1 à 120 caractères.",
        "name",
      );
    }
    changes.name = name;
  }
  if (has(input, "slug") && input.slug !== null && input.slug !== "") {
    changes.slug = normalizeSlug(input.slug, { checkReserved: false });
  }
  if (has(input, "description")) {
    changes.description = optionalText(
      input.description,
      1000,
      "description",
      "La description",
    );
  }
  const integer = (key, options) => {
    if (event && key !== "position") return;
    if (has(input, key) && input[key] !== null) {
      changes[key] = boundedInteger(input[key], { field: key, ...options });
    }
  };
  integer("durationMinutes", { min: 5, max: 480, label: "La durée" });
  integer("bufferBeforeMinutes", {
    min: 0,
    max: MAX_BUFFER_MINUTES,
    label: "La marge avant",
  });
  integer("bufferAfterMinutes", {
    min: 0,
    max: MAX_BUFFER_MINUTES,
    label: "La marge après",
  });
  integer("minNoticeMinutes", {
    min: 0,
    max: MAX_NOTICE_MINUTES,
    label: "Le préavis",
  });
  integer("maxDaysAhead", { min: 1, max: MAX_DAYS_AHEAD, label: "L'horizon" });
  integer("position", { min: 0, max: 1000, label: "La position" });
  if (
    !event &&
    has(input, "slotIntervalMinutes") &&
    input.slotIntervalMinutes !== null
  ) {
    if (!SLOT_INTERVALS.includes(Number(input.slotIntervalMinutes))) {
      throw new AppointmentInputError(
        `L'intervalle entre créneaux doit valoir ${SLOT_INTERVALS.join(", ")} minutes.`,
        "slotIntervalMinutes",
      );
    }
    changes.slotIntervalMinutes = Number(input.slotIntervalMinutes);
  }
  if (!event && has(input, "maxPerDay")) {
    changes.maxPerDay =
      input.maxPerDay === null
        ? null
        : boundedInteger(input.maxPerDay, {
            min: 1,
            max: MAX_PER_DAY,
            field: "maxPerDay",
            label: "Le nombre de rendez-vous par jour",
          });
  }
  if (has(input, "color")) {
    const color = input.color ? String(input.color).trim() : "";
    if (color && !/^[#a-zA-Z0-9-]{1,30}$/.test(color)) {
      throw new AppointmentInputError("Couleur invalide.", "color");
    }
    changes.color = color || null;
  }
  if (has(input, "isActive") && input.isActive !== null) {
    changes.isActive = Boolean(input.isActive);
  }
  if (has(input, "requirePhone") && input.requirePhone !== null) {
    changes.requirePhone = Boolean(input.requirePhone);
  }
  if (!event && has(input, "location") && input.location !== null) {
    changes.location = normalizeLocation(
      input.location,
      await activeProvidersOf(userId),
    );
  }
  return changes;
}

const kindOf = (type) => (type?.kind === "EVENT" ? "EVENT" : "SLOT");

const sameInstant = (a, b) =>
  (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null);

/** Ce qui a changé dans un événement : nom, début, horaires, lieu. */
function eventDiff(before, after) {
  const start = !sameInstant(before.startAt, after.startAt);
  return {
    name: before.name !== after.name,
    start,
    schedule: start || !sameInstant(before.endAt, after.endAt),
    location:
      before.location.kind !== after.location?.kind ||
      before.location.value !== (after.location?.value || null),
  };
}

/**
 * Champs d'un événement : ceux d'un type (nom, description…) et les siens,
 * contrôlés ensemble. `existing` : l'événement enregistré (modification).
 */
async function eventTypeChanges(input, ctx, existing = null) {
  const changes = {
    ...(await typeChanges(input, userIdOf(ctx), { event: true })),
    ...eventChanges(input, { workspaceId: ctx.workspaceId }),
  };
  const merged = {
    ...(existing
      ? typeof existing.toObject === "function"
        ? existing.toObject()
        : existing
      : {}),
    ...changes,
  };
  assertEventConsistency(merged, { isCreation: !existing });
  if (has(changes, "startAt") || has(changes, "endAt") || !existing) {
    changes.durationMinutes = eventDurationMinutes(merged);
  }
  // Mode de paiement et acompte : écrits seulement s'ils changent vraiment
  // (un type existant ne gagne aucun champ sans modification réelle)
  if (has(changes, "paymentMode")) {
    if (
      existing &&
      changes.paymentMode === (existing.paymentMode || "ONLINE")
    ) {
      delete changes.paymentMode;
    }
  }
  if (has(changes, "depositAmount")) {
    const next = changes.depositAmount ?? null;
    if (existing && next === (existing.depositAmount ?? null)) {
      delete changes.depositAmount;
    } else if (next === null) {
      // Retiré : champ effacé (jamais un null écrit)
      changes.depositAmount = undefined;
    }
  }
  const final = {
    ...(existing
      ? typeof existing.toObject === "function"
        ? existing.toObject()
        : existing
      : {}),
    ...changes,
  };
  assertEventPayment(final);
  // Paiement en ligne (tout ou acompte) : un moyen de paiement en ligne
  // doit être prêt, contrôlé seulement à la création ou quand le prix, le
  // mode ou l'acompte change réellement (un moyen déconnecté ne bloque pas
  // la modification du reste de l'événement). Sur place : aucun moyen exigé
  const mode = eventPaymentModeOf(final);
  const paymentChanged =
    !existing ||
    (has(changes, "priceAmount") &&
      (changes.priceAmount || null) !== (existing.priceAmount || null)) ||
    mode !== eventPaymentModeOf(existing) ||
    eventDepositAmountOf(final) !== eventDepositAmountOf(existing);
  if (
    mode &&
    mode !== "ON_SITE" &&
    paymentChanged &&
    (await eventPaymentMethods(ctx.workspaceId)).length === 0
  ) {
    throw new AppointmentInputError(PAYMENT_METHOD_REQUIRED_MESSAGE, "price");
  }
  return changes;
}

/**
 * Paiement d'un créneau : prix, mode et acompte, contrôlés comme ceux d'un
 * événement. Rien n'est renvoyé (donc rien n'est écrit) si la saisie ne
 * change pas le paiement effectif du créneau.
 * Prix > 0 sans mode : ONLINE ; prix nul : gratuit (mode et acompte retirés).
 */
async function slotPaymentChanges(input, ctx, existing = null) {
  if (
    !has(input, "price") &&
    !has(input, "paymentMode") &&
    !has(input, "depositAmount")
  ) {
    return {};
  }
  const parsed = eventChanges(
    Object.fromEntries(
      ["price", "paymentMode", "depositAmount"]
        .filter((key) => has(input, key))
        .map((key) => [key, input[key]]),
    ),
    { workspaceId: ctx.workspaceId },
  );
  // Paiement effectif actuel (un prix sans mode enregistré = gratuit)
  const currentMode = slotPaymentModeOf(existing);
  const currentPrice = currentMode ? existing.priceAmount : null;
  const currentDeposit = slotDepositAmountOf(existing);

  const price = has(parsed, "priceAmount")
    ? parsed.priceAmount || null
    : currentPrice;
  if (!price) {
    // Gratuit : champs retirés s'ils existent, sinon rien d'écrit
    const stored =
      existing &&
      ["priceAmount", "currency", "paymentMode", "depositAmount"].some(
        (key) => existing[key] != null,
      );
    return stored
      ? {
          priceAmount: undefined,
          currency: undefined,
          paymentMode: undefined,
          depositAmount: undefined,
        }
      : {};
  }
  const mode =
    (has(parsed, "paymentMode") ? parsed.paymentMode : currentMode) || "ONLINE";
  let deposit = has(parsed, "depositAmount")
    ? (parsed.depositAmount ?? null)
    : (existing?.depositAmount ?? null);
  if (mode !== "DEPOSIT") deposit = null;
  assertEventPayment({
    priceAmount: price,
    paymentMode: mode,
    depositAmount: deposit,
  });
  if (
    existing &&
    price === currentPrice &&
    mode === currentMode &&
    deposit === currentDeposit
  ) {
    return {};
  }
  if (
    mode !== "ON_SITE" &&
    (await eventPaymentMethods(ctx.workspaceId)).length === 0
  ) {
    throw new AppointmentInputError(PAYMENT_METHOD_REQUIRED_MESSAGE, "price");
  }
  return {
    priceAmount: price,
    currency: "EUR",
    paymentMode: mode,
    // Hors acompte : champ retiré s'il existait, jamais un null écrit
    depositAmount: deposit ?? undefined,
  };
}

/**
 * Moyens proposés d'un type payant (comme les transferts), écrits seulement
 * s'ils changent vraiment : un type existant sans choix garde « tous les
 * moyens disponibles ». Type payant en ligne ou en acompte : au moins un
 * moyen choisi ET prêt, contrôlé à la création, quand le paiement change ou
 * quand le choix change. `changes` : changements déjà calculés du type.
 */
async function paymentMethodsChanges(input, ctx, existing, changes) {
  const plain = existing
    ? typeof existing.toObject === "function"
      ? existing.toObject()
      : existing
    : {};
  const final = { ...plain, ...changes };
  const mode = appointmentPaymentModeOf({
    ...final,
    kind: final.kind || plain.kind,
  });
  const out = {};
  if (has(input, "paymentMethods") && mode) {
    const raw = input.paymentMethods;
    if (
      raw !== null &&
      (!Array.isArray(raw) ||
        raw.some((method) => !APPOINTMENT_PAYMENT_METHODS.includes(method)))
    ) {
      throw new AppointmentInputError(
        "Moyen de paiement inconnu.",
        "paymentMethods",
      );
    }
    const next =
      raw === null
        ? null
        : APPOINTMENT_PAYMENT_METHODS.filter((method) => raw.includes(method));
    const current = chosenPaymentMethodsOf(plain);
    const same =
      next === current ||
      (next &&
        current &&
        next.length === current.length &&
        next.every((method, i) => method === current[i]));
    // Retiré : champ effacé (jamais un null écrit)
    if (!same) out.paymentMethods = next === null ? undefined : next;
  }
  if (!mode || mode === "ON_SITE") return out;
  const paymentChanged =
    !existing ||
    has(out, "paymentMethods") ||
    ["priceAmount", "paymentMode", "depositAmount"].some(
      (key) => has(changes, key) && changes[key] !== plain[key],
    );
  if (!paymentChanged) return out;
  const usable = await eventPaymentMethods(ctx.workspaceId);
  if (usable.length === 0) {
    throw new AppointmentInputError(PAYMENT_METHOD_REQUIRED_MESSAGE, "price");
  }
  const chosen = has(out, "paymentMethods")
    ? (out.paymentMethods ?? null)
    : chosenPaymentMethodsOf(plain);
  if (chosen && !usable.some((method) => chosen.includes(method))) {
    throw new AppointmentInputError(
      PAYMENT_METHOD_CHOICE_MESSAGE,
      "paymentMethods",
    );
  }
  return out;
}

/** Adresse de type libre dans la page (« demo », « demo-2 »…). */
async function uniqueTypeSlug(bookingPageId, base) {
  const taken = new Set(
    await AppointmentType.distinct("slug", {
      bookingPageId,
      slug: { $regex: `^${base}` },
    }),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 31)}-${Date.now().toString(36)}`;
}

/** Nombre de réservations confirmées à venir, par type. */
async function upcomingCounts(typeIds) {
  if (typeIds.length === 0) return new Map();
  const rows = await Booking.aggregate([
    {
      $match: {
        appointmentTypeId: { $in: typeIds },
        status: "CONFIRMED",
        startAt: { $gte: new Date() },
      },
    },
    { $group: { _id: "$appointmentTypeId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.count]));
}

const withPageSlug = (type, pageSlug, upcoming) => {
  const plain = typeof type.toObject === "function" ? type.toObject() : type;
  return { ...plain, _pageSlug: pageSlug, _upcomingCount: upcoming };
};

const isDuplicateKey = (error) => error?.code === 11000;

/**
 * Inscriptions confirmées, billets et présents d'un événement (calculés
 * une fois par objet, mémorisés sur l'objet résolu).
 */
async function eventStats(type) {
  const empty = { registrations: 0, tickets: 0, checkedIn: 0 };
  if (kindOf(type) !== "EVENT") return empty;
  if (!type._eventStats) {
    type._eventStats = EventRegistration.aggregate([
      { $match: { appointmentTypeId: type._id, status: "CONFIRMED" } },
      {
        $group: {
          _id: null,
          registrations: { $sum: 1 },
          tickets: { $sum: { $size: "$tickets" } },
          checkedIn: {
            $sum: {
              $size: {
                $filter: {
                  input: "$tickets",
                  cond: {
                    $ne: [{ $ifNull: ["$$this.checkedInAt", null] }, null],
                  },
                },
              },
            },
          },
        },
      },
    ]).then((rows) => rows[0] || empty);
  }
  return type._eventStats;
}

const appointmentsResolvers = {
  BookingPage: {
    id: (page) => String(page._id || page.id),
    timezone: (page) => page.timezone || "Europe/Paris",
    isActive: (page) => page.isActive !== false,
    availability: (page) => page.availability || [],
    dateOverrides: (page) => page.dateOverrides || [],
    writeConnectionId: (page) =>
      page.writeConnectionId ? String(page.writeConnectionId) : null,
    busyConnectionIds: (page) => (page.busyConnectionIds || []).map(String),
    publicUrl: (page) => publicPageUrl(page.slug),
  },

  AppointmentType: {
    id: (type) => String(type._id || type.id),
    slotIntervalMinutes: (type) =>
      type.slotIntervalMinutes || DEFAULT_SLOT_INTERVAL,
    bufferBeforeMinutes: (type) => type.bufferBeforeMinutes || 0,
    bufferAfterMinutes: (type) => type.bufferAfterMinutes || 0,
    minNoticeMinutes: (type) => type.minNoticeMinutes ?? 0,
    maxDaysAhead: (type) => type.maxDaysAhead ?? 60,
    position: (type) => type.position ?? 0,
    isActive: (type) => type.isActive !== false,
    requirePhone: (type) => Boolean(type.requirePhone),
    publicUrl: async (type) => {
      let slug = type._pageSlug;
      if (!slug) {
        const page = await BookingPage.findById(type.bookingPageId)
          .select("slug")
          .lean();
        slug = page?.slug || "";
      }
      return publicPageUrl(slug, type.slug);
    },
    kind: (type) => kindOf(type),
    startAt: (type) => (kindOf(type) === "EVENT" ? type.startAt : null),
    endAt: (type) => (kindOf(type) === "EVENT" ? type.endAt : null),
    details: (type) => (kindOf(type) === "EVENT" ? type.details : null),
    coverImageUrl: (type) =>
      kindOf(type) === "EVENT" ? type.coverImageUrl : null,
    imageUrl: (type) => (kindOf(type) === "EVENT" ? type.imageUrl : null),
    capacity: (type) =>
      kindOf(type) === "EVENT" ? (type.capacity ?? null) : null,
    seatsTaken: (type) => type.seatsTaken || 0,
    seatsLeft: (type) => (kindOf(type) === "EVENT" ? seatsLeftOf(type) : null),
    maxPerOrder: (type) => type.maxPerOrder || 5,
    registrationClosesAt: (type) =>
      kindOf(type) === "EVENT" ? type.registrationClosesAt || null : null,
    price: (type) =>
      (kindOf(type) === "EVENT" || slotPaymentModeOf(type)) &&
      type.priceAmount > 0
        ? { amount: type.priceAmount, currency: type.currency || "EUR" }
        : null,
    paymentMode: (type) =>
      kindOf(type) === "EVENT"
        ? eventPaymentModeOf(type)
        : slotPaymentModeOf(type),
    depositAmount: (type) =>
      kindOf(type) === "EVENT"
        ? eventDepositAmountOf(type)
        : slotDepositAmountOf(type),
    paymentMethods: (type) =>
      (
        kindOf(type) === "EVENT"
          ? eventPaymentModeOf(type)
          : slotPaymentModeOf(type)
      )
        ? chosenPaymentMethodsOf(type)
        : null,
    registrationsCount: async (type) => (await eventStats(type)).registrations,
    ticketsCount: async (type) => (await eventStats(type)).tickets,
    checkedInCount: async (type) => (await eventStats(type)).checkedIn,
    upcomingCount: async (type) => {
      if (kindOf(type) === "EVENT") {
        if (type.endAt && new Date(type.endAt) < new Date()) return 0;
        return (await eventStats(type)).registrations;
      }
      if (Number.isInteger(type._upcomingCount)) return type._upcomingCount;
      return Booking.countDocuments({
        appointmentTypeId: type._id,
        status: "CONFIRMED",
        startAt: { $gte: new Date() },
      });
    },
  },

  Booking: {
    id: (booking) => String(booking._id || booking.id),
    appointmentTypeId: (booking) =>
      booking.appointmentTypeId ? String(booking.appointmentTypeId) : null,
    clientId: (booking) => (booking.clientId ? String(booking.clientId) : null),
    eventId: (booking) => (booking.eventId ? String(booking.eventId) : null),
    // Paiement (lecture avec repli : absent = gratuit)
    amount: (booking) => Number(booking.amount) || 0,
    currency: (booking) => booking.currency || "EUR",
    paymentMode: (booking) => booking.paymentMode || null,
    amountOnline: (booking) => Number(booking.amountOnline) || 0,
    amountDueOnSite: (booking) => Number(booking.amountDueOnSite) || 0,
    onSitePaidAt: (booking) => booking.onSitePaidAt || null,
    paymentProvider: (booking) => booking.payment?.provider || null,
    paidAt: (booking) => booking.payment?.paidAt || null,
    expiresAt: (booking) =>
      booking.status === "PENDING_PAYMENT" ? booking.expiresAt || null : null,
    paymentReference: (booking) => booking.payment?.bankReference || null,
    bankTransferDeclaredAt: (booking) => booking.payment?.declaredAt || null,
    bankTransferReceivedAt: (booking) =>
      !booking.payment?.paidAt ? booking.payment?.receivedAt || null : null,
    bankTransferReceivedAmount: (booking) =>
      !booking.payment?.paidAt
        ? (booking.payment?.receivedAmount ?? null)
        : null,
    refundedAt: (booking) => booking.payment?.refundedAt || null,
    refundFailed: (booking) =>
      Boolean(
        booking.payment?.paidAt &&
        !booking.payment?.refundedAt &&
        booking.status !== "CONFIRMED" &&
        booking.payment?.refundError,
      ),
  },

  Query: {
    myBookingPage: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, __, ctx) => BookingPage.findOne(ownerScope(ctx))),

    appointmentTypes: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, __, ctx) => {
      const page = await BookingPage.findOne(ownerScope(ctx))
        .select("slug")
        .lean();
      if (!page) return [];
      const types = await AppointmentType.find({
        ...ownerScope(ctx),
        bookingPageId: page._id,
      })
        .sort({ position: 1, createdAt: 1 })
        .lean();
      const counts = await upcomingCounts(types.map((t) => t._id));
      return types.map((type) =>
        withPageSlug(type, page.slug, counts.get(String(type._id)) || 0),
      );
    }),

    bookings: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, { scope, status, limit, offset }, ctx) => {
      const filter = hostScope(ctx);
      const now = new Date();
      let sort = { startAt: -1 };
      if (!scope || scope === "upcoming") {
        filter.startAt = { $gte: now };
        sort = { startAt: 1 };
      } else if (scope === "past") {
        filter.startAt = { $lt: now };
      } else if (scope !== "all") {
        throw new AppError(
          "Filtre inconnu : « upcoming », « past » ou « all ».",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      if (status === "PENDING_PAYMENT") {
        // En attente : aussi les expirées dont le virement est arrivé après
        // la garde, à valider par l'organisateur
        filter.$or = [
          { status: "PENDING_PAYMENT" },
          {
            status: "EXPIRED",
            "payment.receivedAt": { $ne: null },
            "payment.paidAt": null,
          },
        ];
      } else if (status) {
        filter.status = status;
      } else {
        // Expirées sans paiement masquées (celles payées trop tard restent :
        // remboursement)
        filter.$or = [
          { status: { $ne: "EXPIRED" } },
          { "payment.paidAt": { $ne: null } },
          // Virement reçu après la garde : à valider par l'organisateur
          { "payment.receivedAt": { $ne: null } },
        ];
      }
      const take = Math.min(
        Math.max(Number.parseInt(limit, 10) || BOOKINGS_DEFAULT_LIMIT, 1),
        BOOKINGS_MAX_LIMIT,
      );
      const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
      const [items, totalCount] = await Promise.all([
        Booking.find(filter).sort(sort).skip(skip).limit(take).lean(),
        Booking.countDocuments(filter),
      ]);
      return { items, totalCount };
    }),

    booking: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, { id }, ctx) => {
      if (!isObjectIdString(id)) return null;
      return Booking.findOne({ _id: toObjectId(id), ...hostScope(ctx) }).lean();
    }),

    appointmentPaymentMethods: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, __, ctx) => appointmentPaymentMethods(ctx.workspaceId)),

    bookingSlugAvailable: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, { slug }, ctx) => {
      let clean;
      try {
        clean = normalizeSlug(slug);
      } catch {
        return false;
      }
      const existing = await BookingPage.findOne({ slug: clean })
        .select("workspaceId userId")
        .lean();
      if (!existing) return true;
      // Sa propre adresse actuelle reste « disponible » pour lui
      const scope = ownerScope(ctx);
      return (
        String(existing.workspaceId) === String(scope.workspaceId) &&
        String(existing.userId) === String(scope.userId)
      );
    }),
  },

  Mutation: {
    upsertBookingPage: requireWorkspaceAction("appointments", [
      "create",
      "edit",
    ])(async (_, { input }, ctx) => {
      await checkSubscriptionActive(ctx);
      const scope = ownerScope(ctx);
      const userId = userIdOf(ctx);
      const existing = await BookingPage.findOne(scope);
      assertPermissionAction(ctx, "appointments", existing ? "edit" : "create");

      let changes;
      try {
        changes = await pageChanges(input || {}, userId);
      } catch (error) {
        throw inputError(error);
      }

      try {
        if (existing) {
          Object.assign(existing, changes);
          await existing.save();
          return existing;
        }

        if (!changes.slug) {
          throw new AppError(
            "Choisissez l'adresse de votre page.",
            ERROR_CODES.VALIDATION_ERROR,
            { field: "slug" },
          );
        }
        const page = await BookingPage.create({
          ...scope,
          title: ctx.user?.name || "Prise de rendez-vous",
          ...changes,
        });

        // Premier type proposé : visio du premier agenda connecté, sinon
        // appel téléphonique
        const providers = await activeProvidersOf(userId);
        const location = providers.google
          ? { kind: "GOOGLE_MEET", value: null }
          : providers.microsoft
            ? { kind: "TEAMS", value: null }
            : { kind: "PHONE", value: null };
        try {
          await AppointmentType.create({
            ...scope,
            bookingPageId: page._id,
            ...DEFAULT_TYPE,
            location,
            position: 0,
          });
        } catch (error) {
          logger.error(
            `[rendez-vous] type par défaut non créé pour la page ${page._id} : ${error.message}`,
          );
        }
        return page;
      } catch (error) {
        if (isDuplicateKey(error)) {
          if (error.keyPattern?.slug) throw slugTakenError();
          // Page créée entre-temps (double clic) : elle est renvoyée telle quelle
          const page = await BookingPage.findOne(scope);
          if (page) return page;
        }
        throw error;
      }
    }),

    createAppointmentType: requireWorkspaceAction(
      "appointments",
      "create",
    )(async (_, { input }, ctx) => {
      await checkSubscriptionActive(ctx);
      const scope = ownerScope(ctx);
      const page = await BookingPage.findOne(scope).select("slug").lean();
      if (!page) {
        throw new AppError(
          "Créez d'abord votre page de réservation.",
          ERROR_CODES.NOT_FOUND,
        );
      }
      const isEvent = input?.kind === "EVENT";
      let changes;
      try {
        if (!isEvent) {
          changes = {
            ...(await typeChanges(input || {}, userIdOf(ctx))),
            ...(await slotPaymentChanges(input || {}, ctx)),
          };
          Object.assign(
            changes,
            await paymentMethodsChanges(input || {}, ctx, null, changes),
          );
        } else {
          if (!input.name || !String(input.name).trim()) {
            throw new AppointmentInputError(
              "Indiquez le nom de l'événement.",
              "name",
            );
          }
          if (!input.location) {
            throw new AppointmentInputError(
              "Indiquez l'adresse ou le lien de l'événement.",
              "location",
            );
          }
          changes = {
            seatsTaken: 0,
            maxPerOrder: 5,
            ...(await eventTypeChanges(input, ctx)),
            kind: "EVENT",
          };
          Object.assign(
            changes,
            await paymentMethodsChanges(input, ctx, null, changes),
          );
        }
        if (!changes.name) {
          throw new AppointmentInputError(
            "Indiquez le nom du rendez-vous.",
            "name",
          );
        }
        if (!changes.location) {
          throw new AppointmentInputError(
            "Choisissez le lieu du rendez-vous.",
            "location",
          );
        }
      } catch (error) {
        throw inputError(error);
      }
      const slug =
        changes.slug || (await uniqueTypeSlug(page._id, slugify(changes.name)));
      const position =
        changes.position ??
        (await AppointmentType.countDocuments({ bookingPageId: page._id }));
      try {
        const type = await AppointmentType.create({
          ...scope,
          bookingPageId: page._id,
          durationMinutes: DEFAULT_TYPE.durationMinutes,
          ...changes,
          slug,
          position,
        });
        if (isEvent) {
          const eventId = await syncEventCalendarEntry(type);
          if (eventId) type.calendarEventId = eventId;
        }
        return withPageSlug(type, page.slug, 0);
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new AppError(
            "Un autre type de rendez-vous utilise déjà cette adresse.",
            ERROR_CODES.ALREADY_EXISTS,
            { field: "slug" },
          );
        }
        throw error;
      }
    }),

    updateAppointmentType: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { id, input }, ctx) => {
      await checkSubscriptionActive(ctx);
      if (!isObjectIdString(id))
        throw createNotFoundError("Type de rendez-vous");
      const type = await AppointmentType.findOne({
        _id: toObjectId(id),
        ...ownerScope(ctx),
      });
      if (!type) throw createNotFoundError("Type de rendez-vous");
      const isEvent = kindOf(type) === "EVENT";
      let changes;
      try {
        if (
          has(input || {}, "kind") &&
          input.kind &&
          input.kind !== kindOf(type)
        ) {
          throw new AppointmentInputError(
            "Un créneau ne peut pas devenir un événement, ni l'inverse : créez un nouveau type.",
            "kind",
          );
        }
        changes = isEvent
          ? await eventTypeChanges(input || {}, ctx, type)
          : {
              ...(await typeChanges(input || {}, userIdOf(ctx))),
              ...(await slotPaymentChanges(input || {}, ctx, type)),
            };
        Object.assign(
          changes,
          await paymentMethodsChanges(input || {}, ctx, type, changes),
        );
      } catch (error) {
        throw inputError(error);
      }
      // Places : jamais sous celles déjà prises (contrôle atomique)
      if (isEvent && has(changes, "capacity") && changes.capacity !== null) {
        const ok = await AppointmentType.updateOne(
          {
            _id: type._id,
            $expr: {
              $lte: [{ $ifNull: ["$seatsTaken", 0] }, changes.capacity],
            },
          },
          { $set: { capacity: changes.capacity } },
        );
        if (!ok.matchedCount) {
          throw new AppError(
            "Le nombre de places ne peut pas être inférieur aux places déjà prises.",
            ERROR_CODES.VALIDATION_ERROR,
            { field: "capacity" },
          );
        }
      }
      // Avant modification : date, heure et lieu, pour prévenir les inscrits
      const before = isEvent
        ? {
            name: type.name,
            startAt: type.startAt,
            endAt: type.endAt,
            location: {
              kind: type.location?.kind,
              value: type.location?.value || null,
            },
          }
        : null;
      Object.assign(type, changes);
      try {
        await type.save();
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new AppError(
            "Un autre type de rendez-vous utilise déjà cette adresse.",
            ERROR_CODES.ALREADY_EXISTS,
            { field: "slug" },
          );
        }
        throw error;
      }
      if (isEvent) {
        const diff = eventDiff(before, type);
        if (diff.name || diff.schedule || diff.location) {
          await refreshRegistrationSnapshots(type, {
            startChanged: diff.start,
          });
        }
        if (diff.schedule || diff.location) {
          // En arrière-plan : la modification n'attend pas les envois
          notifyEventChanged(type, diff).catch((error) => {
            logger.error(
              `[billetterie] e-mails de modification de l'événement ${type._id} : ${error.message}`,
            );
            return null;
          });
        }
        await syncEventCalendarEntry(type);
      }
      return type;
    }),

    deleteAppointmentType: requireWorkspaceAction(
      "appointments",
      "delete",
    )(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      if (!isObjectIdString(id))
        throw createNotFoundError("Type de rendez-vous");
      const existing = await AppointmentType.findOne({
        _id: toObjectId(id),
        ...ownerScope(ctx),
      }).lean();
      if (!existing) throw createNotFoundError("Type de rendez-vous");
      // Événement à venir avec des inscrits : leurs billets resteraient
      // orphelins
      if (
        kindOf(existing) === "EVENT" &&
        existing.endAt &&
        new Date(existing.endAt) > new Date() &&
        (await EventRegistration.exists({
          appointmentTypeId: existing._id,
          status: { $in: ["CONFIRMED", "PENDING_PAYMENT"] },
        }))
      ) {
        throw new AppError(
          "Annulez d'abord les inscriptions ou désactivez l'événement.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      // Les réservations gardent leur instantané (nom, durée, lieu)
      const deleted = await AppointmentType.findOneAndDelete({
        _id: existing._id,
        ...ownerScope(ctx),
      });
      if (!deleted) throw createNotFoundError("Type de rendez-vous");
      if (kindOf(deleted) === "EVENT") {
        await syncEventCalendarEntry(deleted, { remove: true });
      }
      return true;
    }),

    cancelBooking: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { id, reason }, ctx) => {
      await checkSubscriptionActive(ctx);
      if (!isObjectIdString(id)) throw createNotFoundError("Rendez-vous");
      const booking = await Booking.findOne({
        _id: toObjectId(id),
        ...hostScope(ctx),
      });
      if (!booking) throw createNotFoundError("Rendez-vous");
      if (["CANCELLED", "EXPIRED"].includes(booking.status)) return booking;
      if (new Date(booking.startAt) <= new Date()) {
        throw new AppError(
          "Ce rendez-vous est déjà passé, il ne peut plus être annulé.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      let cleanReason;
      try {
        cleanReason = optionalText(reason, 1000, "reason", "Le motif");
      } catch (error) {
        throw inputError(error);
      }
      const { booking: updated } = await cancelBooking({
        booking,
        by: "HOST",
        reason: cleanReason,
      });
      return updated;
    }),

    markBookingPaid: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      const result = await markBookingPaidByHost({
        scope: hostScope(ctx),
        bookingId: id,
        userId: userIdOf(ctx),
      });
      if (result.error === "NOT_FOUND")
        throw createNotFoundError("Rendez-vous");
      if (result.error === "BUSY") {
        throw new AppError(
          "Une autre réservation est en cours sur votre agenda. Réessayez dans un instant.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      if (result.error === "SLOT_TAKEN") {
        throw new AppError(
          "Ce créneau a été repris entre-temps : le rendez-vous ne peut plus être confirmé. Remboursez l'invité si son virement est arrivé.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      if (result.error) {
        throw new AppError(
          "Seul un rendez-vous en attente de virement peut être marqué comme payé.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      return result.booking;
    }),

    markBookingPaidOnSite: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { id, paid }, ctx) => {
      await checkSubscriptionActive(ctx);
      const result = await markBookingPaidOnSite({
        scope: hostScope(ctx),
        bookingId: id,
        paid: Boolean(paid),
        userId: userIdOf(ctx),
      });
      if (result.error === "NOT_FOUND")
        throw createNotFoundError("Rendez-vous");
      if (result.error === "NOT_CONFIRMED") {
        throw new AppError(
          "Seul un rendez-vous confirmé peut être marqué comme réglé sur place.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      if (result.error === "NOTHING_DUE") {
        throw new AppError(
          "Ce rendez-vous n'a rien à régler sur place.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      return result.booking;
    }),
  },
};

export default appointmentsResolvers;
