/**
 * Billetterie : acompte et paiement sur place.
 *
 * Création et modification d'un événement avec chaque mode (refus de
 * saisie, acompte borné par le prix, sur place sans moyen connecté),
 * inscription sur place confirmée sans prestataire, acompte vérifié au bon
 * montant chez Stripe et PayPal (jamais le total ni un autre montant),
 * remboursement d'un acompte arrivé sans place, reste dû, marquage « réglé
 * sur place » (droits, cloisonnement), export CSV, e-mails, et types et
 * inscriptions existants laissés intacts en base.
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
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import AppointmentType from "../../src/models/AppointmentType.js";
import BookingPage from "../../src/models/BookingPage.js";
import EventRegistration from "../../src/models/EventRegistration.js";
import PaypalMerchantAccount from "../../src/models/PaypalMerchantAccount.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import appointmentsResolvers from "../../src/resolvers/appointments.js";
import appointmentEventsResolvers from "../../src/resolvers/appointmentEvents.js";
import publicBookingRoutes from "../../src/routes/publicBooking.js";
import { loadPublicPage } from "../../src/services/appointments/bookingService.js";
import {
  applyStripeSessionToRegistration,
  refreshRegistrationPayment,
  registerForEvent,
  registrationPayload,
} from "../../src/services/appointments/eventRegistrationService.js";
import {
  buildEventReminderEmail,
  eventPaymentLine,
} from "../../src/services/appointments/eventEmails.js";

const { Mutation } = appointmentsResolvers;
const T = appointmentsResolvers.AppointmentType;
const Events = appointmentEventsResolvers;
const R = appointmentEventsResolvers.EventRegistration;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const viewer = buildUserId();
const outsider = buildUserId();

const DAY = 86400000;
const ORDER = "5O190127TN364715T";
const NBSP = /\u00a0|\u202f/g;
const plain = (text) =>
  String(text)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(NBSP, " ");

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

const eventInput = (overrides = {}) => {
  const start = new Date(Date.now() + 10 * DAY);
  return {
    kind: "EVENT",
    name: "Soirée de lancement",
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 3 * 3600000).toISOString(),
    location: { kind: "IN_PERSON", value: "5 place du Marché, Lyon" },
    capacity: 4,
    maxPerOrder: 4,
    ...overrides,
  };
};

const connectStripe = () =>
  StripeConnectAccount.create({
    organizationId: String(workspaceId),
    accountId: "acct_vendeur",
    connectionType: "oauth",
    chargesEnabled: true,
  });

const createEvent = (input, userId = owner) =>
  call(Mutation.createAppointmentType, userId, { input: eventInput(input) });

async function register(typeId, { quantity = 2, provider = null, i = 0 } = {}) {
  const context = await loadPublicPage("jean-dupont");
  const type = await AppointmentType.findById(typeId).lean();
  return registerForEvent({
    context,
    type,
    buyer: {
      firstName: "Élise",
      lastName: "Martin",
      email: `elise${i}@exemple.fr`,
    },
    quantity,
    provider,
  });
}

const stripeSession = (registration, extra = {}) => ({
  id: "cs_test_acompte",
  status: "complete",
  payment_status: "paid",
  amount_total: registration.amountOnline,
  currency: "eur",
  payment_intent: "pi_acompte",
  metadata: {
    type: "event_registration",
    eventRegistrationId: String(registration._id),
  },
  ...extra,
});

const paypalOrder = (registration, status, capture = null) => ({
  id: ORDER,
  status,
  purchase_units: [
    {
      custom_id: `evt-${registration._id}`,
      amount: {
        value: (registration.amountOnline / 100).toFixed(2),
        currency_code: "EUR",
      },
      payments: capture ? { captures: [capture] } : undefined,
    },
  ],
});

const allowRecheck = (registration) =>
  EventRegistration.updateOne(
    { _id: registration._id },
    { $set: { "payment.checkedAt": null } },
  );

const rawType = (id) =>
  mongoose.connection.db
    .collection("appointment_types")
    .findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
const rawRegistration = (id) =>
  mongoose.connection.db
    .collection("event_registrations")
    .findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

const mailTo = (email) =>
  mail.sent.filter((m) => [].concat(m.to).includes(email));

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    BookingPage.init(),
    AppointmentType.init(),
    EventRegistration.init(),
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
    id: "cs_test_acompte",
    url: "https://checkout.stripe.com/c/pay/cs_test_acompte",
  });
  stripeApi.refunds.create.mockResolvedValue({ id: "re_1" });
  paypal.createPaypalOrder = vi.fn(async () => ({
    id: ORDER,
    approveUrl: "https://www.paypal.com/checkoutnow?token=x",
  }));
  paypal.getPaypalOrder = vi.fn();
  paypal.capturePaypalOrder = vi.fn();
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
  await call(Mutation.upsertBookingPage, owner, {
    input: { slug: "jean-dupont" },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Création et modification ────────────────────────────────────────────

describe("création et modification d'un événement payant", () => {
  it("en ligne : moyen connecté exigé ; mode ONLINE, pas d'acompte", async () => {
    expect(
      await errorOf(createEvent({ price: { amount: 2000 } })),
    ).toMatchObject({ code: "VALIDATION_ERROR", field: "price" });
    expect(
      await errorOf(
        createEvent({ price: { amount: 2000 }, paymentMode: "ONLINE" }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR", field: "price" });
    await connectStripe();
    const type = await createEvent({
      price: { amount: 2000 },
      depositAmount: 500,
    });
    expect(T.paymentMode(type)).toBe("ONLINE");
    expect(T.depositAmount(type)).toBeNull();
  });

  it("sur place : accepté sans aucun moyen de paiement connecté", async () => {
    const type = await createEvent({
      price: { amount: 2000 },
      paymentMode: "ON_SITE",
    });
    expect(T.paymentMode(type)).toBe("ON_SITE");
    expect(T.price(type)).toEqual({ amount: 2000, currency: "EUR" });
    expect(T.depositAmount(type)).toBeNull();
  });

  it("acompte : obligatoire, au moins 0,50 €, inférieur au prix, moyen connecté exigé", async () => {
    const deposit = (overrides) =>
      createEvent({
        price: { amount: 2000 },
        paymentMode: "DEPOSIT",
        ...overrides,
      });
    expect(await errorOf(deposit({ depositAmount: 500 }))).toMatchObject({
      code: "VALIDATION_ERROR",
      field: "price",
    });
    await connectStripe();
    for (const [depositAmount, field] of [
      [undefined, "depositAmount"],
      [null, "depositAmount"],
      [2000, "depositAmount"],
      [2500, "depositAmount"],
      [30, "depositAmount"],
      [0, "depositAmount"],
      [-100, "depositAmount"],
      [12.5, "depositAmount"],
    ]) {
      expect(
        await errorOf(deposit({ depositAmount })),
        `acompte ${depositAmount}`,
      ).toMatchObject({ code: "VALIDATION_ERROR", field });
    }
    const type = await deposit({ depositAmount: 500 });
    expect(T.paymentMode(type)).toBe("DEPOSIT");
    expect(T.depositAmount(type)).toBe(500);
  });

  it("mode inconnu refusé ; gratuit : mode ignoré", async () => {
    expect(
      await errorOf(
        createEvent({ price: { amount: 2000 }, paymentMode: "CASH" }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR", field: "paymentMode" });
    const free = await createEvent({ paymentMode: "DEPOSIT" });
    expect(T.price(free)).toBeNull();
    expect(T.paymentMode(free)).toBeNull();
    expect(T.depositAmount(free)).toBeNull();
  });

  it("modification : moyen exigé seulement quand le prix, le mode ou l'acompte change", async () => {
    const type = await createEvent({
      price: { amount: 2000 },
      paymentMode: "ON_SITE",
    });
    const id = String(type._id);
    const update = (input) =>
      call(Mutation.updateAppointmentType, owner, { id, input });

    // Sur place sans moyen : modifiable
    await update({ name: "Soirée renommée", price: { amount: 2500 } });
    // Passage à l'acompte sans moyen : refusé
    expect(
      await errorOf(update({ paymentMode: "DEPOSIT", depositAmount: 500 })),
    ).toMatchObject({ code: "VALIDATION_ERROR", field: "price" });
    await connectStripe();
    const deposit = await update({
      paymentMode: "DEPOSIT",
      depositAmount: 500,
    });
    expect(T.paymentMode(deposit)).toBe("DEPOSIT");
    expect(T.depositAmount(deposit)).toBe(500);
    // Prix ramené sous l'acompte : refusé
    expect(await errorOf(update({ price: { amount: 400 } }))).toMatchObject({
      code: "VALIDATION_ERROR",
      field: "depositAmount",
    });

    // Moyen déconnecté : le reste reste modifiable, pas l'acompte
    await StripeConnectAccount.deleteMany({});
    await update({ name: "Soirée de nouveau renommée" });
    await update({ paymentMode: "DEPOSIT", depositAmount: 500 });
    expect(await errorOf(update({ depositAmount: 700 }))).toMatchObject({
      code: "VALIDATION_ERROR",
      field: "price",
    });
    // Retour au paiement sur place : permis sans moyen
    const onSite = await update({ paymentMode: "ON_SITE" });
    expect(T.paymentMode(onSite)).toBe("ON_SITE");
    expect(T.depositAmount(onSite)).toBeNull();
    // Acompte retiré : champ effacé (jamais un null écrit)
    await update({ depositAmount: null });
    const raw = await rawType(id);
    expect(raw.paymentMode).toBe("ON_SITE");
    expect("depositAmount" in raw).toBe(false);
  });
});

// ─── Inscription sur place ───────────────────────────────────────────────

describe("inscription à un événement payé sur place", () => {
  it("confirmée tout de suite, sans prestataire ni choix de moyen", async () => {
    const type = await createEvent({
      price: { amount: 2000 },
      paymentMode: "ON_SITE",
    });
    const response = await api(`/jean-dupont/${type.slug}/register`, {
      method: "POST",
      body: {
        buyer: {
          firstName: "Élise",
          lastName: "Martin",
          email: "elise@exemple.fr",
        },
        quantity: 2,
        // Moyen envoyé quand même : ignoré
        provider: "stripe",
        turnstileToken: "jeton",
        website: "",
      },
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.status).toBe("CONFIRMED");
    expect(body.paymentUrl).toBeUndefined();
    expect(body.manageUrl).toMatch(/\/rdv\/inscription\//);
    expect(body.registration).toMatchObject({
      status: "CONFIRMED",
      amount: 4000,
      paymentMode: "ON_SITE",
      amountOnline: 0,
      amountDueOnSite: 4000,
      onSitePaidAt: null,
      canCancel: true,
    });
    expect(body.registration.tickets).toHaveLength(2);
    expect(stripeApi.checkout.sessions.create).not.toHaveBeenCalled();
    expect(paypal.createPaypalOrder).not.toHaveBeenCalled();
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(2);

    const registration = await EventRegistration.findOne({});
    expect(registration.payment?.provider ?? null).toBeNull();
    expect(registration.expiresAt).toBeNull();

    // Billet public : reste dû affiché
    const token = body.registration.tickets[0].token;
    const ticket = await (await api(`/tickets/${token}`)).json();
    expect(ticket).toMatchObject({
      status: "VALID",
      paymentMode: "ON_SITE",
      amountOnline: 0,
      amountDueOnSite: 4000,
      onSitePaidAt: null,
    });

    // E-mails : participant et organisateur, même ligne
    await vi.waitFor(() => expect(mail.sent.length).toBe(2));
    for (const email of ["elise@exemple.fr", "jean@cabinet.fr"]) {
      const [sent] = mailTo(email);
      expect(plain(sent.html)).toContain("À régler sur place : 40,00 €");
      expect(plain(sent.html)).not.toContain("Payé en ligne");
    }
  });

  it("aucun moyen connecté : inscription possible (moyen non exigé)", async () => {
    const type = await createEvent({
      price: { amount: 1500 },
      paymentMode: "ON_SITE",
    });
    expect(await StripeConnectAccount.countDocuments()).toBe(0);
    const result = await register(type._id, { quantity: 1 });
    expect(result.registration.status).toBe("CONFIRMED");
    expect(result.paymentUrl).toBeUndefined();
  });

  it("places atomiques : sur place, jamais de survente", async () => {
    const type = await createEvent({
      price: { amount: 1500 },
      paymentMode: "ON_SITE",
      capacity: 3,
    });
    const results = await Promise.allSettled(
      [0, 1, 2, 3].map((i) => register(type._id, { quantity: 1, i })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe(
      "SOLD_OUT",
    );
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(3);
  });

  it("page publique : mode et acompte de l'événement", async () => {
    await connectStripe();
    const [onSite, deposit, online, free] = await Promise.all([
      createEvent({
        name: "Sur place",
        price: { amount: 2000 },
        paymentMode: "ON_SITE",
      }),
      createEvent({
        name: "Acompte",
        price: { amount: 2000 },
        paymentMode: "DEPOSIT",
        depositAmount: 500,
      }),
      createEvent({ name: "En ligne", price: { amount: 2000 } }),
      createEvent({ name: "Gratuit" }),
    ]);
    const expectations = [
      [onSite, "ON_SITE", null],
      [deposit, "DEPOSIT", 500],
      [online, "ONLINE", null],
      [free, null, null],
    ];
    for (const [type, paymentMode, depositAmount] of expectations) {
      const detail = await (await api(`/jean-dupont/${type.slug}`)).json();
      expect(detail.type.event, type.name).toMatchObject({
        paymentMode,
        depositAmount,
      });
    }
    const list = await (await api("/jean-dupont")).json();
    expect(list.types.find((t) => t.slug === deposit.slug).event).toMatchObject(
      { paymentMode: "DEPOSIT", depositAmount: 500 },
    );
  });
});

// ─── Acompte en ligne ────────────────────────────────────────────────────

describe("acompte payé en ligne", () => {
  async function depositEvent(capacity = 4) {
    await connectStripe();
    return createEvent({
      price: { amount: 2000 },
      paymentMode: "DEPOSIT",
      depositAmount: 500,
      capacity,
    });
  }

  it("Stripe : paiement lancé pour l'acompte, refusé au total ou à un autre montant", async () => {
    const type = await depositEvent();
    const { registration, paymentUrl } = await register(type._id, {
      quantity: 2,
      provider: "stripe",
    });
    expect(paymentUrl).toMatch(/checkout\.stripe\.com/);
    expect(registration).toMatchObject({
      status: "PENDING_PAYMENT",
      amount: 4000,
      paymentMode: "DEPOSIT",
      amountOnline: 1000,
      amountDueOnSite: 3000,
    });
    const [params] = stripeApi.checkout.sessions.create.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(1000);
    expect(params.line_items[0].quantity).toBe(1);
    expect(params.line_items[0].price_data.product_data.name).toMatch(
      /^Acompte : /,
    );

    // Total payé (4000) ou autre montant : jamais appliqué
    for (const extra of [
      { amount_total: 4000 },
      { amount_total: 999 },
      { amount_total: 500 },
      { currency: "usd" },
    ]) {
      const result = await applyStripeSessionToRegistration(
        registration,
        stripeSession(registration, extra),
        "acct_vendeur",
      );
      expect(result.status, JSON.stringify(extra)).toBe("unpaid");
    }
    // Compte étranger : refusé même au bon montant
    expect(
      (
        await applyStripeSessionToRegistration(
          registration,
          stripeSession(registration),
          "acct_autre",
        )
      ).status,
    ).toBe("unpaid");
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "PENDING_PAYMENT",
    );

    // Bon montant : relu chez Stripe, confirmé
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration),
    );
    await allowRecheck(registration);
    const result = await refreshRegistrationPayment(
      await EventRegistration.findById(registration._id),
      { force: true },
    );
    expect(result.status).toBe("paid");
    const paid = await EventRegistration.findById(registration._id);
    expect(paid.status).toBe("CONFIRMED");
    expect(paid.payment.paidAmount).toBe(1000);
    expect(paid.tickets).toHaveLength(2);

    // Reste dû calculé
    expect(R.amountOnline(paid)).toBe(1000);
    expect(R.amountDueOnSite(paid)).toBe(3000);
    expect(R.paymentMode(paid)).toBe("DEPOSIT");
    expect(R.onSitePaidAt(paid)).toBeNull();
    const payload = await registrationPayload(paid);
    expect(payload).toMatchObject({
      amount: 4000,
      amountOnline: 1000,
      amountDueOnSite: 3000,
      paymentMode: "DEPOSIT",
      canCancel: false,
    });

    // E-mails : ligne de l'acompte
    await vi.waitFor(() => expect(mail.sent.length).toBe(2));
    for (const email of ["elise0@exemple.fr", "jean@cabinet.fr"]) {
      expect(plain(mailTo(email)[0].html)).toContain(
        "Acompte payé : 10,00 €. Reste à régler sur place : 30,00 €",
      );
    }
  });

  it("PayPal : commande de l'acompte, capture au total jamais appliquée", async () => {
    const type = await depositEvent();
    await PaypalMerchantAccount.create({
      organizationId: String(workspaceId),
      email: "vendeur@exemple.fr",
    });
    const { registration } = await register(type._id, {
      quantity: 2,
      provider: "paypal",
    });
    expect(paypal.createPaypalOrder.mock.calls[0][0].amount).toBe(10);

    // Capture au total : non appliquée, revendication levée
    paypal.getPaypalOrder.mockResolvedValue(
      paypalOrder(registration, "APPROVED"),
    );
    paypal.capturePaypalOrder.mockResolvedValueOnce(
      paypalOrder(registration, "COMPLETED", {
        id: "CAPTURE_TOTAL",
        status: "COMPLETED",
        amount: { value: "40.00", currency_code: "EUR" },
      }),
    );
    const wrong = await refreshRegistrationPayment(registration, {
      force: true,
    });
    expect(wrong.status).toBe("unpaid");
    const afterWrong = await EventRegistration.findById(registration._id);
    expect(afterWrong.status).toBe("PENDING_PAYMENT");
    expect(afterWrong.payment.status).not.toBe("capturing");
    expect(afterWrong.payment.paidAt).toBeNull();

    // Capture de l'acompte : confirmée
    paypal.capturePaypalOrder.mockResolvedValueOnce(
      paypalOrder(registration, "COMPLETED", {
        id: "CAPTURE_ACOMPTE",
        status: "COMPLETED",
        amount: { value: "10.00", currency_code: "EUR" },
      }),
    );
    await allowRecheck(registration);
    const ok = await refreshRegistrationPayment(
      await EventRegistration.findById(registration._id),
      { force: true },
    );
    expect(ok.status).toBe("paid");
    const paid = await EventRegistration.findById(registration._id);
    expect(paid.status).toBe("CONFIRMED");
    expect(paid.payment.paidAmount).toBe(1000);
    expect(paid.payment.captureId).toBe("CAPTURE_ACOMPTE");
  });

  it("acompte arrivé après expiration sans place : remboursé (le total jamais)", async () => {
    const type = await depositEvent(2);
    const { registration } = await register(type._id, {
      quantity: 2,
      provider: "stripe",
    });
    // Expirée, places rendues puis reprises par une inscription sur place
    await EventRegistration.updateOne(
      { _id: registration._id },
      {
        $set: {
          status: "EXPIRED",
          expiredAt: new Date(),
          seatsHeld: false,
          "payment.status": "expired",
        },
      },
    );
    await AppointmentType.updateOne(
      { _id: type._id },
      { $set: { seatsTaken: 2 } },
    );
    // Total payé : ni confirmé ni remboursé
    expect(
      (
        await applyStripeSessionToRegistration(
          registration,
          stripeSession(registration, { amount_total: 4000 }),
          "acct_vendeur",
        )
      ).status,
    ).toBe("unpaid");
    expect(stripeApi.refunds.create).not.toHaveBeenCalled();

    await applyStripeSessionToRegistration(
      registration,
      stripeSession(registration),
      "acct_vendeur",
    );
    expect(stripeApi.refunds.create).toHaveBeenCalledTimes(1);
    const [refund, options] = stripeApi.refunds.create.mock.calls[0];
    expect(refund.payment_intent).toBe("pi_acompte");
    expect(refund.amount).toBeUndefined();
    expect(options.stripeAccount).toBe("acct_vendeur");
    const after = await EventRegistration.findById(registration._id);
    expect(after.status).toBe("EXPIRED");
    expect(after.payment.paidAmount).toBe(1000);
    expect(after.payment.refundedAt).toBeInstanceOf(Date);
  });

  it("inscription publique avec acompte : moyen exigé, adresse de paiement renvoyée", async () => {
    const type = await depositEvent();
    const body = {
      buyer: {
        firstName: "Élise",
        lastName: "Martin",
        email: "elise@exemple.fr",
      },
      quantity: 1,
      turnstileToken: "jeton",
      website: "",
    };
    const missing = await api(`/jean-dupont/${type.slug}/register`, {
      method: "POST",
      body,
    });
    expect(missing.status).toBe(400);
    const started = await api(`/jean-dupont/${type.slug}/register`, {
      method: "POST",
      body: { ...body, provider: "stripe" },
    });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      status: "PENDING_PAYMENT",
      paymentUrl: "https://checkout.stripe.com/c/pay/cs_test_acompte",
    });
    const [params] = stripeApi.checkout.sessions.create.mock.calls[0];
    expect(params.line_items[0].price_data.unit_amount).toBe(500);
  });
});

// ─── Réglé sur place ─────────────────────────────────────────────────────

describe("marquer le reste comme réglé sur place", () => {
  const mark = (userId, id, paid, org = workspaceId) =>
    call(
      Events.Mutation.markEventRegistrationPaidOnSite,
      userId,
      { id: String(id), paid },
      org,
    );

  it("marque, garde la date du premier marquage, démarque", async () => {
    const type = await createEvent({
      price: { amount: 2000 },
      paymentMode: "ON_SITE",
    });
    const { registration } = await register(type._id);
    const marked = await mark(owner, registration._id, true);
    expect(R.onSitePaidAt(marked)).toBeInstanceOf(Date);
    expect(String(marked.onSitePaidBy)).toBe(String(owner));
    expect(R.amountDueOnSite(marked)).toBe(4000);

    const again = await mark(owner, registration._id, true);
    expect(again.onSitePaidAt.getTime()).toBe(marked.onSitePaidAt.getTime());

    const payload = await registrationPayload(again);
    expect(payload.onSitePaidAt).toBe(marked.onSitePaidAt.toISOString());

    const unmarked = await mark(owner, registration._id, false);
    expect(R.onSitePaidAt(unmarked)).toBeNull();
    const raw = await rawRegistration(registration._id);
    expect("onSitePaidAt" in raw).toBe(false);
    expect("onSitePaidBy" in raw).toBe(false);

    // Contrôle à l'entrée : la réponse porte le reste dû
    const checked = await call(Events.Mutation.checkInTicket, owner, {
      typeId: String(type._id),
      code: registration.tickets[0].number,
    });
    expect(checked.result).toBe("VALID");
    expect(R.amountDueOnSite(checked.registration)).toBe(4000);
    expect(R.onSitePaidAt(checked.registration)).toBeNull();
  });

  it("rien à régler, non confirmée : VALIDATION_ERROR", async () => {
    await connectStripe();
    const [onSite, online, free] = await Promise.all([
      createEvent({
        name: "Sur place",
        price: { amount: 2000 },
        paymentMode: "ON_SITE",
      }),
      createEvent({ name: "En ligne", price: { amount: 2000 } }),
      createEvent({ name: "Gratuit" }),
    ]);
    const freeRegistration = (await register(free._id)).registration;
    expect(
      await errorOf(mark(owner, freeRegistration._id, true)),
    ).toMatchObject({ code: "VALIDATION_ERROR" });

    // En ligne, payée : rien sur place
    const { registration: paidOnline } = await register(online._id, {
      provider: "stripe",
    });
    await applyStripeSessionToRegistration(
      paidOnline,
      stripeSession(paidOnline),
      "acct_vendeur",
    );
    expect((await EventRegistration.findById(paidOnline._id)).status).toBe(
      "CONFIRMED",
    );
    expect(await errorOf(mark(owner, paidOnline._id, true))).toMatchObject({
      code: "VALIDATION_ERROR",
    });

    // En attente de paiement d'un acompte : non confirmée
    await call(Mutation.updateAppointmentType, owner, {
      id: String(online._id),
      input: { paymentMode: "DEPOSIT", depositAmount: 500 },
    });
    const { registration: pending } = await register(online._id, {
      provider: "stripe",
      i: 1,
    });
    expect(pending.amountDueOnSite).toBe(3000);
    expect(await errorOf(mark(owner, pending._id, true))).toMatchObject({
      code: "VALIDATION_ERROR",
    });

    // Annulée
    const { registration: cancelled } = await register(onSite._id, { i: 2 });
    await call(Events.Mutation.cancelEventRegistration, owner, {
      id: String(cancelled._id),
    });
    expect(await errorOf(mark(owner, cancelled._id, true))).toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(await errorOf(mark(owner, "pas-un-id", true))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("droits et cloisonnement : lecteur refusé, autre organisateur et autre espace introuvables", async () => {
    const type = await createEvent({
      price: { amount: 2000 },
      paymentMode: "ON_SITE",
    });
    const { registration } = await register(type._id);
    expect(await errorOf(mark(viewer, registration._id, true))).toMatchObject({
      code: "FORBIDDEN",
    });
    // Membre du même espace : pas son événement
    expect(await errorOf(mark(member, registration._id, true))).toMatchObject({
      code: "NOT_FOUND",
    });
    // Autre espace
    expect(
      await errorOf(mark(outsider, registration._id, true, otherWorkspace)),
    ).toMatchObject({ code: "NOT_FOUND" });
    // Espace d'un autre dans les arguments : refusé
    expect(
      await errorOf(
        call(
          Events.Mutation.markEventRegistrationPaidOnSite,
          outsider,
          {
            id: String(registration._id),
            paid: true,
            workspaceId: String(workspaceId),
          },
          otherWorkspace,
        ),
      ),
    ).toBeTruthy();
    expect(
      (await EventRegistration.findById(registration._id)).onSitePaidAt,
    ).toBeUndefined();
  });
});

// ─── CSV et e-mails ──────────────────────────────────────────────────────

describe("export CSV et e-mails", () => {
  it("CSV : payé en ligne, reste sur place, réglé sur place", async () => {
    await connectStripe();
    const onSite = await createEvent({
      name: "Sur place",
      price: { amount: 2000 },
      paymentMode: "ON_SITE",
    });
    const deposit = await createEvent({
      name: "Acompte",
      price: { amount: 2000 },
      paymentMode: "DEPOSIT",
      depositAmount: 500,
    });
    const free = await createEvent({ name: "Gratuit" });

    const { registration: a } = await register(onSite._id, { quantity: 1 });
    const { registration: b } = await register(onSite._id, {
      quantity: 1,
      i: 1,
    });
    await call(Events.Mutation.markEventRegistrationPaidOnSite, owner, {
      id: String(b._id),
      paid: true,
    });
    const csv = async (typeId) =>
      (
        await call(Events.Query.eventRegistrationsCsv, owner, {
          typeId: String(typeId),
        })
      )
        .replace(/^\ufeff/, "")
        .trim()
        .split("\r\n")
        .map((line) => line.split(";"));
    const [header, ...rows] = await csv(onSite._id);
    const col = (name) => header.indexOf(name);
    expect(col("Payé en ligne")).toBeGreaterThan(-1);
    expect(col("Reste sur place")).toBeGreaterThan(-1);
    expect(col("Réglé sur place")).toBeGreaterThan(-1);
    const byEmail = Object.fromEntries(rows.map((r) => [r[col("E-mail")], r]));
    expect(byEmail[a.buyer.email][col("Payé en ligne")]).toBe("0,00");
    expect(byEmail[a.buyer.email][col("Reste sur place")]).toBe("20,00");
    expect(byEmail[a.buyer.email][col("Réglé sur place")]).toBe("non");
    expect(byEmail[a.buyer.email][col("Moyen de paiement")]).toBe("Sur place");
    expect(byEmail[b.buyer.email][col("Réglé sur place")]).toBe("oui");

    const { registration: c } = await register(deposit._id, {
      quantity: 2,
      provider: "stripe",
      i: 2,
    });
    await applyStripeSessionToRegistration(c, stripeSession(c), "acct_vendeur");
    const [, depositRow] = await csv(deposit._id);
    expect(depositRow[col("Montant de l'inscription (€)")]).toBe("40,00");
    expect(depositRow[col("Payé en ligne")]).toBe("10,00");
    expect(depositRow[col("Reste sur place")]).toBe("30,00");
    expect(depositRow[col("Réglé sur place")]).toBe("non");
    expect(depositRow[col("Moyen de paiement")]).toBe("Stripe");

    await register(free._id, { quantity: 1, i: 3 });
    const [, freeRow] = await csv(free._id);
    expect(freeRow[col("Payé en ligne")]).toBe("0,00");
    expect(freeRow[col("Reste sur place")]).toBe("0,00");
    expect(freeRow[col("Réglé sur place")]).toBe("");
    expect(freeRow[col("Moyen de paiement")]).toBe("Gratuit");
  });

  it("ligne de paiement : en ligne, acompte, sur place, réglé, gratuit, inscription d'avant l'acompte", () => {
    const base = { amount: 2000, currency: "EUR" };
    const cases = [
      [
        {
          ...base,
          paymentMode: "ONLINE",
          amountOnline: 2000,
          amountDueOnSite: 0,
        },
        "Payé en ligne : 20,00 €",
      ],
      [
        {
          ...base,
          paymentMode: "DEPOSIT",
          amountOnline: 500,
          amountDueOnSite: 1500,
        },
        "Acompte payé : 5,00 €. Reste à régler sur place : 15,00 €",
      ],
      [
        {
          ...base,
          paymentMode: "ON_SITE",
          amountOnline: 0,
          amountDueOnSite: 2000,
        },
        "À régler sur place : 20,00 €",
      ],
      [
        {
          ...base,
          paymentMode: "ON_SITE",
          amountOnline: 0,
          amountDueOnSite: 2000,
          onSitePaidAt: new Date(),
        },
        "Réglé sur place : 20,00 €",
      ],
      // Inscription d'avant l'acompte (aucun champ nouveau)
      [{ ...base, payment: { provider: "stripe" } }, "Payé en ligne : 20,00 €"],
      [{ amount: 0, currency: "EUR" }, null],
    ];
    for (const [registration, expected] of cases) {
      const line = eventPaymentLine(registration);
      expect(line === null ? null : plain(line)).toBe(expected);
    }
  });

  it("rappel de la veille : ligne de paiement", () => {
    const start = new Date(Date.now() + DAY / 2);
    const email = buildEventReminderEmail({
      registration: {
        _id: new mongoose.Types.ObjectId(),
        event: {
          name: "Soirée",
          startAt: start,
          endAt: new Date(start.getTime() + 3600000),
          location: { kind: "IN_PERSON", value: "Lyon" },
          timezone: "Europe/Paris",
        },
        buyer: { firstName: "Élise", lastName: "Martin", email: "e@x.fr" },
        quantity: 2,
        amount: 4000,
        currency: "EUR",
        paymentMode: "DEPOSIT",
        amountOnline: 1000,
        amountDueOnSite: 3000,
      },
      tickets: [],
      organizationName: "Cabinet Martin",
      manageUrl: "https://www.newbi.fr/rdv/inscription/x",
    });
    expect(plain(email.html)).toContain(
      "Acompte payé : 10,00 €. Reste à régler sur place : 30,00 €",
    );
  });
});

// ─── Données existantes intactes ─────────────────────────────────────────

describe("types et inscriptions existants intacts", () => {
  it("type payant d'avant l'acompte : lu en ONLINE, aucun champ ajouté à la modification", async () => {
    await connectStripe();
    const page = await BookingPage.findOne({ slug: "jean-dupont" }).lean();
    const start = new Date(Date.now() + 5 * DAY);
    const { insertedId } = await mongoose.connection.db
      .collection("appointment_types")
      .insertOne({
        workspaceId,
        bookingPageId: page._id,
        userId: owner,
        kind: "EVENT",
        slug: "ancien",
        name: "Ancien concert",
        durationMinutes: 60,
        startAt: start,
        endAt: new Date(start.getTime() + 3600000),
        location: { kind: "IN_PERSON", value: "Salle" },
        capacity: 10,
        seatsTaken: 0,
        maxPerOrder: 5,
        priceAmount: 1500,
        currency: "EUR",
        isActive: true,
      });
    const lean = await AppointmentType.findById(insertedId).lean();
    expect(T.paymentMode(lean)).toBe("ONLINE");
    expect(T.depositAmount(lean)).toBeNull();

    // Modification sans changement de paiement (valeurs effectives renvoyées)
    await call(Mutation.updateAppointmentType, owner, {
      id: String(insertedId),
      input: {
        name: "Ancien concert renommé",
        paymentMode: "ONLINE",
        depositAmount: null,
        price: { amount: 1500 },
      },
    });
    const raw = await rawType(insertedId);
    expect(raw.name).toBe("Ancien concert renommé");
    expect("paymentMode" in raw).toBe(false);
    expect("depositAmount" in raw).toBe(false);

    // Créneau existant : rien non plus
    const slot = await AppointmentType.findOne({ kind: { $exists: false } });
    expect(slot).toBeTruthy();
    await call(Mutation.updateAppointmentType, owner, {
      id: String(slot._id),
      input: { name: "Rendez-vous renommé" },
    });
    const rawSlot = await rawType(slot._id);
    expect("paymentMode" in rawSlot).toBe(false);
    expect("depositAmount" in rawSlot).toBe(false);

    // Inscription au type existant : payée en ligne au total
    const { registration } = await register(insertedId, {
      quantity: 2,
      provider: "stripe",
    });
    expect(registration.amountOnline).toBe(3000);
    expect(
      stripeApi.checkout.sessions.create.mock.calls[0][0].line_items[0]
        .price_data.unit_amount,
    ).toBe(3000);
  });

  it("inscription d'avant l'acompte : repli à la lecture, vérifiée au total, jamais réécrite", async () => {
    await connectStripe();
    const type = await createEvent({ price: { amount: 1500 } });
    const page = await BookingPage.findOne({ slug: "jean-dupont" }).lean();
    const legacy = {
      workspaceId,
      bookingPageId: page._id,
      appointmentTypeId: type._id,
      hostUserId: owner,
      event: {
        name: type.name,
        startAt: type.startAt,
        endAt: type.endAt,
        location: { kind: "IN_PERSON", value: "Salle" },
        timezone: "Europe/Paris",
      },
      buyer: {
        firstName: "Ancien",
        lastName: "Inscrit",
        email: "ancien@exemple.fr",
      },
      quantity: 2,
      unitAmount: 1500,
      amount: 3000,
      currency: "EUR",
      status: "PENDING_PAYMENT",
      seatsHeld: true,
      expiresAt: new Date(Date.now() + 20 * 60000),
      payment: {
        provider: "stripe",
        reference: "cs_test_ancien",
        accountId: "acct_vendeur",
        status: "open",
      },
      manageTokenHash: "hash-ancien",
      tickets: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await mongoose.connection.db
      .collection("event_registrations")
      .insertOne(legacy);
    const registration = await EventRegistration.findById(insertedId);
    expect(R.amountOnline(registration)).toBe(3000);
    expect(R.amountDueOnSite(registration)).toBe(0);
    expect(R.paymentMode(registration)).toBe("ONLINE");
    expect(R.onSitePaidAt(registration)).toBeNull();

    // Acompte jamais exigé d'une ancienne inscription : vérifiée au total
    expect(
      (
        await applyStripeSessionToRegistration(
          registration,
          stripeSession(registration, { amount_total: 1500 }),
          "acct_vendeur",
        )
      ).status,
    ).toBe("unpaid");
    const result = await applyStripeSessionToRegistration(
      registration,
      stripeSession(registration, { amount_total: 3000 }),
      "acct_vendeur",
    );
    expect(result.status).toBe("paid");
    const paid = await EventRegistration.findById(insertedId);
    expect(paid.status).toBe("CONFIRMED");
    expect(
      await errorOf(
        call(Events.Mutation.markEventRegistrationPaidOnSite, owner, {
          id: String(insertedId),
          paid: true,
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
    const raw = await rawRegistration(insertedId);
    for (const key of [
      "paymentMode",
      "amountOnline",
      "amountDueOnSite",
      "onSitePaidAt",
      "onSitePaidBy",
    ]) {
      expect(key in raw, key).toBe(false);
    }
  });

  it("nouvelle inscription gratuite : aucun champ de paiement écrit", async () => {
    const type = await createEvent({});
    const { registration } = await register(type._id, { quantity: 1 });
    const raw = await rawRegistration(registration._id);
    expect(raw.status).toBe("CONFIRMED");
    for (const key of [
      "paymentMode",
      "amountOnline",
      "amountDueOnSite",
      "onSitePaidAt",
      "onSitePaidBy",
    ]) {
      expect(key in raw, key).toBe(false);
    }
    expect(R.paymentMode(registration)).toBeNull();
    expect(R.amountOnline(registration)).toBe(0);
    expect(R.amountDueOnSite(registration)).toBe(0);
    const rawEvent = await rawType(type._id);
    expect("paymentMode" in rawEvent).toBe(false);
    expect("depositAmount" in rawEvent).toBe(false);
  });
});
