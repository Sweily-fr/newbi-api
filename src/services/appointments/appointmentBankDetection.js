/**
 * Virements des rendez-vous et inscriptions payants repérés sur le compte
 * bancaire synchronisé par Bridge (appelé après chaque synchronisation,
 * comme pour les transferts payants) : chaque crédit dont le libellé porte
 * la référence `NB-XXXXXX` d'un paiement attendu, d'au moins son montant et
 * dans sa devise, le règle.
 *
 * - en attente, dans la garde et avant le début : confirmé (billets,
 *   agenda, e-mails) ;
 * - garde échue (expiré, ou échéance passée) ou début passé : RIEN n'est
 *   confirmé tout seul. Le virement est noté sur la réservation
 *   (payment.receivedAt) et l'organisateur est prévenu « virement reçu, à
 *   valider » : il décide (« Marquer comme payé » ou remboursement) ;
 * - annulé : signalé à l'organisateur « à rembourser à la main ».
 */
import mongoose from "mongoose";
import Booking from "../../models/Booking.js";
import EventRegistration, {
  expectedOnlineAmount,
} from "../../models/EventRegistration.js";
import {
  bankPaymentId,
  claimBankCredit,
  findBankCredit,
  labelledCredits,
  releaseBankCredit,
} from "../payments/bankTransfer.js";
import { workspaceKey } from "../payments/directPayments.js";
import {
  BANK_TRANSFER,
  bankTransferArrivedLate,
  notifyHostBankReceivedLate,
} from "./appointmentPayments.js";
import { markRegistrationPaid } from "./eventRegistrationService.js";
import {
  expectedBookingAmount,
  markBookingPaid,
} from "./bookingPaymentService.js";
import logger from "../../utils/logger.js";

// Virement tardif cherché jusqu'à 60 jours après la réservation
const LATE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Virement tardif noté sur la réservation (une seule fois) puis signalé à
 * l'organisateur. @returns {Promise<boolean>} noté par cet appel
 */
async function holdLateTransfer(Model, doc, { match, reference, notice }) {
  const noted = await Model.findOneAndUpdate(
    { _id: doc._id, "payment.paidAt": null, "payment.receivedAt": null },
    {
      $set: {
        "payment.receivedAt": new Date(),
        "payment.receivedAmount": Math.round(Number(match.amount) * 100),
        "payment.receivedPaymentId": bankPaymentId(match, reference),
      },
    },
    { new: true },
  );
  if (!noted) return false;
  await notifyHostBankReceivedLate(notice).catch((error) =>
    logger.error(
      `[rendez-vous] avis de virement tardif ${reference} : ${error.message}`,
    ),
  );
  return true;
}

const candidatesFilter = (workspaceId, now) => ({
  workspaceId,
  "payment.provider": BANK_TRANSFER,
  "payment.bankReference": { $type: "string" },
  "payment.paidAt": null,
  // Virement tardif déjà noté : l'organisateur décide
  "payment.receivedAt": null,
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
    // Un crédit ne règle qu'une seule chose (contrôle en base)
    const claim = {
      workspaceId: orgId,
      transaction: match,
      targetKind: "event_registration",
      targetId: registration._id,
      reference,
    };
    if (!(await claimBankCredit(claim))) continue;
    try {
      const startAt = registration.event?.startAt;
      if (
        registration.status !== "CANCELLED" &&
        bankTransferArrivedLate(registration, startAt, now)
      ) {
        const amountCents = Math.round(Number(match.amount) * 100);
        await holdLateTransfer(EventRegistration, registration, {
          match,
          reference,
          notice: {
            hostUserId: registration.hostUserId,
            workspaceId: registration.workspaceId,
            payerName:
              `${registration.buyer?.firstName || ""} ${registration.buyer?.lastName || ""}`.trim(),
            payerEmail: registration.buyer?.email,
            amountCents,
            currency: registration.currency,
            reference,
            label: `l'événement « ${registration.event?.name} »`,
            started: Boolean(startAt && new Date(startAt) <= now),
          },
        });
        done.registrations.push(String(registration._id));
        logger.info(
          `[billetterie] virement ${reference} repéré après la garde pour l'inscription ${registration._id} : à valider par l'organisateur`,
        );
        continue;
      }
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
      await releaseBankCredit(claim).catch(() => {});
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
    const claim = {
      workspaceId: orgId,
      transaction: match,
      targetKind: "appointment_booking",
      targetId: booking._id,
      reference,
    };
    if (!(await claimBankCredit(claim))) continue;
    try {
      if (
        booking.status !== "CANCELLED" &&
        bankTransferArrivedLate(booking, booking.startAt, now)
      ) {
        await holdLateTransfer(Booking, booking, {
          match,
          reference,
          notice: {
            hostUserId: booking.hostUserId,
            workspaceId: booking.workspaceId,
            payerName:
              `${booking.guest?.firstName || ""} ${booking.guest?.lastName || ""}`.trim(),
            payerEmail: booking.guest?.email,
            amountCents: Math.round(Number(match.amount) * 100),
            currency: booking.currency,
            reference,
            label: `le rendez-vous « ${booking.typeName} »`,
            started: new Date(booking.startAt) <= now,
          },
        });
        done.bookings.push(String(booking._id));
        logger.info(
          `[rendez-vous] virement ${reference} repéré après la garde pour la réservation ${booking._id} : à valider par l'organisateur`,
        );
        continue;
      }
      const result = await markBookingPaid(booking, {
        provider: BANK_TRANSFER,
        paymentId: bankPaymentId(match, reference),
        amountCents: Math.round(Number(match.amount) * 100),
      });
      // Verrou indisponible : rien d'enregistré, crédit libéré
      if (result.status === "pending") {
        await releaseBankCredit(claim);
        continue;
      }
      done.bookings.push(String(booking._id));
      logger.info(
        `[rendez-vous] virement ${reference} repéré pour la réservation ${booking._id}`,
      );
    } catch (error) {
      await releaseBankCredit(claim).catch(() => {});
      logger.error(
        `[rendez-vous] virement ${reference} de la réservation ${booking._id} : ${error.message}`,
      );
    }
  }
  return done;
}
