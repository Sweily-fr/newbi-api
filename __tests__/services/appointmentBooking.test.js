/**
 * Prise de rendez-vous, service de réservation :
 *   - deux réservations simultanées du même créneau : une seule passe ;
 *   - client CRM existant rattaché sans modification de sa fiche ;
 *   - client bloqué refusé, rien d'enregistré ;
 *   - lien de visio en échec : réservation valide, avertissement ;
 *   - occupation : panne du fournisseur → événements synchronisés ;
 *   - déplacement et annulation par l'invité.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
  process.env.FRONTEND_URL = "https://www.newbi.fr";
});

// Redis : pas de cache ni de verrou, sauf client fourni par un test
const redis = vi.hoisted(() => ({ client: null }));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => redis.client,
}));
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
}));

// Fournisseurs d'agenda factices
const providers = vi.hoisted(() => ({}));
vi.mock("../../src/services/calendar/CalendarProviderFactory.js", () => ({
  getCalendarProvider: (name) => providers[name],
}));

// E-mails capturés (Resend simulé)
const mail = vi.hoisted(() => ({ sent: [] }));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: {
    useResend: true,
    resendFromEmail: "no-reply@newbi.fr",
    resend: {
      emails: {
        send: async (payload) => {
          mail.sent.push(payload);
          return { data: { id: `mail-${mail.sent.length}` }, error: null };
        },
      },
    },
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import AppointmentType from "../../src/models/AppointmentType.js";
import Booking from "../../src/models/Booking.js";
import BookingPage from "../../src/models/BookingPage.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import Client from "../../src/models/Client.js";
import Event from "../../src/models/Event.js";
import {
  availableSlots,
  cancelBooking,
  createBooking,
  findBookingByToken,
  loadPublicPage,
  rescheduleBooking,
} from "../../src/services/appointments/bookingService.js";
import { addDays, localDayOf } from "../../src/utils/appointmentSlots.js";

const hostId = buildUserId();
const workspaceId = buildOrganizationId();
let page;
let type;
let context;

const today = () => localDayOf(new Date(), "Europe/Paris");

const guest = (overrides = {}) => ({
  firstName: "Élise",
  lastName: "Martin",
  email: "elise.martin@exemple.fr",
  phone: "06 12 34 56 78",
  message: "Bonjour, à bientôt.",
  ...overrides,
});

async function nextSlots(count = 2) {
  const slots = await availableSlots({
    page,
    type,
    from: addDays(today(), 1),
    to: addDays(today(), 15),
  });
  expect(slots.length).toBeGreaterThanOrEqual(count);
  return slots;
}

const book = (start, overrides = {}) =>
  createBooking({
    context,
    type,
    start,
    guest: guest(overrides),
    timezone: "Europe/Paris",
  });

function fakeGoogle({
  meetingUrl = "https://meet.google.com/abc-defg-hij",
  fail = false,
  busy = [],
} = {}) {
  return {
    pushEventDetailed: vi.fn(async (_connection, _event, options) => {
      if (fail) throw new Error("Google indisponible");
      return {
        externalEventId: "google-evt-1",
        meetingUrl: options.conference ? meetingUrl : null,
        meetingError:
          options.conference && !meetingUrl
            ? "Google n'a pas créé de lien Google Meet pour ce compte."
            : null,
      };
    }),
    getBusyIntervals: vi.fn(async () => busy),
    rescheduleEvent: vi.fn(async () => {}),
    deleteEvent: vi.fn(async () => {}),
  };
}

async function connectGoogle() {
  return CalendarConnection.create({
    userId: hostId,
    provider: "google",
    status: "active",
    accountEmail: "jean@gmail.com",
  });
}

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Booking.init(),
    Client.init(),
    BookingPage.init(),
    AppointmentType.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  mail.sent = [];
  redis.client = null;
  for (const key of Object.keys(providers)) delete providers[key];
  providers.google = fakeGoogle();

  await seedOrgMembership({
    userId: hostId,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Cabinet Martin",
  });
  await mongoose.connection.db.collection("user").insertOne({
    _id: hostId,
    name: "Jean Dupont",
    email: "jean@cabinet.fr",
  });
  page = (
    await BookingPage.create({
      workspaceId,
      userId: hostId,
      slug: "jean-dupont",
      title: "Jean Dupont",
    })
  ).toObject();
  type = (
    await AppointmentType.create({
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      slug: "decouverte",
      name: "Découverte",
      durationMinutes: 30,
      location: { kind: "GOOGLE_MEET" },
      minNoticeMinutes: 0,
    })
  ).toObject();
  context = await loadPublicPage("jean-dupont");
});

describe("page publique", () => {
  it("charge la page, l'organisation et l'organisateur", () => {
    expect(context.host).toMatchObject({
      name: "Jean Dupont",
      email: "jean@cabinet.fr",
    });
    expect(context.organization.companyName).toBe("Cabinet Martin");
  });

  it("404 sans abonnement actif", async () => {
    const otherHost = buildUserId();
    const otherOrg = buildOrganizationId();
    await seedOrgMembership({
      userId: otherHost,
      organizationId: otherOrg,
      subscriptionStatus: null,
    });
    await mongoose.connection.db
      .collection("user")
      .insertOne({ _id: otherHost, name: "Sans Abonnement" });
    await BookingPage.create({
      workspaceId: otherOrg,
      userId: otherHost,
      slug: "sans-abonnement",
      title: "X",
    });
    expect(await loadPublicPage("sans-abonnement")).toBeNull();
  });

  it("404 si l'organisateur a quitté l'espace", async () => {
    await mongoose.connection.db
      .collection("member")
      .deleteMany({ userId: hostId });
    invalidateOrgCache();
    expect(await loadPublicPage("jean-dupont")).toBeNull();
  });
});

describe("réservation", () => {
  it("crée la réservation, le client, l'événement et le lien Meet, puis envoie les e-mails", async () => {
    await connectGoogle();
    const [slot] = await nextSlots();
    const { booking, token, emails } = await book(slot.start);
    await emails;

    expect(booking.status).toBe("CONFIRMED");
    expect(booking.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(booking.meetingWarning).toBeNull();
    expect(booking.externalEventId).toBe("google-evt-1");
    expect(booking.manageTokenHash).not.toContain(token);

    const event = await Event.findById(booking.eventId).lean();
    expect(event).toMatchObject({
      type: "APPOINTMENT",
      visibility: "private",
      title: "Découverte avec Élise Martin",
      location: "https://meet.google.com/abc-defg-hij",
    });
    expect(String(event.bookingId)).toBe(String(booking._id));
    expect(event.externalCalendarLinks).toHaveLength(1);
    expect(event.externalCalendarLinks[0].externalEventId).toBe("google-evt-1");

    // Invité ajouté sans notification Google, visio demandée
    const [, , options] = providers.google.pushEventDetailed.mock.calls[0];
    expect(options.conference).toBe(true);
    expect(options.attendees).toEqual([
      { email: "elise.martin@exemple.fr", name: "Élise Martin" },
    ]);

    const client = await Client.findById(booking.clientId).lean();
    expect(client).toMatchObject({
      type: "INDIVIDUAL",
      name: "Élise Martin",
      firstName: "Élise",
      lastName: "Martin",
      email: "elise.martin@exemple.fr",
      phone: "0612345678",
    });

    expect(mail.sent).toHaveLength(2);
    const toGuest = mail.sent.find(
      (m) => m.to[0] === "elise.martin@exemple.fr",
    );
    const toHost = mail.sent.find((m) => m.to[0] === "jean@cabinet.fr");
    expect(toGuest.from).toBe("Cabinet Martin via Newbi <no-reply@newbi.fr>");
    expect(toGuest.replyTo).toBe("jean@cabinet.fr");
    expect(toGuest.html).toContain(`https://www.newbi.fr/rdv/gerer/${token}`);
    expect(toGuest.html).toContain("https://meet.google.com/abc-defg-hij");
    expect(toGuest.attachments[0].contentType).toContain("method=REQUEST");
    expect(toGuest.attachments[0].content.toString()).toContain(
      "METHOD:REQUEST",
    );
    expect(toHost.replyTo).toBe("elise.martin@exemple.fr");
    expect(toHost.html).toContain("/dashboard/outils/rendez-vous");
    for (const message of mail.sent) {
      expect(message.html).not.toContain("—");
      expect(message.subject).not.toContain("—");
    }
  });

  it("deux réservations simultanées du même créneau : une seule passe (index unique)", async () => {
    const [slot] = await nextSlots();
    const results = await Promise.allSettled([
      book(slot.start),
      book(slot.start, { email: "autre@exemple.fr", firstName: "Paul" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.code).toBe("SLOT_TAKEN");
    expect(rejected[0].reason.status).toBe(409);
    expect(await Booking.countDocuments({ status: "CONFIRMED" })).toBe(1);
  });

  it("sans Redis, deux réservations simultanées qui se chevauchent (débuts différents) : une seule passe", async () => {
    // Séance d'une heure à X, rendez-vous de 30 min à X + 30 min
    const long = (
      await AppointmentType.create({
        workspaceId,
        bookingPageId: page._id,
        userId: hostId,
        slug: "seance-longue",
        name: "Séance longue",
        durationMinutes: 60,
        location: { kind: "GOOGLE_MEET" },
        minNoticeMinutes: 0,
      })
    ).toObject();
    const slots = await availableSlots({
      page,
      type: long,
      from: addDays(today(), 1),
      to: addDays(today(), 15),
    });
    const start = new Date(slots[0].start);
    const overlapping = new Date(start.getTime() + 30 * 60_000).toISOString();

    const results = await Promise.allSettled([
      createBooking({
        context,
        type: long,
        start: slots[0].start,
        guest: guest(),
        timezone: "Europe/Paris",
      }),
      book(overlapping, { email: "autre@exemple.fr", firstName: "Paul" }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.status).toBe(
      409,
    );
    expect(await Booking.countDocuments({ status: "CONFIRMED" })).toBe(1);
  });

  it("deux réservations simultanées avec le verrou Redis : la seconde voit le créneau pris", async () => {
    const store = new Map();
    redis.client = {
      set: async (key, value, _px, _ttl, nx) => {
        if (nx === "NX" && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
      get: async (key) => store.get(key) ?? null,
      del: async (key) => store.delete(key),
    };
    const [slot] = await nextSlots();
    const results = await Promise.allSettled([
      book(slot.start),
      book(slot.start, { email: "autre@exemple.fr" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe(
      "SLOT_TAKEN",
    );
    expect(store.size).toBe(0);
  });

  it("refuse une heure qui n'est pas un créneau libre", async () => {
    const [slot] = await nextSlots();
    const offGrid = new Date(slot.start.getTime() + 7 * 60 * 1000);
    await expect(book(offGrid)).rejects.toMatchObject({ code: "SLOT_TAKEN" });
    expect(await Booking.countDocuments()).toBe(0);
  });

  it("rattache un client existant sans modifier sa fiche", async () => {
    const { insertedId } = await Client.collection.insertOne({
      workspaceId,
      name: "Elise Martin SARL",
      type: "COMPANY",
      email: "elise.martin@exemple.fr",
      phone: "0102030405",
      address: {
        street: "1 rue de Test",
        city: "Lyon",
        postalCode: "69001",
        country: "France",
      },
      createdBy: hostId,
      activity: [],
    });
    const before = await Client.collection.findOne({ _id: insertedId });

    const [slot] = await nextSlots();
    const { booking, emails } = await book(slot.start, {
      email: "Elise.Martin@Exemple.fr",
      firstName: "Lise",
      phone: "0699999999",
    });
    await emails;

    expect(String(booking.clientId)).toBe(String(insertedId));
    expect(await Client.countDocuments()).toBe(1);
    const after = await Client.collection.findOne({ _id: insertedId });
    const { activity: activityBefore, ...restBefore } = before;
    const { activity: activityAfter, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(activityBefore).toHaveLength(0);
    expect(activityAfter).toHaveLength(1);
    expect(activityAfter[0].type).toBe("reminder_created");
  });

  it("le client créé garde le nom saisi (apostrophe typographique, « œ », point)", async () => {
    const [slot] = await nextSlots();
    const { booking, emails } = await book(slot.start, {
      email: "anais.darcy@exemple.fr",
      firstName: "Anaïs",
      lastName: "D’Arcy-Lecœur Jr.",
    });
    await emails;

    const client = await Client.findById(booking.clientId).lean();
    expect(client).toMatchObject({
      type: "INDIVIDUAL",
      name: "Anaïs D’Arcy-Lecœur Jr.",
      firstName: "Anaïs",
      lastName: "D’Arcy-Lecœur Jr.",
    });
  });

  it("caractères refusés par la fiche client remplacés, nom inutilisable : repli sur l'adresse", async () => {
    const [slot] = await nextSlots();
    const { booking, emails } = await book(slot.start, {
      email: "zoe.piege@exemple.fr",
      firstName: "<b>",
      lastName: "42",
    });
    await emails;

    const client = await Client.findById(booking.clientId).lean();
    expect(client.name).toBe("zoe.piege");
    expect(client.firstName ?? null).toBeNull();
    expect(client.lastName ?? null).toBeNull();
  });

  it("refuse un client bloqué, sans rien enregistrer", async () => {
    await Client.collection.insertOne({
      workspaceId,
      name: "Bloqué",
      type: "COMPANY",
      email: "elise.martin@exemple.fr",
      isBlocked: true,
      address: {},
      createdBy: hostId,
      activity: [],
    });
    const [slot] = await nextSlots();
    await expect(book(slot.start)).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 403,
    });
    expect(await Booking.countDocuments()).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("lien de visio en échec : la réservation reste valide, avec un avertissement", async () => {
    await connectGoogle();
    providers.google = fakeGoogle({ meetingUrl: null });
    const [slot] = await nextSlots();
    const { booking, emails } = await book(slot.start);
    await emails;

    expect(booking.status).toBe("CONFIRMED");
    expect(booking.meetingUrl).toBeNull();
    expect(booking.meetingWarning).toMatch(/Google Meet/);
    expect(booking.externalEventId).toBe("google-evt-1");
    const toGuest = mail.sent.find(
      (m) => m.to[0] === "elise.martin@exemple.fr",
    );
    const toHost = mail.sent.find((m) => m.to[0] === "jean@cabinet.fr");
    expect(toGuest.html).toContain("vous sera envoyé par");
    expect(toHost.html).toContain("Lien de visioconférence non");
    expect(toHost.html).toContain("Envoyez un lien à votre invité");
  });

  it("écriture dans l'agenda en échec : réservation valide, sans erreur pour l'invité", async () => {
    await connectGoogle();
    providers.google = fakeGoogle({ fail: true });
    const [slot] = await nextSlots();
    const { booking } = await book(slot.start);
    expect(booking.status).toBe("CONFIRMED");
    expect(booking.externalEventId).toBeNull();
    expect(booking.meetingWarning).toMatch(/n'a pas pu être ajouté/);
    expect(booking.eventId).toBeTruthy();
  });

  it("sans agenda Google connecté, Meet ne peut pas être créé (avertissement)", async () => {
    const [slot] = await nextSlots();
    const { booking } = await book(slot.start);
    expect(booking.meetingWarning).toMatch(/Aucun agenda Google connecté/);
    expect(providers.google.pushEventDetailed).not.toHaveBeenCalled();
  });
});

describe("occupation", () => {
  it("bloque les créneaux occupés dans l'agenda connecté", async () => {
    const [first] = await nextSlots();
    await connectGoogle();
    providers.google = fakeGoogle({
      busy: [{ start: first.start, end: first.end }],
    });
    const slots = await nextSlots(1);
    expect(slots.some((s) => s.start.getTime() === first.start.getTime())).toBe(
      false,
    );
  });

  it("panne du fournisseur : repli sur les événements déjà synchronisés", async () => {
    const [first] = await nextSlots();
    const connection = await connectGoogle();
    providers.google = {
      ...fakeGoogle(),
      getBusyIntervals: vi.fn(async () => {
        throw new Error("Google indisponible");
      }),
    };
    await Event.create({
      title: "Externe",
      start: first.start,
      end: first.end,
      type: "EXTERNAL",
      source: "google",
      visibility: "private",
      isReadOnly: true,
      externalEventId: "ext-1",
      calendarConnectionId: connection._id,
      userId: hostId,
    });
    const slots = await nextSlots(1);
    expect(slots.some((s) => s.start.getTime() === first.start.getTime())).toBe(
      false,
    );
  });

  it("un événement Newbi de l'organisateur bloque, une journée entière non", async () => {
    const [first, second] = await nextSlots();
    await Event.create({
      title: "Réunion",
      start: first.start,
      end: first.end,
      userId: hostId,
      workspaceId,
    });
    await Event.create({
      title: "Congés",
      start: second.start,
      end: second.end,
      allDay: true,
      userId: hostId,
      workspaceId,
    });
    const slots = await nextSlots(1);
    const starts = slots.map((s) => s.start.getTime());
    expect(starts).not.toContain(first.start.getTime());
    expect(starts).toContain(second.start.getTime());
  });
});

describe("gestion par l'invité", () => {
  it("déplace le rendez-vous : rappels remis à zéro, historique, e-mails", async () => {
    await connectGoogle();
    const [first, second] = await nextSlots();
    const { booking, token } = await book(first.start);
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { "reminders.h24SentAt": new Date() } },
    );
    mail.sent = [];

    const current = await findBookingByToken(token);
    const { booking: moved, emails } = await rescheduleBooking({
      booking: current,
      token,
      start: second.start,
    });
    await emails;

    expect(moved.startAt.getTime()).toBe(second.start.getTime());
    expect(moved.reminders.h24SentAt).toBeNull();
    expect(moved.rescheduleHistory).toHaveLength(1);
    expect(moved.rescheduleHistory[0].fromStartAt.getTime()).toBe(
      first.start.getTime(),
    );
    const event = await Event.findById(moved.eventId).lean();
    expect(event.start.getTime()).toBe(second.start.getTime());
    expect(providers.google.rescheduleEvent).toHaveBeenCalledTimes(1);
    expect(mail.sent.map((m) => m.to[0]).sort()).toEqual([
      "elise.martin@exemple.fr",
      "jean@cabinet.fr",
    ]);
    const ics = mail.sent
      .find((m) => m.to[0] === "elise.martin@exemple.fr")
      .attachments[0].content.toString();
    expect(ics).toContain("SEQUENCE:1");
  });

  it("le créneau de la réservation déplacée redevient libre pour elle seule", async () => {
    const [first] = await nextSlots();
    const { booking } = await book(first.start);
    const current = await Booking.findById(booking._id);
    const withExclusion = await availableSlots({
      page,
      type,
      from: localDayOf(first.start, "Europe/Paris"),
      to: localDayOf(first.start, "Europe/Paris"),
      excludeBooking: current,
    });
    expect(
      withExclusion.some((s) => s.start.getTime() === first.start.getTime()),
    ).toBe(true);
  });

  it("refuse un déplacement vers un créneau pris (409)", async () => {
    const [first, second] = await nextSlots();
    const { token } = await book(first.start);
    await book(second.start, { email: "autre@exemple.fr" });
    const current = await findBookingByToken(token);
    await expect(
      rescheduleBooking({ booking: current, token, start: second.start }),
    ).rejects.toMatchObject({ code: "SLOT_TAKEN", status: 409 });
  });

  it("annulation par l'invité : statut, agenda et Calendrier nettoyés, e-mail à l'organisateur", async () => {
    await connectGoogle();
    const [first] = await nextSlots();
    const { booking, token } = await book(first.start);
    mail.sent = [];
    const current = await findBookingByToken(token);
    const { booking: cancelled, emails } = await cancelBooking({
      booking: current,
      by: "GUEST",
      reason: "Empêchement",
    });
    await emails;

    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      cancelledBy: "GUEST",
      cancelReason: "Empêchement",
    });
    expect(providers.google.deleteEvent).toHaveBeenCalledWith(
      expect.anything(),
      "google-evt-1",
    );
    expect(await Event.findById(booking.eventId)).toBeNull();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(["jean@cabinet.fr"]);
    expect(mail.sent[0].html).toContain("Empêchement");

    // Le créneau est de nouveau proposé
    const slots = await nextSlots(1);
    expect(slots.some((s) => s.start.getTime() === first.start.getTime())).toBe(
      true,
    );
  });

  it("annulation par l'organisateur : e-mail à l'invité avec .ics METHOD:CANCEL", async () => {
    const [first] = await nextSlots();
    const { booking } = await book(first.start);
    mail.sent = [];
    const { emails } = await cancelBooking({
      booking: await Booking.findById(booking._id),
      by: "HOST",
    });
    await emails;
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(["elise.martin@exemple.fr"]);
    const ics = mail.sent[0].attachments[0].content.toString();
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(mail.sent[0].html).toContain(
      "https://www.newbi.fr/rdv/jean-dupont/decouverte",
    );
  });
});
