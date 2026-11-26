/**
 * Billetterie côté tableau de bord : création d'un événement et refus de
 * saisie, inscrits, export CSV, annulation, contrôle des billets (VALID,
 * ALREADY_CHECKED_IN, OTHER_EVENT, UNKNOWN, CANCELLED), cloisonnement entre
 * espaces et utilisateurs, droits par rôle.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
  process.env.FRONTEND_URL = "https://www.newbi.fr";
  process.env.COMPANY_IMAGE_URL = "https://images.newbi.fr";
});

vi.mock("stripe", () => ({
  default: class {
    constructor() {
      return { checkout: { sessions: {} }, refunds: {} };
    }
  },
}));
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
  getCalendarProvider: () => ({}),
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
import BookingPage from "../../src/models/BookingPage.js";
import Event from "../../src/models/Event.js";
import EventRegistration from "../../src/models/EventRegistration.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import appointmentsResolvers from "../../src/resolvers/appointments.js";
import appointmentEventsResolvers from "../../src/resolvers/appointmentEvents.js";
import { loadPublicPage } from "../../src/services/appointments/bookingService.js";
import {
  registerForEvent,
  runEventReminders,
} from "../../src/services/appointments/eventRegistrationService.js";

const { Mutation } = appointmentsResolvers;
const Events = appointmentEventsResolvers;
const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();
const outsider = buildUserId();

const DAY = 86400000;
const ctx = (userId, org = workspaceId) =>
  buildContext({ userId, organizationId: org });
const call = (resolver, userId, args = {}, org = workspaceId) =>
  resolver(null, args, ctx(userId, org), { fieldName: "test" });
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code || error.extensions?.code;
  }
};
const fieldOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.extensions?.field || error.field || error.details?.field;
  }
};

const eventInput = (overrides = {}) => {
  const start = new Date(Date.now() + 10 * DAY);
  return {
    kind: "EVENT",
    name: "Soirée de lancement",
    description: "Venez nombreux",
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3 * 3600000).toISOString(),
    location: { kind: "IN_PERSON", value: "5 place du Marché, Lyon" },
    capacity: 10,
    maxPerOrder: 4,
    details: "Programme :\n19 h accueil",
    ...overrides,
  };
};

async function createPage(userId, slug, org = workspaceId) {
  return call(Mutation.upsertBookingPage, userId, { input: { slug } }, org);
}

async function register(slug, typeSlug, quantity = 1, email = "a@b.fr") {
  const context = await loadPublicPage(slug);
  const type = await AppointmentType.findOne({ slug: typeSlug }).lean();
  return registerForEvent({
    context,
    type,
    buyer: { firstName: "Élise", lastName: "Martin", email },
    quantity,
  });
}

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    BookingPage.init(),
    AppointmentType.init(),
    EventRegistration.init(),
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
  for (const [userId, role, org] of [
    [owner, "owner", workspaceId],
    [member, "member", workspaceId],
    [viewer, "viewer", workspaceId],
    [accountant, "accountant", workspaceId],
    [outsider, "owner", otherWorkspace],
  ]) {
    await seedOrgMembership({
      userId,
      organizationId: org,
      role,
      organizationName: org === workspaceId ? "Cabinet" : "Autre",
    });
  }
  await mongoose.connection.db.collection("user").insertMany([
    { _id: owner, name: "Jean Dupont", email: "jean@cabinet.fr" },
    { _id: member, name: "Paul Membre", email: "paul@cabinet.fr" },
    { _id: outsider, name: "Ola Autre", email: "ola@autre.fr" },
  ]);
  await createPage(owner, "jean-dupont");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("création d'un événement", () => {
  it("gratuit : champs d'événement, entrée du Calendrier, durée calculée", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    const T = appointmentsResolvers.AppointmentType;
    expect(T.kind(type)).toBe("EVENT");
    expect(type.slug).toBe("soiree-de-lancement");
    expect(type.durationMinutes).toBe(180);
    expect(T.capacity(type)).toBe(10);
    expect(T.seatsLeft(type)).toBe(10);
    expect(T.maxPerOrder(type)).toBe(4);
    expect(T.price(type)).toBeNull();
    expect(T.details(type)).toBe("Programme :\n19 h accueil");
    expect(await T.registrationsCount(type)).toBe(0);
    const entry = await Event.findById(type.calendarEventId);
    expect(entry).toMatchObject({
      title: "Soirée de lancement",
      type: "APPOINTMENT",
    });
    // Un créneau existant reste un créneau
    const slot = await AppointmentType.findOne({ slug: "rendez-vous-30-min" });
    expect(T.kind(slot)).toBe("SLOT");
    expect(T.startAt(slot)).toBeNull();
  });

  it("refus de saisie", async () => {
    const cases = [
      [{ location: { kind: "GOOGLE_MEET" } }, "location"],
      [{ location: { kind: "PHONE" } }, "location"],
      [{ endAt: new Date(Date.now() + 9 * DAY).toISOString() }, "endAt"],
      [
        {
          startAt: new Date(Date.now() - DAY).toISOString(),
          endAt: new Date(Date.now() + DAY).toISOString(),
        },
        "startAt",
      ],
      [{ maxPerOrder: 11 }, "maxPerOrder"],
      [{ capacity: 0 }, "capacity"],
      [{ details: "x".repeat(10001) }, "details"],
      [
        { registrationClosesAt: new Date(Date.now() + 20 * DAY).toISOString() },
        "registrationClosesAt",
      ],
      [{ imageUrl: "https://ailleurs.fr/image.webp" }, "imageUrl"],
      [
        {
          coverImageUrl: `https://images.newbi.fr/${otherWorkspace}/events/a.webp`,
        },
        "coverImageUrl",
      ],
      [{ price: { amount: 1500 } }, "price"],
      [{ price: { amount: 10 } }, "price"],
    ];
    for (const [overrides, field] of cases) {
      const promise = call(Mutation.createAppointmentType, owner, {
        input: eventInput(overrides),
      });
      expect(await fieldOf(promise), JSON.stringify(overrides)).toBe(field);
    }
    expect(await AppointmentType.countDocuments({ kind: "EVENT" })).toBe(0);
  });

  it("payant accepté quand Stripe est connecté ; image de l'espace acceptée", async () => {
    await StripeConnectAccount.create({
      organizationId: String(workspaceId),
      accountId: "acct_vendeur",
      connectionType: "oauth",
      chargesEnabled: true,
    });
    expect(await call(Events.Query.eventPaymentMethods, owner)).toEqual([
      "stripe",
    ]);
    const image = `https://images.newbi.fr/${workspaceId}/events/abc.webp`;
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput({ price: { amount: 2500 }, imageUrl: image }),
    });
    expect(appointmentsResolvers.AppointmentType.price(type)).toEqual({
      amount: 2500,
      currency: "EUR",
    });
    expect(type.imageUrl).toBe(image);
  });

  it("modification : kind figé, places jamais sous les places prises, instantané des inscriptions mis à jour", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput({ capacity: 5 }),
    });
    await register("jean-dupont", type.slug, 3);
    expect(
      await fieldOf(
        call(Mutation.updateAppointmentType, owner, {
          id: String(type._id),
          input: { kind: "SLOT" },
        }),
      ),
    ).toBe("kind");
    expect(
      await fieldOf(
        call(Mutation.updateAppointmentType, owner, {
          id: String(type._id),
          input: { capacity: 2 },
        }),
      ),
    ).toBe("capacity");
    const updated = await call(Mutation.updateAppointmentType, owner, {
      id: String(type._id),
      input: { capacity: 3, name: "Soirée renommée" },
    });
    expect(updated.capacity).toBe(3);
    expect(updated.seatsTaken).toBe(3);
    const registration = await EventRegistration.findOne();
    expect(registration.event.name).toBe("Soirée renommée");
    expect((await Event.findById(type.calendarEventId)).title).toBe(
      "Soirée renommée",
    );
  });

  it("suppression refusée tant qu'il y a des inscrits à venir", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    await register("jean-dupont", type.slug, 1);
    expect(
      await codeOf(
        call(Mutation.deleteAppointmentType, owner, { id: String(type._id) }),
      ),
    ).toBe("VALIDATION_ERROR");
    await EventRegistration.updateMany({}, { status: "CANCELLED" });
    expect(
      await call(Mutation.deleteAppointmentType, owner, {
        id: String(type._id),
      }),
    ).toBe(true);
    expect(await Event.countDocuments({ _id: type.calendarEventId })).toBe(0);
  });
});

describe("inscrits, export et annulation", () => {
  it("liste avec recherche, CSV, annulation par l'organisateur", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    const first = await register("jean-dupont", type.slug, 2, "elise@ex.fr");
    const context = await loadPublicPage("jean-dupont");
    await registerForEvent({
      context,
      type: await AppointmentType.findById(type._id).lean(),
      buyer: {
        firstName: '=HYPERLINK("x")',
        lastName: "Durand",
        email: "zoe@ex.fr",
      },
      quantity: 1,
    });
    const list = await call(Events.Query.eventRegistrations, owner, {
      typeId: String(type._id),
    });
    expect(list.totalCount).toBe(2);
    const found = await call(Events.Query.eventRegistrations, owner, {
      typeId: String(type._id),
      search: first.tickets[0].number.toLowerCase(),
    });
    expect(found.items.map((r) => r.buyer.email)).toEqual(["elise@ex.fr"]);
    const byName = await call(Events.Query.eventRegistrations, owner, {
      typeId: String(type._id),
      search: "Élise Martin",
    });
    expect(byName.totalCount).toBe(1);

    const csv = await call(Events.Query.eventRegistrationsCsv, owner, {
      typeId: String(type._id),
    });
    expect(csv.startsWith("\ufeffNuméro du billet;")).toBe(true);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(4);
    expect(csv).toContain(first.tickets[0].number);
    // Formule neutralisée
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);

    const cancelled = await call(
      Events.Mutation.cancelEventRegistration,
      owner,
      {
        id: String(first.registration._id),
        reason: "Événement complet",
      },
    );
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelledBy).toBe("HOST");
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(1);
    await vi.waitFor(() =>
      expect(
        mail.sent.some((m) => m.subject.startsWith("Inscription annulée")),
      ).toBe(true),
    );
  });

  it("rappel la veille : une seule fois", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    await register("jean-dupont", type.slug, 1);
    mail.sent = [];
    const startAt = new Date(Date.now() + 20 * 3600000);
    // createdAt est immuable pour Mongoose : écriture directe
    await EventRegistration.collection.updateMany(
      {},
      {
        $set: {
          "event.startAt": startAt,
          createdAt: new Date(Date.now() - 2 * DAY),
        },
      },
    );
    expect(await runEventReminders()).toEqual({ sent: 1, failed: 0 });
    expect(await runEventReminders()).toEqual({ sent: 0, failed: 0 });
    expect(mail.sent[0].subject).toMatch(/^Rappel : Soirée de lancement/);
    expect(mail.sent[0].html).toContain("/qr.png");
  });
});

describe("contrôle des billets", () => {
  it("VALID, ALREADY_CHECKED_IN, numéro saisi, OTHER_EVENT, UNKNOWN, CANCELLED, retour arrière", async () => {
    const soiree = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    const autre = await call(Mutation.createAppointmentType, owner, {
      input: eventInput({ name: "Atelier" }),
    });
    const { tickets } = await register("jean-dupont", soiree.slug, 2);
    const typeId = String(soiree._id);

    const valid = await call(Events.Mutation.checkInTicket, owner, {
      typeId,
      code: `https://www.newbi.fr/rdv/billet/${tickets[0].token}`,
    });
    expect(valid.result).toBe("VALID");
    expect(valid.ticket.number).toBe(tickets[0].number);
    expect(valid.ticket.checkedInAt).toBeInstanceOf(Date);

    const again = await call(Events.Mutation.checkInTicket, owner, {
      typeId,
      code: tickets[0].token,
    });
    expect(again.result).toBe("ALREADY_CHECKED_IN");
    expect(again.ticket.checkedInAt).toEqual(valid.ticket.checkedInAt);

    // Saisie manuelle du numéro : casse, espaces et préfixe indifférents
    const manual = await call(Events.Mutation.checkInTicket, owner, {
      typeId,
      code: ` ${tickets[1].number.slice(4).toLowerCase()} `,
    });
    expect(manual.result).toBe("VALID");

    const other = await call(Events.Mutation.checkInTicket, owner, {
      typeId: String(autre._id),
      code: tickets[0].token,
    });
    expect(other).toMatchObject({
      result: "OTHER_EVENT",
      otherEventName: "Soirée de lancement",
      ticket: null,
    });

    for (const code of ["", "n'importe quoi", "EVT-AAAAAA", "a".repeat(43)]) {
      const unknown = await call(Events.Mutation.checkInTicket, owner, {
        typeId,
        code,
      });
      expect(unknown.result, code).toBe("UNKNOWN");
    }

    const undone = await call(Events.Mutation.undoTicketCheckIn, owner, {
      ticketId: String(valid.ticket._id),
    });
    expect(undone.checkedInAt).toBeNull();
    const stats = await AppointmentType.findById(soiree._id).lean();
    expect(
      await appointmentsResolvers.AppointmentType.checkedInCount(stats),
    ).toBe(1);

    await EventRegistration.updateMany({}, { status: "CANCELLED" });
    const cancelled = await call(Events.Mutation.checkInTicket, owner, {
      typeId,
      code: tickets[0].token,
    });
    expect(cancelled.result).toBe("CANCELLED");
  });

  it("deux scans simultanés : un VALID, un ALREADY_CHECKED_IN", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    const { tickets } = await register("jean-dupont", type.slug, 1);
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        call(Events.Mutation.checkInTicket, owner, {
          typeId: String(type._id),
          code: tickets[0].token,
        }),
      ),
    );
    expect(results.map((r) => r.result).sort()).toEqual([
      "ALREADY_CHECKED_IN",
      "ALREADY_CHECKED_IN",
      "VALID",
    ]);
  });
});

describe("cloisonnement et droits", () => {
  it("un membre ou un autre espace ne voit ni ne contrôle les billets de l'organisateur", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    const { tickets, registration } = await register(
      "jean-dupont",
      type.slug,
      1,
    );
    const typeId = String(type._id);

    // Autre membre du même espace : l'événement n'est pas le sien
    expect(
      await codeOf(call(Events.Query.eventRegistrations, member, { typeId })),
    ).toBe("NOT_FOUND");
    await createPage(member, "paul-membre");
    const own = await call(Mutation.createAppointmentType, member, {
      input: eventInput({ name: "Événement de Paul" }),
    });
    const crossed = await call(Events.Mutation.checkInTicket, member, {
      typeId: String(own._id),
      code: tickets[0].token,
    });
    expect(crossed.result).toBe("UNKNOWN");
    expect(
      await codeOf(
        call(Events.Mutation.cancelEventRegistration, member, {
          id: String(registration._id),
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        call(Events.Mutation.undoTicketCheckIn, member, {
          ticketId: String(registration.tickets[0]._id),
        }),
      ),
    ).toBe("NOT_FOUND");

    // Autre espace
    expect(
      await codeOf(
        call(
          Events.Query.eventRegistrations,
          outsider,
          { typeId, workspaceId: String(otherWorkspace) },
          otherWorkspace,
        ),
      ),
    ).toBe("NOT_FOUND");
    // Espace d'un autre dans les arguments : refusé
    expect(
      await codeOf(
        call(
          Events.Query.eventRegistrations,
          outsider,
          { typeId, workspaceId: String(workspaceId) },
          otherWorkspace,
        ),
      ),
    ).toBeTruthy();
    expect(
      (await EventRegistration.findById(registration._id)).tickets[0]
        .checkedInAt,
    ).toBeNull();
  });

  it("rôles : lecteur sans écriture, comptable sans accès", async () => {
    const type = await call(Mutation.createAppointmentType, owner, {
      input: eventInput(),
    });
    const typeId = String(type._id);
    expect(
      await codeOf(
        call(Mutation.createAppointmentType, viewer, { input: eventInput() }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        call(Events.Mutation.checkInTicket, viewer, { typeId, code: "x" }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        call(Events.Query.eventRegistrations, accountant, { typeId }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(call(Events.Query.eventPaymentMethods, accountant)),
    ).toBe("FORBIDDEN");
  });
});
