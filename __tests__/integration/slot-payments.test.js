/**
 * Rendez-vous payants (créneaux) : prix, acompte ou sur place, payés par
 * carte (Stripe), PayPal ou virement.
 *
 * Réglages du type (contrôles, moyen exigé, rien d'écrit sans changement,
 * créneaux existants gratuits), page publique, réservation sur place
 * confirmée tout de suite, réservation payante qui TIENT le créneau sans
 * rien écrire dans l'agenda (concurrence comprise), confirmation complète
 * après paiement (agenda, visio, client, e-mails), montant vérifié,
 * abandon, expiration, paiement tardif (confirmé, remboursé ou « à
 * rembourser à la main »), virement (annonce, repérage, « Marquer comme
 * payé »), droits et cloisonnement, et réservations existantes intactes.
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
  process.env.BACKEND_URL = "https://api.newbi.fr";
  process.env.NODE_ENV = "test";
  delete process.env.TURNSTILE_SECRET_KEY;
});

const stripeApi = vi.hoisted(() => ({
  checkout: {
    sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() },
  },
  refunds: { create: vi.fn() },
}));
vi.mock("stripe", () => ({
  default: class {
    constructor() {
      return stripeApi;
    }
  },
}));
const paypal = vi.hoisted(() => ({
  createPaypalOrder: null,
  getPaypalOrder: null,
  capturePaypalOrder: null,
}));
vi.mock("../../src/services/paypalService.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    isPaypalConfigured: () => true,
    createPaypalOrder: (...args) => paypal.createPaypalOrder(...args),
    getPaypalOrder: (...args) => paypal.getPaypalOrder(...args),
    capturePaypalOrder: (...args) => paypal.capturePaypalOrder(...args),
  };
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
const google = vi.hoisted(() => ({
  pushEventDetailed: null,
  getBusyIntervals: null,
  deleteEvent: null,
}));
vi.mock("../../src/services/calendar/CalendarProviderFactory.js", () => ({
  getCalendarProvider: () => ({
    pushEventDetailed: (...args) => google.pushEventDetailed(...args),
    getBusyIntervals: (...args) => google.getBusyIntervals(...args),
    deleteEvent: (...args) => google.deleteEvent(...args),
    rescheduleEvent: async () => {},
  }),
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
    sendEmail: async (payload) => {
      mail.sent.push(payload);
      return true;
    },
  },
}));

import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import AppointmentType from "../../src/models/AppointmentType.js";
import BankCreditClaim from "../../src/models/BankCreditClaim.js";
import Booking from "../../src/models/Booking.js";
import BookingPage from "../../src/models/BookingPage.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import Client from "../../src/models/Client.js";
import Event from "../../src/models/Event.js";
import Notification from "../../src/models/Notification.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import appointmentsResolvers from "../../src/resolvers/appointments.js";
import publicBookingRoutes from "../../src/routes/publicBooking.js";
import { dispatchConnectEvent } from "../../src/controllers/stripeConnectWebhookController.js";
import {
  expireOverdueBookings,
  sweepAppointmentBookings,
} from "../../src/services/appointments/bookingPaymentService.js";
import { detectAppointmentBankPayments } from "../../src/services/appointments/appointmentBankDetection.js";
import { uniquePaymentReference } from "../../src/services/payments/bankTransfer.js";
import { runAppointmentReminders } from "../../src/services/appointments/reminderService.js";
import { addDays, localDayOf } from "../../src/utils/appointmentSlots.js";

const { Mutation, Query } = appointmentsResolvers;
const T = appointmentsResolvers.AppointmentType;
const B = appointmentsResolvers.Booking;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const viewer = buildUserId();
const outsider = buildUserId();

const MINUTE = 60000;
const DAY = 86400000;
const IBAN = "FR7630006000011234567890189";
const ORDER = "5O190127TN364715T";

let server;
let baseUrl;

const ctx = (userId, org = workspaceId) =>
  buildContext({ userId, organizationId: org });
const call = (resolver, userId, args = {}, org = workspaceId) =>
  resolver(null, args, ctx(userId, org), { fieldName: "test" });
const errorOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return {
      code: error.code || error.extensions?.code,
      field: error.extensions?.field || error.field || error.details?.field,
      message: error.message,
    };
  }
};

const api = (path, options = {}) =>
  fetch(`${baseUrl}/api/public/booking${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

const setIban = () =>
  mongoose.connection.db
    .collection("organization")
    .updateOne({ _id: workspaceId }, { $set: { bankIban: IBAN } });
const connectStripe = () =>
  StripeConnectAccount.create({
    organizationId: String(workspaceId),
    accountId: "acct_vendeur",
    connectionType: "oauth",
    chargesEnabled: true,
  });
const connectGoogle = () =>
  CalendarConnection.create({
    userId: owner,
    provider: "google",
    status: "active",
    accountEmail: "jean@gmail.com",
  });

const slotInput = (overrides = {}) => ({
  name: "Consultation",
  durationMinutes: 30,
  location: { kind: "GOOGLE_MEET" },
  minNoticeMinutes: 0,
  ...overrides,
});
const createSlot = (overrides, userId = owner) =>
  call(Mutation.createAppointmentType, userId, {
    input: slotInput(overrides),
  });
const updateSlot = (type, input) =>
  call(Mutation.updateAppointmentType, owner, { id: String(type._id), input });

const today = () => localDayOf(new Date(), "Europe/Paris");
async function freeSlots(type, fromDay = 1) {
  const res = await api(
    `/jean-dupont/${type.slug}/slots?from=${addDays(today(), fromDay)}&to=${addDays(today(), fromDay + 13)}`,
  );
  return (await res.json()).slots;
}

const book = (type, start, { provider, i = 0 } = {}) =>
  api(`/jean-dupont/${type.slug}/book`, {
    method: "POST",
    body: {
      start,
      guest: {
        firstName: "Élise",
        lastName: "Martin",
        email: `elise${i}@exemple.fr`,
        phone: "0612345678",
      },
      timezone: "Europe/Paris",
      ...(provider ? { provider } : {}),
    },
  });

const stripeSession = (booking, extra = {}) => ({
  id: "cs_test_rdv",
  status: "complete",
  payment_status: "paid",
  amount_total: booking.amountOnline,
  currency: "eur",
  payment_intent: "pi_rdv",
  metadata: { type: "appointment_booking", bookingId: String(booking._id) },
  ...extra,
});

/** Jeton de retour de la dernière session Stripe créée. */
const returnTokenOf = () =>
  new URL(
    stripeApi.checkout.sessions.create.mock.calls.at(-1)[0].success_url,
  ).searchParams.get("rt");

const rawBooking = (id) =>
  mongoose.connection.db
    .collection("bookings")
    .findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
const mailTo = (email) =>
  mail.sent.filter((m) => [].concat(m.to).includes(email));
const textOf = (html) =>
  String(html)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|\u00a0|\u202f/g, " ")
    .replace(/&#39;|&#x27;|’/g, "'");

/** Créneau payant par carte, réservé, en attente. */
async function pendingStripeBooking(type, { i = 0 } = {}) {
  const [slot] = await freeSlots(type);
  const res = await book(type, slot.start, { provider: "stripe", i });
  expect(res.status).toBe(201);
  const body = await res.json();
  const booking = await Booking.findOne({
    "guest.email": `elise${i}@exemple.fr`,
  });
  return { slot, body, booking, returnToken: returnTokenOf() };
}

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
  for (const fn of [
    stripeApi.checkout.sessions.create,
    stripeApi.checkout.sessions.retrieve,
    stripeApi.checkout.sessions.expire,
    stripeApi.refunds.create,
  ]) {
    fn.mockReset();
  }
  stripeApi.checkout.sessions.create.mockResolvedValue({
    id: "cs_test_rdv",
    url: "https://checkout.stripe.com/c/pay/cs_test_rdv",
  });
  stripeApi.refunds.create.mockResolvedValue({ id: "re_1" });
  paypal.createPaypalOrder = vi.fn(async () => ({
    id: ORDER,
    approveUrl: "https://www.paypal.com/checkoutnow?token=x",
  }));
  paypal.getPaypalOrder = vi.fn();
  paypal.capturePaypalOrder = vi.fn();
  google.pushEventDetailed = vi.fn(async (_c, _e, options) => ({
    externalEventId: "google-evt-1",
    meetingUrl: options.conference
      ? "https://meet.google.com/abc-defg-hij"
      : null,
  }));
  google.getBusyIntervals = vi.fn(async () => []);
  google.deleteEvent = vi.fn(async () => {});
  for (const [userId, role, org] of [
    [owner, "owner", workspaceId],
    [member, "member", workspaceId],
    [viewer, "viewer", workspaceId],
    [outsider, "owner", otherWorkspace],
  ]) {
    await seedOrgMembership({
      userId,
      organizationId: org,
      role,
      organizationName: org === workspaceId ? "Cabinet Martin" : "Autre",
    });
  }
  await mongoose.connection.db.collection("user").insertMany([
    { _id: owner, name: "Jean Dupont", email: "jean@cabinet.fr" },
    { _id: member, name: "Paul Membre", email: "paul@cabinet.fr" },
    { _id: outsider, name: "Ola Autre", email: "ola@autre.fr" },
  ]);
  await connectGoogle();
  await call(Mutation.upsertBookingPage, owner, {
    input: { slug: "jean-dupont" },
  });
});

// ─── Réglages du type ────────────────────────────────────────────────────

describe("réglages d'un créneau payant", () => {
  it("prix sans moyen refusé ; IBAN suffit ; ONLINE par défaut", async () => {
    expect(
      await errorOf(createSlot({ price: { amount: 4000 } })),
    ).toMatchObject({ code: "VALIDATION_ERROR", field: "price" });
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    expect(T.price(type)).toEqual({ amount: 4000, currency: "EUR" });
    expect(T.paymentMode(type)).toBe("ONLINE");
    expect(T.depositAmount(type)).toBeNull();
    expect(await call(Query.appointmentPaymentMethods, owner)).toEqual([
      "bank_transfer",
    ]);
  });

  it("sur place sans moyen ; acompte contrôlé", async () => {
    const onSite = await createSlot({
      price: { amount: 4000 },
      paymentMode: "ON_SITE",
    });
    expect(T.paymentMode(onSite)).toBe("ON_SITE");
    await connectStripe();
    for (const depositAmount of [undefined, 4000, 5000, 30]) {
      expect(
        await errorOf(
          createSlot({
            name: `Acompte ${depositAmount}`,
            price: { amount: 4000 },
            paymentMode: "DEPOSIT",
            depositAmount,
          }),
        ),
      ).toMatchObject({ code: "VALIDATION_ERROR", field: "depositAmount" });
    }
    const deposit = await createSlot({
      name: "Avec acompte",
      price: { amount: 4000 },
      paymentMode: "DEPOSIT",
      depositAmount: 1000,
    });
    expect(T.depositAmount(deposit)).toBe(1000);
  });

  it("modification : rien d'écrit sans changement, gratuit retire les champs", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const before = await mongoose.connection.db
      .collection("appointment_types")
      .findOne({ _id: type._id });
    await updateSlot(type, { name: "Consultation longue" });
    await updateSlot(type, { price: { amount: 4000 }, paymentMode: "ONLINE" });
    const after = await mongoose.connection.db
      .collection("appointment_types")
      .findOne({ _id: type._id });
    expect(after.priceAmount).toBe(before.priceAmount);
    expect(after.paymentMode).toBe("ONLINE");
    expect(after).not.toHaveProperty("depositAmount");

    await updateSlot(type, { price: null });
    const free = await mongoose.connection.db
      .collection("appointment_types")
      .findOne({ _id: type._id });
    expect(free).not.toHaveProperty("paymentMode");
    expect(free).not.toHaveProperty("priceAmount");
    expect(T.price(free)).toBeNull();
  });

  it("créneau existant : gratuit même avec un prix égaré, intact en base", async () => {
    const page = await BookingPage.findOne({ userId: owner });
    const { insertedId } = await mongoose.connection.db
      .collection("appointment_types")
      .insertOne({
        workspaceId,
        bookingPageId: page._id,
        userId: owner,
        slug: "ancien",
        name: "Ancien",
        durationMinutes: 30,
        location: { kind: "PHONE", value: null },
        minNoticeMinutes: 0,
        priceAmount: 9900,
        isActive: true,
      });
    const raw = await mongoose.connection.db
      .collection("appointment_types")
      .findOne({ _id: insertedId });
    const type = await AppointmentType.findById(insertedId);
    expect(T.price(type)).toBeNull();
    expect(T.paymentMode(type)).toBeNull();
    // Modification sans rapport : aucun champ de paiement écrit
    await updateSlot(type, { name: "Ancien renommé" });
    const after = await mongoose.connection.db
      .collection("appointment_types")
      .findOne({ _id: insertedId });
    expect(after).not.toHaveProperty("paymentMode");
    expect(after).not.toHaveProperty("depositAmount");
    expect(after.priceAmount).toBe(raw.priceAmount);
    // Réservation : confirmée comme un gratuit
    const [slot] = await freeSlots(type);
    const res = await book(type, slot.start);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("CONFIRMED");
    expect(body.booking).not.toHaveProperty("amount");
    const bookingRaw = await mongoose.connection.db
      .collection("bookings")
      .findOne({});
    for (const key of ["amount", "paymentMode", "payment", "expiresAt"]) {
      expect(bookingRaw).not.toHaveProperty(key);
    }
  });
});

// ─── Page publique ───────────────────────────────────────────────────────

describe("page publique", () => {
  it("prix et règle de paiement ; gratuits inchangés", async () => {
    await connectStripe();
    await setIban();
    const paid = await createSlot({
      price: { amount: 4000 },
      paymentMode: "DEPOSIT",
      depositAmount: 1000,
    });
    const list = await (await api("/jean-dupont")).json();
    const free = list.types.find((t) => t.slug !== paid.slug);
    expect(free).not.toHaveProperty("payment");
    expect(list.types.find((t) => t.slug === paid.slug).payment).toEqual({
      price: { amount: 4000, currency: "EUR" },
      paymentMode: "DEPOSIT",
      depositAmount: 1000,
      amountOnline: 1000,
      amountDueOnSite: 3000,
    });
    const detail = await (await api(`/jean-dupont/${paid.slug}`)).json();
    expect(detail.type.payment.paymentMethods).toEqual([
      "stripe",
      "bank_transfer",
    ]);
  });
});

// ─── Sur place ───────────────────────────────────────────────────────────

describe("sur place", () => {
  it("confirmé tout de suite, reste dû, marqué réglé par l'organisateur", async () => {
    const type = await createSlot({
      price: { amount: 4000 },
      paymentMode: "ON_SITE",
    });
    const [slot] = await freeSlots(type);
    const res = await book(type, slot.start, { provider: "stripe" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("CONFIRMED");
    expect(body.booking).toMatchObject({
      status: "CONFIRMED",
      amount: 4000,
      paymentMode: "ON_SITE",
      amountOnline: 0,
      amountDueOnSite: 4000,
      paymentProvider: null,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
    });
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mailTo("elise0@exemple.fr")).toHaveLength(1));
    expect(textOf(mailTo("elise0@exemple.fr")[0].html)).toContain(
      "À régler sur place : 40,00 €",
    );
    const booking = await Booking.findOne({});
    const marked = await call(Mutation.markBookingPaidOnSite, owner, {
      id: String(booking._id),
      paid: true,
    });
    expect(B.onSitePaidAt(marked)).toBeInstanceOf(Date);
    // Gestion : annulable (rien payé en ligne)
    const token = body.manageUrl.split("/").pop();
    const manage = await (await api(`/manage/${token}`)).json();
    expect(manage.canCancel).toBe(true);
    expect(manage.onSitePaidAt).toEqual(expect.any(String));
  });
});

// ─── Carte : créneau tenu, confirmation ──────────────────────────────────

describe("paiement par carte", () => {
  it("créneau tenu, rien dans l'agenda ni d'e-mail avant le paiement", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const before = Date.now();
    const { slot, body, booking } = await pendingStripeBooking(type);

    expect(body).toEqual({
      status: "PENDING_PAYMENT",
      paymentUrl: "https://checkout.stripe.com/c/pay/cs_test_rdv",
      expiresAt: expect.any(String),
    });
    const hold = new Date(body.expiresAt).getTime() - before;
    expect(hold).toBeGreaterThan(29 * MINUTE);
    expect(hold).toBeLessThanOrEqual(31 * MINUTE);
    const [params, options] = stripeApi.checkout.sessions.create.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(4000);
    expect(params.metadata).toMatchObject({
      type: "appointment_booking",
      bookingId: String(booking._id),
    });
    expect(params.success_url).toContain(
      `/rdv/jean-dupont/${type.slug}/retour?rt=`,
    );
    expect(params.success_url).toContain("&kind=slot");
    expect(options.stripeAccount).toBe("acct_vendeur");

    expect(booking.status).toBe("PENDING_PAYMENT");
    expect(booking.meetingUrl).toBeNull();
    expect(google.pushEventDetailed).not.toHaveBeenCalled();
    expect(await Event.countDocuments()).toBe(0);
    expect(await Client.countDocuments()).toBe(0);
    expect(mail.sent).toHaveLength(0);

    // Créneau tenu : plus proposé, refusé à un autre
    expect((await freeSlots(type)).map((s) => s.start)).not.toContain(
      slot.start,
    );
    const other = await book(type, slot.start, { provider: "stripe", i: 1 });
    expect(other.status).toBe(409);
    expect(await other.json()).toEqual({ error: "SLOT_TAKEN" });
    // Y compris par un type gratuit du même organisateur
    const free = await createSlot({ name: "Gratuit" });
    const freeRes = await book(free, slot.start, { i: 2 });
    expect(freeRes.status).toBe(409);
    // Pas de rappel pour une réservation en attente
    expect(
      (
        await runAppointmentReminders(
          new Date(Date.parse(slot.start) - 30 * MINUTE),
        )
      ).sent,
    ).toBe(0);
  });

  it("concurrence : deux réservations simultanées du même créneau, une seule passe", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const [slot] = await freeSlots(type);
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        book(type, slot.start, { provider: "stripe", i }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    expect(await Booking.countDocuments({ status: "PENDING_PAYMENT" })).toBe(1);
  });

  it("retour payé : confirmé, agenda, visio, client, e-mails, rappels", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { booking, returnToken } = await pendingStripeBooking(type);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(booking),
    );
    const res = await api("/bookings/return", {
      method: "POST",
      body: { returnToken, provider: "stripe", sessionId: "cs_test_rdv" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      paymentStatus: "paid",
      refundStatus: "NONE",
      booking: {
        status: "CONFIRMED",
        amount: 4000,
        amountOnline: 4000,
        amountDueOnSite: 0,
        paymentProvider: "stripe",
        meetingUrl: "https://meet.google.com/abc-defg-hij",
      },
    });
    expect(body.manageUrl).toMatch(/\/rdv\/gerer\/[A-Za-z0-9_-]{43}$/);
    expect(body.icsUrl).toMatch(/\/ics$/);
    expect(google.pushEventDetailed).toHaveBeenCalledTimes(1);
    expect(await Event.countDocuments({ bookingId: booking._id })).toBe(1);
    expect(await Client.countDocuments({ email: "elise0@exemple.fr" })).toBe(1);
    expect(mailTo("elise0@exemple.fr")).toHaveLength(1);
    expect(mailTo("jean@cabinet.fr")).toHaveLength(1);
    expect(textOf(mailTo("elise0@exemple.fr")[0].html)).toContain(
      "Payé en ligne : 40,00 €",
    );
    // Second retour (double chargement) : rien de plus
    await api("/bookings/return", {
      method: "POST",
      body: { returnToken, provider: "stripe", sessionId: "cs_test_rdv" },
    });
    expect(google.pushEventDetailed).toHaveBeenCalledTimes(1);
    expect(mail.sent).toHaveLength(2);
    // Annulation par l'invité d'un rendez-vous payé : refusée
    const token = body.manageUrl.split("/").pop();
    const manage = await (await api(`/manage/${token}`)).json();
    expect(manage.canCancel).toBe(false);
    expect(manage.canReschedule).toBe(true);
    const cancel = await api(`/manage/${token}/cancel`, {
      method: "POST",
      body: {},
    });
    expect(cancel.status).toBe(409);
  });

  it("montant, devise ou compte différents : jamais confirmé", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { booking } = await pendingStripeBooking(type);
    for (const [session, account] of [
      [stripeSession(booking, { amount_total: 100 }), "acct_vendeur"],
      [stripeSession(booking, { currency: "usd" }), "acct_vendeur"],
      [stripeSession(booking), "acct_pirate"],
      [
        stripeSession(booking, {
          metadata: { type: "appointment_booking", bookingId: "x" },
        }),
        "acct_vendeur",
      ],
    ]) {
      await dispatchConnectEvent({
        type: "checkout.session.completed",
        account,
        data: { object: session },
      });
    }
    expect((await Booking.findById(booking._id)).status).toBe(
      "PENDING_PAYMENT",
    );
    // Webhook juste : confirmé
    const result = await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: { object: stripeSession(booking) },
    });
    expect(result.status).toBe("success");
    expect((await Booking.findById(booking._id)).status).toBe("CONFIRMED");
  });

  it("acompte : montant de l'acompte seulement, reste sur place", async () => {
    await connectStripe();
    const type = await createSlot({
      price: { amount: 4000 },
      paymentMode: "DEPOSIT",
      depositAmount: 1000,
    });
    const { booking, returnToken } = await pendingStripeBooking(type);
    const [params] = stripeApi.checkout.sessions.create.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(1000);
    expect(booking.amountOnline).toBe(1000);
    expect(booking.amountDueOnSite).toBe(3000);
    // Le total payé n'est pas l'acompte attendu : refusé
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(booking, { amount_total: 4000 }),
    );
    let res = await api("/bookings/return", {
      method: "POST",
      body: { returnToken, provider: "stripe" },
    });
    expect((await res.json()).booking.status).toBe("PENDING_PAYMENT");
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { "payment.checkedAt": null } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(booking),
    );
    res = await api("/bookings/return", {
      method: "POST",
      body: { returnToken, provider: "stripe" },
    });
    const body = await res.json();
    expect(body.booking).toMatchObject({
      status: "CONFIRMED",
      amountOnline: 1000,
      amountDueOnSite: 3000,
    });
    expect(textOf(mailTo("elise0@exemple.fr")[0].html)).toContain(
      "Acompte payé : 10,00 €. Reste à régler sur place : 30,00 €",
    );
  });

  it("abandon : paiement fermé, créneau libéré, sans e-mail", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { slot, booking, returnToken } = await pendingStripeBooking(type);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...stripeSession(booking),
      status: "open",
      payment_status: "unpaid",
    });
    const res = await api("/bookings/return/cancel", {
      method: "POST",
      body: { returnToken },
    });
    const body = await res.json();
    expect(body.paymentStatus).toBe("unpaid");
    expect(body.booking.status).toBe("EXPIRED");
    expect(stripeApi.checkout.sessions.expire).toHaveBeenCalled();
    expect((await freeSlots(type)).map((s) => s.start)).toContain(slot.start);
    expect(mail.sent).toHaveLength(0);
  });

  it("expiration après 30 minutes : créneau libéré, e-mail au participant", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { slot, booking } = await pendingStripeBooking(type);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...stripeSession(booking),
      status: "expired",
      payment_status: "unpaid",
    });
    await sweepAppointmentBookings({ now: new Date(Date.now() + 10 * MINUTE) });
    expect((await Booking.findById(booking._id)).status).toBe(
      "PENDING_PAYMENT",
    );
    await sweepAppointmentBookings({ now: new Date(Date.now() + 31 * MINUTE) });
    expect((await Booking.findById(booking._id)).status).toBe("EXPIRED");
    expect(mailTo("elise0@exemple.fr")[0].subject).toContain(
      "Réservation expirée",
    );
    expect((await freeSlots(type)).map((s) => s.start)).toContain(slot.start);
  });

  it("paiement tardif : confirmé si le créneau est libre, sinon remboursé", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const first = await pendingStripeBooking(type);
    await Booking.updateOne(
      { _id: first.booking._id },
      { $set: { status: "EXPIRED", "payment.status": "expired" } },
    );
    await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: { object: stripeSession(first.booking) },
    });
    expect((await Booking.findById(first.booking._id)).status).toBe(
      "CONFIRMED",
    );

    // Second cas : créneau repris entre-temps
    const second = await pendingStripeBooking(type, { i: 1 });
    await Booking.updateOne(
      { _id: second.booking._id },
      { $set: { status: "EXPIRED", "payment.status": "expired" } },
    );
    const [taker] = await freeSlots(type);
    expect(taker.start).toBe(second.slot.start);
    await book(type, taker.start, { provider: "stripe", i: 2 });
    await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: {
        object: stripeSession(second.booking, { payment_intent: "pi_tard" }),
      },
    });
    const late = await Booking.findById(second.booking._id);
    expect(late.status).toBe("EXPIRED");
    expect(stripeApi.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_tard" }),
      expect.objectContaining({ stripeAccount: "acct_vendeur" }),
    );
    expect(late.payment.refundedAt).toBeInstanceOf(Date);
    expect(B.refundedAt(late)).toBeInstanceOf(Date);
    // Jamais deux rendez-vous sur le même créneau
    expect(
      await Booking.countDocuments({
        startAt: late.startAt,
        status: { $in: ["CONFIRMED", "PENDING_PAYMENT"] },
      }),
    ).toBe(1);
  });

  it("annulation par l'organisateur d'une réservation en attente : créneau libéré", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { slot, booking } = await pendingStripeBooking(type);
    const cancelled = await call(Mutation.cancelBooking, owner, {
      id: String(booking._id),
    });
    expect(cancelled.status).toBe("CANCELLED");
    expect(google.deleteEvent).not.toHaveBeenCalled();
    expect(mail.sent).toHaveLength(0);
    expect((await freeSlots(type)).map((s) => s.start)).toContain(slot.start);
  });
});

// ─── PayPal ──────────────────────────────────────────────────────────────

describe("PayPal", () => {
  it("commande approuvée : encaissée au retour, confirmée", async () => {
    const { default: PaypalMerchantAccount } =
      await import("../../src/models/PaypalMerchantAccount.js");
    await PaypalMerchantAccount.deleteMany({});
    await PaypalMerchantAccount.create({
      organizationId: String(workspaceId),
      email: "vendeur@exemple.fr",
    });
    const type = await createSlot({ price: { amount: 4000 } });
    const [slot] = await freeSlots(type);
    const res = await book(type, slot.start, { provider: "paypal" });
    expect(res.status).toBe(201);
    const booking = await Booking.findOne({});
    expect(paypal.createPaypalOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 40, customId: `rdv-${booking._id}` }),
    );
    const unit = (status, capture) => ({
      id: ORDER,
      status,
      purchase_units: [
        {
          custom_id: `rdv-${booking._id}`,
          amount: { value: "40.00", currency_code: "EUR" },
          payments: capture ? { captures: [capture] } : undefined,
        },
      ],
    });
    paypal.getPaypalOrder.mockResolvedValue(unit("APPROVED"));
    paypal.capturePaypalOrder.mockResolvedValue(
      unit("COMPLETED", {
        id: "CAPTURE1",
        status: "COMPLETED",
        amount: { value: "40.00", currency_code: "EUR" },
      }),
    );
    const returnUrl = paypal.createPaypalOrder.mock.calls[0][0].returnUrl;
    const returnToken = new URL(returnUrl).searchParams.get("rt");
    const back = await api("/bookings/return", {
      method: "POST",
      body: { returnToken, provider: "paypal", orderId: ORDER },
    });
    expect((await back.json()).booking.status).toBe("CONFIRMED");
    expect(paypal.capturePaypalOrder).toHaveBeenCalledTimes(1);
  });
});

// ─── Virement ────────────────────────────────────────────────────────────

describe("virement", () => {
  async function pendingBank(type, i = 0) {
    // Virement : début à 48 h au moins (ici une semaine)
    const [slot] = await freeSlots(type, 7);
    const res = await book(type, slot.start, { provider: "bank_transfer", i });
    expect(res.status).toBe(201);
    const body = await res.json();
    const booking = await Booking.findOne({
      "guest.email": `elise${i}@exemple.fr`,
    });
    // L'e-mail des coordonnées part en arrière-plan : attendu ici, sinon il
    // peut arriver après un « mail.sent = [] » du test (CI plus lente)
    await vi.waitFor(() =>
      expect(
        mailTo(`elise${i}@exemple.fr`).some((m) =>
          String(m.subject).includes("Virement"),
        ),
      ).toBe(true),
    );
    return { slot, body, booking };
  }

  it("créneau tenu 3 jours, coordonnées, annonce sans confirmation, repérage", async () => {
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    const before = Date.now();
    const { slot, body, booking } = await pendingBank(type);
    expect(body.status).toBe("PENDING_PAYMENT");
    expect(body.icsUrl).toBeNull();
    expect(new Date(body.expiresAt).getTime() - before).toBeGreaterThan(
      3 * DAY - MINUTE,
    );
    expect(body.booking).toMatchObject({
      status: "PENDING_PAYMENT",
      paymentProvider: "bank_transfer",
      meetingUrl: null,
      bankTransfer: {
        iban: "FR76 3000 6000 0112 3456 7890 189",
        amount: 4000,
        reference: booking.payment.bankReference,
        dueAt: body.expiresAt,
      },
    });
    expect((await freeSlots(type)).map((s) => s.start)).not.toContain(
      slot.start,
    );
    expect(google.pushEventDetailed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mailTo("elise0@exemple.fr")).toHaveLength(1));
    expect(mailTo("elise0@exemple.fr")[0].subject).toContain("Virement");
    const token = body.manageUrl.split("/").pop();
    expect((await api(`/manage/${token}/ics`)).status).toBe(404);
    let manage = await (await api(`/manage/${token}`)).json();
    expect(manage).toMatchObject({
      status: "PENDING_PAYMENT",
      canCancel: false,
      canReschedule: false,
    });
    expect(manage.bankTransfer.reference).toBe(booking.payment.bankReference);

    // Annonce : organisateur prévenu, rien de confirmé
    mail.sent = [];
    const declared = await api(`/manage/${token}/bank-transfer`, {
      method: "POST",
      body: {},
    });
    expect((await declared.json()).declaredAt).toEqual(expect.any(String));
    expect((await Booking.findById(booking._id)).status).toBe(
      "PENDING_PAYMENT",
    );
    expect(
      await Notification.countDocuments({
        userId: owner,
        type: "APPOINTMENT_BANK_DECLARED",
      }),
    ).toBe(1);
    expect(mailTo("jean@cabinet.fr")).toHaveLength(1);

    // Repérage bancaire : confirmé, agenda, e-mails
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx-1",
        amount: 40,
        currency: "EUR",
        description: `VIR ${booking.payment.bankReference} E MARTIN`,
      },
    ]);
    const confirmed = await Booking.findById(booking._id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.meetingUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(google.pushEventDetailed).toHaveBeenCalledTimes(1);
    manage = await (await api(`/manage/${token}`)).json();
    expect(manage.bankTransfer).toBeNull();
    expect(manage.status).toBe("CONFIRMED");
  });

  it("« Marquer comme payé » : droits, cloisonnement, confirmation", async () => {
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    const { booking } = await pendingBank(type);
    const id = String(booking._id);
    const mark = (userId, org) =>
      errorOf(call(Mutation.markBookingPaid, userId, { id }, org));
    expect((await mark(viewer)).code).toBe("FORBIDDEN");
    expect(await mark(member)).toMatchObject({ code: "NOT_FOUND" });
    expect(await mark(outsider, otherWorkspace)).toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await errorOf(
        call(
          Mutation.markBookingPaidOnSite,
          outsider,
          { id, paid: true },
          otherWorkspace,
        ),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect((await Booking.findById(id)).status).toBe("PENDING_PAYMENT");

    const done = await call(Mutation.markBookingPaid, owner, { id });
    expect(done.status).toBe("CONFIRMED");
    expect(B.paymentProvider(done)).toBe("bank_transfer");
    expect(B.paidAt(done)).toBeInstanceOf(Date);
    expect(google.pushEventDetailed).toHaveBeenCalledTimes(1);
    // Idempotent
    await call(Mutation.markBookingPaid, owner, { id });
    expect(google.pushEventDetailed).toHaveBeenCalledTimes(1);
  });

  it("expirée après 3 jours ; virement tardif sans créneau : à rembourser à la main", async () => {
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    const { slot, booking } = await pendingBank(type);
    mail.sent = [];
    await expireOverdueBookings({ now: new Date(Date.now() + 2 * DAY) });
    expect((await Booking.findById(booking._id)).status).toBe(
      "PENDING_PAYMENT",
    );
    await expireOverdueBookings({
      now: new Date(Date.now() + 3 * DAY + MINUTE),
    });
    expect((await Booking.findById(booking._id)).status).toBe("EXPIRED");
    expect(textOf(mailTo("elise0@exemple.fr")[0].html)).toContain(
      "le virement n'est pas arrivé",
    );
    // Masquée de la liste par défaut (non payée)
    const list = await call(Query.bookings, owner, { scope: "all" });
    expect(list.items.map((b) => String(b._id))).not.toContain(
      String(booking._id),
    );

    // Créneau repris
    await book(type, slot.start, { i: 1, provider: "bank_transfer" });
    // L'organisateur ne peut plus le marquer payé
    expect(
      await errorOf(
        call(Mutation.markBookingPaid, owner, { id: String(booking._id) }),
      ),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "Ce créneau a été repris entre-temps : le rendez-vous ne peut plus être confirmé.",
    });
    // Le virement arrive quand même
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx-2",
        amount: 40,
        currency: "EUR",
        description: `VIR ${booking.payment.bankReference}`,
      },
    ]);
    const late = await Booking.findById(booking._id);
    expect(late.status).toBe("EXPIRED");
    expect(B.refundFailed(late)).toBe(true);
    expect(
      await Notification.countDocuments({
        userId: owner,
        type: "APPOINTMENT_REFUND_NEEDED",
      }),
    ).toBe(1);
    // Visible de nouveau dans la liste (paiement à rendre)
    const after = await call(Query.bookings, owner, { scope: "all" });
    expect(after.items.map((b) => String(b._id))).toContain(
      String(booking._id),
    );
  });
});

// ─── Existant ────────────────────────────────────────────────────────────

describe("réservations existantes", () => {
  it("balayage, repérage et liste ne modifient pas une réservation d'avant", async () => {
    const page = await BookingPage.findOne({ userId: owner });
    const start = new Date(Date.now() + 5 * DAY);
    const { insertedId } = await mongoose.connection.db
      .collection("bookings")
      .insertOne({
        workspaceId,
        bookingPageId: page._id,
        appointmentTypeId: null,
        hostUserId: owner,
        startAt: start,
        endAt: new Date(start.getTime() + 30 * MINUTE),
        typeName: "Ancien",
        durationMinutes: 30,
        location: { kind: "PHONE", value: null },
        guest: {
          firstName: "Ancien",
          lastName: "Client",
          email: "ancien@exemple.fr",
        },
        status: "CONFIRMED",
        manageTokenHash: "hash-ancien",
        reminders: { h24SentAt: null, h1SentAt: null },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    const before = JSON.stringify(await rawBooking(insertedId));
    await sweepAppointmentBookings({ now: new Date(Date.now() + 4 * DAY) });
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx",
        amount: 99,
        currency: "EUR",
        description: "NB-ABCDEF",
      },
    ]);
    const list = await call(Query.bookings, owner, { scope: "all" });
    expect(list.items).toHaveLength(1);
    const item = list.items[0];
    expect(B.amount(item)).toBe(0);
    expect(B.amountOnline(item)).toBe(0);
    expect(B.paymentMode(item)).toBeNull();
    expect(B.refundFailed(item)).toBe(false);
    expect(JSON.stringify(await rawBooking(insertedId))).toBe(before);
  });
});

// ─── Corrections de relecture ────────────────────────────────────────────

describe("relecture : délais du virement et début passé", () => {
  it("virement refusé à moins de 48 h, disponibilité par créneau, garde bornée au début - 24 h", async () => {
    await setIban();
    // Page ouverte 7 jours sur 7 : avec les horaires par défaut (lundi au
    // vendredi), un vendredi ou un samedi n'a aucun créneau à moins de 48 h
    await call(Mutation.upsertBookingPage, owner, {
      input: {
        availability: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
          dayOfWeek,
          intervals: [{ start: "09:00", end: "18:00" }],
        })),
      },
    });
    const type = await createSlot({ price: { amount: 4000 } });
    const soon = await freeSlots(type, 1);
    const now = Date.now();
    const tooSoon = soon.find((s) => Date.parse(s.start) - now < 48 * 3600000);
    const later = soon.find(
      (s) =>
        Date.parse(s.start) - now >= 49 * 3600000 &&
        Date.parse(s.start) - now < 4 * DAY,
    );
    expect(tooSoon.bankTransferAvailable).toBe(false);
    expect(later.bankTransferAvailable).toBe(true);
    const detail = await (await api(`/jean-dupont/${type.slug}`)).json();
    expect(detail.type.payment.bankTransferMinLeadHours).toBe(48);

    const refused = await book(type, tooSoon.start, {
      provider: "bank_transfer",
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "BANK_TRANSFER_TOO_LATE" });

    const res = await book(type, later.start, { provider: "bank_transfer" });
    expect(res.status).toBe(201);
    const { expiresAt } = await res.json();
    // Garde : début - 24 h (plus tôt que création + 3 jours)
    expect(Date.parse(expiresAt)).toBe(Date.parse(later.start) - DAY);
  });

  it("paiement arrivé après le début : jamais confirmé, remboursé, payeur prévenu", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { booking } = await pendingStripeBooking(type);
    // Début passé entre-temps
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { startAt: new Date(Date.now() - MINUTE) } },
    );
    await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: { object: stripeSession(booking) },
    });
    const after = await Booking.findById(booking._id);
    expect(after.status).toBe("EXPIRED");
    expect(after.payment.refundedAt).toBeInstanceOf(Date);
    expect(google.pushEventDetailed).not.toHaveBeenCalled();
    expect(await Event.countDocuments()).toBe(0);
    const email = mailTo("elise0@exemple.fr")[0];
    expect(email.subject).toContain("Paiement remboursé");
    expect(textOf(email.html)).toContain("la date de début était déjà passée");
  });

  it("« Marquer comme payé » après le début : refusé", async () => {
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    const [slot] = await freeSlots(type, 7);
    await book(type, slot.start, { provider: "bank_transfer" });
    const booking = await Booking.findOne({});
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { startAt: new Date(Date.now() - MINUTE) } },
    );
    expect(
      await errorOf(
        call(Mutation.markBookingPaid, owner, { id: String(booking._id) }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      (await Booking.findById(booking._id)).payment.paidAt,
    ).toBeUndefined();
  });
});

describe("relecture : paiement tardif, calcul complet du créneau", () => {
  it("créneau désormais occupé dans l'agenda connecté : remboursé, pas confirmé", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { slot, booking } = await pendingStripeBooking(type);
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { status: "EXPIRED", "payment.status": "expired" } },
    );
    // Rendez-vous personnel ajouté entre-temps dans Google
    google.getBusyIntervals = vi.fn(async () => [
      { start: slot.start, end: slot.end },
    ]);
    await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: { object: stripeSession(booking) },
    });
    const after = await Booking.findById(booking._id);
    expect(after.status).toBe("EXPIRED");
    expect(stripeApi.refunds.create).toHaveBeenCalledTimes(1);
    expect(google.pushEventDetailed).not.toHaveBeenCalled();
  });
});

describe("relecture : limites des virements", () => {
  it("au plus 2 virements en attente par adresse et par organisateur", async () => {
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    const slots = await freeSlots(type, 7);
    for (const slot of slots.slice(0, 2)) {
      expect(
        (await book(type, slot.start, { provider: "bank_transfer" })).status,
      ).toBe(201);
    }
    const third = await book(type, slots[2].start, {
      provider: "bank_transfer",
    });
    expect(third.status).toBe(409);
    expect(await third.json()).toEqual({ error: "TOO_MANY_PENDING_TRANSFERS" });
    // Autre adresse : acceptée
    expect(
      (await book(type, slots[2].start, { provider: "bank_transfer", i: 1 }))
        .status,
    ).toBe(201);
  });
});

describe("relecture : un crédit ne règle qu'une seule chose", () => {
  it("crédit portant deux références : un seul rendez-vous réglé ; crédit déjà pris par un transfert : refusé", async () => {
    await setIban();
    const type = await createSlot({ price: { amount: 4000 } });
    const slots = await freeSlots(type, 7);
    await book(type, slots[0].start, { provider: "bank_transfer", i: 0 });
    await book(type, slots[1].start, { provider: "bank_transfer", i: 1 });
    const [a, b] = await Booking.find({}).sort({ startAt: 1 });
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx-double",
        amount: 80,
        currency: "EUR",
        description: `VIR ${a.payment.bankReference} ${b.payment.bankReference}`,
      },
    ]);
    const statuses = (await Booking.find({}).sort({ startAt: 1 })).map(
      (x) => x.status,
    );
    expect(statuses.filter((x) => x === "CONFIRMED")).toHaveLength(1);
    // Resynchronisation : le même crédit ne règle pas l'autre
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx-double",
        amount: 80,
        currency: "EUR",
        description: `VIR ${a.payment.bankReference} ${b.payment.bankReference}`,
      },
    ]);
    expect(await Booking.countDocuments({ status: "CONFIRMED" })).toBe(1);

    // Crédit déjà utilisé par un transfert payant
    const pending = await Booking.findOne({ status: "PENDING_PAYMENT" });
    await BankCreditClaim.create({
      workspaceId: String(workspaceId),
      transactionId: "tx-transfert",
      targetKind: "file_transfer",
      targetId: "un-transfert",
    });
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx-transfert",
        amount: 40,
        currency: "EUR",
        description: `VIR ${pending.payment.bankReference}`,
      },
    ]);
    expect((await Booking.findById(pending._id)).status).toBe(
      "PENDING_PAYMENT",
    );
  });

  it("références uniques dans les deux sens (transferts, réservations, inscriptions)", async () => {
    const page = await BookingPage.findOne({ userId: owner });
    await mongoose.connection.db.collection("bookings").insertOne({
      workspaceId,
      bookingPageId: page._id,
      hostUserId: owner,
      startAt: new Date(),
      status: "EXPIRED",
      payment: { bankReference: "NB-AAAAAA" },
    });
    await mongoose.connection.db.collection("filetransfers").insertOne({
      workspaceId: String(workspaceId),
      paymentReference: "NB-BBBBBB",
    });
    const spy = vi.spyOn(crypto, "randomInt");
    // Tirages : AAAAAA (pris), BBBBBB (pris), CCCCCC (libre)
    for (const index of [0, 1, 2]) {
      for (let k = 0; k < 6; k += 1) spy.mockReturnValueOnce(index);
    }
    expect(await uniquePaymentReference(workspaceId)).toBe("NB-CCCCCC");
    spy.mockRestore();
  });
});

describe("relecture : paiement en confirmation plafonné", () => {
  it("paiement « pending » depuis plus de 7 jours : expiré, puis règle du paiement tardif", async () => {
    await connectStripe();
    const type = await createSlot({ price: { amount: 4000 } });
    const { booking } = await pendingStripeBooking(type);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...stripeSession(booking),
      payment_status: "unpaid",
      status: "complete",
    });
    await mongoose.connection.db.collection("bookings").updateOne(
      { _id: booking._id },
      {
        $set: {
          "payment.status": "pending",
          createdAt: new Date(Date.now() - 8 * DAY),
        },
      },
    );
    await sweepAppointmentBookings({ now: new Date() });
    const expired = await Booking.findById(booking._id);
    expect(expired.status).toBe("EXPIRED");
    expect(expired.payment.status).toBe("expired_pending");
    // Le paiement aboutit ensuite : créneau encore libre, confirmé
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(booking),
    );
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { "payment.checkedAt": null } },
    );
    await sweepAppointmentBookings({ now: new Date() });
    expect((await Booking.findById(booking._id)).status).toBe("CONFIRMED");
  });
});

describe("relecture : unicité en base", () => {
  it("index : un rendez-vous tenu et un confirmé ne peuvent pas commencer au même instant", async () => {
    await Booking.init();
    const page = await BookingPage.findOne({ userId: owner });
    const base = {
      workspaceId,
      bookingPageId: page._id,
      hostUserId: owner,
      startAt: new Date(Date.now() + 9 * DAY),
    };
    const raw = mongoose.connection.db.collection("bookings");
    await raw.insertOne({
      ...base,
      status: "PENDING_PAYMENT",
      manageTokenHash: "h1",
    });
    await expect(
      raw.insertOne({ ...base, status: "CONFIRMED", manageTokenHash: "h2" }),
    ).rejects.toMatchObject({ code: 11000 });
    // Expirée ou annulée : libre
    await raw.insertOne({ ...base, status: "EXPIRED", manageTokenHash: "h3" });
  });
});

describe("relecture : organisateur prévenu, chemin gratuit", () => {
  it("« Remboursement à faire » envoyé malgré la préférence, motif « annulée »", async () => {
    await setIban();
    await mongoose.connection.db.collection("user").updateOne(
      { _id: owner },
      {
        $set: {
          notificationPreferences: { payment_received: { email: false } },
        },
      },
    );
    const type = await createSlot({ price: { amount: 4000 } });
    const [slot] = await freeSlots(type, 7);
    await book(type, slot.start, { provider: "bank_transfer" });
    const booking = await Booking.findOne({});
    await call(Mutation.cancelBooking, owner, { id: String(booking._id) });
    mail.sent = [];
    await detectAppointmentBankPayments(String(workspaceId), [
      {
        externalId: "tx-annule",
        amount: 40,
        currency: "EUR",
        description: `VIR ${booking.payment.bankReference}`,
      },
    ]);
    const hostMail = mailTo("jean@cabinet.fr");
    expect(hostMail).toHaveLength(1);
    expect(textOf(hostMail[0].html)).toContain(
      "la réservation avait été annulée",
    );
    const payerMail = mailTo("elise0@exemple.fr");
    expect(payerMail).toHaveLength(1);
    expect(textOf(payerMail[0].html)).toContain("va vous rembourser");
  });

  it("réservation gratuite : expiration en base sans appel aux prestataires", async () => {
    await connectStripe();
    const paid = await createSlot({ price: { amount: 4000 } });
    const { booking } = await pendingStripeBooking(paid);
    await Booking.updateOne(
      { _id: booking._id },
      { $set: { expiresAt: new Date(Date.now() - MINUTE) } },
    );
    stripeApi.checkout.sessions.retrieve.mockClear();
    const free = await createSlot({ name: "Gratuit" });
    const [slot] = await freeSlots(free, 3);
    expect((await book(free, slot.start, { i: 5 })).status).toBe(201);
    expect(stripeApi.checkout.sessions.retrieve).not.toHaveBeenCalled();
    expect((await Booking.findById(booking._id)).status).toBe("EXPIRED");
  });
});
