/**
 * Virements des rendez-vous et inscriptions payants repérés sur le compte
 * bancaire synchronisé par Bridge (appelé après chaque synchronisation,
 * comme pour les transferts payants) : chaque crédit dont le libellé porte
 * la référence `NB-XXXXXX` d'un paiement attendu, d'au moins son montant et
 * dans sa devise, le règle.
 *
 * - en attente : confirmé (billets, agenda, e-mails) ;
 * - expiré ou annulé (virement arrivé trop tard) : confirmé s'il reste de
 *   la place, sinon signalé à l'organisateur « à rembourser à la main ».
 */
import mongoose from "mongoose";
import Booking from "../../models/Booking.js";
import EventRegistration, {
  expectedOnlineAmount,
} from "../../models/EventRegistration.js";
import {
  bankPaymentId,
  findBankCredit,
  labelledCredits,
} from "../payments/bankTransfer.js";
import { workspaceKey } from "../payments/directPayments.js";
import { BANK_TRANSFER } from "./appointmentPayments.js";
import { markRegistrationPaid } from "./eventRegistrationService.js";
import {
  expectedBookingAmount,
  markBookingPaid,
} from "./bookingPaymentService.js";
import logger from "../../utils/logger.js";

// Virement tardif cherché jusqu'à 60 jours après la réservation
const LATE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

const candidatesFilter = (workspaceId, now) => ({
  workspaceId,
  "payment.provider": BANK_TRANSFER,
  "payment.bankReference": { $type: "string" },
  "payment.paidAt": null,
  $or: [
    { status: "PENDING_PAYMENT" },
    {
      status: { $in: ["EXPIRED", "CANCELLED"] },
      createdAt: { $gte: new Date(now.getTime() - LATE_WINDOW_MS) },
    },
  ],
});

/**
 * @param {string} workspaceId
 * @param {Array<object>} transactions - transactions synchronisées
 *   ({ amount, currency, reference, description, externalId })
 * @returns {Promise<{registrations: string[], bookings: string[]}>} réglés
 */
export async function detectAppointmentBankPayments(
  workspaceId,
  transactions,
  { now = new Date() } = {},
) {
  const done = { registrations: [], bookings: [] };
  const orgId = workspaceKey(workspaceId);
  if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) return done;
  const labelled = labelledCredits(transactions);
  if (!labelled.length) return done;
  const objectId = new mongoose.Types.ObjectId(orgId);

  const [registrations, bookings] = await Promise.all([
    EventRegistration.find(candidatesFilter(objectId, now)),
    Booking.find(candidatesFilter(objectId, now)),
  ]);

  for (const registration of registrations) {
    const reference = registration.payment.bankReference;
    const match = findBankCredit(labelled, {
      reference,
      amountCents: expectedOnlineAmount(registration),
      currency: registration.currency,
    });
    if (!match) continue;
    try {
      await markRegistrationPaid(registration, {
        provider: BANK_TRANSFER,
        paymentId: bankPaymentId(match, reference),
        amountCents: Math.round(Number(match.amount) * 100),
      });
      done.registrations.push(String(registration._id));
      logger.info(
        `[billetterie] virement ${reference} repéré pour l'inscription ${registration._id}`,
      );
    } catch (error) {
      logger.error(
        `[billetterie] virement ${reference} de l'inscription ${registration._id} : ${error.message}`,
      );
    }
  }

  for (const booking of bookings) {
    const reference = booking.payment.bankReference;
    const match = findBankCredit(labelled, {
      reference,
      amountCents: expectedBookingAmount(booking),
      currency: booking.currency,
    });
    if (!match) continue;
    try {
      await markBookingPaid(booking, {
        provider: BANK_TRANSFER,
        paymentId: bankPaymentId(match, reference),
        amountCents: Math.round(Number(match.amount) * 100),
      });
      done.bookings.push(String(booking._id));
      logger.info(
        `[rendez-vous] virement ${reference} repéré pour la réservation ${booking._id}`,
      );
    } catch (error) {
      logger.error(
        `[rendez-vous] virement ${reference} de la réservation ${booking._id} : ${error.message}`,
      );
    }
  }
  return done;
}
