/**
 * Prise de rendez-vous, routes publiques /api/public/booking :
 * 404 uniforme (rien n'est révélé), formes de réponse du contrat avec le
 * site, pot de miel, validation, Turnstile, limitation par IP (429),
 * gestion par l'invité avec son jeton.
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
  delete process.env.TURNSTILE_SECRET_KEY;
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

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import AppointmentType from "../../src/models/AppointmentType.js";
import Booking from "../../src/models/Booking.js";
import BookingPage from "../../src/models/BookingPage.js";
import Client from "../../src/models/Client.js";
import publicBookingRoutes from "../../src/routes/publicBooking.js";
import { addDays, localDayOf } from "../../src/utils/appointmentSlots.js";

let server;
let baseUrl;
const hostId = buildUserId();
const workspaceId = buildOrganizationId();
let page;

const api = (path, options = {}) =>
  fetch(`${baseUrl}/api/public/booking${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

const today = () => localDayOf(new Date(), "Europe/Paris");

async function firstSlots(typeSlug = "decouverte") {
  const res = await api(
    `/jean-dupont/${typeSlug}/slots?from=${addDays(today(), 1)}&to=${addDays(today(), 15)}`,
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.slots.length).toBeGreaterThan(1);
  return body.slots;
}

const bookingBody = (start, overrides = {}) => ({
  start,
  guest: {
    firstName: "Élise",
    lastName: "Martin",
    email: "elise@exemple.fr",
    phone: "0612345678",
    message: "",
  },
  timezone: "America/Montreal",
  turnstileToken: "jeton",
  website: "",
  ...overrides,
});

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Booking.init(),
    Client.init(),
    BookingPage.init(),
    AppointmentType.init(),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/api/public/booking", publicBookingRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  resetMemoryAttempts();
  mail.sent = [];
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
  page = await BookingPage.create({
    workspaceId,
    userId: hostId,
    slug: "jean-dupont",
    title: "Jean Dupont",
    description: "Prenez rendez-vous",
  });
  await AppointmentType.create([
    {
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      slug: "decouverte",
      name: "Découverte",
      durationMinutes: 30,
      location: { kind: "CUSTOM_LINK", value: "https://zoom.us/j/123" },
      minNoticeMinutes: 0,
      position: 1,
    },
    {
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      slug: "appel",
      name: "Appel",
      durationMinutes: 15,
      location: { kind: "PHONE" },
      minNoticeMinutes: 0,
      position: 0,
    },
    {
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      slug: "ancien",
      name: "Ancien",
      durationMinutes: 30,
      location: { kind: "PHONE" },
      isActive: false,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TURNSTILE_SECRET_KEY;
});

describe("404 uniforme", () => {
  it("page inconnue, adresse invalide, type inactif ou inconnu : même réponse", async () => {
    const paths = [
      "/inconnue",
      "/A$",
      "/jean-dupont/ancien",
      "/jean-dupont/inconnu",
      "/jean-dupont/ancien/slots",
      "/manage/jeton-invalide",
      `/manage/${"a".repeat(43)}`,
    ];
    for (const path of paths) {
      const res = await api(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    }
  });

  it("page désactivée : 404", async () => {
    await BookingPage.updateOne({ _id: page._id }, { isActive: false });
    const res = await api("/jean-dupont");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("organisation sans abonnement actif (lecture seule) : 404", async () => {
    await mongoose.connection.db.collection("subscription").updateOne(
      { referenceId: String(workspaceId) },
      {
        $set: { status: "canceled", periodEnd: new Date(Date.now() - 1000) },
      },
    );
    invalidateSubCache();
    for (const path of [
      "/jean-dupont",
      "/jean-dupont/decouverte",
      "/jean-dupont/decouverte/slots",
    ]) {
      const res = await api(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "NOT_FOUND" });
    }
  });

  it("réservation sur une page inconnue : 404", async () => {
    const res = await api("/inconnue/decouverte/book", {
      method: "POST",
      body: bookingBody(new Date().toISOString()),
    });
    expect(res.status).toBe(404);
  });
});

describe("lecture des pages", () => {
  it("GET /:slug : page et types actifs triés par position", async () => {
    const res = await api("/jean-dupont");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.page).toEqual({
      slug: "jean-dupont",
      title: "Jean Dupont",
      description: "Prenez rendez-vous",
      accentColor: "#5b50ff",
      avatarUrl: null,
      timezone: "Europe/Paris",
      organizationName: "Cabinet Martin",
    });
    expect(body.types).toEqual([
      {
        slug: "appel",
        name: "Appel",
        description: null,
        durationMinutes: 15,
        locationKind: "PHONE",
        requirePhone: true,
      },
      {
        slug: "decouverte",
        name: "Découverte",
        description: null,
        durationMinutes: 30,
        locationKind: "CUSTOM_LINK",
        requirePhone: false,
      },
    ]);
  });

  it("GET /:slug/:typeSlug : type avec libellé du lieu et horizon", async () => {
    const res = await api("/jean-dupont/decouverte");
    const body = await res.json();
    expect(body.page.slug).toBe("jean-dupont");
    expect(body.type).toEqual({
      slug: "decouverte",
      name: "Découverte",
      description: null,
      durationMinutes: 30,
      locationKind: "CUSTOM_LINK",
      locationLabel: "Visioconférence",
      requirePhone: false,
      maxDaysAhead: 60,
    });
  });

  it("GET slots : fuseau de la page et heures UTC", async () => {
    const res = await api(
      `/jean-dupont/decouverte/slots?from=${addDays(today(), 1)}&to=${addDays(today(), 7)}`,
    );
    const body = await res.json();
    expect(body.timezone).toBe("Europe/Paris");
    expect(body.slots[0]).toEqual({
      start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/),
      end: expect.stringMatching(/Z$/),
    });
  });

  it("GET slots : dates invalides ou inversées refusées", async () => {
    let res = await api(
      "/jean-dupont/decouverte/slots?from=2026-13-01&to=2026-12-01",
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION");
    res = await api(
      `/jean-dupont/decouverte/slots?from=${addDays(today(), 5)}&to=${addDays(today(), 1)}`,
    );
    expect(res.status).toBe(400);
  });

  it("GET slots : plage bornée à 42 jours", async () => {
    const from = addDays(today(), 1);
    const res = await api(
      `/jean-dupont/decouverte/slots?from=${from}&to=${addDays(from, 200)}`,
    );
    const body = await res.json();
    const last = body.slots.at(-1).start;
    expect(
      localDayOf(new Date(last), "Europe/Paris") <= addDays(from, 41),
    ).toBe(true);
  });
});

describe("réservation", () => {
  it("201 : forme du contrat, lien de gestion et .ics", async () => {
    const [slot] = await firstSlots();
    const res = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slot.start),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking).toEqual({
      startAt: slot.start,
      endAt: slot.end,
      typeName: "Découverte",
      locationKind: "CUSTOM_LINK",
      locationLabel: "Visioconférence",
      meetingUrl: "https://zoom.us/j/123",
      hostName: "Jean Dupont",
      timezone: "America/Montreal",
    });
    expect(body.manageUrl).toMatch(
      /^https:\/\/www\.newbi\.fr\/rdv\/gerer\/[A-Za-z0-9_-]{43}$/,
    );
    const token = body.manageUrl.split("/").pop();
    expect(body.icsUrl).toBe(`/api/public/booking/manage/${token}/ics`);

    // Page de gestion
    const manage = await (await api(`/manage/${token}`)).json();
    expect(manage).toEqual({
      status: "CONFIRMED",
      startAt: slot.start,
      endAt: slot.end,
      typeName: "Découverte",
      locationKind: "CUSTOM_LINK",
      locationLabel: "Visioconférence",
      meetingUrl: "https://zoom.us/j/123",
      hostName: "Jean Dupont",
      timezone: "America/Montreal",
      page: {
        slug: "jean-dupont",
        title: "Jean Dupont",
        accentColor: "#5b50ff",
        timezone: "Europe/Paris",
      },
      typeSlug: "decouverte",
      canCancel: true,
      canReschedule: true,
      cancelledAt: null,
    });

    // Fichier .ics
    const ics = await api(`/manage/${token}/ics`);
    expect(ics.headers.get("content-type")).toContain("text/calendar");
    const content = await ics.text();
    expect(content).toContain("METHOD:PUBLISH");
    expect(content).toContain("SUMMARY:Découverte avec Jean Dupont");

    // Le créneau n'est plus proposé
    const after = await firstSlots();
    expect(after.some((s) => s.start === slot.start)).toBe(false);
  });

  it("409 SLOT_TAKEN quand le créneau vient d'être pris", async () => {
    const [slot] = await firstSlots();
    const first = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slot.start),
    });
    expect(first.status).toBe(201);
    const second = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slot.start, {
        guest: {
          firstName: "Paul",
          lastName: "Durand",
          email: "paul@exemple.fr",
        },
      }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "SLOT_TAKEN" });
  });

  it("400 VALIDATION avec les champs en erreur", async () => {
    const [slot] = await firstSlots("appel");
    const res = await api("/jean-dupont/appel/book", {
      method: "POST",
      body: bookingBody(slot.start, {
        guest: {
          firstName: "",
          lastName: "Martin",
          email: "pas-un-email",
          phone: "",
        },
        timezone: "Mars/Olympus",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION");
    expect(Object.keys(body.fields).sort()).toEqual([
      "email",
      "firstName",
      "phone",
      "timezone",
    ]);
    expect(await Booking.countDocuments()).toBe(0);
  });

  it("pot de miel : 201 factice, rien d'enregistré ni envoyé", async () => {
    const [slot] = await firstSlots();
    const res = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slot.start, { website: "https://spam.example" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.booking.startAt).toBe(slot.start);
    expect(body.manageUrl).toMatch(/\/rdv\/gerer\//);
    expect(await Booking.countDocuments()).toBe(0);
    expect(await Client.countDocuments()).toBe(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("Turnstile configuré : jeton absent refusé", async () => {
    process.env.TURNSTILE_SECRET_KEY = "secret-de-test";
    const [slot] = await firstSlots();
    const res = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slot.start, { turnstileToken: undefined }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).fields).toHaveProperty("turnstileToken");
    expect(await Booking.countDocuments()).toBe(0);
  });

  it("client bloqué : UNAVAILABLE", async () => {
    await Client.collection.insertOne({
      workspaceId,
      name: "Bloquée",
      type: "COMPANY",
      email: "elise@exemple.fr",
      isBlocked: true,
      address: {},
      createdBy: hostId,
      activity: [],
    });
    const [slot] = await firstSlots();
    const res = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slot.start),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "UNAVAILABLE" });
  });
});

describe("gestion par l'invité", () => {
  async function bookFirst() {
    const slots = await firstSlots();
    const res = await api("/jean-dupont/decouverte/book", {
      method: "POST",
      body: bookingBody(slots[0].start),
    });
    const body = await res.json();
    return { token: body.manageUrl.split("/").pop(), slots };
  }

  it("annule, puis l'annulation répétée reste sans effet", async () => {
    const { token } = await bookFirst();
    const res = await api(`/manage/${token}/cancel`, {
      method: "POST",
      body: { reason: "Empêchement" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "CANCELLED" });
    const again = await api(`/manage/${token}/cancel`, {
      method: "POST",
      body: {},
    });
    expect(await again.json()).toEqual({ status: "CANCELLED" });

    const manage = await (await api(`/manage/${token}`)).json();
    expect(manage).toMatchObject({
      status: "CANCELLED",
      canCancel: false,
      canReschedule: false,
      meetingUrl: null,
    });
    expect(manage.cancelledAt).toEqual(expect.any(String));
  });

  it("déplace le rendez-vous (même forme que la page de gestion)", async () => {
    const { token, slots } = await bookFirst();
    // excludeToken : le créneau actuel redevient visible pour l'invité
    const withExclusion = await (
      await api(
        `/jean-dupont/decouverte/slots?from=${addDays(today(), 1)}&to=${addDays(today(), 15)}&excludeToken=${token}`,
      )
    ).json();
    expect(withExclusion.slots.some((s) => s.start === slots[0].start)).toBe(
      true,
    );

    const res = await api(`/manage/${token}/reschedule`, {
      method: "POST",
      body: { start: slots[1].start, turnstileToken: "jeton" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: "CONFIRMED",
      startAt: slots[1].start,
      canReschedule: true,
    });
  });

  it("refuse un déplacement vers un créneau invalide (409) ou sans heure (400)", async () => {
    const { token, slots } = await bookFirst();
    const offGrid = new Date(
      new Date(slots[1].start).getTime() + 7 * 60000,
    ).toISOString();
    let res = await api(`/manage/${token}/reschedule`, {
      method: "POST",
      body: { start: offGrid },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SLOT_TAKEN" });
    res = await api(`/manage/${token}/reschedule`, {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(400);
  });
});

describe("limitation par IP", () => {
  it("lectures : 429 au-delà de 60 par minute", async () => {
    for (let i = 0; i < 60; i += 1) {
      const res = await api("/inconnue");
      expect(res.status).toBe(404);
    }
    const res = await api("/inconnue");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "RATE_LIMITED" });
  });

  it("réservations : 429 au-delà de 5 par minute", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await api("/inconnue/decouverte/book", {
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(404);
    }
    const res = await api("/inconnue/decouverte/book", {
      method: "POST",
      body: {},
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "RATE_LIMITED" });
  });

  it("gestion : 429 au-delà de 10 par minute", async () => {
    for (let i = 0; i < 10; i += 1) {
      await api(`/manage/${"b".repeat(43)}`);
    }
    const res = await api(`/manage/${"b".repeat(43)}`);
    expect(res.status).toBe(429);
  });
});
