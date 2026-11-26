/**
 * Paiements de la prise de rendez-vous (inscriptions aux événements et
 * rendez-vous payants) : briques communes du virement et des avis à
 * l'organisateur.
 *
 * Virement : référence `NB-XXXXXX` unique dans l'espace, place ou créneau
 * gardé 3 jours, coordonnées montrées au payeur (IBAN de l'entreprise).
 * Jamais de confirmation sur la seule annonce « J'ai fait le virement » :
 * seulement au repérage bancaire (voir appointmentBankDetection.js) ou au
 * « Marquer comme payé » de l'organisateur.
 */
import mongoose from "mongoose";
import Booking from "../../models/Booking.js";
import EventRegistration from "../../models/EventRegistration.js";
import FileTransfer from "../../models/FileTransfer.js";
import Notification from "../../models/Notification.js";
import User from "../../models/User.js";
import {
  generatePaymentReference,
  getOrganizationBankAccount,
  hasConnectedBank,
} from "../payments/bankTransfer.js";
import { workspaceKey } from "../payments/directPayments.js";
import { APP_URL, escapeHtml, renderEmail } from "../../utils/trialEmails.js";
import { DASHBOARD_PATH, deliverBookingEmail } from "./bookingEmails.js";
import logger from "../../utils/logger.js";
import { formatCents } from "../../utils/paymentLine.js";

export { formatCents, paymentLineOf } from "../../utils/paymentLine.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Place ou créneau gardé pour un paiement par carte, PayPal ou SumUp. */
export const ONLINE_HOLD_MS = 30 * MINUTE;
/** Place ou créneau gardé pour un virement. */
export const BANK_TRANSFER_HOLD_MS = 3 * DAY;

export const BANK_TRANSFER = "bank_transfer";

const iso = (date) => (date ? new Date(date).toISOString() : null);
const appUrl = () => String(APP_URL).replace(/\/+$/, "");

/**
 * Référence de virement libre dans l'espace (aucune autre inscription,
 * réservation ou transfert ne la porte) : un crédit bancaire ne règle
 * jamais deux paiements.
 */
export async function newBankReference(workspaceId) {
  const orgId = workspaceKey(workspaceId);
  const objectId =
    orgId && mongoose.Types.ObjectId.isValid(orgId)
      ? new mongoose.Types.ObjectId(orgId)
      : null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const reference = generatePaymentReference();
    const [registration, booking, transfer] = await Promise.all([
      objectId
        ? EventRegistration.exists({
            workspaceId: objectId,
            "payment.bankReference": reference,
          })
        : null,
      objectId
        ? Booking.exists({
            workspaceId: objectId,
            "payment.bankReference": reference,
          })
        : null,
      FileTransfer.exists({ workspaceId: orgId, paymentReference: reference }),
    ]);
    if (!registration && !booking && !transfer) return reference;
  }
  // Huit tirages pris sur un milliard de références : hautement improbable
  return generatePaymentReference();
}

/**
 * Coordonnées de virement montrées au payeur (null si le moyen n'est pas
 * le virement, si le paiement n'est plus attendu ou sans IBAN).
 *
 * @param {object} doc - inscription ou réservation
 * @param {object} params
 * @param {number} params.amountCents - montant exact à virer
 * @param {string} params.currency
 */
export async function bankTransferPayload(doc, { amountCents, currency }) {
  const payment = doc?.payment || {};
  if (
    payment.provider !== BANK_TRANSFER ||
    doc.status !== "PENDING_PAYMENT" ||
    payment.paidAt ||
    !payment.bankReference
  ) {
    return null;
  }
  const [account, autoDetect] = await Promise.all([
    getOrganizationBankAccount(doc.workspaceId),
    hasConnectedBank(doc.workspaceId),
  ]);
  if (!account) return null;
  return {
    holder: account.holder,
    iban: account.iban,
    bic: account.bic,
    bankName: account.bankName,
    reference: payment.bankReference,
    amount: amountCents,
    currency: currency || "EUR",
    dueAt: iso(doc.expiresAt),
    declaredAt: iso(payment.declaredAt),
    autoDetect,
  };
}

/**
 * « J'ai fait le virement » (ou son retrait, `cancel`) sur une inscription
 * ou une réservation en attente de virement. Rien n'est confirmé.
 * @param {mongoose.Model} Model - EventRegistration ou Booking
 * @returns {Promise<{doc: object, firstDeclaration: boolean}|null>} null si
 *   le virement n'est plus attendu
 */
export async function declareBankTransfer(Model, doc, { cancel = false }) {
  const waiting = {
    _id: doc._id,
    status: "PENDING_PAYMENT",
    "payment.provider": BANK_TRANSFER,
    "payment.paidAt": null,
  };
  if (cancel) {
    const reverted = await Model.findOneAndUpdate(
      waiting,
      { $unset: { "payment.declaredAt": "" } },
      { new: true },
    );
    return reverted ? { doc: reverted, firstDeclaration: false } : null;
  }
  const declared = await Model.findOneAndUpdate(
    { ...waiting, "payment.declaredAt": null },
    { $set: { "payment.declaredAt": new Date() } },
    { new: true },
  );
  if (declared) return { doc: declared, firstDeclaration: true };
  const current = await Model.findOne(waiting);
  return current ? { doc: current, firstDeclaration: false } : null;
}

// ─── E-mails au payeur ───────────────────────────────────────────────────

const P =
  'style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;"';
const ROW =
  'style="font-size: 15px; color: #4b5563; margin: 0 0 12px 0; line-height: 1.6;"';
const LABEL = 'style="color: #1a1a1a; font-weight: 600;"';
const STRONG = 'style="color: #1a1a1a;"';

const row = (label, valueHtml) =>
  `<p ${ROW}><span ${LABEL}>${escapeHtml(label)}</span><br>${valueHtml}</p>`;

const dueLabel = (date) =>
  new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  }).format(new Date(date));

/**
 * Réservation en attente de virement : coordonnées bancaires, montant,
 * référence, échéance, lien de la réservation.
 *
 * @param {object} params
 * @param {"event"|"slot"} params.kind
 * @param {string} params.firstName
 * @param {string} params.title - nom de l'événement ou du rendez-vous
 * @param {string} params.whenText - « samedi 12 décembre à 18:00 »
 * @param {object} params.bank - BankTransferPayload
 * @param {string} params.organizationName
 * @param {string|null} params.manageUrl
 */
export function buildBankTransferPendingEmail({
  kind,
  firstName,
  title,
  whenText,
  bank,
  organizationName,
  manageUrl,
}) {
  const amount = formatCents(bank.amount, bank.currency);
  const what = kind === "slot" ? "votre rendez-vous" : "votre inscription";
  const kept =
    kind === "slot" ? "Le créneau est gardé" : "Vos places sont gardées";
  const html = renderEmail({
    preheader: `Virement de ${amount} à faire avant le ${dueLabel(bank.dueAt)}`,
    badge: "VIREMENT EN ATTENTE",
    iconLabel: "En attente",
    iconBg: "#fef3c7",
    iconColor: "#92400e",
    title: "Il reste à faire votre virement",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(firstName)},</p>
          <p ${P}>Pour confirmer ${what} <strong ${STRONG}>«\u00a0${escapeHtml(title)}\u00a0»</strong>${whenText ? ` (${escapeHtml(whenText)})` : ""}, faites un virement de <strong ${STRONG}>${escapeHtml(amount)}</strong> à ${escapeHtml(bank.holder || organizationName)} avec la référence ci-dessous dans le libellé.</p>
          ${row("Montant", escapeHtml(amount))}
          ${row("Référence à indiquer", `<strong ${STRONG}>${escapeHtml(bank.reference)}</strong>`)}
          ${bank.holder ? row("Titulaire", escapeHtml(bank.holder)) : ""}
          ${row("IBAN", escapeHtml(bank.iban))}
          ${bank.bic ? row("BIC", escapeHtml(bank.bic)) : ""}
          <p ${P}>${kept} jusqu'au ${escapeHtml(dueLabel(bank.dueAt))}. La confirmation vous sera envoyée par e-mail dès que le virement sera arrivé.</p>`,
    ctaLabel: manageUrl ? "Voir ma réservation" : undefined,
    ctaUrl: manageUrl || undefined,
    footerNoteHtml: `Vous recevez cet e-mail car vous avez réservé auprès de ${escapeHtml(organizationName)} via Newbi`,
  });
  return {
    subject: `Virement de ${amount} en attente : ${title}`,
    html,
    attachments: [],
  };
}

/** Réservation expirée faute de paiement (place ou créneau rendu). */
export function buildPaymentExpiredEmail({
  kind,
  firstName,
  title,
  bankTransfer,
  organizationName,
  rebookUrl,
}) {
  const what = kind === "slot" ? "votre rendez-vous" : "votre inscription";
  const reason = bankTransfer
    ? "le virement n'est pas arrivé dans les 3 jours"
    : "le paiement n'a pas été finalisé";
  const freed =
    kind === "slot"
      ? "Le créneau a été libéré."
      : "Les places ont été libérées.";
  const html = renderEmail({
    preheader: `Réservation expirée : ${title}`,
    badge: "RÉSERVATION EXPIRÉE",
    iconLabel: "Expirée",
    iconBg: "#fee2e2",
    iconColor: "#991b1b",
    title: "Votre réservation a expiré",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(firstName)},</p>
          <p ${P}>${escapeHtml(what.charAt(0).toUpperCase() + what.slice(1))} <strong ${STRONG}>«\u00a0${escapeHtml(title)}\u00a0»</strong> n'a pas été confirmé${kind === "slot" ? "" : "e"} : ${escapeHtml(reason)}. ${escapeHtml(freed)}</p>
          <p ${P}>${
            bankTransfer
              ? `Si vous avez déjà fait le virement, contactez ${escapeHtml(organizationName)} : il sera confirmé s'il reste de la place, sinon remboursé.`
              : "Vous pouvez réserver de nouveau."
          }</p>`,
    ctaLabel: rebookUrl ? "Réserver de nouveau" : undefined,
    ctaUrl: rebookUrl || undefined,
    footerNoteHtml: `Vous recevez cet e-mail car vous avez réservé auprès de ${escapeHtml(organizationName)} via Newbi`,
  });
  return { subject: `Réservation expirée : ${title}`, html, attachments: [] };
}

// ─── Avis à l'organisateur ───────────────────────────────────────────────

/** Organisateur, s'il accepte les e-mails « paiement reçu ». */
async function hostEmailRecipient(hostUserId) {
  const host = await User.findById(hostUserId)
    .select("email notificationPreferences")
    .lean();
  if (!host?.email) return null;
  if (host.notificationPreferences?.payment_received?.email === false) {
    return null;
  }
  return host.email;
}

async function notifyHostInApp({
  hostUserId,
  workspaceId,
  type,
  title,
  message,
  amountCents,
}) {
  const orgId = workspaceKey(workspaceId);
  if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) return;
  try {
    const notification = await Notification.create({
      userId: hostUserId,
      workspaceId: new mongoose.Types.ObjectId(orgId),
      type,
      title,
      message,
      data: {
        url: DASHBOARD_PATH,
        amountTTC: amountCents != null ? amountCents / 100 : undefined,
      },
    });
    const [{ publishNotification }, { sendNotificationPush }] =
      await Promise.all([
        import("../../resolvers/notification.js"),
        import("../notificationPushService.js"),
      ]);
    await publishNotification(notification).catch(() => {});
    await sendNotificationPush(notification);
  } catch (error) {
    logger.warn(
      `[rendez-vous] notification à l'organisateur non créée : ${error.message}`,
    );
  }
}

function hostEmail({ badge, title, paragraphs, rows, ctaLabel }) {
  return renderEmail({
    preheader: title,
    badge,
    title,
    bodyHtml: `
          ${paragraphs.map((text) => `<p ${P}>${escapeHtml(text)}</p>`).join("\n")}
          ${rows
            .filter(Boolean)
            .map(([label, value]) => row(label, escapeHtml(value)))
            .join("\n")}`,
    ctaLabel,
    ctaUrl: `${appUrl()}${DASHBOARD_PATH}`,
  });
}

/**
 * Virement annoncé par le payeur : e-mail et notification à l'organisateur
 * (une seule fois par annonce).
 *
 * @param {object} params
 * @param {string} params.label - « l'événement « Soirée » » / « le rendez-vous « Démo » le … »
 */
export async function notifyHostBankDeclared({
  hostUserId,
  workspaceId,
  payerName,
  payerEmail,
  amountCents,
  currency,
  reference,
  label,
}) {
  const amount = formatCents(amountCents, currency);
  const autoDetect = await hasConnectedBank(workspaceId);
  const who = payerName || payerEmail || "Votre client";
  const next = autoDetect
    ? "Votre compte bancaire est connecté à Newbi : la réservation sera confirmée toute seule dès que le virement y arrivera."
    : "Dès que vous le voyez sur votre compte, confirmez la réservation avec « Marquer comme payé ».";
  await notifyHostInApp({
    hostUserId,
    workspaceId,
    type: "APPOINTMENT_BANK_DECLARED",
    title: "Virement annoncé",
    message: `${who} indique avoir payé ${amount} par virement pour ${label} (réf. ${reference}). ${next}`,
    amountCents,
  });
  const to = await hostEmailRecipient(hostUserId);
  if (!to) return false;
  return deliverBookingEmail({
    to,
    replyTo: payerEmail || undefined,
    organizationName: "Newbi",
    subject: `Virement annoncé : ${amount}`,
    html: hostEmail({
      badge: "VIREMENT ANNONCÉ",
      title: "Votre client a fait un virement",
      paragraphs: [
        `${who} indique avoir fait un virement de ${amount} pour ${label}.`,
        next,
      ],
      rows: [
        ["Montant", amount],
        ["Référence du virement", reference],
        payerEmail ? ["Annoncé par", payerEmail] : null,
      ],
      ctaLabel: autoDetect ? "Voir mes rendez-vous" : "Vérifier et confirmer",
    }),
  });
}

/**
 * Paiement arrivé sans place ou sans créneau, non remboursable
 * automatiquement : à rembourser à la main (jamais perdu en silence).
 */
export async function notifyHostRefundNeeded({
  hostUserId,
  workspaceId,
  payerName,
  payerEmail,
  amountCents,
  currency,
  provider,
  reference,
  label,
}) {
  const amount = formatCents(amountCents, currency);
  const who = payerName || payerEmail || "Un client";
  const how =
    provider === BANK_TRANSFER
      ? "Remboursez-le par virement depuis votre banque."
      : "Remboursez-le depuis votre compte Stripe, PayPal ou SumUp.";
  await notifyHostInApp({
    hostUserId,
    workspaceId,
    type: "APPOINTMENT_REFUND_NEEDED",
    title: "Remboursement à faire",
    message: `${who} a payé ${amount} pour ${label}, mais la réservation avait expiré et la place n'est plus libre. ${how}`,
    amountCents,
  });
  const to = await hostEmailRecipient(hostUserId);
  if (!to) return false;
  return deliverBookingEmail({
    to,
    replyTo: payerEmail || undefined,
    organizationName: "Newbi",
    subject: `Remboursement à faire : ${amount}`,
    html: hostEmail({
      badge: "REMBOURSEMENT À FAIRE",
      title: "Un paiement est arrivé trop tard",
      paragraphs: [
        `${who} a payé ${amount} pour ${label}, mais la réservation avait expiré et la place a été reprise entre-temps.`,
        how,
      ],
      rows: [
        ["Montant", amount],
        reference ? ["Référence", reference] : null,
        payerEmail ? ["Payeur", payerEmail] : null,
      ],
      ctaLabel: "Voir mes rendez-vous",
    }),
  });
}
