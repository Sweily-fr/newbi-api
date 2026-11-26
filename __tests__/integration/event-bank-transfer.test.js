/**
 * Billetterie : paiement par virement.
 *
 * Moyen proposé avec l'IBAN de l'entreprise, inscription en attente 3 jours
 * (places tenues, référence NB-…, coordonnées et e-mail), « J'ai fait le
 * virement » qui prévient l'organisateur sans jamais confirmer, repérage
 * bancaire Bridge (libellé, montant, devise), « Marquer comme payé »
 * (droits, cloisonnement), expiration après 3 jours (e-mail, places
 * rendues), virement tardif (confirmé s'il reste des places, sinon « à
 * rembourser à la main »), et inscriptions existantes laissées intactes.
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
    // Jamais d'envoi réel (e-mails hors prise de rendez-vous)
    sendEmail: async (payload) => {
      mail.sent.push(payload);
      return true;
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
import AccountBanking from "../../src/models/AccountBanking.js";
import AppointmentType from "../../src/models/AppointmentType.js";
import BookingPage from "../../src/models/BookingPage.js";
import EventRegistration from "../../src/models/EventRegistration.js";
import Notification from "../../src/models/Notification.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import appointmentsResolvers from "../../src/resolvers/appointments.js";
import appointmentEventsResolvers from "../../src/resolvers/appointmentEvents.js";
import publicBookingRoutes from "../../src/routes/publicBooking.js";
import {
  expireOverdueRegistrations,
  sweepEventRegistrations,
} from "../../src/services/appointments/eventRegistrationService.js";
import { detectAppointmentBankPayments } from "../../src/services/appointments/appointmentBankDetection.js";
import { BridgeProvider } from "../../src/services/banking/providers/BridgeProvider.js";

const { Mutation } = appointmentsResolvers;
const Events = appointmentEventsResolvers;
const R = appointmentEventsResolvers.EventRegistration;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const viewer = buildUserId();
const outsider = buildUserId();

const DAY = 86400000;
const IBAN = "FR7630006000011234567890189";

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

const setIban = (iban = IBAN) =>
  mongoose.connection.db
    .collection("organization")
    .updateOne(
      { _id: workspaceId },
      { $set: { bankIban: iban, bankBic: "AGRIFRPP" } },
    );

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
    price: { amount: 2000 },
    ...overrides,
  };
};

const createEvent = (overrides) =>
  call(Mutation.createAppointmentType, owner, {
    input: eventInput(overrides),
  });

const register = (
  type,
  { quantity = 2, i = 0, provider = "bank_transfer" } = {},
) =>
  api(`/jean-dupont/${type.slug}/register`, {
    method: "POST",
    body: {
      buyer: {
        firstName: "Élise",
        lastName: "Martin",
        email: `elise${i}@exemple.fr`,
      },
      quantity,
      provider,
    },
  });

const tokenOf = (manageUrl) => manageUrl.split("/").pop();

/** Crédit bancaire tel que synchronisé (Bridge). */
const credit = (fields = {}) => ({
  externalId: `tx-${Math.random()}`,
  amount: 40,
  currency: "EUR",
  description: "VIR SEPA ELISE MARTIN",
  reference: "",
  ...fields,
});

const rawRegistration = (id) =>
  mongoose.connection.db
    .collection("event_registrations")
    .findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

const mailTo = (email) =>
  mail.sent.filter((m) => [].concat(m.to).includes(email));

async function pendingRegistration(type, options) {
  const res = await register(type, options);
  expect(res.status).toBe(201);
  const body = await res.json();
  const registration = await EventRegistration.findOne({
    manageTokenHash: { $exists: true },
    "buyer.email": `elise${options?.i || 0}@exemple.fr`,
  });
  return { body, registration };
}

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

// ─── Moyens et création ───────────────────────────────────────────────────

describe("virement proposé", () => {
  it("IBAN seul : moyen bank_transfer, événement payant accepté", async () => {
    expect(await errorOf(createEvent()), "sans moyen ni IBAN").toMatchObject({
      code: "VALIDATION_ERROR",
      field: "price",
    });
    await setIban();
    expect(await call(Events.Query.eventPaymentMethods, owner)).toEqual([
      "bank_transfer",
    ]);
    const type = await createEvent({
      paymentMode: "DEPOSIT",
      depositAmount: 500,
    });
    const detail = await (await api(`/jean-dupont/${type.slug}`)).json();
    expect(detail.type.event.paymentMethods).toEqual(["bank_transfer"]);
  });

  it("ordre : carte, PayPal, SumUp puis virement", async () => {
    await setIban();
    await StripeConnectAccount.create({
      organizationId: String(workspaceId),
      accountId: "acct_vendeur",
      connectionType: "oauth",
      chargesEnabled: true,
    });
    expect(await call(Events.Query.eventPaymentMethods, owner)).toEqual([
      "stripe",
      "bank_transfer",
    ]);
  });

  it("IBAN absent : virement refusé (PAYMENT_METHOD_UNAVAILABLE)", async () => {
    await setIban();
    const type = await createEvent();
    await setIban("pas un iban");
    const res = await register(type);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "PAYMENT_METHOD_UNAVAILABLE" });
    expect(await EventRegistration.countDocuments()).toBe(0);
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(0);
  });
});

// ─── Inscription en attente ───────────────────────────────────────────────

describe("inscription par virement", () => {
  it("en attente 3 jours, places tenues, coordonnées, e-mail, aucun billet", async () => {
    await setIban();
    const type = await createEvent({
      paymentMode: "DEPOSIT",
      depositAmount: 500,
    });
    const before = Date.now();
    const { body, registration } = await pendingRegistration(type);

    expect(body.status).toBe("PENDING_PAYMENT");
    expect(body.paymentUrl).toBeUndefined();
    expect(body.manageUrl).toMatch(/\/rdv\/inscription\/[A-Za-z0-9_-]{43}$/);
    const expires = new Date(body.expiresAt).getTime();
    expect(expires - before).toBeGreaterThan(3 * DAY - 60000);
    expect(expires - before).toBeLessThanOrEqual(3 * DAY + 60000);
    expect(body.registration).toMatchObject({
      status: "PENDING_PAYMENT",
      paymentProvider: "bank_transfer",
      amount: 4000,
      amountOnline: 1000,
      amountDueOnSite: 3000,
      tickets: [],
      canCancel: false,
      bankTransfer: {
        holder: "Cabinet Martin",
        iban: "FR76 3000 6000 0112 3456 7890 189",
        bic: "AGRIFRPP",
        amount: 1000,
        currency: "EUR",
        declaredAt: null,
        autoDetect: false,
      },
    });
    expect(body.registration.bankTransfer.reference).toMatch(
      /^NB-[A-HJ-NP-Z2-9]{6}$/,
    );
    expect(body.registration.bankTransfer.dueAt).toBe(body.expiresAt);

    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(2);
    expect(registration.payment.bankReference).toBe(
      body.registration.bankTransfer.reference,
    );
    expect(registration.tickets).toHaveLength(0);

    // E-mail au participant : coordonnées et lien ; rien à l'organisateur
    await vi.waitFor(() => expect(mailTo("elise0@exemple.fr")).toHaveLength(1));
    const html = mailTo("elise0@exemple.fr")[0].html;
    expect(html).toContain(registration.payment.bankReference);
    expect(
      html.replace(/<[^>]+>/g, "").replace(/&nbsp;|\u00a0/g, " "),
    ).toContain("FR76 3000 6000 0112 3456 7890 189");
    expect(html).toContain(tokenOf(body.manageUrl));
    expect(mailTo("jean@cabinet.fr")).toHaveLength(0);

    // Page de l'inscription : mêmes coordonnées
    const page = await (
      await api(`/registrations/${tokenOf(body.manageUrl)}`)
    ).json();
    expect(page.bankTransfer.reference).toBe(
      registration.payment.bankReference,
    );
    expect(page.expiresAt).toBe(body.expiresAt);

    // Liste des inscrits : référence visible
    const list = await call(Events.Query.eventRegistrations, owner, {
      typeId: String(type._id),
    });
    expect(R.paymentProvider(list.items[0])).toBe("bank_transfer");
    expect(R.paymentReference(list.items[0])).toBe(
      registration.payment.bankReference,
    );
  });

  it("références distinctes d'une inscription à l'autre", async () => {
    await setIban();
    const type = await createEvent({ capacity: 10 });
    const refs = new Set();
    for (let i = 0; i < 4; i += 1) {
      const { registration } = await pendingRegistration(type, {
        quantity: 1,
        i,
      });
      refs.add(registration.payment.bankReference);
    }
    expect(refs.size).toBe(4);
  });
});

// ─── « J'ai fait le virement » ────────────────────────────────────────────

describe("annonce du virement", () => {
  it("prévient l'organisateur une seule fois, ne confirme jamais, annulable", async () => {
    await setIban();
    const type = await createEvent();
    const { body, registration } = await pendingRegistration(type);
    const token = tokenOf(body.manageUrl);
    mail.sent = [];

    const declare = (payload = {}) =>
      api(`/registrations/${token}/bank-transfer`, {
        method: "POST",
        body: payload,
      });
    let res = await declare();
    expect(res.status).toBe(200);
    const { declaredAt } = await res.json();
    expect(declaredAt).toEqual(expect.any(String));
    res = await declare();
    expect((await res.json()).declaredAt).toBe(declaredAt);

    const fresh = await EventRegistration.findById(registration._id);
    expect(fresh.status).toBe("PENDING_PAYMENT");
    expect(fresh.tickets).toHaveLength(0);
    expect(fresh.payment.paidAt).toBeNull();
    expect(R.bankTransferDeclaredAt(fresh)).toEqual(new Date(declaredAt));

    const notifications = await Notification.find({ userId: owner });
    expect(notifications.map((n) => n.type)).toEqual([
      "APPOINTMENT_BANK_DECLARED",
    ]);
    expect(notifications[0].message).toContain(
      registration.payment.bankReference,
    );
    expect(mailTo("jean@cabinet.fr")).toHaveLength(1);
    expect(mailTo("elise0@exemple.fr")).toHaveLength(0);

    res = await declare({ cancel: true });
    expect(await res.json()).toEqual({ declaredAt: null });
    expect(
      (await EventRegistration.findById(registration._id)).payment.declaredAt,
    ).toBeUndefined();
  });

  it("409 hors virement en attente ; 404 jeton inconnu", async () => {
    await setIban();
    const free = await call(Mutation.createAppointmentType, owner, {
      input: eventInput({ price: null, name: "Gratuit" }),
    });
    const res = await register(free, { provider: undefined });
    const { manageUrl } = await res.json();
    const declared = await api(
      `/registrations/${tokenOf(manageUrl)}/bank-transfer`,
      { method: "POST", body: {} },
    );
    expect(declared.status).toBe(409);
    expect(await declared.json()).toEqual({ error: "NOT_ALLOWED" });
    const unknown = await api(
      `/registrations/${"x".repeat(43)}/bank-transfer`,
      {
        method: "POST",
        body: {},
      },
    );
    expect(unknown.status).toBe(404);
  });
});

// ─── Repérage bancaire ────────────────────────────────────────────────────

describe("repérage du virement", () => {
  it("libellé avec la référence, montant >=, même devise : confirmée (billets, e-mails)", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    const ref = registration.payment.bankReference;
    mail.sent = [];

    // Mauvais montant, mauvaise devise, sans référence : rien
    let done = await detectAppointmentBankPayments(String(workspaceId), [
      credit({ amount: 39.99, description: `VIR ${ref}` }),
      credit({ amount: 40, currency: "USD", description: `VIR ${ref}` }),
      credit({ amount: 40, description: "VIR SANS REFERENCE" }),
      credit({ amount: -40, description: `VIR ${ref}` }),
    ]);
    expect(done.registrations).toEqual([]);
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "PENDING_PAYMENT",
    );

    // Autre espace : jamais
    done = await detectAppointmentBankPayments(String(otherWorkspace), [
      credit({ description: `VIR ${ref}` }),
    ]);
    expect(done.registrations).toEqual([]);

    // Libellé compact en minuscules, montant supérieur
    const compact = ref.replace("-", "").toLowerCase();
    done = await detectAppointmentBankPayments(String(workspaceId), [
      credit({ amount: 45, reference: `motif ${compact}` }),
    ]);
    expect(done.registrations).toEqual([String(registration._id)]);
    const confirmed = await EventRegistration.findById(registration._id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.tickets).toHaveLength(2);
    expect(confirmed.payment.paidAt).toBeInstanceOf(Date);
    expect(confirmed.payment.paidAmount).toBe(4500);
    expect(mailTo("elise0@exemple.fr")).toHaveLength(1);
    expect(mailTo("jean@cabinet.fr")).toHaveLength(1);

    // Resynchronisation du même crédit : rien de plus
    await detectAppointmentBankPayments(String(workspaceId), [
      credit({ amount: 45, reference: `motif ${compact}` }),
    ]);
    expect(mail.sent).toHaveLength(2);
  });

  it("branché sur la synchronisation Bridge", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    const provider = new BridgeProvider();
    const transaction = provider._mapTransaction(
      {
        id: 9001,
        account_id: 4242,
        amount: 40,
        currency_code: "EUR",
        date: "2026-11-20",
        clean_description: `VIREMENT ${registration.payment.bankReference} MARTIN`,
        provider_description: `VIR SEPA ${registration.payment.bankReference}`,
        category_id: 0,
      },
      String(workspaceId),
      "webhook-sync",
    );
    await provider._saveTransactionsToDatabase(
      [transaction],
      String(workspaceId),
    );
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "CONFIRMED",
    );
  });
});

// ─── « Marquer comme payé » ───────────────────────────────────────────────

describe("marquer comme payé (organisateur)", () => {
  it("confirme une inscription en attente ; idempotent", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    const id = String(registration._id);
    const done = await call(Events.Mutation.markEventRegistrationPaid, owner, {
      id,
    });
    expect(done.status).toBe("CONFIRMED");
    expect(done.tickets).toHaveLength(2);
    expect(String(done.payment.markedBy)).toBe(String(owner));
    const again = await call(Events.Mutation.markEventRegistrationPaid, owner, {
      id,
    });
    expect(again.status).toBe("CONFIRMED");
    expect(again.tickets.map((t) => t.number)).toEqual(
      done.tickets.map((t) => t.number),
    );
  });

  it("droits, cloisonnement, autre moyen refusé", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    const id = String(registration._id);
    const mark = (userId, org) =>
      errorOf(
        call(Events.Mutation.markEventRegistrationPaid, userId, { id }, org),
      );
    expect((await mark(viewer)).code).toBe("FORBIDDEN");
    expect(await mark(member)).toMatchObject({ code: "NOT_FOUND" });
    expect(await mark(outsider, otherWorkspace)).toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await EventRegistration.findById(id)).status).toBe(
      "PENDING_PAYMENT",
    );

    // Gratuite : pas un virement
    const free = await call(Mutation.createAppointmentType, owner, {
      input: eventInput({ price: null, name: "Gratuit" }),
    });
    await register(free, { provider: undefined, i: 3, quantity: 1 });
    const freeReg = await EventRegistration.findOne({
      appointmentTypeId: free._id,
    });
    expect(
      await errorOf(
        call(Events.Mutation.markEventRegistrationPaid, owner, {
          id: String(freeReg._id),
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("abonnement inactif : refusé", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    await mongoose.connection.db.collection("subscription").deleteMany({});
    invalidateSubCache(String(workspaceId));
    const error = await errorOf(
      call(Events.Mutation.markEventRegistrationPaid, owner, {
        id: String(registration._id),
      }),
    );
    expect(error).not.toBeNull();
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "PENDING_PAYMENT",
    );
  });
});

// ─── Expiration et virement tardif ────────────────────────────────────────

describe("expiration après 3 jours", () => {
  it("pas expirée avant 3 jours ; ensuite EXPIRED, places rendues, e-mail", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    mail.sent = [];

    await sweepEventRegistrations({ now: new Date(Date.now() + 2 * DAY) });
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "PENDING_PAYMENT",
    );

    await sweepEventRegistrations({
      now: new Date(Date.now() + 3 * DAY + 60000),
    });
    const expired = await EventRegistration.findById(registration._id);
    expect(expired.status).toBe("EXPIRED");
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(0);
    const emails = mailTo("elise0@exemple.fr");
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toContain("Réservation expirée");
    expect(emails[0].html).toContain("virement");
  });

  it("virement tardif, places libres : confirmée", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    await expireOverdueRegistrations({ now: new Date(Date.now() + 4 * DAY) });
    await detectAppointmentBankPayments(String(workspaceId), [
      credit({ description: `VIR ${registration.payment.bankReference}` }),
    ]);
    const fresh = await EventRegistration.findById(registration._id);
    expect(fresh.status).toBe("CONFIRMED");
    expect(fresh.tickets).toHaveLength(2);
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(2);
  });

  it("virement tardif, plus de places : à rembourser à la main, organisateur prévenu", async () => {
    await setIban();
    const type = await createEvent({ capacity: 2, maxPerOrder: 2 });
    const { registration } = await pendingRegistration(type);
    await expireOverdueRegistrations({ now: new Date(Date.now() + 4 * DAY) });
    // Places reprises entre-temps
    const other = await pendingRegistration(type, { i: 1 });
    await call(Events.Mutation.markEventRegistrationPaid, owner, {
      id: String(other.registration._id),
    });
    mail.sent = [];

    await detectAppointmentBankPayments(String(workspaceId), [
      credit({ description: `VIR ${registration.payment.bankReference}` }),
    ]);
    const late = await EventRegistration.findById(registration._id);
    expect(late.status).toBe("EXPIRED");
    expect(late.payment.paidAt).toBeInstanceOf(Date);
    expect(R.refundFailed(late)).toBe(true);
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(2);
    const notifications = await Notification.find({
      userId: owner,
      type: "APPOINTMENT_REFUND_NEEDED",
    });
    expect(notifications).toHaveLength(1);
    expect(mailTo("jean@cabinet.fr")).toHaveLength(1);
    // Visible dans la liste par défaut (paiement à rendre)
    const list = await call(Events.Query.eventRegistrations, owner, {
      typeId: String(type._id),
    });
    expect(list.items.map((r) => String(r._id))).toContain(
      String(registration._id),
    );

    // Complet : aucune nouvelle inscription
    const full = await register(type, { i: 2 });
    expect(full.status).toBe(409);
  });

  it("marquer payée une expirée : places reprises si libres, sinon refus", async () => {
    await setIban();
    const type = await createEvent({ capacity: 2, maxPerOrder: 2 });
    const { registration } = await pendingRegistration(type);
    await expireOverdueRegistrations({ now: new Date(Date.now() + 4 * DAY) });
    const other = await pendingRegistration(type, { i: 1 });
    expect(
      await errorOf(
        call(Events.Mutation.markEventRegistrationPaid, owner, {
          id: String(registration._id),
        }),
      ),
    ).toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "Il ne reste plus assez de places pour confirmer cette inscription.",
    });
    expect(
      (await EventRegistration.findById(registration._id)).payment.paidAt,
    ).toBeNull();
    await call(Events.Mutation.cancelEventRegistration, owner, {
      id: String(other.registration._id),
    });
    const done = await call(Events.Mutation.markEventRegistrationPaid, owner, {
      id: String(registration._id),
    });
    expect(done.status).toBe("CONFIRMED");
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(2);
  });
});

// ─── Existant intact ──────────────────────────────────────────────────────

describe("inscriptions existantes", () => {
  it("aucun champ de virement écrit sur une inscription par carte ni gratuite", async () => {
    await setIban();
    const free = await call(Mutation.createAppointmentType, owner, {
      input: eventInput({ price: null, name: "Gratuit" }),
    });
    await register(free, { provider: undefined, quantity: 1 });
    const saved = await EventRegistration.findOne({
      appointmentTypeId: free._id,
    });
    // Suite de la confirmation (client CRM) terminée
    await vi.waitFor(async () =>
      expect((await rawRegistration(saved._id)).clientId).not.toBeNull(),
    );
    const raw = await rawRegistration(saved._id);
    expect(raw.payment).not.toHaveProperty("bankReference");
    expect(raw.payment).not.toHaveProperty("declaredAt");
    expect(raw.payment).not.toHaveProperty("markedBy");
    // Repérage d'un crédit quelconque : rien ne change
    const before = JSON.stringify(raw);
    await detectAppointmentBankPayments(String(workspaceId), [
      credit({ description: "VIR NB-ABCDEF" }),
    ]);
    expect(JSON.stringify(await rawRegistration(saved._id))).toBe(before);
  });

  it("CSV : moyen « Virement »", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    await call(Events.Mutation.markEventRegistrationPaid, owner, {
      id: String(registration._id),
    });
    const csv = await call(Events.Query.eventRegistrationsCsv, owner, {
      typeId: String(type._id),
    });
    expect(csv.split("\r\n")[1]).toContain(";Virement;");
  });

  it("AccountBanking connecté : autoDetect annoncé", async () => {
    await setIban();
    await AccountBanking.collection.insertOne({
      workspaceId: String(workspaceId),
      provider: "bridge",
      status: "active",
      externalId: "acc-1",
    });
    const type = await createEvent();
    const { body } = await pendingRegistration(type);
    expect(body.registration.bankTransfer.autoDetect).toBe(true);
  });
});

// ─── Corrections de relecture ────────────────────────────────────────────

describe("relecture : délais, limites, paiement après le début", () => {
  it("événement à moins de 48 h : virement indisponible et refusé ; garde bornée au début - 24 h", async () => {
    await setIban();
    const soonStart = new Date(Date.now() + 36 * 3600000);
    const soon = await createEvent({
      name: "Bientôt",
      startAt: soonStart.toISOString(),
      endAt: new Date(soonStart.getTime() + 3600000).toISOString(),
    });
    const detail = await (await api(`/jean-dupont/${soon.slug}`)).json();
    expect(detail.type.event.bankTransferAvailable).toBe(false);
    const refused = await register(soon);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "BANK_TRANSFER_TOO_LATE" });
    expect((await AppointmentType.findById(soon._id)).seatsTaken).toBe(0);

    const start = new Date(Date.now() + 60 * 3600000);
    const later = await createEvent({
      name: "Plus tard",
      startAt: start.toISOString(),
      endAt: new Date(start.getTime() + 3600000).toISOString(),
    });
    expect(
      (await (await api(`/jean-dupont/${later.slug}`)).json()).type.event
        .bankTransferAvailable,
    ).toBe(true);
    const { body } = await pendingRegistration(later);
    expect(Date.parse(body.expiresAt)).toBe(start.getTime() - DAY);
  });

  it("une seule inscription par virement en attente par adresse et par événement", async () => {
    await setIban();
    const type = await createEvent({ capacity: 10 });
    await pendingRegistration(type, { quantity: 1 });
    const again = await register(type, { quantity: 1 });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "TOO_MANY_PENDING_TRANSFERS" });
  });

  it("limite par adresse IP : 5 virements par jour", async () => {
    await setIban();
    const type = await createEvent({ capacity: 20 });
    for (let i = 0; i < 5; i += 1) {
      expect((await register(type, { quantity: 1, i })).status).toBe(201);
    }
    const sixth = await register(type, { quantity: 1, i: 9 });
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ error: "BANK_TRANSFER_LIMIT" });
  });

  it("virement repéré après le début : jamais de billets, organisateur et payeur prévenus", async () => {
    await setIban();
    const type = await createEvent();
    const { registration } = await pendingRegistration(type);
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { "event.startAt": new Date(Date.now() - 60000) } },
    );
    mail.sent = [];
    await detectAppointmentBankPayments(String(workspaceId), [
      credit({ description: `VIR ${registration.payment.bankReference}` }),
    ]);
    const after = await EventRegistration.findById(registration._id);
    expect(after.status).toBe("EXPIRED");
    expect(after.tickets).toHaveLength(0);
    expect(R.refundFailed(after)).toBe(true);
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(0);
    expect(mailTo("jean@cabinet.fr")).toHaveLength(1);
    const payer = mailTo("elise0@exemple.fr");
    expect(payer).toHaveLength(1);
    expect(payer[0].subject).toContain("Réservation non confirmée");
    // « Marquer comme payé » d'une autre inscription après le début : refusé
    const other = await pendingRegistration(type, { i: 1 });
    await EventRegistration.updateOne(
      { _id: other.registration._id },
      { $set: { "event.startAt": new Date(Date.now() - 60000) } },
    );
    expect(
      await errorOf(
        call(Events.Mutation.markEventRegistrationPaid, owner, {
          id: String(other.registration._id),
        }),
      ),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("paiement carte « pending » au-delà de 7 jours : inscription expirée, places rendues", async () => {
    await StripeConnectAccount.create({
      organizationId: String(workspaceId),
      accountId: "acct_vendeur",
      connectionType: "oauth",
      chargesEnabled: true,
    });
    stripeApi.checkout.sessions.create.mockResolvedValue({
      id: "cs_test_evt",
      url: "https://checkout.stripe.com/c/pay/cs_test_evt",
    });
    const type = await createEvent();
    const res = await register(type, { provider: "stripe" });
    expect(res.status).toBe(201);
    const registration = await EventRegistration.findOne({});
    await mongoose.connection.db.collection("event_registrations").updateOne(
      { _id: registration._id },
      {
        $set: {
          "payment.status": "pending",
          createdAt: new Date(Date.now() - 8 * DAY),
        },
      },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      id: "cs_test_evt",
      status: "complete",
      payment_status: "unpaid",
      metadata: {
        type: "event_registration",
        eventRegistrationId: String(registration._id),
      },
    });
    await sweepEventRegistrations({ now: new Date() });
    const after = await EventRegistration.findById(registration._id);
    expect(after.status).toBe("EXPIRED");
    expect(after.payment.status).toBe("expired_pending");
    expect((await AppointmentType.findById(type._id)).seatsTaken).toBe(0);
  });
});
