/**
 * Rappels de rendez-vous (cron toutes les 5 minutes) : 24 h et 1 h avant,
 * jamais deux fois (revendication atomique, même avec deux passages
 * simultanés), pas pour une réservation prise au dernier moment, coupure
 * d'urgence APPOINTMENT_REMINDERS_MODE=off.
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
const mail = vi.hoisted(() => ({ sent: [] }));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: {
    useResend: true,
    resendFromEmail: "no-reply@newbi.fr",
    resend: {
      emails: {
        send: async (payload) => {
          // Envoi lent : deux passages simultanés se chevauchent vraiment
          await new Promise((resolve) => setTimeout(resolve, 20));
          mail.sent.push(payload);
          return { data: { id: "mail" }, error: null };
        },
      },
    },
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Booking, {
  encryptManageToken,
  generateManageToken,
  hashManageToken,
} from "../../src/models/Booking.js";
import BookingPage from "../../src/models/BookingPage.js";
import { runAppointmentReminders } from "../../src/services/appointments/reminderService.js";

const HOUR = 60 * 60 * 1000;
const now = new Date("2026-11-02T08:00:00Z");
const hostId = buildUserId();
const workspaceId = buildOrganizationId();
let pageId;

async function insertBooking({
  startIn,
  createdAgo,
  status = "CONFIRMED",
  email,
  reminders = {},
}) {
  const token = generateManageToken();
  const startAt = new Date(now.getTime() + startIn);
  // Insertion brute : createdAt choisi (le modèle l'imposerait à maintenant)
  const { insertedId } = await Booking.collection.insertOne({
    workspaceId,
    bookingPageId: pageId,
    hostUserId: hostId,
    startAt,
    endAt: new Date(startAt.getTime() + 30 * 60000),
    typeName: "Découverte",
    durationMinutes: 30,
    location: { kind: "PHONE", value: null },
    guest: {
      firstName: "Élise",
      lastName: "Martin",
      email,
      phone: "0612345678",
      timezone: "Europe/Paris",
    },
    status,
    rescheduleHistory: [],
    manageTokenHash: hashManageToken(token),
    manageTokenEncrypted: encryptManageToken(token),
    reminders: { h24SentAt: null, h1SentAt: null, ...reminders },
    createdAt: new Date(now.getTime() - createdAgo),
    updatedAt: new Date(now.getTime() - createdAgo),
  });
  return { id: insertedId, token };
}

beforeAll(async () => {
  await startMongo();
  await Booking.init();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  mail.sent = [];
  await mongoose.connection.db.collection("user").insertOne({
    _id: hostId,
    name: "Jean Dupont",
    email: "jean@cabinet.fr",
  });
  await mongoose.connection.db.collection("organization").insertOne({
    _id: workspaceId,
    name: "Cabinet Martin",
  });
  pageId = (
    await BookingPage.create({
      workspaceId,
      userId: hostId,
      slug: "jean-dupont",
      title: "Jean",
    })
  )._id;
});

afterEach(() => {
  delete process.env.APPOINTMENT_REMINDERS_MODE;
});

describe("rappels de rendez-vous", () => {
  it("envoie le rappel 24 h une seule fois, avec le lien de gestion", async () => {
    const { id, token } = await insertBooking({
      startIn: 20 * HOUR,
      createdAgo: 3 * 24 * HOUR,
      email: "elise@exemple.fr",
    });
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 1 });
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 0 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(["elise@exemple.fr"]);
    expect(mail.sent[0].subject).toMatch(/^Rappel : votre rendez-vous le/);
    expect(mail.sent[0].html).toContain(
      `https://www.newbi.fr/rdv/gerer/${token}`,
    );
    expect(mail.sent[0].from).toBe(
      "Cabinet Martin via Newbi <no-reply@newbi.fr>",
    );
    const booking = await Booking.findById(id).lean();
    expect(booking.reminders.h24SentAt).toEqual(now);
    expect(booking.reminders.h1SentAt).toBeNull();
  });

  it("deux passages simultanés n'envoient jamais deux fois", async () => {
    for (let i = 0; i < 3; i += 1) {
      await insertBooking({
        startIn: (10 + i) * HOUR,
        createdAgo: 3 * 24 * HOUR,
        email: `invite${i}@exemple.fr`,
      });
    }
    const results = await Promise.all([
      runAppointmentReminders(now),
      runAppointmentReminders(now),
    ]);
    expect(results[0].sent + results[1].sent).toBe(3);
    expect(mail.sent).toHaveLength(3);
    expect(new Set(mail.sent.map((m) => m.to[0])).size).toBe(3);
  });

  it("rappel 1 h : prime sur celui de la veille dans la dernière heure", async () => {
    const { id } = await insertBooking({
      startIn: 40 * 60000,
      createdAgo: 2 * 24 * HOUR,
      email: "elise@exemple.fr",
    });
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 1 });
    expect(mail.sent[0].subject).toMatch(/^Rappel : votre rendez-vous à/);
    const booking = await Booking.findById(id).lean();
    expect(booking.reminders.h1SentAt).toEqual(now);
    expect(booking.reminders.h24SentAt).toBeNull();
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 0 });
  });

  it("pas de rappel 24 h pour une réservation prise moins de 24 h avant", async () => {
    await insertBooking({
      startIn: 20 * HOUR,
      createdAgo: 2 * HOUR,
      email: "a@exemple.fr",
    });
    // Le rappel 1 h viendra : prise plus d'une heure avant le début
    await insertBooking({
      startIn: 30 * 60000,
      createdAgo: 20 * 60000,
      email: "b@exemple.fr",
    });
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 0 });
    expect(mail.sent).toHaveLength(0);
  });

  it("ignore les annulations, les rendez-vous passés ou lointains", async () => {
    await insertBooking({
      startIn: 5 * HOUR,
      createdAgo: 3 * 24 * HOUR,
      status: "CANCELLED",
      email: "a@exemple.fr",
    });
    await insertBooking({
      startIn: -HOUR,
      createdAgo: 3 * 24 * HOUR,
      email: "b@exemple.fr",
    });
    await insertBooking({
      startIn: 30 * HOUR,
      createdAgo: 3 * 24 * HOUR,
      email: "c@exemple.fr",
    });
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 0 });
  });

  it("APPOINTMENT_REMINDERS_MODE=off : rien n'est envoyé ni revendiqué", async () => {
    process.env.APPOINTMENT_REMINDERS_MODE = "off";
    const { id } = await insertBooking({
      startIn: 20 * HOUR,
      createdAgo: 3 * 24 * HOUR,
      email: "a@exemple.fr",
    });
    expect(await runAppointmentReminders(now)).toEqual({
      mode: "off",
      sent: 0,
      failed: 0,
    });
    expect((await Booking.findById(id).lean()).reminders.h24SentAt).toBeNull();
  });

  it("un déplacement récent compte comme une nouvelle réservation", async () => {
    const { id } = await insertBooking({
      startIn: 20 * HOUR,
      createdAgo: 5 * 24 * HOUR,
      email: "a@exemple.fr",
    });
    await Booking.collection.updateOne(
      { _id: id },
      {
        $push: {
          rescheduleHistory: {
            fromStartAt: now,
            toStartAt: now,
            at: new Date(now.getTime() - HOUR),
            by: "GUEST",
          },
        },
      },
    );
    expect(await runAppointmentReminders(now)).toMatchObject({ sent: 0 });
  });
});
