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
  slugify,
} from "../utils/appointmentValidation.js";
import { cancelBooking } from "../services/appointments/bookingService.js";
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
async function typeChanges(input, userId) {
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
  if (has(input, "slotIntervalMinutes") && input.slotIntervalMinutes !== null) {
    if (!SLOT_INTERVALS.includes(Number(input.slotIntervalMinutes))) {
      throw new AppointmentInputError(
        `L'intervalle entre créneaux doit valoir ${SLOT_INTERVALS.join(", ")} minutes.`,
        "slotIntervalMinutes",
      );
    }
    changes.slotIntervalMinutes = Number(input.slotIntervalMinutes);
  }
  if (has(input, "maxPerDay")) {
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
  if (has(input, "location") && input.location !== null) {
    changes.location = normalizeLocation(
      input.location,
      await activeProvidersOf(userId),
    );
  }
  return changes;
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
    upcomingCount: async (type) => {
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
      if (status) filter.status = status;
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
      let changes;
      try {
        changes = await typeChanges(input || {}, userIdOf(ctx));
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
      let changes;
      try {
        changes = await typeChanges(input || {}, userIdOf(ctx));
      } catch (error) {
        throw inputError(error);
      }
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
      return type;
    }),

    deleteAppointmentType: requireWorkspaceAction(
      "appointments",
      "delete",
    )(async (_, { id }, ctx) => {
      await checkSubscriptionActive(ctx);
      if (!isObjectIdString(id))
        throw createNotFoundError("Type de rendez-vous");
      // Les réservations gardent leur instantané (nom, durée, lieu)
      const deleted = await AppointmentType.findOneAndDelete({
        _id: toObjectId(id),
        ...ownerScope(ctx),
      });
      if (!deleted) throw createNotFoundError("Type de rendez-vous");
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
      if (booking.status === "CANCELLED") return booking;
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
  },
};

export default appointmentsResolvers;
