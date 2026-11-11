/**
 * Prise de rendez-vous, tableau de bord (GraphQL) : chacun ne voit et ne
 * modifie que SA page, SES types et SES réservations ; droits par rôle ;
 * création de la page avec son type par défaut ; adresses ; filtres des
 * réservations ; annulation par l'organisateur ; événements APPOINTMENT
 * intouchables depuis le Calendrier.
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

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
}));
vi.mock("../../src/services/calendar/CalendarProviderFactory.js", () => ({
  getCalendarProvider: () => ({ deleteEvent: vi.fn(async () => {}) }),
}));
const mail = vi.hoisted(() => ({ sent: [] }));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: {
    useResend: true,
    resendFromEmail: "no-reply@newbi.fr",
    resend: {
      emails: {
        send: async (payload) => {
          mail.sent.push(payload);
          return { data: { id: "mail" }, error: null };
        },
      },
    },
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import AppointmentType from "../../src/models/AppointmentType.js";
import Booking, { hashManageToken } from "../../src/models/Booking.js";
import BookingPage from "../../src/models/BookingPage.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import Event from "../../src/models/Event.js";
import appointmentsResolvers from "../../src/resolvers/appointments.js";
import eventResolvers from "../../src/resolvers/event.js";

const { Query, Mutation } = appointmentsResolvers;
const workspaceId = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();

const ctx = (userId) => buildContext({ userId, organizationId: workspaceId });
const info = (fieldName) => ({ fieldName });
const call = (resolver, userId, args = {}) =>
  resolver(null, args, ctx(userId), info("test"));
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code || error.extensions?.code;
  }
};

async function insertBooking(
  hostUserId,
  { startIn, status = "CONFIRMED", pageId, typeId },
) {
  const startAt = new Date(Date.now() + startIn);
  const { insertedId } = await Booking.collection.insertOne({
    workspaceId,
    bookingPageId: pageId,
    appointmentTypeId: typeId,
    hostUserId,
    startAt,
    endAt: new Date(startAt.getTime() + 30 * 60000),
    typeName: "Découverte",
    durationMinutes: 30,
    location: { kind: "PHONE", value: null },
    guest: {
      firstName: "Élise",
      lastName: "Martin",
      email: "elise@exemple.fr",
      timezone: "Europe/Paris",
    },
    status,
    rescheduleHistory: [],
    manageTokenHash: hashManageToken(String(new mongoose.Types.ObjectId())),
    reminders: { h24SentAt: null, h1SentAt: null },
    createdAt: new Date(),
  });
  return insertedId;
}

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    BookingPage.init(),
    AppointmentType.init(),
    Booking.init(),
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
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Cabinet",
  });
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: "member",
  });
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
  await seedOrgMembership({
    userId: accountant,
    organizationId: workspaceId,
    role: "accountant",
  });
  await mongoose.connection.db.collection("user").insertMany([
    { _id: owner, name: "Jean Dupont", email: "jean@cabinet.fr" },
    { _id: member, name: "Paul Membre", email: "paul@cabinet.fr" },
  ]);
});

describe("création de la page", () => {
  it("premier appel : adresse obligatoire, type par défaut créé (téléphone sans agenda)", async () => {
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, owner, { input: { title: "X" } }),
      ),
    ).toBe("VALIDATION_ERROR");
    const page = await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "Jean-Dupont" },
    });
    expect(page.slug).toBe("jean-dupont");
    expect(appointmentsResolvers.BookingPage.publicUrl(page)).toBe(
      "https://www.newbi.fr/rdv/jean-dupont",
    );
    expect(page.availability).toHaveLength(5);

    const types = await call(Query.appointmentTypes, owner);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({
      slug: "rendez-vous-30-min",
      name: "Rendez-vous de 30 min",
      durationMinutes: 30,
      location: { kind: "PHONE" },
    });
    expect(
      await appointmentsResolvers.AppointmentType.publicUrl(types[0]),
    ).toBe("https://www.newbi.fr/rdv/jean-dupont/rendez-vous-30-min");
    expect(
      await appointmentsResolvers.AppointmentType.upcomingCount(types[0]),
    ).toBe(0);
  });

  it("type par défaut en Google Meet quand un agenda Google est connecté", async () => {
    await CalendarConnection.create({
      userId: owner,
      provider: "google",
      status: "active",
    });
    await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "jean-dupont" },
    });
    const [type] = await call(Query.appointmentTypes, owner);
    expect(type.location.kind).toBe("GOOGLE_MEET");
  });

  it("modifie la page : horaires contrôlés, agendas de l'utilisateur seulement", async () => {
    await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "jean-dupont" },
    });
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, owner, {
          input: {
            availability: [
              {
                dayOfWeek: 1,
                intervals: [
                  { start: "09:00", end: "12:00" },
                  { start: "11:00", end: "13:00" },
                ],
              },
            ],
          },
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    const foreign = await CalendarConnection.create({
      userId: member,
      provider: "google",
      status: "active",
    });
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, owner, {
          input: { writeConnectionId: String(foreign._id) },
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    const mine = await CalendarConnection.create({
      userId: owner,
      provider: "microsoft",
      status: "active",
    });
    const page = await call(Mutation.upsertBookingPage, owner, {
      input: {
        title: "Mon agenda",
        timezone: "America/Montreal",
        writeConnectionId: String(mine._id),
        busyConnectionIds: [String(mine._id)],
        dateOverrides: [{ date: "2026-12-25", intervals: [] }],
      },
    });
    expect(page).toMatchObject({
      title: "Mon agenda",
      timezone: "America/Montreal",
    });
    expect(appointmentsResolvers.BookingPage.writeConnectionId(page)).toBe(
      String(mine._id),
    );
    expect(appointmentsResolvers.BookingPage.busyConnectionIds(page)).toEqual([
      String(mine._id),
    ]);
  });

  it("adresses : réservée, prise par un autre, disponible", async () => {
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, owner, { input: { slug: "gerer" } }),
      ),
    ).toBe("VALIDATION_ERROR");
    await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "jean-dupont" },
    });
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, member, {
          input: { slug: "jean-dupont" },
        }),
      ),
    ).toBe("ALREADY_EXISTS");
    expect(
      await call(Query.bookingSlugAvailable, member, { slug: "jean-dupont" }),
    ).toBe(false);
    expect(
      await call(Query.bookingSlugAvailable, owner, { slug: "jean-dupont" }),
    ).toBe(true);
    expect(
      await call(Query.bookingSlugAvailable, member, { slug: "paul-membre" }),
    ).toBe(true);
    expect(
      await call(Query.bookingSlugAvailable, member, { slug: "admin" }),
    ).toBe(false);
    expect(await call(Query.bookingSlugAvailable, member, { slug: "x" })).toBe(
      false,
    );
  });
});

describe("types de rendez-vous", () => {
  beforeEach(async () => {
    await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "jean-dupont" },
    });
  });

  it("contrôle le lieu et propose une adresse libre", async () => {
    expect(
      await codeOf(
        call(Mutation.createAppointmentType, owner, {
          input: { name: "Démo", location: { kind: "GOOGLE_MEET" } },
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    const first = await call(Mutation.createAppointmentType, owner, {
      input: {
        name: "Démo",
        durationMinutes: 45,
        location: { kind: "CUSTOM_LINK", value: "https://zoom.us/j/1" },
      },
    });
    const second = await call(Mutation.createAppointmentType, owner, {
      input: {
        name: "Démo",
        location: { kind: "IN_PERSON", value: "1 rue de Paris" },
      },
    });
    expect(first).toMatchObject({
      slug: "demo",
      durationMinutes: 45,
      position: 1,
    });
    expect(second.slug).toBe("demo-2");
    expect(
      await codeOf(
        call(Mutation.updateAppointmentType, owner, {
          id: String(second._id),
          input: { slug: "demo" },
        }),
      ),
    ).toBe("ALREADY_EXISTS");
    expect(
      await codeOf(
        call(Mutation.updateAppointmentType, owner, {
          id: String(second._id),
          input: { slotIntervalMinutes: 7 },
        }),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  it("un membre gère ses propres types, jamais ceux d'un autre", async () => {
    const [ownerType] = await call(Query.appointmentTypes, owner);
    expect(
      await codeOf(
        call(Mutation.updateAppointmentType, member, {
          id: String(ownerType._id),
          input: { name: "Piraté" },
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        call(Mutation.deleteAppointmentType, member, {
          id: String(ownerType._id),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect((await AppointmentType.findById(ownerType._id)).name).toBe(
      "Rendez-vous de 30 min",
    );

    // Sa propre page, son propre type, qu'il peut supprimer (outil personnel)
    await call(Mutation.upsertBookingPage, member, {
      input: { slug: "paul-membre" },
    });
    const [memberType] = await call(Query.appointmentTypes, member);
    expect(
      await call(Mutation.deleteAppointmentType, member, {
        id: String(memberType._id),
      }),
    ).toBe(true);
  });

  it("supprimer un type garde les réservations à venir", async () => {
    const [type] = await call(Query.appointmentTypes, owner);
    const page = await BookingPage.findOne({ userId: owner });
    const bookingId = await insertBooking(owner, {
      startIn: 86400000,
      pageId: page._id,
      typeId: type._id,
    });
    await call(Mutation.deleteAppointmentType, owner, { id: String(type._id) });
    expect(await Booking.findById(bookingId)).not.toBeNull();
  });
});

describe("cloisonnement et droits", () => {
  it("un membre ne voit pas la page, les types ni les réservations d'un autre", async () => {
    const page = await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "jean-dupont" },
    });
    const [type] = await call(Query.appointmentTypes, owner);
    const bookingId = await insertBooking(owner, {
      startIn: 86400000,
      pageId: page._id,
      typeId: type._id,
    });

    expect(await call(Query.myBookingPage, member)).toBeNull();
    expect(await call(Query.appointmentTypes, member)).toEqual([]);
    expect(await call(Query.bookings, member, { scope: "all" })).toEqual({
      items: [],
      totalCount: 0,
    });
    expect(
      await call(Query.booking, member, { id: String(bookingId) }),
    ).toBeNull();
    expect(
      await codeOf(
        call(Mutation.cancelBooking, member, { id: String(bookingId) }),
      ),
    ).toBe("NOT_FOUND");
    expect((await Booking.findById(bookingId)).status).toBe("CONFIRMED");

    expect((await call(Query.myBookingPage, owner)).slug).toBe("jean-dupont");
    expect(
      (await call(Query.booking, owner, { id: String(bookingId) }))._id,
    ).toEqual(bookingId);
  });

  it("comptable : aucun accès ; membre en lecture seule : pas de création", async () => {
    expect(await codeOf(call(Query.myBookingPage, accountant))).toBe(
      "FORBIDDEN",
    );
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, accountant, {
          input: { slug: "compta" },
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(await call(Query.myBookingPage, viewer)).toBeNull();
    expect(
      await codeOf(
        call(Mutation.upsertBookingPage, viewer, {
          input: { slug: "lecteur" },
        }),
      ),
    ).toBe("FORBIDDEN");
  });
});

describe("réservations de l'organisateur", () => {
  let page;
  let type;
  beforeEach(async () => {
    page = await call(Mutation.upsertBookingPage, owner, {
      input: { slug: "jean-dupont" },
    });
    [type] = await call(Query.appointmentTypes, owner);
  });

  it("filtre à venir (croissant), passées (décroissant), statut", async () => {
    const later = await insertBooking(owner, {
      startIn: 3 * 86400000,
      pageId: page._id,
      typeId: type._id,
    });
    const sooner = await insertBooking(owner, {
      startIn: 86400000,
      pageId: page._id,
      typeId: type._id,
    });
    const cancelled = await insertBooking(owner, {
      startIn: 2 * 86400000,
      status: "CANCELLED",
      pageId: page._id,
      typeId: type._id,
    });
    const old = await insertBooking(owner, {
      startIn: -86400000,
      pageId: page._id,
      typeId: type._id,
    });
    const older = await insertBooking(owner, {
      startIn: -3 * 86400000,
      pageId: page._id,
      typeId: type._id,
    });

    const upcoming = await call(Query.bookings, owner, {});
    expect(upcoming.items.map((b) => b._id)).toEqual([
      sooner,
      cancelled,
      later,
    ]);
    const confirmed = await call(Query.bookings, owner, {
      scope: "upcoming",
      status: "CONFIRMED",
    });
    expect(confirmed.totalCount).toBe(2);
    const past = await call(Query.bookings, owner, { scope: "past" });
    expect(past.items.map((b) => b._id)).toEqual([old, older]);
    const paged = await call(Query.bookings, owner, {
      scope: "all",
      limit: 2,
      offset: 1,
    });
    expect(paged.items).toHaveLength(2);
    expect(paged.totalCount).toBe(5);
    expect(await codeOf(call(Query.bookings, owner, { scope: "demain" }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      await appointmentsResolvers.AppointmentType.upcomingCount({
        _id: type._id,
      }),
    ).toBe(2);
    const [listed] = await call(Query.appointmentTypes, owner);
    expect(
      await appointmentsResolvers.AppointmentType.upcomingCount(listed),
    ).toBe(2);
  });

  it("annulation par l'organisateur : statut, e-mail à l'invité, événement retiré", async () => {
    const bookingId = await insertBooking(owner, {
      startIn: 86400000,
      pageId: page._id,
      typeId: type._id,
    });
    const event = await Event.create({
      title: "Découverte avec Élise Martin",
      start: new Date(Date.now() + 86400000),
      end: new Date(Date.now() + 86400000 + 1800000),
      type: "APPOINTMENT",
      bookingId,
      userId: owner,
      workspaceId,
      visibility: "private",
    });
    await Booking.updateOne(
      { _id: bookingId },
      { $set: { eventId: event._id } },
    );

    const cancelled = await call(Mutation.cancelBooking, owner, {
      id: String(bookingId),
      reason: "Indisponible",
    });
    expect(cancelled).toMatchObject({
      status: "CANCELLED",
      cancelledBy: "HOST",
      cancelReason: "Indisponible",
    });
    expect(await Event.findById(event._id)).toBeNull();
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
    expect(mail.sent[0].to).toEqual(["elise@exemple.fr"]);
    expect(mail.sent[0].attachments[0].content.toString()).toContain(
      "METHOD:CANCEL",
    );

    const past = await insertBooking(owner, {
      startIn: -86400000,
      pageId: page._id,
      typeId: type._id,
    });
    expect(
      await codeOf(call(Mutation.cancelBooking, owner, { id: String(past) })),
    ).toBe("VALIDATION_ERROR");
  });
});

describe("événements APPOINTMENT dans le Calendrier", () => {
  it("ne se créent, ne se modifient ni ne se suppriment depuis le Calendrier", async () => {
    const event = await Event.create({
      title: "Découverte avec Élise Martin",
      start: new Date("2026-11-02T09:00:00Z"),
      end: new Date("2026-11-02T09:30:00Z"),
      type: "APPOINTMENT",
      userId: owner,
      workspaceId,
    });
    const message =
      "Gérez ce rendez-vous depuis Communication > Prise de rendez-vous.";
    const update = await eventResolvers.Mutation.updateEvent(
      null,
      { input: { id: String(event._id), title: "Modifié" } },
      ctx(owner),
      info("updateEvent"),
    );
    expect(update).toMatchObject({ success: false, message });
    const remove = await eventResolvers.Mutation.deleteEvent(
      null,
      { id: String(event._id) },
      ctx(owner),
      info("deleteEvent"),
    );
    expect(remove).toMatchObject({ success: false, message });
    expect((await Event.findById(event._id)).title).toBe(
      "Découverte avec Élise Martin",
    );

    const create = await eventResolvers.Mutation.createEvent(
      null,
      {
        input: {
          title: "Faux rendez-vous",
          start: new Date("2026-11-03T09:00:00Z"),
          end: new Date("2026-11-03T09:30:00Z"),
          type: "APPOINTMENT",
        },
      },
      ctx(owner),
      info("createEvent"),
    );
    expect(create.success).toBe(false);
  });
});
