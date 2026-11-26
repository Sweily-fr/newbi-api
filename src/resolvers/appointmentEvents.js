/**
 * Resolvers de la billetterie (événements de la prise de rendez-vous) côté
 * tableau de bord : inscrits, export CSV, annulation, contrôle des billets,
 * envoi des images. Même périmètre que la prise de rendez-vous : chaque
 * membre ne voit et ne gère que ses propres événements. Filtrés par
 * l'accès anticipé « appointments » (resolvers/index.js).
 */
import mongoose from "mongoose";
import { DateTime } from "luxon";
import AppointmentType from "../models/AppointmentType.js";
import BookingPage from "../models/BookingPage.js";
import EventRegistration, {
  REGISTRATION_STATUSES,
} from "../models/EventRegistration.js";
import cloudflareService from "../services/cloudflareService.js";
import {
  assertStorageAvailable,
  recordStoredFile,
} from "../services/storage/storageService.js";
import {
  EventRegistrationError,
  amountDueOnSiteOf,
  amountOnlineOf,
  cancelRegistration,
  checkInTicket,
  eventPaymentMethods,
  markRegistrationPaidOnSite,
  registrationPaymentModeOf,
  undoTicketCheckIn,
} from "../services/appointments/eventRegistrationService.js";
import {
  checkSubscriptionActive,
  requireWorkspaceAction,
  requireWorkspaceLevel,
} from "../middlewares/rbac.js";
import { AppError, ERROR_CODES, createNotFoundError } from "../utils/errors.js";
import {
  EVENT_IMAGE_MAX_BYTES,
  isAcceptedEventImage,
  processEventImage,
} from "../utils/eventValidation.js";
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  optionalText,
} from "../utils/appointmentValidation.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { isObjectIdString } from "../utils/objectIdString.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));
const userIdOf = (ctx) => String(ctx.user?._id || ctx.user?.id);

/** Inscriptions : celles des événements de l'utilisateur dans l'espace. */
const hostScope = (ctx) => ({
  workspaceId: toObjectId(ctx.workspaceId),
  hostUserId: toObjectId(userIdOf(ctx)),
});

/** Événement de l'utilisateur, sinon NOT_FOUND. */
async function ownEvent(ctx, typeId) {
  if (!isObjectIdString(typeId)) throw createNotFoundError("Événement");
  const type = await AppointmentType.findOne({
    _id: toObjectId(typeId),
    workspaceId: toObjectId(ctx.workspaceId),
    userId: toObjectId(userIdOf(ctx)),
    kind: "EVENT",
  }).lean();
  if (!type) throw createNotFoundError("Événement");
  return type;
}

function registrationFilter(ctx, type, { search, status }) {
  const filter = { ...hostScope(ctx), appointmentTypeId: type._id };
  if (status) {
    if (!REGISTRATION_STATUSES.includes(status)) {
      throw new AppError("Statut inconnu.", ERROR_CODES.VALIDATION_ERROR);
    }
    filter.status = status;
  } else {
    // Expirées masquées, sauf celles payées trop tard (remboursement)
    filter.$and = [
      {
        $or: [
          { status: { $ne: "EXPIRED" } },
          { "payment.paidAt": { $ne: null } },
        ],
      },
    ];
  }
  const term = typeof search === "string" ? search.trim() : "";
  if (term) {
    const pattern = new RegExp(escapeRegex(term, 100), "i");
    const filters = [
      { "buyer.firstName": pattern },
      { "buyer.lastName": pattern },
      { "buyer.email": pattern },
      { "tickets.number": pattern },
      { "tickets.attendeeName": pattern },
    ];
    // « Élise Martin » : prénom et nom
    const [first, ...rest] = term.split(/\s+/);
    if (rest.length) {
      filters.push({
        "buyer.firstName": new RegExp(escapeRegex(first, 100), "i"),
        "buyer.lastName": new RegExp(escapeRegex(rest.join(" "), 100), "i"),
      });
    }
    filter.$or = filters;
  }
  return filter;
}

// ─── CSV ──────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  PENDING_PAYMENT: "En attente de paiement",
  CONFIRMED: "Confirmée",
  CANCELLED: "Annulée",
  EXPIRED: "Expirée",
};
const PROVIDER_LABELS = { stripe: "Stripe", paypal: "PayPal", sumup: "SumUp" };

/** Cellule CSV : guillemets doublés, formules neutralisées. */
export function csvCell(value) {
  let text = value == null ? "" : String(value);
  // Formules neutralisées (=, +, -, @…), sauf un numéro de téléphone
  // international (« +33 6 12… ») qui reste lisible tel quel
  if (/^[=+\-@\t\r]/.test(text) && !/^\+[\d\s.()-]+$/.test(text)) {
    text = `'${text}`;
  }
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const formatDate = (date, zone) =>
  date
    ? DateTime.fromJSDate(new Date(date), { zone }).toFormat("dd/LL/yyyy HH:mm")
    : "";

const formatAmount = (cents) =>
  (Number(cents || 0) / 100).toFixed(2).replace(".", ",");

/** Une ligne par billet des inscriptions confirmées. */
export function registrationsCsv(registrations, zone) {
  const header = [
    "Numéro du billet",
    "Participant",
    "Prénom",
    "Nom",
    "E-mail",
    "Téléphone",
    "Places de l'inscription",
    "Montant de l'inscription (€)",
    "Payé en ligne",
    "Reste sur place",
    "Réglé sur place",
    "Moyen de paiement",
    "Statut",
    "Inscrit le",
    "Présent le",
  ];
  const lines = [header.map(csvCell).join(";")];
  for (const registration of registrations) {
    for (const ticket of registration.tickets || []) {
      lines.push(
        [
          ticket.number,
          ticket.attendeeName,
          registration.buyer.firstName,
          registration.buyer.lastName,
          registration.buyer.email,
          registration.buyer.phone || "",
          registration.quantity,
          formatAmount(registration.amount),
          formatAmount(amountOnlineOf(registration)),
          formatAmount(amountDueOnSiteOf(registration)),
          // Rien à régler sur place : cellule vide
          amountDueOnSiteOf(registration) > 0
            ? registration.onSitePaidAt
              ? "oui"
              : "non"
            : "",
          PROVIDER_LABELS[registration.payment?.provider] ||
            (registration.amount > 0
              ? registrationPaymentModeOf(registration) === "ON_SITE"
                ? "Sur place"
                : ""
              : "Gratuit"),
          STATUS_LABELS[registration.status] || registration.status,
          formatDate(registration.createdAt, zone),
          formatDate(ticket.checkedInAt, zone),
        ]
          .map(csvCell)
          .join(";"),
      );
    }
  }
  return `\ufeff${lines.join("\r\n")}\r\n`;
}

// ─── Resolvers ────────────────────────────────────────────────────────────

const appointmentEventsResolvers = {
  EventRegistration: {
    id: (r) => String(r._id || r.id),
    appointmentTypeId: (r) =>
      r.appointmentTypeId ? String(r.appointmentTypeId) : null,
    eventName: (r) => r.event?.name || "",
    eventStartAt: (r) => r.event?.startAt,
    eventEndAt: (r) => r.event?.endAt,
    amount: (r) => r.amount || 0,
    currency: (r) => r.currency || "EUR",
    paymentProvider: (r) => r.payment?.provider || null,
    paidAt: (r) => r.payment?.paidAt || null,
    amountOnline: (r) => amountOnlineOf(r),
    amountDueOnSite: (r) => amountDueOnSiteOf(r),
    onSitePaidAt: (r) => r.onSitePaidAt || null,
    paymentMode: (r) => registrationPaymentModeOf(r),
    expiresAt: (r) => (r.status === "PENDING_PAYMENT" ? r.expiresAt : null),
    refundedAt: (r) => r.payment?.refundedAt || null,
    refundFailed: (r) =>
      Boolean(
        r.payment?.paidAt &&
        !r.payment?.refundedAt &&
        r.status !== "CONFIRMED" &&
        r.payment?.refundError,
      ),
    clientId: (r) => (r.clientId ? String(r.clientId) : null),
    tickets: (r) => r.tickets || [],
    checkedInCount: (r) =>
      (r.tickets || []).filter((ticket) => ticket.checkedInAt).length,
  },

  EventTicket: {
    id: (t) => String(t._id || t.id),
    checkedInBy: (t) => (t.checkedInBy ? String(t.checkedInBy) : null),
  },

  Query: {
    eventRegistrations: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, { typeId, search, status, limit, offset }, ctx) => {
      const type = await ownEvent(ctx, typeId);
      const filter = registrationFilter(ctx, type, { search, status });
      const take = Math.min(
        Math.max(Number.parseInt(limit, 10) || DEFAULT_LIMIT, 1),
        MAX_LIMIT,
      );
      const skip = Math.max(Number.parseInt(offset, 10) || 0, 0);
      const [items, totalCount] = await Promise.all([
        EventRegistration.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(take)
          .lean(),
        EventRegistration.countDocuments(filter),
      ]);
      return { items, totalCount };
    }),

    eventRegistrationsCsv: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, { typeId }, ctx) => {
      const type = await ownEvent(ctx, typeId);
      const [registrations, page] = await Promise.all([
        EventRegistration.find({
          ...hostScope(ctx),
          appointmentTypeId: type._id,
          status: "CONFIRMED",
        })
          .sort({ createdAt: 1 })
          .lean(),
        BookingPage.findById(type.bookingPageId).select("timezone").lean(),
      ]);
      const zone = isValidTimezone(page?.timezone)
        ? page.timezone
        : DEFAULT_TIMEZONE;
      return registrationsCsv(registrations, zone);
    }),

    eventPaymentMethods: requireWorkspaceLevel(
      "appointments",
      "read",
    )(async (_, __, ctx) => eventPaymentMethods(ctx.workspaceId)),
  },

  Mutation: {
    uploadAppointmentEventImage: requireWorkspaceAction("appointments", [
      "create",
      "edit",
    ])(async (_, { file, kind }, ctx) => {
      await checkSubscriptionActive(ctx);
      const { createReadStream, filename, mimetype } = await file;
      if (!isAcceptedEventImage(filename, mimetype)) {
        return {
          success: false,
          message:
            "Format non pris en charge. Formats acceptés : JPEG, PNG, WebP, HEIC",
        };
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of createReadStream()) {
        size += chunk.length;
        if (size > EVENT_IMAGE_MAX_BYTES) {
          return {
            success: false,
            message: "Image trop volumineuse (5 Mo maximum)",
          };
        }
        chunks.push(chunk);
      }
      let buffer;
      try {
        buffer = await processEventImage(Buffer.concat(chunks), {
          filename,
          mimetype,
          kind,
        });
      } catch {
        return {
          success: false,
          message:
            "Impossible de lire cette image. Réessayez avec un fichier JPEG ou PNG",
        };
      }
      const workspaceId = String(ctx.workspaceId);
      await assertStorageAvailable(workspaceId, buffer.length);
      const { key, url, contentType } = await cloudflareService.uploadImage(
        buffer,
        "image.webp",
        userIdOf(ctx),
        "eventImage",
        workspaceId,
      );
      await recordStoredFile({
        workspaceId,
        key,
        bucket: cloudflareService.companyImagesBucketName,
        size: buffer.length,
        category: "branding",
        userId: userIdOf(ctx),
      });
      return { success: true, key, url, contentType };
    }),

    cancelEventRegistration: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { id, reason }, ctx) => {
      await checkSubscriptionActive(ctx);
      if (!isObjectIdString(id)) throw createNotFoundError("Inscription");
      const registration = await EventRegistration.findOne({
        _id: toObjectId(id),
        ...hostScope(ctx),
      });
      if (!registration) throw createNotFoundError("Inscription");
      if (["CANCELLED", "EXPIRED"].includes(registration.status)) {
        return registration;
      }
      let cleanReason;
      try {
        cleanReason = optionalText(reason, 1000, "reason", "Le motif");
      } catch (error) {
        throw new AppError(error.message, ERROR_CODES.VALIDATION_ERROR, {
          field: "reason",
        });
      }
      try {
        const { registration: updated } = await cancelRegistration({
          registration,
          by: "HOST",
          reason: cleanReason,
        });
        return updated;
      } catch (error) {
        if (error instanceof EventRegistrationError) {
          throw new AppError(
            "Le paiement de cette inscription est en cours d'encaissement. Réessayez dans une minute.",
            ERROR_CODES.VALIDATION_ERROR,
          );
        }
        throw error;
      }
    }),

    checkInTicket: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { typeId, code }, ctx) => {
      await checkSubscriptionActive(ctx);
      const type = await ownEvent(ctx, typeId);
      const result = await checkInTicket({
        scope: hostScope(ctx),
        typeId: type._id,
        code,
        userId: userIdOf(ctx),
      });
      return {
        result: result.result,
        ticket: result.ticket || null,
        registration: result.registration || null,
        otherEventName: result.otherEventName || null,
      };
    }),

    markEventRegistrationPaidOnSite: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { id, paid }, ctx) => {
      await checkSubscriptionActive(ctx);
      const result = await markRegistrationPaidOnSite({
        scope: hostScope(ctx),
        registrationId: id,
        paid: Boolean(paid),
        userId: userIdOf(ctx),
      });
      if (result.error === "NOT_FOUND")
        throw createNotFoundError("Inscription");
      if (result.error === "NOT_CONFIRMED") {
        throw new AppError(
          "Seule une inscription confirmée peut être marquée comme réglée sur place.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      if (result.error === "NOTHING_DUE") {
        throw new AppError(
          "Cette inscription n'a rien à régler sur place.",
          ERROR_CODES.VALIDATION_ERROR,
        );
      }
      return result.registration;
    }),

    undoTicketCheckIn: requireWorkspaceAction(
      "appointments",
      "edit",
    )(async (_, { ticketId }, ctx) => {
      await checkSubscriptionActive(ctx);
      const ticket = await undoTicketCheckIn({
        scope: hostScope(ctx),
        ticketId,
      });
      if (!ticket) throw createNotFoundError("Billet");
      return ticket;
    }),
  },
};

export default appointmentEventsResolvers;
