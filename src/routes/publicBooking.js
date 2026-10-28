import express from "express";
import AppointmentType from "../models/AppointmentType.js";
import { generateManageToken } from "../models/Booking.js";
import {
  BookingError,
  availableSlots,
  cancelBooking,
  createBooking,
  findBookingByToken,
  guestBookingPayload,
  loadBookingParties,
  loadManageContext,
  loadPublicPage,
  loadPublicType,
  managePayload,
  publicPagePayload,
  rescheduleBooking,
} from "../services/appointments/bookingService.js";
import {
  bookingIcs,
  manageUrlFor,
} from "../services/appointments/bookingEmails.js";
import { recordAttempt } from "../utils/attemptLimiter.js";
import { verifyTurnstileToken } from "../utils/turnstile.js";
import { addDays, daysBetween, localDayOf } from "../utils/appointmentSlots.js";
import {
  DEFAULT_TIMEZONE,
  isValidDay,
  isValidTimezone,
  locationLabel,
  phoneRequired,
} from "../utils/appointmentValidation.js";
import logger from "../utils/logger.js";

/**
 * Prise de rendez-vous, routes publiques (sans compte) montées sous
 * /api/public/booking :
 *
 *   GET  /:slug                         page et types actifs
 *   GET  /:slug/:typeSlug               page et type
 *   GET  /:slug/:typeSlug/slots         créneaux libres (?from&to&excludeToken)
 *   POST /:slug/:typeSlug/book          réservation
 *   GET  /manage/:token                 rendez-vous de l'invité
 *   POST /manage/:token/cancel          annulation par l'invité
 *   POST /manage/:token/reschedule      déplacement par l'invité
 *   GET  /manage/:token/ics             fichier .ics
 *
 * Page inconnue, inactive, type inactif, organisation sans abonnement actif
 * ou en lecture seule : même 404 { error: "NOT_FOUND" }, rien n'est révélé.
 * Limites par adresse IP (Redis, repli en mémoire) : lectures 60/min,
 * réservations 5/min et 20/h, gestion 10/min ; au-delà 429 RATE_LIMITED.
 */
const router = express.Router();

export const RATE_LIMITS = {
  read: [{ window: 60, max: 60 }],
  book: [
    { window: 60, max: 5 },
    { window: 3600, max: 20 },
  ],
  manage: [{ window: 60, max: 10 }],
};
// Plage de créneaux demandée en une fois (jours, bornes comprises)
export const MAX_RANGE_DAYS = 42;

const MINUTE = 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[\d\s.()-]{6,30}$/;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const notFound = (res) => res.status(404).json({ error: "NOT_FOUND" });
const validation = (res, fields) =>
  res.status(400).json({ error: "VALIDATION", fields });

function privateHeaders(res) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "X-Robots-Tag": "noindex, nofollow",
    "Referrer-Policy": "no-referrer",
  });
}

const clientIp = (req) => req.ip || req.socket?.remoteAddress || "unknown";

function rateLimit(kind) {
  return async (req, res, next) => {
    privateHeaders(res);
    const ip = clientIp(req);
    try {
      for (const { window, max } of RATE_LIMITS[kind]) {
        const count = await recordAttempt(
          `booking:${kind}:${window}:${ip}`,
          window,
        );
        if (count > max) {
          res.set("Retry-After", String(window));
          return res.status(429).json({ error: "RATE_LIMITED" });
        }
      }
    } catch (error) {
      // Compteur indisponible : on laisse passer plutôt que bloquer la page
      logger.warn(`[rendez-vous] limitation indisponible : ${error.message}`);
    }
    return next();
  };
}

function serverError(res, error, where) {
  logger.error(`[rendez-vous] ${where} : ${error.message}`);
  return res.status(500).json({ error: "SERVER_ERROR" });
}

function bookingErrorResponse(res, error) {
  if (error instanceof BookingError) {
    return res.status(error.status).json({ error: error.code });
  }
  return null;
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Instant ISO-8601 (avec fuseau) envoyé par le site. */
function parseInstant(value) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Contrôle du formulaire de réservation.
 * @returns {{ fields: object|null, start, guest, timezone }}
 */
export function validateBookingBody(body, type) {
  const fields = {};
  const start = parseInstant(body?.start);
  if (!start) fields.start = "Créneau invalide.";

  const raw = body?.guest && typeof body.guest === "object" ? body.guest : {};
  const guest = {
    firstName: text(raw.firstName),
    lastName: text(raw.lastName),
    email: text(raw.email).toLowerCase(),
    phone: text(raw.phone) || null,
    message: text(raw.message) || null,
  };
  if (!guest.firstName) fields.firstName = "Indiquez votre prénom.";
  else if (guest.firstName.length > 100)
    fields.firstName = "Prénom trop long (100 caractères au plus).";
  if (!guest.lastName) fields.lastName = "Indiquez votre nom.";
  else if (guest.lastName.length > 100)
    fields.lastName = "Nom trop long (100 caractères au plus).";
  if (
    !guest.email ||
    guest.email.length > 254 ||
    !EMAIL_PATTERN.test(guest.email)
  ) {
    fields.email = "Adresse e-mail invalide.";
  }
  if (guest.phone) {
    const digits = guest.phone.replace(/\D/g, "").length;
    if (!PHONE_PATTERN.test(guest.phone) || digits < 6) {
      fields.phone = "Numéro de téléphone invalide.";
    }
  } else if (phoneRequired(type)) {
    fields.phone = "Indiquez votre numéro de téléphone.";
  }
  if (guest.message && guest.message.length > 2000) {
    fields.message = "Message trop long (2 000 caractères au plus).";
  }
  const timezone = text(body?.timezone);
  if (timezone && !isValidTimezone(timezone))
    fields.timezone = "Fuseau horaire invalide.";

  return {
    fields: Object.keys(fields).length ? fields : null,
    start,
    guest,
    timezone: timezone || null,
  };
}

const publicType = (type) => ({
  slug: type.slug,
  name: type.name,
  description: type.description || null,
  durationMinutes: type.durationMinutes,
  locationKind: type.location?.kind || null,
  requirePhone: phoneRequired(type),
});

// ─── Gestion par l'invité (avant /:slug pour ne pas être prise pour une page)

router.get("/manage/:token", rateLimit("manage"), async (req, res) => {
  try {
    const booking = await findBookingByToken(req.params.token);
    if (!booking) return notFound(res);
    const context = await loadManageContext(booking);
    return res.json(managePayload(booking, context));
  } catch (error) {
    return serverError(res, error, "lecture d'un rendez-vous");
  }
});

router.post("/manage/:token/cancel", rateLimit("manage"), async (req, res) => {
  try {
    const booking = await findBookingByToken(req.params.token);
    if (!booking) return notFound(res);
    if (booking.status === "CANCELLED")
      return res.json({ status: "CANCELLED" });
    const context = await loadManageContext(booking);
    if (!context.canCancel)
      return res.status(409).json({ error: "NOT_ALLOWED" });
    const reason = text(req.body?.reason).slice(0, 1000) || null;
    const { booking: updated } = await cancelBooking({
      booking,
      by: "GUEST",
      reason,
    });
    return res.json({ status: updated?.status || "CANCELLED" });
  } catch (error) {
    return (
      bookingErrorResponse(res, error) || serverError(res, error, "annulation")
    );
  }
});

router.post(
  "/manage/:token/reschedule",
  rateLimit("manage"),
  async (req, res) => {
    try {
      const booking = await findBookingByToken(req.params.token);
      if (!booking) return notFound(res);
      const start = parseInstant(req.body?.start);
      if (!start) return validation(res, { start: "Créneau invalide." });
      if (
        !(await verifyTurnstileToken(req.body?.turnstileToken, clientIp(req)))
      ) {
        return validation(res, {
          turnstileToken:
            "Vérification anti-robot échouée. Veuillez réessayer.",
        });
      }
      const { booking: updated } = await rescheduleBooking({
        booking,
        token: req.params.token,
        start,
      });
      const context = await loadManageContext(updated);
      return res.json(managePayload(updated, context));
    } catch (error) {
      return (
        bookingErrorResponse(res, error) ||
        serverError(res, error, "déplacement")
      );
    }
  },
);

router.get("/manage/:token/ics", rateLimit("manage"), async (req, res) => {
  try {
    const booking = await findBookingByToken(req.params.token);
    if (!booking) return notFound(res);
    const { host, organizationName } = await loadBookingParties(booking);
    const ics = bookingIcs(booking, {
      method: "PUBLISH",
      host,
      organizationName,
    });
    res.set({
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="rendez-vous.ics"',
    });
    return res.status(200).send(ics);
  } catch (error) {
    return serverError(res, error, "fichier .ics");
  }
});

// ─── Pages publiques ──────────────────────────────────────────────────────

router.get("/:slug", rateLimit("read"), async (req, res) => {
  try {
    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const types = await AppointmentType.find({
      bookingPageId: context.page._id,
      isActive: true,
    })
      .sort({ position: 1, createdAt: 1 })
      .lean();
    return res.json({
      page: publicPagePayload(context),
      types: types.map(publicType),
    });
  } catch (error) {
    return serverError(res, error, "page publique");
  }
});

router.get("/:slug/:typeSlug", rateLimit("read"), async (req, res) => {
  try {
    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const type = await loadPublicType(context.page, req.params.typeSlug);
    if (!type) return notFound(res);
    return res.json({
      page: publicPagePayload(context),
      type: {
        ...publicType(type),
        locationLabel: locationLabel(type.location),
        maxDaysAhead: type.maxDaysAhead,
      },
    });
  } catch (error) {
    return serverError(res, error, "type de rendez-vous");
  }
});

router.get("/:slug/:typeSlug/slots", rateLimit("read"), async (req, res) => {
  try {
    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const type = await loadPublicType(context.page, req.params.typeSlug);
    if (!type) return notFound(res);

    const zone = isValidTimezone(context.page.timezone)
      ? context.page.timezone
      : DEFAULT_TIMEZONE;
    const from =
      typeof req.query.from === "string" && req.query.from
        ? req.query.from
        : localDayOf(new Date(), zone);
    let to =
      typeof req.query.to === "string" && req.query.to
        ? req.query.to
        : addDays(from, MAX_RANGE_DAYS - 1);
    const fields = {};
    if (!isValidDay(from)) fields.from = "Date de début invalide (AAAA-MM-JJ).";
    if (!isValidDay(to)) fields.to = "Date de fin invalide (AAAA-MM-JJ).";
    if (!fields.from && !fields.to && to < from) {
      fields.to = "La date de fin doit suivre la date de début.";
    }
    if (Object.keys(fields).length) return validation(res, fields);
    // Plage bornée à 42 jours
    if (daysBetween(from, to) > MAX_RANGE_DAYS - 1) {
      to = addDays(from, MAX_RANGE_DAYS - 1);
    }

    // Déplacement en cours : la réservation de l'invité ne bloque pas
    let excludeBooking = null;
    if (typeof req.query.excludeToken === "string" && req.query.excludeToken) {
      const booking = await findBookingByToken(req.query.excludeToken);
      if (
        booking?.status === "CONFIRMED" &&
        String(booking.hostUserId) === String(context.page.userId)
      ) {
        excludeBooking = booking;
      }
    }

    const slots = await availableSlots({
      page: context.page,
      type,
      from,
      to,
      excludeBooking,
    });
    return res.json({
      timezone: zone,
      slots: slots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      })),
    });
  } catch (error) {
    return serverError(res, error, "créneaux");
  }
});

router.post("/:slug/:typeSlug/book", rateLimit("book"), async (req, res) => {
  try {
    // Pot de miel : réponse factice, rien n'est enregistré
    if (req.body?.website) {
      logger.warn(`[rendez-vous] pot de miel déclenché (${clientIp(req)})`);
      const start = parseInstant(req.body?.start) || new Date();
      const token = generateManageToken();
      return res.status(201).json({
        booking: {
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 30 * MINUTE).toISOString(),
          typeName: "Rendez-vous",
          locationKind: null,
          locationLabel: "",
          meetingUrl: null,
          hostName: null,
          timezone: text(req.body?.timezone) || DEFAULT_TIMEZONE,
        },
        manageUrl: manageUrlFor(token),
        icsUrl: `/api/public/booking/manage/${token}/ics`,
      });
    }

    const context = await loadPublicPage(req.params.slug);
    if (!context) return notFound(res);
    const type = await loadPublicType(context.page, req.params.typeSlug);
    if (!type) return notFound(res);

    const { fields, start, guest, timezone } = validateBookingBody(
      req.body,
      type,
    );
    if (fields) return validation(res, fields);
    if (
      !(await verifyTurnstileToken(req.body?.turnstileToken, clientIp(req)))
    ) {
      return validation(res, {
        turnstileToken: "Vérification anti-robot échouée. Veuillez réessayer.",
      });
    }

    const { booking, token } = await createBooking({
      context,
      type,
      start,
      guest,
      timezone,
    });
    return res.status(201).json({
      booking: guestBookingPayload(booking, { host: context.host }),
      manageUrl: manageUrlFor(token),
      icsUrl: `/api/public/booking/manage/${token}/ics`,
    });
  } catch (error) {
    return (
      bookingErrorResponse(res, error) || serverError(res, error, "réservation")
    );
  }
});

export default router;
