import { APP_URL, escapeHtml, renderEmail } from "../../utils/trialEmails.js";
import { buildIcsEvent, icsUid } from "../../utils/ics.js";
import { DASHBOARD_PATH, formatWhen } from "./bookingEmails.js";

/**
 * E-mails de la billetterie (événements de la prise de rendez-vous) :
 * confirmation au participant avec un bloc par billet (QR code en image
 * hébergée par l'API), nouvelle inscription à l'organisateur, rappel la
 * veille, annulation. Même présentation que les e-mails de rendez-vous,
 * sans émoji ni icône.
 */

const P =
  'style="font-size: 15px; color: #4b5563; margin: 0 0 16px 0; line-height: 1.6;"';
const ROW =
  'style="font-size: 15px; color: #4b5563; margin: 0 0 12px 0; line-height: 1.6;"';
const LABEL = 'style="color: #1a1a1a; font-weight: 600;"';
const LINK =
  'style="color: #5b50ff; text-decoration: underline; word-break: break-all;"';
const STRONG = 'style="color: #1a1a1a;"';

const appUrl = () => String(APP_URL).replace(/\/+$/, "");
const apiUrl = () =>
  String(
    process.env.BACKEND_URL || process.env.API_URL || "https://api.newbi.fr",
  ).replace(/\/+$/, "");

export const registrationManageUrlFor = (token) =>
  `${appUrl()}/rdv/inscription/${token}`;
export const ticketUrlFor = (token) => `${appUrl()}/rdv/billet/${token}`;
export const ticketQrUrlFor = (token) =>
  `${apiUrl()}/api/public/booking/tickets/${token}/qr.png`;
export const registrationIcsPath = (token) =>
  `/api/public/booking/registrations/${token}/ics`;

/** « 15,00 € » ; « Gratuit » pour 0. */
export function formatEventPrice(cents, currency = "EUR") {
  if (!cents) return "Gratuit";
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: currency || "EUR",
  })
    .format(cents / 100)
    .replace(/\u202f/g, "\u00a0");
}

const row = (label, valueHtml) =>
  `<p ${ROW}><span ${LABEL}>${escapeHtml(label)}</span><br>${valueHtml}</p>`;

const link = (url) =>
  `<a href="${escapeHtml(url)}" ${LINK}>${escapeHtml(url)}</a>`;

const buyerName = (buyer) =>
  [buyer?.firstName, buyer?.lastName].filter(Boolean).join(" ").trim();

const placesLabel = (quantity) =>
  `${quantity}\u00a0place${quantity > 1 ? "s" : ""}`;

/** Date et heure d'un événement (un ou plusieurs jours). */
function whenRows(event, zone) {
  const start = formatWhen(event.startAt, event.startAt, zone);
  const end = formatWhen(event.endAt, event.endAt, zone);
  if (start.date === end.date) {
    return [
      row("Date", escapeHtml(start.date)),
      row(
        "Heure",
        `De ${start.start} à ${end.start} (${escapeHtml(start.zone)})`,
      ),
    ].join("\n");
  }
  return row(
    "Dates",
    `Du ${escapeHtml(start.date)} à ${start.start}<br>au ${escapeHtml(end.date)} à ${end.start} (${escapeHtml(start.zone)})`,
  );
}

/** Lieu vu par le participant (lien seulement si l'inscription est confirmée). */
function locationRow(event, { showLink = true } = {}) {
  const location = event.location || {};
  if (location.kind === "IN_PERSON") {
    return row("Adresse", escapeHtml(location.value || "En personne"));
  }
  if (location.kind === "CUSTOM_LINK") {
    return row(
      "Lieu",
      showLink && location.value
        ? `En ligne<br>${link(location.value)}`
        : "En ligne",
    );
  }
  return "";
}

function ticketBlocks(tickets) {
  return tickets
    .map(
      (ticket, index) => `
          <div style="border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; margin: 0 0 16px 0; text-align: center;">
            <p style="font-size: 13px; color: #6b7280; margin: 0 0 8px 0;">Billet ${index + 1} sur ${tickets.length}</p>
            <img src="${escapeHtml(ticketQrUrlFor(ticket.token))}" width="180" height="180" alt="QR code du billet ${escapeHtml(ticket.number)}" style="display: block; margin: 0 auto 8px auto; width: 180px; height: 180px;">
            <p style="font-size: 16px; color: #1a1a1a; font-weight: 600; margin: 0 0 4px 0; letter-spacing: 1px;">${escapeHtml(ticket.number)}</p>
            <p style="font-size: 14px; color: #4b5563; margin: 0;">${escapeHtml(ticket.attendeeName)}</p>
            <p style="font-size: 13px; margin: 8px 0 0 0;"><a href="${escapeHtml(ticketUrlFor(ticket.token))}" style="color: #5b50ff; text-decoration: underline;">Ouvrir le billet</a></p>
          </div>`,
    )
    .join("\n");
}

const guestFooter = (organizationName) =>
  `Vous recevez cet e-mail car vous vous êtes inscrit à un événement de ${escapeHtml(organizationName)} via Newbi`;

/** Fichier .ics de l'événement (participant). */
export function registrationIcs(
  registration,
  { method = "PUBLISH", organizationName, host } = {},
) {
  const event = registration.event;
  const location =
    event.location?.kind === "CUSTOM_LINK"
      ? registration.status === "CONFIRMED"
        ? event.location.value
        : "En ligne"
      : event.location?.value || "";
  return buildIcsEvent({
    method,
    uid: icsUid(`inscription-${registration._id}`),
    sequence: method === "CANCEL" ? 1 : 0,
    start: event.startAt,
    end: event.endAt,
    summary: event.name,
    description: [
      `${event.name}${organizationName ? ` (${organizationName})` : ""}`,
      `${placesLabel(registration.quantity).replace("\u00a0", " ")}`,
    ].join("\n"),
    location,
    url:
      event.location?.kind === "CUSTOM_LINK" &&
      registration.status === "CONFIRMED"
        ? event.location.value
        : undefined,
    organizer: host?.email ? { name: host.name, email: host.email } : undefined,
    attendee: registration.buyer?.email
      ? { name: buyerName(registration.buyer), email: registration.buyer.email }
      : undefined,
  });
}

const icsAttachment = (content, method) => ({
  filename: method === "CANCEL" ? "annulation.ics" : "evenement.ics",
  content: Buffer.from(content, "utf8"),
  contentType: `text/calendar; charset=utf-8; method=${method}`,
});

const eventZone = (registration) =>
  registration.buyer?.timezone || registration.event?.timezone;

/** Confirmation au participant, avec ses billets. */
export function buildEventConfirmationEmail({
  registration,
  tickets,
  organizationName,
  host,
  manageUrl,
}) {
  const event = registration.event;
  const when = formatWhen(event.startAt, event.endAt, eventZone(registration));
  const paid = registration.amount > 0;
  const html = renderEmail({
    preheader: `${event.name} le ${when.shortDate} à ${when.start}`,
    badge: "INSCRIPTION CONFIRMÉE",
    iconLabel: "Confirmé",
    iconBg: "#dcfce7",
    iconColor: "#166534",
    title: "Votre inscription est confirmée",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(registration.buyer.firstName)},</p>
          <p ${P}>Votre inscription à <strong ${STRONG}>«\u00a0${escapeHtml(event.name)}\u00a0»</strong> (${escapeHtml(organizationName)}) est confirmée.</p>
          ${whenRows(event, eventZone(registration))}
          ${locationRow(event)}
          ${row("Places", escapeHtml(placesLabel(registration.quantity)))}
          ${paid ? row("Montant payé", escapeHtml(formatEventPrice(registration.amount, registration.currency))) : ""}
          <p ${P}>Présentez ${tickets.length > 1 ? "ces QR codes" : "ce QR code"} à l'entrée, sur votre téléphone ou imprimé.</p>
          ${ticketBlocks(tickets)}
          <p ${P}>Le fichier joint ajoute l'événement à votre agenda.</p>`,
    ctaLabel: "Voir mes billets",
    ctaUrl: manageUrl,
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: `Vos billets : ${event.name}, le ${when.shortDate}`,
    html,
    attachments: [
      icsAttachment(
        registrationIcs(registration, {
          method: "REQUEST",
          organizationName,
          host,
        }),
        "REQUEST",
      ),
    ],
  };
}

/** Nouvelle inscription, pour l'organisateur. */
export function buildEventHostNewRegistrationEmail({
  registration,
  type,
  pageTimezone,
}) {
  const event = registration.event;
  const when = formatWhen(event.startAt, event.endAt, pageTimezone);
  const name = buyerName(registration.buyer);
  const seats =
    type?.capacity != null
      ? `${type.seatsTaken} / ${type.capacity} places prises`
      : `${type?.seatsTaken ?? registration.quantity} places prises`;
  const html = renderEmail({
    preheader: `${name} s'est inscrit à « ${event.name} »`,
    badge: "NOUVELLE INSCRIPTION",
    iconLabel: "Inscrit",
    iconBg: "#ede9fe",
    iconColor: "#5b21b6",
    title: `Nouvelle inscription de ${name}`,
    bodyHtml: `
          <p ${P}><strong ${STRONG}>${escapeHtml(name)}</strong> s'est inscrit à <strong ${STRONG}>«\u00a0${escapeHtml(event.name)}\u00a0»</strong> (${escapeHtml(when.shortDate)} à ${when.start}).</p>
          ${row("Participant", escapeHtml(name))}
          ${row("E-mail", `<a href="mailto:${escapeHtml(registration.buyer.email)}" ${LINK}>${escapeHtml(registration.buyer.email)}</a>`)}
          ${registration.buyer.phone ? row("Téléphone", escapeHtml(registration.buyer.phone)) : ""}
          ${row("Places", escapeHtml(placesLabel(registration.quantity)))}
          ${row("Montant", escapeHtml(formatEventPrice(registration.amount, registration.currency)))}
          ${row("Remplissage", escapeHtml(seats))}`,
    ctaLabel: "Voir les inscrits",
    ctaUrl: `${appUrl()}${DASHBOARD_PATH}`,
  });
  return {
    subject: `Nouvelle inscription : ${event.name} (${placesLabel(registration.quantity)})`,
    html,
  };
}

/** Rappel la veille, au participant. */
export function buildEventReminderEmail({
  registration,
  tickets,
  organizationName,
  manageUrl,
}) {
  const event = registration.event;
  const when = formatWhen(event.startAt, event.endAt, eventZone(registration));
  const html = renderEmail({
    preheader: `${event.name} commence ${when.shortDate} à ${when.start}`,
    badge: "RAPPEL",
    iconLabel: "Demain",
    iconBg: "#e0f2fe",
    iconColor: "#075985",
    title: `Rappel : ${event.name}`,
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(registration.buyer.firstName)},</p>
          <p ${P}>L'événement <strong ${STRONG}>«\u00a0${escapeHtml(event.name)}\u00a0»</strong> (${escapeHtml(organizationName)}) approche.</p>
          ${whenRows(event, eventZone(registration))}
          ${locationRow(event)}
          ${tickets.length ? `<p ${P}>Vos billets, à présenter à l'entrée :</p>${ticketBlocks(tickets)}` : ""}`,
    ctaLabel: manageUrl ? "Voir mes billets" : undefined,
    ctaUrl: manageUrl || undefined,
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: `Rappel : ${event.name}, ${when.shortDate} à ${when.start}`,
    html,
  };
}

/** Annulation, au participant (par l'organisateur ou par lui-même). */
export function buildEventCancelledEmail({
  registration,
  organizationName,
  host,
}) {
  const event = registration.event;
  const when = formatWhen(event.startAt, event.endAt, eventZone(registration));
  const byHost = registration.cancelledBy === "HOST";
  const paid = registration.amount > 0 && registration.payment?.paidAt;
  const reason =
    byHost && registration.cancelReason
      ? row(
          "Motif",
          escapeHtml(registration.cancelReason).replace(/\r?\n/g, "<br>"),
        )
      : "";
  const refund = paid
    ? `<p ${P}>Pour le remboursement de votre paiement, ${escapeHtml(organizationName)} reviendra vers vous ; vous pouvez aussi répondre à cet e-mail.</p>`
    : "";
  const html = renderEmail({
    preheader: `Inscription à « ${event.name} » annulée`,
    badge: "INSCRIPTION ANNULÉE",
    iconLabel: "Annulé",
    iconBg: "#fee2e2",
    iconColor: "#991b1b",
    title: "Votre inscription est annulée",
    bodyHtml: `
          <p ${P}>Bonjour ${escapeHtml(registration.buyer.firstName)},</p>
          <p ${P}>${byHost ? `${escapeHtml(organizationName)} a annulé votre inscription` : "Votre inscription"} à <strong ${STRONG}>«\u00a0${escapeHtml(event.name)}\u00a0»</strong> du ${escapeHtml(when.date)}${byHost ? "" : " est annulée, comme vous l'avez demandé"}. Vos billets ne sont plus valables.</p>
          ${reason}
          ${refund}`,
    footerNoteHtml: guestFooter(organizationName),
  });
  return {
    subject: `Inscription annulée : ${event.name}`,
    html,
    attachments: [
      icsAttachment(
        registrationIcs(registration, {
          method: "CANCEL",
          organizationName,
          host,
        }),
        "CANCEL",
      ),
    ],
  };
}

/** Annulation par le participant, pour l'organisateur. */
export function buildEventHostCancelledEmail({ registration, pageTimezone }) {
  const event = registration.event;
  const when = formatWhen(event.startAt, event.endAt, pageTimezone);
  const name = buyerName(registration.buyer);
  const html = renderEmail({
    preheader: `${name} a annulé son inscription à « ${event.name} »`,
    badge: "INSCRIPTION ANNULÉE",
    iconLabel: "Annulé",
    iconBg: "#fee2e2",
    iconColor: "#991b1b",
    title: `${name} a annulé son inscription`,
    bodyHtml: `
          <p ${P}><strong ${STRONG}>${escapeHtml(name)}</strong> a annulé son inscription à <strong ${STRONG}>«\u00a0${escapeHtml(event.name)}\u00a0»</strong> (${escapeHtml(when.shortDate)} à ${when.start}) : ${escapeHtml(placesLabel(registration.quantity))} de nouveau disponible${registration.quantity > 1 ? "s" : ""}.</p>
          ${registration.cancelReason ? row("Motif", escapeHtml(registration.cancelReason).replace(/\r?\n/g, "<br>")) : ""}`,
    ctaLabel: "Voir les inscrits",
    ctaUrl: `${appUrl()}${DASHBOARD_PATH}`,
  });
  return { subject: `Inscription annulée : ${event.name} (${name})`, html };
}
