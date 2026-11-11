import { DateTime } from "luxon";
import emailReminderService from "../emailReminderService.js";
import { APP_URL, escapeHtml, renderEmail } from "../../utils/trialEmails.js";
import { buildIcsEvent, icsUid } from "../../utils/ics.js";
import {
  DEFAULT_TIMEZONE,
  isValidTimezone,
  locationLabel,
} from "../../utils/appointmentValidation.js";
import logger from "../../utils/logger.js";

/**
 * E-mails de la prise de rendez-vous : confirmation, déplacement,
 * annulation et rappels. Envoyés par Resend (repli SMTP), au nom de
 * « <Organisation> via Newbi » ; on répond à l'organisateur depuis un
 * e-mail de l'invité, et inversement.
 *
 * Les heures sont affichées dans le fuseau du destinataire : celui choisi
 * par l'invité pour lui, celui de la page pour l'organisateur. Aucun
 * émoji ni icône, typographie via renderEmail (typo()).
 */

export const DASHBOARD_PATH = "/dashboard/outils/rendez-vous";

const P =
  'style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;"';
const ROW =
  'style="font-size: 15px; color: #4b5563; margin: 0 0 12px 0; line-height: 1.6;"';
const LABEL = 'style="color: #1a1a1a; font-weight: 600;"';
const LINK =
  'style="color: #5b50ff; text-decoration: underline; word-break: break-all;"';
const STRONG = 'style="color: #1a1a1a;"';

const appUrl = () => String(APP_URL).replace(/\/+$/, "");

export const manageUrlFor = (token) => `${appUrl()}/rdv/gerer/${token}`;
export const publicPageUrl = (slug, typeSlug) =>
  `${appUrl()}/rdv/${slug}${typeSlug ? `/${typeSlug}` : ""}`;

/** « heure de Paris », « heure de New York », « heure UTC ». */
export function zoneLabel(zone) {
  if (!zone || zone === "UTC" || zone === "Etc/UTC") return "heure UTC";
  const city = zone.split("/").pop().replace(/_/g, " ");
  return `heure de ${city}`;
}

/** Date, heures et fuseau d'un rendez-vous dans un fuseau donné. */
export function formatWhen(startAt, endAt, zone) {
  const tz = isValidTimezone(zone) ? zone : DEFAULT_TIMEZONE;
  const start = DateTime.fromJSDate(new Date(startAt), { zone: tz }).setLocale(
    "fr",
  );
  const end = DateTime.fromJSDate(new Date(endAt), { zone: tz }).setLocale(
    "fr",
  );
  return {
    date: start.toFormat("cccc d LLLL yyyy"),
    shortDate: start.toFormat("cccc d LLLL"),
    start: start.toFormat("HH:mm"),
    end: end.toFormat("HH:mm"),
    zone: zoneLabel(tz),
  };
}

const guestName = (guest) =>
  [guest?.firstName, guest?.lastName].filter(Boolean).join(" ").trim();

const durationLabel = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} h ${String(rest).padStart(2, "0")}` : `${hours} h`;
};

const row = (label, valueHtml) =>
  `<p ${ROW}><span ${LABEL}>${escapeHtml(label)}</span><br>${valueHtml}</p>`;

const link = (url) =>
  `<a href="${escapeHtml(url)}" ${LINK}>${escapeHtml(url)}</a>`;

/** Lignes « Date », « Heure », « Durée » d'un rendez-vous. */
function whenRows(booking, zone) {
  const when = formatWhen(booking.startAt, booking.endAt, zone);
  return [
    row("Date", escapeHtml(when.date)),
    row("Heure", `De ${when.start} à ${when.end} (${escapeHtml(when.zone)})`),
    row("Durée", escapeHtml(durationLabel(booking.durationMinutes))),
  ].join("\n");
}

/** Ligne « Lieu » vue par l'invité. */
function guestLocationRow(booking, hostName) {
  const kind = booking.location?.kind;
  const label = escapeHtml(locationLabel(booking.location));
  if (kind === "PHONE") {
    const phone = booking.guest?.phone
      ? ` au ${escapeHtml(booking.guest.phone)}`
      : "";
    return row(
      "Lieu",
      `${label} : ${escapeHtml(hostName)} vous appellera${phone}.`,
    );
  }
  if (kind === "IN_PERSON") return row("Adresse", label);
  if (booking.meetingUrl)
    return row("Lieu", `${label}<br>${link(booking.meetingUrl)}`);
  return row("Lieu", label);
}

/** Ligne « Lieu » vue par l'organisateur. */
function hostLocationRow(booking) {
  const kind = booking.location?.kind;
  const label = escapeHtml(locationLabel(booking.location));
  if (kind === "PHONE") {
    return row("Lieu", `${label} : vous appelez votre invité.`);
  }
  if (kind === "IN_PERSON") return row("Adresse", label);
  if (booking.meetingUrl)
    return row("Lieu", `${label}<br>${link(booking.meetingUrl)}`);
  return row("Lieu", label);
}

/** Coordonnées et message de l'invité (e-mails de l'organisateur). */
function guestRows(booking) {
  const guest = booking.guest || {};
  const rows = [
    row("Invité", escapeHtml(guestName(guest))),
    row(
      "E-mail",
      `<a href="mailto:${escapeHtml(guest.email)}" ${LINK}>${escapeHtml(guest.email)}</a>`,
    ),
  ];
  if (guest.phone) rows.push(row("Téléphone", escapeHtml(guest.phone)));
  if (guest.message) {
    rows.push(
      row("Message", escapeHtml(guest.message).replace(/\r?\n/g, "<br>")),
    );
  }
  return rows.join("\n");
}

/** Lieu et lien d'un rendez-vous dans le fichier .ics. */
function icsLocation(booking) {
  if (booking.meetingUrl) return booking.meetingUrl;
  if (booking.location?.kind === "IN_PERSON") return booking.location.value;
  return locationLabel(booking.location);
}

/**
 * Fichier .ics du rendez-vous. SEQUENCE croissante à chaque déplacement
 * (et à l'annulation) : l'agenda de l'invité met l'événement à jour.
 */
export function bookingIcs(
  booking,
  { method = "PUBLISH", host, organizationName } = {},
) {
  const cancelled = method === "CANCEL";
  const sequence =
    (booking.rescheduleHistory?.length || 0) + (cancelled ? 1 : 0);
  const withName = host?.name ? ` avec ${host.name}` : "";
  const descriptionLines = [
    `${booking.typeName}${withName}${organizationName ? ` (${organizationName})` : ""}`,
  ];
  if (booking.meetingUrl) descriptionLines.push(`Lien : ${booking.meetingUrl}`);
  if (booking.location?.kind === "PHONE") {
    descriptionLines.push(
      "Appel téléphonique : l'organisateur vous appellera.",
    );
  }
  return buildIcsEvent({
    method,
    uid: icsUid(`rendez-vous-${booking._id}`),
    sequence,
    start: booking.startAt,
    end: booking.endAt,
    summary: `${booking.typeName}${withName}`,
    description: descriptionLines.join("\n"),
    location: icsLocation(booking),
    url: booking.meetingUrl || undefined,
    organizer: host?.email ? { name: host.name, email: host.email } : undefined,
    attendee: booking.guest?.email
      ? { name: guestName(booking.guest), email: booking.guest.email }
      : undefined,
  });
}

const icsAttachment = (content, method) => ({
  filename: method === "CANCEL" ? "annulation.ics" : "rendez-vous.ics",
  content: Buffer.from(content, "utf8"),
  contentType: `text/calendar; charset=utf-8; method=${method}`,
});

const guestFooter = (organizationName) =>
  `Vous recevez cet e-mail car vous avez pris rendez-vous avec ${escapeHtml(organizationName)} via Newbi`;

// ─── Constructeurs (purs) ─────────────────────────────────────────────────

/** Confirmation à l'invité, avec invitation .ics (METHOD:REQUEST). */
export function buildGuestConfirmationEmail({
  booking,
  host,
  organizationName,
  manageUrl,
}) {
  const zone = booking.guest?.timezone;
  const when = formatWhen(booking.startAt, booking.endAt, zone);
  const warning =
    booking.meetingWarning && !booking.meetingUrl
      ? `<p ${P}>Le lien de visioconférence vous sera envoyé par ${escapeHtml(host.name)} avant le rendez-vous.</p>`
      : "";
  const html = renderEmail({
    preheader: `${booking.typeName} le ${when.shortDate} à ${when.start}`,
    badge: "RENDEZ-VOUS CONFIRMÉ",
    iconLabel: "Confirmé",
    iconBg: "#dcfce7",
    iconColor: "#166534",
    title: "Votre rendez-vous est confirmé",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(booking.guest.firstName)},</p>
          <p ${P}>Votre rendez-vous <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong> avec ${escapeHtml(host.name)} (${escapeHtml(organizationName)}) est confirmé.</p>
          ${whenRows(booking, zone)}
          ${guestLocationRow(booking, host.name)}
          ${warning}
          <p ${P}>Le fichier joint ajoute le rendez-vous à votre agenda. Pour le déplacer ou l'annuler, utilisez le bouton ci-dessous.</p>`,
    ctaLabel: "Gérer mon rendez-vous",
    ctaUrl: manageUrl,
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: `Rendez-vous confirmé le ${when.shortDate} à ${when.start}`,
    html,
    attachments: [
      icsAttachment(
        bookingIcs(booking, { method: "REQUEST", host, organizationName }),
        "REQUEST",
      ),
    ],
  };
}

/** Nouveau rendez-vous, pour l'organisateur. */
export function buildHostNewBookingEmail({
  booking,
  host,
  organizationName,
  pageTimezone,
}) {
  const when = formatWhen(booking.startAt, booking.endAt, pageTimezone);
  const name = guestName(booking.guest);
  const warning = booking.meetingWarning
    ? `<p ${P}><strong ${STRONG}>Lien de visioconférence non créé :</strong> ${escapeHtml(booking.meetingWarning)} Envoyez un lien à votre invité avant le rendez-vous.</p>`
    : "";
  const html = renderEmail({
    preheader: `${name} a réservé « ${booking.typeName} » le ${when.shortDate} à ${when.start}`,
    badge: "NOUVEAU RENDEZ-VOUS",
    iconLabel: "Réservé",
    iconBg: "#ede9fe",
    iconColor: "#5b21b6",
    title: `Nouveau rendez-vous avec ${name}`,
    bodyHtml: `
          <p ${P}>${escapeHtml(name)} a réservé <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong> sur votre page de prise de rendez-vous.</p>
          ${whenRows(booking, pageTimezone)}
          ${hostLocationRow(booking)}
          ${guestRows(booking)}
          ${warning}`,
    ctaLabel: "Voir mes rendez-vous",
    ctaUrl: `${appUrl()}${DASHBOARD_PATH}`,
  });
  return {
    subject: `Nouveau rendez-vous : ${name}, le ${when.shortDate} à ${when.start}`,
    html,
    attachments: [
      icsAttachment(
        bookingIcs(booking, { method: "PUBLISH", host, organizationName }),
        "PUBLISH",
      ),
    ],
  };
}

/** Rendez-vous déplacé par l'invité : confirmation à l'invité. */
export function buildGuestRescheduledEmail({
  booking,
  host,
  organizationName,
  manageUrl,
}) {
  const zone = booking.guest?.timezone;
  const when = formatWhen(booking.startAt, booking.endAt, zone);
  const html = renderEmail({
    preheader: `Nouvel horaire : le ${when.shortDate} à ${when.start}`,
    badge: "RENDEZ-VOUS DÉPLACÉ",
    iconLabel: "Nouvel horaire",
    iconBg: "#e0f2fe",
    iconColor: "#075985",
    title: "Votre rendez-vous a été déplacé",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(booking.guest.firstName)},</p>
          <p ${P}>Votre rendez-vous <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong> avec ${escapeHtml(host.name)} (${escapeHtml(organizationName)}) a bien été déplacé. Voici le nouvel horaire.</p>
          ${whenRows(booking, zone)}
          ${guestLocationRow(booking, host.name)}
          <p ${P}>Le fichier joint met à jour le rendez-vous dans votre agenda.</p>`,
    ctaLabel: "Gérer mon rendez-vous",
    ctaUrl: manageUrl,
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: `Rendez-vous déplacé au ${when.shortDate} à ${when.start}`,
    html,
    attachments: [
      icsAttachment(
        bookingIcs(booking, { method: "REQUEST", host, organizationName }),
        "REQUEST",
      ),
    ],
  };
}

/** Rendez-vous déplacé par l'invité : prévenir l'organisateur. */
export function buildHostRescheduledEmail({
  booking,
  previousStartAt,
  pageTimezone,
}) {
  const when = formatWhen(booking.startAt, booking.endAt, pageTimezone);
  const before = formatWhen(
    previousStartAt,
    new Date(
      new Date(previousStartAt).getTime() + booking.durationMinutes * 60000,
    ),
    pageTimezone,
  );
  const name = guestName(booking.guest);
  const html = renderEmail({
    preheader: `${name} a déplacé son rendez-vous au ${when.shortDate} à ${when.start}`,
    badge: "RENDEZ-VOUS DÉPLACÉ",
    iconLabel: "Nouvel horaire",
    iconBg: "#e0f2fe",
    iconColor: "#075985",
    title: `${name} a déplacé son rendez-vous`,
    bodyHtml: `
          <p ${P}>Le rendez-vous <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong> prévu le ${escapeHtml(before.date)} à ${before.start} a été déplacé par votre invité.</p>
          ${whenRows(booking, pageTimezone)}
          ${hostLocationRow(booking)}
          ${guestRows(booking)}`,
    ctaLabel: "Voir mes rendez-vous",
    ctaUrl: `${appUrl()}${DASHBOARD_PATH}`,
  });
  return {
    subject: `Rendez-vous déplacé : ${name}, le ${when.shortDate} à ${when.start}`,
    html,
    attachments: [],
  };
}

/** Annulation par l'invité : prévenir l'organisateur. */
export function buildHostCancelledEmail({ booking, pageTimezone }) {
  const when = formatWhen(booking.startAt, booking.endAt, pageTimezone);
  const name = guestName(booking.guest);
  const reason = booking.cancelReason
    ? row("Motif", escapeHtml(booking.cancelReason).replace(/\r?\n/g, "<br>"))
    : "";
  const html = renderEmail({
    preheader: `${name} a annulé le rendez-vous du ${when.shortDate} à ${when.start}`,
    badge: "RENDEZ-VOUS ANNULÉ",
    iconLabel: "Annulé",
    iconBg: "#fee2e2",
    iconColor: "#991b1b",
    title: `${name} a annulé son rendez-vous`,
    bodyHtml: `
          <p ${P}>Le rendez-vous <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong> a été annulé par votre invité. Le créneau est de nouveau libre.</p>
          ${whenRows(booking, pageTimezone)}
          ${guestRows(booking)}
          ${reason}`,
    ctaLabel: "Voir mes rendez-vous",
    ctaUrl: `${appUrl()}${DASHBOARD_PATH}`,
  });
  return {
    subject: `Rendez-vous annulé : ${name}, le ${when.shortDate} à ${when.start}`,
    html,
    attachments: [],
  };
}

/** Annulation par l'organisateur : prévenir l'invité (.ics METHOD:CANCEL). */
export function buildGuestCancelledEmail({
  booking,
  host,
  organizationName,
  rebookUrl,
}) {
  const zone = booking.guest?.timezone;
  const when = formatWhen(booking.startAt, booking.endAt, zone);
  const reason = booking.cancelReason
    ? row("Motif", escapeHtml(booking.cancelReason).replace(/\r?\n/g, "<br>"))
    : "";
  const html = renderEmail({
    preheader: `Le rendez-vous du ${when.shortDate} à ${when.start} est annulé`,
    badge: "RENDEZ-VOUS ANNULÉ",
    iconLabel: "Annulé",
    iconBg: "#fee2e2",
    iconColor: "#991b1b",
    title: "Votre rendez-vous a été annulé",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(booking.guest.firstName)},</p>
          <p ${P}>${escapeHtml(host.name)} (${escapeHtml(organizationName)}) a annulé votre rendez-vous <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong>.</p>
          ${whenRows(booking, zone)}
          ${reason}
          <p ${P}>Le fichier joint retire le rendez-vous de votre agenda. Vous pouvez choisir un autre créneau quand vous le souhaitez.</p>`,
    ctaLabel: "Choisir un autre créneau",
    ctaUrl: rebookUrl,
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: `Rendez-vous annulé : ${booking.typeName} le ${when.shortDate}`,
    html,
    attachments: [
      icsAttachment(
        bookingIcs(booking, { method: "CANCEL", host, organizationName }),
        "CANCEL",
      ),
    ],
  };
}

/** Rappel à l'invité, 24 h ou 1 h avant. */
export function buildGuestReminderEmail({
  booking,
  host,
  organizationName,
  manageUrl,
  kind,
}) {
  const zone = booking.guest?.timezone;
  const when = formatWhen(booking.startAt, booking.endAt, zone);
  const soon = kind === "h1";
  const html = renderEmail({
    preheader: `${booking.typeName} le ${when.shortDate} à ${when.start}`,
    badge: "RAPPEL DE RENDEZ-VOUS",
    iconLabel: soon ? "Dans une heure" : "Demain",
    iconBg: "#fef3c7",
    iconColor: "#92400e",
    title: soon
      ? "Votre rendez-vous commence bientôt"
      : "Votre rendez-vous approche",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(booking.guest.firstName)},</p>
          <p ${P}>Petit rappel de votre rendez-vous <strong ${STRONG}>«\u00a0${escapeHtml(booking.typeName)}\u00a0»</strong> avec ${escapeHtml(host.name)} (${escapeHtml(organizationName)}).</p>
          ${whenRows(booking, zone)}
          ${guestLocationRow(booking, host.name)}
          <p ${P}>Un empêchement ? Déplacez ou annulez le rendez-vous avec le bouton ci-dessous.</p>`,
    ctaLabel: manageUrl
      ? "Gérer mon rendez-vous"
      : "Voir la page de rendez-vous",
    ctaUrl: manageUrl || appUrl(),
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: soon
      ? `Rappel : votre rendez-vous à ${when.start}`
      : `Rappel : votre rendez-vous le ${when.shortDate} à ${when.start}`,
    html,
    attachments: [],
  };
}

// ─── Envoi ────────────────────────────────────────────────────────────────

/** « Cabinet Martin via Newbi » : guillemets et chevrons retirés. */
export function senderName(organizationName) {
  const clean = String(organizationName || "")
    .replace(/[<>"\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return clean ? `${clean} via Newbi` : "Newbi";
}

/**
 * Envoie un e-mail de rendez-vous (Resend en priorité, repli SMTP).
 * @returns {Promise<boolean>} true si parti
 */
export async function deliverBookingEmail({
  to,
  subject,
  html,
  attachments = [],
  replyTo,
  organizationName,
}) {
  if (!to) return false;
  const fromName = senderName(organizationName);
  try {
    if (emailReminderService.useResend && emailReminderService.resend) {
      const { error } = await emailReminderService.resend.emails.send({
        from: `${fromName} <${emailReminderService.resendFromEmail}>`,
        to: [to],
        subject,
        html,
        ...(replyTo ? { replyTo } : {}),
        ...(attachments.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
              })),
            }
          : {}),
      });
      if (error) throw new Error(error.message || "erreur Resend");
      return true;
    }
    if (!emailReminderService.transporter) {
      throw new Error("aucun service d'e-mail configuré (ni Resend, ni SMTP)");
    }
    await emailReminderService.transporter.sendMail({
      from: `"${fromName}" <${emailReminderService.fromEmail}>`,
      to,
      subject,
      html,
      ...(replyTo ? { replyTo } : {}),
      attachments,
    });
    return true;
  } catch (error) {
    logger.error(
      `[rendez-vous] e-mail « ${subject} » non envoyé : ${error.message}`,
    );
    return false;
  }
}
