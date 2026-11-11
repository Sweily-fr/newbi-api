import Booking from "../../models/Booking.js";
import BookingPage from "../../models/BookingPage.js";
import {
  buildGuestReminderEmail,
  deliverBookingEmail,
  manageUrlFor,
  publicPageUrl,
} from "./bookingEmails.js";
import { loadBookingParties, manageTokenOf } from "./bookingService.js";
import logger from "../../utils/logger.js";

/**
 * Rappels de rendez-vous à l'invité, 24 h puis 1 h avant (cron toutes les
 * 5 minutes, instance PM2 n° 0 seulement).
 *
 *   - 24 h : début dans ]maintenant, maintenant + 24 h], réservation prise
 *     (ou déplacée) plus de 24 h avant le début, et pas dans l'heure qui
 *     vient (le rappel d'une heure suffit alors) ;
 *   - 1 h : début dans ]maintenant, maintenant + 1 h], réservation prise
 *     (ou déplacée) plus d'une heure avant.
 * Chaque rappel est revendiqué avant l'envoi (date posée par un
 * findOneAndUpdate atomique) : jamais deux envois, même si deux passages se
 * chevauchent. Un envoi en échec n'est pas retenté.
 *
 * APPOINTMENT_REMINDERS_MODE : « live » (défaut) ou « off » (coupure
 * d'urgence, rien n'est envoyé ni revendiqué).
 */

const HOUR = 60 * 60 * 1000;
// Garde-fou : rappels envoyés au plus par passage
const MAX_PER_RUN = 500;

const REMINDERS = [
  // Le rappel d'une heure d'abord : il prime sur celui de la veille
  { kind: "h1", field: "reminders.h1SentAt", window: HOUR, skipWithin: 0 },
  {
    kind: "h24",
    field: "reminders.h24SentAt",
    window: 24 * HOUR,
    skipWithin: HOUR,
  },
];

export function remindersMode() {
  const value = String(process.env.APPOINTMENT_REMINDERS_MODE || "live")
    .trim()
    .toLowerCase();
  return value === "off" ? "off" : "live";
}

/** Revendique le prochain rappel dû (ou null). */
function claimNext({ field, window, skipWithin }, now) {
  return Booking.findOneAndUpdate(
    {
      status: "CONFIRMED",
      startAt: {
        $gt: new Date(now.getTime() + skipWithin),
        $lte: new Date(now.getTime() + window),
      },
      [field]: null,
      // Prise ou dernier déplacement au moins `window` avant le début
      $expr: {
        $lt: [
          { $max: ["$createdAt", { $max: "$rescheduleHistory.at" }] },
          { $subtract: ["$startAt", window] },
        ],
      },
    },
    { $set: { [field]: now } },
    { new: true, sort: { startAt: 1 } },
  );
}

async function sendReminder(booking, kind) {
  const [{ host, organizationName }, page] = await Promise.all([
    loadBookingParties(booking),
    BookingPage.findById(booking.bookingPageId).select("slug").lean(),
  ]);
  const token = manageTokenOf(booking);
  const email = buildGuestReminderEmail({
    booking,
    host,
    organizationName,
    kind,
    manageUrl: token
      ? manageUrlFor(token)
      : page
        ? publicPageUrl(page.slug)
        : null,
  });
  return deliverBookingEmail({
    to: booking.guest.email,
    replyTo: host.email || undefined,
    organizationName,
    ...email,
  });
}

/**
 * Un passage du cron.
 * @returns {Promise<{ mode: string, sent: number, failed: number }>}
 */
export async function runAppointmentReminders(now = new Date()) {
  const mode = remindersMode();
  if (mode === "off") return { mode, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const reminder of REMINDERS) {
    while (sent + failed < MAX_PER_RUN) {
      const booking = await claimNext(reminder, now);
      if (!booking) break;
      try {
        if (await sendReminder(booking, reminder.kind)) sent += 1;
        else failed += 1;
      } catch (error) {
        failed += 1;
        logger.error(
          `[rendez-vous] rappel ${reminder.kind} de la réservation ${booking._id} non envoyé : ${error.message}`,
        );
      }
    }
  }
  if (sent || failed) {
    logger.info(
      `[rendez-vous] rappels : ${sent} envoyé(s), ${failed} en échec`,
    );
  }
  return { mode, sent, failed };
}
