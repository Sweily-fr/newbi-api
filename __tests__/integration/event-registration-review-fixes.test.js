/**
 * Billetterie : un test par correction de la relecture du 26/11.
 *
 *  1. capture PayPal revendiquée atomiquement (jamais sur une inscription
 *     expirée ou annulée entre-temps, annulation refusée pendant la capture)
 *  2. paiement relu 24 h après l'expiration
 *  3. places jamais perdues (gratuit interrompu, réconciliation)
 *  4. aucun champ d'événement écrit dans un créneau existant
 *  5. limites dédiées au retour (par jeton) et à l'inscription
 *  6. abandon du paiement par le payeur
 *  7. état du remboursement dans la réponse du retour
 *  8. pagination des inscrits par offset
 *  9. expiration non bloquée par les paiements en confirmation
 * 10. moyen de paiement déconnecté : modification sans changer le prix permise
 * 11. jeton de retour : une heure, puis quelques minutes après confirmation
 * 12. contrôle des billets : abonnement actif exigé
 * 13. CSV : numéro de téléphone international non préfixé
 * 14. date déplacée : rappel remis à zéro, inscrits prévenus
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
import publicBookingRoutes from "../../src/routes/publicBooking.js";
import appointmentsResolvers from "../../src/resolvers/appointments.js";
import appointmentEventsResolvers, {
  csvCell,
} from "../../src/resolvers/appointmentEvents.js";
import { loadPublicPage } from "../../src/services/appointments/bookingService.js";
import {
  cancelRegistration,
  reconcileHeldSeats,
  refreshRegistrationPayment,
  registerForEvent,
  sweepEventRegistrations,
} from "../../src/services/appointments/eventRegistrationService.js";

let server;
let baseUrl;
const hostId = buildUserId();
const workspaceId = buildOrganizationId();
let page;
let concert;
let atelier;

const DAY = 86400000;
const ORDER = "5O190127TN364715T";
const api = (path, options = {}) =>
  fetch(`${baseUrl}/api/public/booking${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
const call = (resolver, args = {}) =>
  resolver(
    null,
    args,
    buildContext({ userId: hostId, organizationId: workspaceId }),
    {
      fieldName: "test",
    },
  );
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code || error.extensions?.code;
  }
};

const buyer = (i = 0) => ({
  firstName: "Élise",
  lastName: `Martin${i ? ` ${i}` : ""}`.trim(),
  email: `elise${i}@exemple.fr`,
});

const paypalOrder = (registration, status, capture = null) => ({
  id: ORDER,
  status,
  purchase_units: [
    {
      custom_id: `evt-${registration._id}`,
      amount: {
        value: (registration.amount / 100).toFixed(2),
        currency_code: "EUR",
      },
      payments: capture ? { captures: [capture] } : undefined,
    },
  ],
});

async function registerPaid(provider = "stripe", quantity = 1) {
  const context = await loadPublicPage("jean-dupont");
  const type = await AppointmentType.findById(concert._id).lean();
  const result = await registerForEvent({
    context,
    type,
    buyer: buyer(),
    quantity,
    provider,
  });
  const call0 =
    provider === "stripe"
      ? stripeApi.checkout.sessions.create.mock.calls.at(-1)[0].success_url
      : paypal.createPaypalOrder.mock.calls.at(-1)[0].returnUrl;
  const returnToken = new URL(call0).searchParams.get("rt");
  return { registration: result.registration, returnToken };
}

const stripeSession = (registration, extra = {}) => ({
  id: "cs_test_concert",
  status: "complete",
  payment_status: "paid",
  amount_total: registration.amount,
  currency: "eur",
  payment_intent: "pi_concert",
  metadata: {
    type: "event_registration",
    eventRegistrationId: String(registration._id),
  },
  ...extra,
});

const seatsOf = async (typeId) =>
  (await AppointmentType.findById(typeId).lean()).seatsTaken ?? 0;

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EventRegistration.init(),
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
    id: "cs_test_concert",
    url: "https://checkout.stripe.com/c/pay/cs_test_concert",
  });
  paypal.createPaypalOrder = vi.fn(async () => ({
    id: ORDER,
    approveUrl: "https://www.paypal.com/checkoutnow?token=x",
  }));
  paypal.getPaypalOrder = vi.fn();
  paypal.capturePaypalOrder = vi.fn();
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
  await StripeConnectAccount.create({
    organizationId: String(workspaceId),
    accountId: "acct_vendeur",
    connectionType: "oauth",
    chargesEnabled: true,
  });
  await PaypalMerchantAccount.create({
    organizationId: String(workspaceId),
    email: "vendeur@exemple.fr",
  });
  page = await BookingPage.create({
    workspaceId,
    userId: hostId,
    slug: "jean-dupont",
    title: "Jean Dupont",
  });
  const start = new Date(Date.now() + 3 * DAY);
  [concert, atelier] = await AppointmentType.create([
    {
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      kind: "EVENT",
      slug: "concert",
      name: "Concert",
      durationMinutes: 90,
      startAt: start,
      endAt: new Date(start.getTime() + 90 * 60000),
      location: { kind: "IN_PERSON", value: "Salle Pleyel" },
      capacity: 2,
      seatsTaken: 0,
      maxPerOrder: 2,
      priceAmount: 1500,
      currency: "EUR",
    },
    {
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      kind: "EVENT",
      slug: "atelier",
      name: "Atelier",
      durationMinutes: 60,
      startAt: start,
      endAt: new Date(start.getTime() + 3600000),
      location: { kind: "IN_PERSON", value: "12 rue des Arts" },
      capacity: 5,
      seatsTaken: 0,
      maxPerOrder: 5,
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("1. capture PayPal revendiquée", () => {
  it("inscription expirée entre l'instantané et la capture : jamais encaissée", async () => {
    const { registration } = await registerPaid("paypal");
    const snapshot = await EventRegistration.findById(registration._id);
    // Expirée pendant que le balayage travaillait sur son instantané
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { status: "EXPIRED", "payment.status": "expired" } },
    );
    paypal.getPaypalOrder.mockResolvedValue(paypalOrder(snapshot, "APPROVED"));
    const result = await refreshRegistrationPayment(snapshot, { force: true });
    expect(result.status).toBe("unpaid");
    expect(paypal.capturePaypalOrder).not.toHaveBeenCalled();
  });

  it("une seule capture à la fois ; annulation refusée pendant la capture", async () => {
    const { registration } = await registerPaid("paypal");
    paypal.getPaypalOrder.mockResolvedValue(
      paypalOrder(registration, "APPROVED"),
    );
    let release;
    paypal.capturePaypalOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve(
              paypalOrder(registration, "COMPLETED", {
                id: "CAPTURE1",
                status: "COMPLETED",
                amount: { value: "15.00", currency_code: "EUR" },
              }),
            );
        }),
    );
    const first = refreshRegistrationPayment(registration, { force: true });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    // Pendant la capture : seconde relecture sans capture, annulation refusée
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { "payment.checkedAt": null } },
    );
    const second = await refreshRegistrationPayment(
      await EventRegistration.findById(registration._id),
      { force: true },
    );
    expect(second.status).toBe("pending");
    await expect(
      cancelRegistration({ registration, by: "HOST" }),
    ).rejects.toMatchObject({ code: "PAYMENT_IN_PROGRESS" });
    const host = appointmentEventsResolvers.Mutation.cancelEventRegistration;
    expect(await codeOf(call(host, { id: String(registration._id) }))).toBe(
      "VALIDATION_ERROR",
    );

    release();
    expect((await first).status).toBe("paid");
    expect(paypal.capturePaypalOrder).toHaveBeenCalledTimes(1);
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "CONFIRMED",
    );
  });
});

describe("2. filet après l'expiration", () => {
  it("paiement tombé pendant l'expiration : relu par le balayage dans les 24 h", async () => {
    const { registration } = await registerPaid("stripe");
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration, { status: "open", payment_status: "unpaid" }),
    );
    await sweepEventRegistrations();
    const expired = await EventRegistration.findById(registration._id);
    expect(expired.status).toBe("EXPIRED");
    expect(expired.payment.status).toBe("expired");
    expect(expired.expiredAt).toBeInstanceOf(Date);

    // Le paiement aboutit malgré tout : le balayage suivant le voit
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration),
    );
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { "payment.checkedAt": null } },
    );
    const result = await sweepEventRegistrations();
    expect(result.checked).toBe(1);
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "CONFIRMED",
    );

    // Au-delà de 24 h : plus relue
    await EventRegistration.updateOne(
      { _id: registration._id },
      {
        $set: {
          status: "EXPIRED",
          "payment.status": "expired",
          "payment.paidAt": null,
          expiredAt: new Date(Date.now() - 25 * 3600000),
        },
      },
    );
    expect((await sweepEventRegistrations()).checked).toBe(0);
  });
});

describe("3. places jamais perdues", () => {
  it("inscription gratuite non confirmée : expirée, places rendues", async () => {
    const context = await loadPublicPage("jean-dupont");
    const type = await AppointmentType.findById(atelier._id).lean();
    const spy = vi
      .spyOn(EventRegistration, "findOneAndUpdate")
      .mockImplementationOnce(async () => {
        throw new Error("panne de base");
      });
    await expect(
      registerForEvent({ context, type, buyer: buyer(), quantity: 2 }),
    ).rejects.toThrow();
    spy.mockRestore();
    const stored = await EventRegistration.findOne().lean();
    expect(stored.status).toBe("EXPIRED");
    expect(stored.expiresAt).toBeInstanceOf(Date);
    expect(await seatsOf(atelier._id)).toBe(0);
  });

  it("réconciliation : annulée ou expirée qui tient encore ses places", async () => {
    const context = await loadPublicPage("jean-dupont");
    const type = await AppointmentType.findById(atelier._id).lean();
    const { registration } = await registerForEvent({
      context,
      type,
      buyer: buyer(),
      quantity: 3,
    });
    expect(await seatsOf(atelier._id)).toBe(3);
    // Arrêt entre le passage en CANCELLED et la restitution des places
    await EventRegistration.collection.updateOne(
      { _id: registration._id },
      {
        $set: {
          status: "CANCELLED",
          updatedAt: new Date(Date.now() - 5 * 60000),
        },
      },
    );
    expect(await reconcileHeldSeats()).toBe(1);
    expect(await seatsOf(atelier._id)).toBe(0);
    expect(await reconcileHeldSeats()).toBe(0);
  });
});

describe("4. créneaux existants intacts", () => {
  it("un créneau sans champs d'événement modifié puis enregistré n'en gagne aucun", async () => {
    const { insertedId } = await AppointmentType.collection.insertOne({
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      slug: "ancien",
      name: "Ancien créneau",
      durationMinutes: 30,
      location: { kind: "PHONE", value: null },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await appointmentsResolvers.Mutation.updateAppointmentType(
      null,
      { id: String(insertedId), input: { name: "Créneau renommé" } },
      buildContext({ userId: hostId, organizationId: workspaceId }),
      { fieldName: "test" },
    );
    const raw = await AppointmentType.collection.findOne({ _id: insertedId });
    expect(raw.name).toBe("Créneau renommé");
    for (const field of [
      "kind",
      "seatsTaken",
      "maxPerOrder",
      "startAt",
      "endAt",
      "details",
      "capacity",
      "coverImageUrl",
      "imageUrl",
      "registrationClosesAt",
      "calendarEventId",
    ]) {
      expect(raw, field).not.toHaveProperty(field);
    }
    const T = appointmentsResolvers.AppointmentType;
    expect(T.kind(raw)).toBe("SLOT");
    expect(T.seatsTaken(raw)).toBe(0);
    expect(T.maxPerOrder(raw)).toBe(5);
  });
});

describe("5. limites par adresse", () => {
  it("retour relu 12 fois par le site : jamais de 429 ; inscriptions groupées permises", async () => {
    const { returnToken, registration } = await registerPaid("stripe");
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration, { status: "open", payment_status: "unpaid" }),
    );
    for (let i = 0; i < 12; i += 1) {
      const res = await api("/registrations/return", {
        method: "POST",
        body: { returnToken, provider: "stripe" },
      });
      expect(res.status, `appel ${i + 1}`).toBe(200);
    }
    for (let i = 0; i < 10; i += 1) {
      const res = await api("/jean-dupont/atelier/register", {
        method: "POST",
        body: { buyer: buyer(i + 1), quantity: 1 },
      });
      expect([201, 409], `inscription ${i + 1}`).toContain(res.status);
    }
  });
});

describe("6. abandon du paiement", () => {
  it("le payeur annule : session fermée, inscription expirée, places rendues", async () => {
    const { returnToken, registration } = await registerPaid("stripe", 2);
    expect(await seatsOf(concert._id)).toBe(2);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration, { status: "open", payment_status: "unpaid" }),
    );
    const res = await api("/registrations/return/cancel", {
      method: "POST",
      body: { returnToken },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      paymentStatus: "unpaid",
      refundStatus: "NONE",
      registration: { status: "EXPIRED" },
      manageUrl: null,
    });
    expect(stripeApi.checkout.sessions.expire).toHaveBeenCalled();
    expect(await seatsOf(concert._id)).toBe(0);
  });

  it("déjà payé : confirmé, rien n'est rendu", async () => {
    const { returnToken, registration } = await registerPaid("stripe");
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration),
    );
    const body = await (
      await api("/registrations/return/cancel", {
        method: "POST",
        body: { returnToken },
      })
    ).json();
    expect(body.paymentStatus).toBe("paid");
    expect(body.registration.status).toBe("CONFIRMED");
    expect(await seatsOf(concert._id)).toBe(1);
  });

  it("jeton inconnu : 404", async () => {
    const res = await api("/registrations/return/cancel", {
      method: "POST",
      body: { returnToken: "b".repeat(43) },
    });
    expect(res.status).toBe(404);
  });
});

describe("7. état du remboursement", () => {
  it("REFUNDED, MANUAL puis NONE", async () => {
    const { returnToken, registration } = await registerPaid("stripe");
    // Payée après expiration sans place : remboursée
    await EventRegistration.updateOne(
      { _id: registration._id },
      {
        $set: {
          status: "EXPIRED",
          seatsHeld: false,
          "payment.status": "expired",
        },
      },
    );
    await AppointmentType.updateOne(
      { _id: concert._id },
      { $set: { seatsTaken: 2 } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration),
    );
    stripeApi.refunds.create.mockResolvedValue({ id: "re_1" });
    const refunded = await (
      await api("/registrations/return", {
        method: "POST",
        body: { returnToken, provider: "stripe" },
      })
    ).json();
    expect(refunded.refundStatus).toBe("REFUNDED");
    expect(refunded.registration.refundStatus).toBe("REFUNDED");

    // Remboursement impossible : à rembourser à la main
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { "payment.refundedAt": null } },
    );
    const manual = await (
      await api("/registrations/return", {
        method: "POST",
        body: { returnToken, provider: "stripe" },
      })
    ).json();
    expect(manual.refundStatus).toBe("MANUAL");
    await AppointmentType.updateOne(
      { _id: concert._id },
      { $set: { seatsTaken: 0 } },
    );

    const other = await registerPaid("stripe");
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(other.registration, {
        status: "open",
        payment_status: "unpaid",
      }),
    );
    const none = await (
      await api("/registrations/return", {
        method: "POST",
        body: { returnToken: other.returnToken, provider: "stripe" },
      })
    ).json();
    expect(none.refundStatus).toBe("NONE");
  });
});

describe("8. pagination des inscrits", () => {
  it("offset et totalCount", async () => {
    const context = await loadPublicPage("jean-dupont");
    const type = await AppointmentType.findById(atelier._id).lean();
    for (let i = 0; i < 5; i += 1) {
      await registerForEvent({ context, type, buyer: buyer(i), quantity: 1 });
    }
    const Q = appointmentEventsResolvers.Query.eventRegistrations;
    const first = await call(Q, { typeId: String(atelier._id), limit: 2 });
    const third = await call(Q, {
      typeId: String(atelier._id),
      limit: 2,
      offset: 4,
    });
    expect(first.totalCount).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(third.items).toHaveLength(1);
  });
});

describe("9. expiration non bloquée", () => {
  it("des paiements en confirmation en tête de liste n'empêchent pas d'expirer les autres", async () => {
    const context = await loadPublicPage("jean-dupont");
    await AppointmentType.updateOne(
      { _id: concert._id },
      { $set: { capacity: null } },
    );
    const type = await AppointmentType.findById(concert._id).lean();
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const { registration } = await registerForEvent({
        context,
        type,
        buyer: buyer(i),
        quantity: 1,
        provider: "stripe",
      });
      ids.push(registration._id);
    }
    // Les deux plus anciennes : paiement en confirmation chez Stripe
    await EventRegistration.updateMany(
      { _id: { $in: ids.slice(0, 2) } },
      {
        $set: {
          "payment.status": "pending",
          expiresAt: new Date(Date.now() - 60000),
        },
      },
    );
    await EventRegistration.updateOne(
      { _id: ids[2] },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...stripeSession({ _id: ids[2], amount: 1500 }),
      status: "open",
      payment_status: "unpaid",
    });
    const { expireOverdueRegistrations } =
      await import("../../src/services/appointments/eventRegistrationService.js");
    expect(await expireOverdueRegistrations({ limit: 1 })).toBe(1);
    expect((await EventRegistration.findById(ids[2])).status).toBe("EXPIRED");
    expect((await EventRegistration.findById(ids[0])).status).toBe(
      "PENDING_PAYMENT",
    );
  });
});

describe("10. moyen de paiement déconnecté", () => {
  it("modifier le nom d'un événement payant reste possible, changer le prix non", async () => {
    await StripeConnectAccount.deleteMany({});
    await PaypalMerchantAccount.deleteMany({});
    const update = appointmentsResolvers.Mutation.updateAppointmentType;
    const renamed = await call(update, {
      id: String(concert._id),
      input: { name: "Concert du soir", price: { amount: 1500 } },
    });
    expect(renamed.name).toBe("Concert du soir");
    expect(
      await codeOf(
        call(update, {
          id: String(concert._id),
          input: { price: { amount: 2000 } },
        }),
      ),
    ).toBe("VALIDATION_ERROR");
  });
});

describe("11. jeton de retour", () => {
  it("valable une heure ; après confirmation, quelques minutes seulement", async () => {
    const { returnToken, registration } = await registerPaid("stripe");
    const stored = await EventRegistration.findById(registration._id);
    const ttl =
      stored.payment.returnTokenExpiresAt.getTime() -
      stored.createdAt.getTime();
    expect(ttl).toBeLessThanOrEqual(3600000 + 5000);
    expect(ttl).toBeGreaterThan(3500000);

    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      stripeSession(registration),
    );
    const ok = await api("/registrations/return", {
      method: "POST",
      body: { returnToken, provider: "stripe" },
    });
    expect((await ok.json()).registration.status).toBe("CONFIRMED");
    // Double chargement de la page : encore servi
    expect(
      (
        await api("/registrations/return", {
          method: "POST",
          body: { returnToken, provider: "stripe" },
        })
      ).status,
    ).toBe(200);
    // Plus tard : 404, le lien de gestion prend le relais
    await EventRegistration.updateOne(
      { _id: registration._id },
      {
        $set: {
          "payment.returnTokenConsumedAt": new Date(Date.now() - 10 * 60000),
        },
      },
    );
    expect(
      (
        await api("/registrations/return", {
          method: "POST",
          body: { returnToken, provider: "stripe" },
        })
      ).status,
    ).toBe(404);
  });
});

describe("12. contrôle des billets et abonnement", () => {
  it("abonnement inactif : contrôle et retour arrière refusés", async () => {
    await mongoose.connection.db.collection("subscription").updateOne(
      { referenceId: String(workspaceId) },
      {
        $set: { status: "canceled", periodEnd: new Date(Date.now() - 1000) },
      },
    );
    invalidateSubCache();
    const M = appointmentEventsResolvers.Mutation;
    const check = await codeOf(
      call(M.checkInTicket, { typeId: String(atelier._id), code: "x" }),
    );
    const undo = await codeOf(
      call(M.undoTicketCheckIn, {
        ticketId: String(new mongoose.Types.ObjectId()),
      }),
    );
    for (const code of [check, undo]) {
      expect(code).toBeTruthy();
      expect(code).not.toBe("NOT_FOUND");
    }
  });
});

describe("13. CSV", () => {
  it("téléphone international lisible, formules neutralisées", () => {
    expect(csvCell("+33 6 12 34 56 78")).toBe("+33 6 12 34 56 78");
    expect(csvCell("+33(0)612.34.56-78")).toBe("+33(0)612.34.56-78");
    expect(csvCell("+SUM(A1)")).toBe("'+SUM(A1)");
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-2")).toBe("'-2");
  });
});

describe("14. événement déplacé", () => {
  it("rappel remis à zéro, inscrits confirmés prévenus (pas pour le seul nom)", async () => {
    const context = await loadPublicPage("jean-dupont");
    const type = await AppointmentType.findById(atelier._id).lean();
    const { registration } = await registerForEvent({
      context,
      type,
      buyer: buyer(),
      quantity: 1,
    });
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { "reminders.h24SentAt": new Date() } },
    );
    await vi.waitFor(() => expect(mail.sent.length).toBe(2));
    mail.sent = [];
    const update = appointmentsResolvers.Mutation.updateAppointmentType;

    await call(update, {
      id: String(atelier._id),
      input: { name: "Atelier renommé", description: "Nouveau texte" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mail.sent).toHaveLength(0);
    expect(
      (await EventRegistration.findById(registration._id)).reminders.h24SentAt,
    ).toBeInstanceOf(Date);

    const newStart = new Date(Date.now() + 5 * DAY);
    await call(update, {
      id: String(atelier._id),
      input: {
        startAt: newStart.toISOString(),
        endAt: new Date(newStart.getTime() + 3600000).toISOString(),
      },
    });
    const moved = await EventRegistration.findById(registration._id);
    expect(moved.reminders.h24SentAt).toBeNull();
    expect(moved.event.startAt.getTime()).toBe(newStart.getTime());
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
    expect(mail.sent[0].to).toEqual(["elise0@exemple.fr"]);
    expect(mail.sent[0].subject).toMatch(
      /^Événement modifié : Atelier renommé/,
    );
    expect(mail.sent[0].html).not.toContain("\u2014");

    mail.sent = [];
    await call(update, {
      id: String(atelier._id),
      input: { location: { kind: "IN_PERSON", value: "1 place Bellecour" } },
    });
    await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
    // renderEmail insère des insécables (typographie) : texte comparé sans balises
    expect(mail.sent[0].html.replace(/<[^>]+>/g, "")).toContain(
      "1 place Bellecour",
    );
  });
});
