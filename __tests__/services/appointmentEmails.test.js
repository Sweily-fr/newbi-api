/**
 * E-mails de la prise de rendez-vous : heure dans le fuseau du
 * destinataire, ni tiret cadratin ni émoji, lien de gestion, invitation
 * .ics (REQUEST, CANCEL, SEQUENCE croissante).
 */
import { describe, it, expect, vi } from "vitest";

vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://www.newbi.fr";
});
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { useResend: false, transporter: null },
}));

import {
  buildGuestCancelledEmail,
  buildGuestConfirmationEmail,
  buildGuestReminderEmail,
  buildGuestRescheduledEmail,
  buildHostCancelledEmail,
  buildHostNewBookingEmail,
  buildHostRescheduledEmail,
  bookingIcs,
  formatWhen,
  senderName,
  zoneLabel,
} from "../../src/services/appointments/bookingEmails.js";

const booking = {
  _id: "6720a1b2c3d4e5f6a7b8c9d0",
  startAt: new Date("2026-11-02T09:00:00Z"),
  endAt: new Date("2026-11-02T09:30:00Z"),
  typeName: "Découverte",
  durationMinutes: 30,
  location: { kind: "GOOGLE_MEET", value: null },
  meetingUrl: "https://meet.google.com/abc-defg-hij",
  guest: {
    firstName: "Élise",
    lastName: "Martin",
    email: "elise@exemple.fr",
    phone: "0612345678",
    message: "Bonjour <script>",
    timezone: "America/Montreal",
  },
  rescheduleHistory: [],
  cancelReason: "Empêchement",
};
const host = { name: "Jean Dupont", email: "jean@cabinet.fr" };
const common = { booking, host, organizationName: "Cabinet Martin" };
const EMOJI = /\p{Extended_Pictographic}/u;

const all = () => [
  buildGuestConfirmationEmail({
    ...common,
    manageUrl: "https://www.newbi.fr/rdv/gerer/abc",
  }),
  buildHostNewBookingEmail({ ...common, pageTimezone: "Europe/Paris" }),
  buildGuestRescheduledEmail({
    ...common,
    manageUrl: "https://www.newbi.fr/rdv/gerer/abc",
  }),
  buildHostRescheduledEmail({
    booking,
    previousStartAt: new Date("2026-11-01T09:00:00Z"),
    pageTimezone: "Europe/Paris",
  }),
  buildHostCancelledEmail({ booking, pageTimezone: "Europe/Paris" }),
  buildGuestCancelledEmail({
    ...common,
    rebookUrl: "https://www.newbi.fr/rdv/jean",
  }),
  buildGuestReminderEmail({
    ...common,
    manageUrl: "https://www.newbi.fr/rdv/gerer/abc",
    kind: "h24",
  }),
  buildGuestReminderEmail({
    ...common,
    manageUrl: "https://www.newbi.fr/rdv/gerer/abc",
    kind: "h1",
  }),
];

describe("e-mails de rendez-vous", () => {
  it("affichent l'heure dans le fuseau du destinataire", () => {
    expect(
      formatWhen(booking.startAt, booking.endAt, "Europe/Paris"),
    ).toMatchObject({
      date: "lundi 2 novembre 2026",
      start: "10:00",
      end: "10:30",
      zone: "heure de Paris",
    });
    const [guestMail, hostMail] = all();
    expect(guestMail.html).toContain("De 04:00 à 04:30 (heure");
    expect(guestMail.html).toContain("Montreal)");
    expect(hostMail.html).toContain("De 10:00 à 10:30 (heure");
    expect(zoneLabel("America/Argentina/Buenos_Aires")).toBe(
      "heure de Buenos Aires",
    );
    expect(zoneLabel("UTC")).toBe("heure UTC");
  });

  it("ni tiret cadratin ni émoji, contenus de l'invité échappés", () => {
    for (const email of all()) {
      expect(email.subject).not.toMatch(/—/);
      expect(email.html).not.toMatch(/—/);
      expect(email.subject).not.toMatch(EMOJI);
      expect(email.html).not.toMatch(EMOJI);
      expect(email.html).not.toContain("<script>");
    }
  });

  it("confirmation : lien de gestion, lien Meet, invitation .ics", () => {
    const [guestMail] = all();
    expect(guestMail.html).toContain("https://www.newbi.fr/rdv/gerer/abc");
    expect(guestMail.html).toContain("https://meet.google.com/abc-defg-hij");
    const ics = guestMail.attachments[0].content.toString();
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("SEQUENCE:0");
    expect(ics).toContain('ORGANIZER;CN="Jean Dupont":mailto:jean@cabinet.fr');
    expect(ics).toContain("ATTENDEE;CN=");
    expect(ics).toContain("DTSTART:20261102T090000Z");
    expect(ics).toContain("UID:rendez-vous-6720a1b2c3d4e5f6a7b8c9d0@newbi.fr");
  });

  it("annulation : .ics METHOD:CANCEL avec le même UID et une séquence supérieure", () => {
    const moved = { ...booking, rescheduleHistory: [{}, {}] };
    expect(bookingIcs(moved, { method: "REQUEST", host })).toContain(
      "SEQUENCE:2",
    );
    const cancel = bookingIcs(moved, { method: "CANCEL", host });
    expect(cancel).toContain("METHOD:CANCEL");
    expect(cancel).toContain("STATUS:CANCELLED");
    expect(cancel).toContain("SEQUENCE:3");
    expect(cancel).toContain(
      "UID:rendez-vous-6720a1b2c3d4e5f6a7b8c9d0@newbi.fr",
    );
  });

  it("téléphone : l'organisateur appelle l'invité", () => {
    const phone = { ...booking, location: { kind: "PHONE" }, meetingUrl: null };
    const email = buildGuestConfirmationEmail({
      ...common,
      booking: phone,
      manageUrl: "https://x",
    });
    expect(email.html).toContain("vous appellera");
    expect(email.html).toContain("0612345678");
  });

  it("nom d'expéditeur sans caractères dangereux", () => {
    expect(senderName('Cabinet "Martin" <SAS>')).toBe(
      "Cabinet Martin SAS via Newbi",
    );
    expect(senderName("")).toBe("Newbi");
  });
});
