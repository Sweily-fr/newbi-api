/**
 * Billetterie, routes publiques /api/public/booking et paiement :
 * page d'un événement, inscription gratuite (billets, QR codes, e-mails),
 * places épuisées en concurrence, inscription payante vérifiée auprès de
 * Stripe (jamais confirmée sur un simple retour), webhook, expiration et
 * paiement tardif (confirmé ou remboursé), billet public, gestion par le
 * participant.
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
import BookingPage from "../../src/models/BookingPage.js";
import Client from "../../src/models/Client.js";
import EventRegistration from "../../src/models/EventRegistration.js";
import StripeConnectAccount from "../../src/models/StripeConnectAccount.js";
import publicBookingRoutes from "../../src/routes/publicBooking.js";
import { loadPublicPage } from "../../src/services/appointments/bookingService.js";
import {
  refreshRegistrationPayment,
  registerForEvent,
  sweepEventRegistrations,
} from "../../src/services/appointments/eventRegistrationService.js";
import { dispatchConnectEvent } from "../../src/controllers/stripeConnectWebhookController.js";

let server;
let baseUrl;
const hostId = buildUserId();
const workspaceId = buildOrganizationId();
let page;
let atelier;
let concert;

const DAY = 86400000;
const api = (path, options = {}) =>
  fetch(`${baseUrl}/api/public/booking${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

const registerBody = (overrides = {}) => ({
  buyer: {
    firstName: "Élise",
    lastName: "Martin",
    email: "elise@exemple.fr",
    phone: "0612345678",
  },
  quantity: 2,
  timezone: "Europe/Paris",
  turnstileToken: "jeton",
  website: "",
  ...overrides,
});

const paidSession = (registration, extra = {}) => ({
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
  customer_details: { email: "elise@exemple.fr" },
  ...extra,
});

/** Permet une nouvelle relecture immédiate chez le prestataire. */
const allowRecheck = (registration) =>
  EventRegistration.updateOne(
    { _id: registration._id },
    { $set: { "payment.checkedAt": null } },
  );

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EventRegistration.init(),
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
  stripeApi.checkout.sessions.create.mockReset();
  stripeApi.checkout.sessions.retrieve.mockReset();
  stripeApi.checkout.sessions.expire.mockReset();
  stripeApi.refunds.create.mockReset();
  stripeApi.checkout.sessions.create.mockResolvedValue({
    id: "cs_test_concert",
    url: "https://checkout.stripe.com/c/pay/cs_test_concert",
  });
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
  page = await BookingPage.create({
    workspaceId,
    userId: hostId,
    slug: "jean-dupont",
    title: "Jean Dupont",
  });
  const start = new Date(Date.now() + 3 * DAY);
  [atelier, concert] = await AppointmentType.create([
    {
      workspaceId,
      bookingPageId: page._id,
      userId: hostId,
      kind: "EVENT",
      slug: "atelier",
      name: "Atelier céramique",
      description: "Initiation",
      details: "Ligne 1\nLigne 2",
      durationMinutes: 120,
      startAt: start,
      endAt: new Date(start.getTime() + 2 * 3600000),
      location: { kind: "IN_PERSON", value: "12 rue des Arts, Paris" },
      capacity: 3,
      maxPerOrder: 3,
    },
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
      location: { kind: "CUSTOM_LINK", value: "https://live.exemple.fr/salle" },
      capacity: 2,
      maxPerOrder: 2,
      priceAmount: 1500,
      currency: "EUR",
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("page publique d'un événement", () => {
  it("liste et détail : places, prix, moyens de paiement ; pas de créneaux", async () => {
    const list = await (await api("/jean-dupont")).json();
    const ateliers = list.types.find((t) => t.slug === "atelier");
    expect(ateliers).toMatchObject({
      kind: "EVENT",
      event: {
        seatsLeft: 3,
        soldOut: false,
        registrationOpen: true,
        price: null,
      },
    });

    const detail = await (await api("/jean-dupont/atelier")).json();
    expect(detail.type.kind).toBe("EVENT");
    expect(detail.type.event).toMatchObject({
      details: "Ligne 1\nLigne 2",
      address: "12 rue des Arts, Paris",
      capacity: 3,
      seatsLeft: 3,
      maxPerOrder: 3,
      paymentMethods: [],
    });
    const paid = await (await api("/jean-dupont/concert")).json();
    expect(paid.type.locationLabel).toBe("En ligne");
    expect(paid.type.event).toMatchObject({
      price: { amount: 1500, currency: "EUR" },
      paymentMethods: ["stripe"],
      address: null,
    });

    expect((await api("/jean-dupont/atelier/slots")).status).toBe(404);
    expect(
      (await api("/jean-dupont/atelier/book", { method: "POST", body: {} }))
        .status,
    ).toBe(404);
  });

  it("événement passé : retiré de la liste, 404", async () => {
    await AppointmentType.updateOne(
      { _id: atelier._id },
      {
        startAt: new Date(Date.now() - 2 * DAY),
        endAt: new Date(Date.now() - DAY),
      },
    );
    const list = await (await api("/jean-dupont")).json();
    expect(list.types.map((t) => t.slug)).toEqual(["concert"]);
    expect((await api("/jean-dupont/atelier")).status).toBe(404);
  });
});

describe("inscription gratuite", () => {
  it("confirmée tout de suite : billets, QR codes, client CRM, e-mails", async () => {
    const res = await api("/jean-dupont/atelier/register", {
      method: "POST",
      body: registerBody(),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("CONFIRMED");
    expect(body.manageUrl).toMatch(
      /^https:\/\/www\.newbi\.fr\/rdv\/inscription\/[A-Za-z0-9_-]{43}$/,
    );
    expect(body.registration.tickets).toHaveLength(2);
    const [ticket] = body.registration.tickets;
    expect(ticket.number).toMatch(/^EVT-[A-HJ-NP-Z2-9]{6}$/);
    expect(ticket.attendeeName).toBe("Élise Martin");
    expect(ticket.url).toBe(`https://www.newbi.fr/rdv/billet/${ticket.token}`);
    expect(ticket.qrUrl).toBe(
      `https://api.newbi.fr/api/public/booking/tickets/${ticket.token}/qr.png`,
    );
    expect(body.registration.event).toMatchObject({
      name: "Atelier céramique",
      address: "12 rue des Arts, Paris",
      timezone: "Europe/Paris",
    });
    expect(body.registration.canCancel).toBe(true);

    expect((await AppointmentType.findById(atelier._id)).seatsTaken).toBe(2);
    const stored = await EventRegistration.findOne().lean();
    // Jetons jamais en clair
    expect(JSON.stringify(stored)).not.toContain(ticket.token);
    expect(stored.tickets[0].tokenHash).toHaveLength(64);

    await vi.waitFor(() => expect(mail.sent).toHaveLength(2));
    const guestMail = mail.sent.find((m) => m.to[0] === "elise@exemple.fr");
    expect(guestMail.subject).toContain("Vos billets");
    expect(guestMail.html).toContain(ticket.qrUrl);
    expect(guestMail.html).toContain(ticket.number);
    expect(guestMail.html).not.toContain("\u2014");
    expect(guestMail.attachments[0].filename).toBe("evenement.ics");
    const hostMail = mail.sent.find((m) => m.to[0] === "jean@cabinet.fr");
    expect(hostMail.subject).toContain("Nouvelle inscription");
    await vi.waitFor(async () =>
      expect(await Client.countDocuments({ email: "elise@exemple.fr" })).toBe(
        1,
      ),
    );

    // Billet public et QR code
    const ticketPage = await (await api(`/tickets/${ticket.token}`)).json();
    expect(ticketPage).toMatchObject({
      status: "VALID",
      number: ticket.number,
      attendeeName: "Élise Martin",
      typeSlug: "atelier",
    });
    const qr = await api(`/tickets/${ticket.token}/qr.png`);
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await qr.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    expect((await api(`/tickets/${"x".repeat(43)}`)).status).toBe(404);

    // Lien de gestion
    const token = body.manageUrl.split("/").pop();
    const managed = await (await api(`/registrations/${token}`)).json();
    expect(managed.tickets.map((t) => t.number)).toEqual(
      body.registration.tickets.map((t) => t.number),
    );
    const ics = await api(`/registrations/${token}/ics`);
    expect(await ics.text()).toContain("BEGIN:VEVENT");
  });

  it("refus de saisie : quantité, nom, e-mail", async () => {
    const res = await api("/jean-dupont/atelier/register", {
      method: "POST",
      body: registerBody({
        quantity: 4,
        buyer: { firstName: "", lastName: "M", email: "pas-un-mail" },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("VALIDATION");
    expect(Object.keys(body.fields).sort()).toEqual([
      "email",
      "firstName",
      "quantity",
    ]);
    expect(body.fields.quantity).toBe("Choisissez entre 1 et 3 places.");
    expect(await EventRegistration.countDocuments()).toBe(0);
  });

  it("inscriptions closes : 409 REGISTRATION_CLOSED", async () => {
    await AppointmentType.updateOne(
      { _id: atelier._id },
      { registrationClosesAt: new Date(Date.now() - 60000) },
    );
    const res = await api("/jean-dupont/atelier/register", {
      method: "POST",
      body: registerBody(),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "REGISTRATION_CLOSED" });
  });

  it("places épuisées en concurrence : jamais de survente", async () => {
    const context = await loadPublicPage("jean-dupont");
    const type = await AppointmentType.findById(atelier._id).lean();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        registerForEvent({
          context,
          type,
          buyer: {
            firstName: "Participant",
            lastName: `N${i}`,
            email: `p${i}@exemple.fr`,
          },
          quantity: 1,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(3);
    expect(refused).toHaveLength(5);
    expect(refused.every((r) => r.reason.code === "SOLD_OUT")).toBe(true);
    expect((await AppointmentType.findById(atelier._id)).seatsTaken).toBe(3);
    expect(
      await EventRegistration.countDocuments({ status: "CONFIRMED" }),
    ).toBe(3);

    const res = await api("/jean-dupont/atelier/register", {
      method: "POST",
      body: registerBody({ quantity: 1 }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "SOLD_OUT", seatsLeft: 0 });
  });

  it("annulation par le participant : places rendues, e-mails", async () => {
    const body = await (
      await api("/jean-dupont/atelier/register", {
        method: "POST",
        body: registerBody(),
      })
    ).json();
    const token = body.manageUrl.split("/").pop();
    await vi.waitFor(() => expect(mail.sent).toHaveLength(2));
    mail.sent = [];
    const res = await api(`/registrations/${token}/cancel`, {
      method: "POST",
      body: { reason: "Empêchement" },
    });
    expect(await res.json()).toEqual({ status: "CANCELLED" });
    expect((await AppointmentType.findById(atelier._id)).seatsTaken ?? 0).toBe(
      0,
    );
    await vi.waitFor(() => expect(mail.sent).toHaveLength(2));
    const ticketToken = body.registration.tickets[0].token;
    const ticket = await (await api(`/tickets/${ticketToken}`)).json();
    expect(ticket.status).toBe("CANCELLED");
  });
});

describe("inscription payante", () => {
  async function startPaid() {
    const res = await api("/jean-dupont/concert/register", {
      method: "POST",
      body: registerBody({ provider: "stripe" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const [params, options] = stripeApi.checkout.sessions.create.mock.calls[0];
    const returnToken = new URL(params.success_url).searchParams.get("rt");
    return { body, params, options, returnToken };
  }

  it("paiement sur le compte du vendeur, sans commission ; retour non payé refusé, payé confirmé", async () => {
    const { body, params, options, returnToken } = await startPaid();
    expect(body).toMatchObject({
      status: "PENDING_PAYMENT",
      paymentUrl: "https://checkout.stripe.com/c/pay/cs_test_concert",
    });
    expect(options.stripeAccount).toBe("acct_vendeur");
    expect(params.payment_intent_data.application_fee_amount).toBeUndefined();
    expect(params.line_items[0].price_data.unit_amount).toBe(3000);
    expect(params.success_url).toMatch(
      /^https:\/\/www\.newbi\.fr\/rdv\/jean-dupont\/concert\/retour\?rt=[A-Za-z0-9_-]{43}&provider=stripe&session_id=\{CHECKOUT_SESSION_ID\}$/,
    );
    expect((await AppointmentType.findById(concert._id)).seatsTaken).toBe(2);
    const registration = await EventRegistration.findOne();
    expect(registration.status).toBe("PENDING_PAYMENT");
    expect(registration.tickets).toHaveLength(0);

    // Retour sans paiement : rien n'est confirmé
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...paidSession(registration),
      status: "open",
      payment_status: "unpaid",
    });
    const unpaid = await (
      await api("/registrations/return", {
        method: "POST",
        body: { returnToken, provider: "stripe", sessionId: "cs_test_concert" },
      })
    ).json();
    expect(unpaid.paymentStatus).toBe("unpaid");
    expect(unpaid.registration.status).toBe("PENDING_PAYMENT");
    expect(unpaid.registration.tickets).toEqual([]);
    expect(unpaid.manageUrl).toBeNull();

    // Montant différent : refusé
    await allowRecheck(registration);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      paidSession(registration, { amount_total: 100 }),
    );
    const wrong = await (
      await api("/registrations/return", {
        method: "POST",
        body: { returnToken, provider: "stripe", sessionId: "cs_test_concert" },
      })
    ).json();
    expect(wrong.registration.status).toBe("PENDING_PAYMENT");

    // Payé : confirmé avec ses billets
    await allowRecheck(registration);
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      paidSession(registration),
    );
    const paid = await (
      await api("/registrations/return", {
        method: "POST",
        body: { returnToken, provider: "stripe", sessionId: "cs_test_concert" },
      })
    ).json();
    expect(paid.paymentStatus).toBe("paid");
    expect(paid.registration.status).toBe("CONFIRMED");
    expect(paid.registration.tickets).toHaveLength(2);
    expect(paid.registration.event.link).toBe("https://live.exemple.fr/salle");
    expect(paid.registration.canCancel).toBe(false);
    expect(paid.manageUrl).toMatch(/\/rdv\/inscription\//);
    expect(stripeApi.checkout.sessions.retrieve).toHaveBeenLastCalledWith(
      "cs_test_concert",
      { stripeAccount: "acct_vendeur" },
    );
    const stored = await EventRegistration.findById(registration._id);
    expect(stored.payment.paymentId).toBe("pi_concert");

    // Le participant ne peut pas annuler une inscription payante
    const token = paid.manageUrl.split("/").pop();
    const cancel = await api(`/registrations/${token}/cancel`, {
      method: "POST",
      body: {},
    });
    expect(cancel.status).toBe(409);
    expect(await cancel.json()).toEqual({ error: "NOT_ALLOWED" });
  });

  it("jeton de retour inconnu : 404", async () => {
    const res = await api("/registrations/return", {
      method: "POST",
      body: { returnToken: "a".repeat(43), provider: "stripe" },
    });
    expect(res.status).toBe(404);
  });

  it("moyen de paiement absent ou non connecté : refusé", async () => {
    const missing = await api("/jean-dupont/concert/register", {
      method: "POST",
      body: registerBody(),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).fields.provider).toBeTruthy();
    const paypal = await api("/jean-dupont/concert/register", {
      method: "POST",
      body: registerBody({ provider: "paypal" }),
    });
    expect(paypal.status).toBe(409);
    expect(await paypal.json()).toEqual({
      error: "PAYMENT_METHOD_UNAVAILABLE",
    });
    expect((await AppointmentType.findById(concert._id)).seatsTaken ?? 0).toBe(
      0,
    );
  });

  it("prestataire injoignable : places rendues, 502", async () => {
    stripeApi.checkout.sessions.create.mockRejectedValue(new Error("panne"));
    const res = await api("/jean-dupont/concert/register", {
      method: "POST",
      body: registerBody({ provider: "stripe" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "PAYMENT_START_FAILED" });
    expect((await AppointmentType.findById(concert._id)).seatsTaken ?? 0).toBe(
      0,
    );
  });

  it("webhook Stripe Connect : confirme ; une session d'un autre compte est ignorée", async () => {
    await startPaid();
    const registration = await EventRegistration.findOne();
    const foreign = await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_autre",
      data: { object: paidSession(registration) },
    });
    expect(foreign.status).toBe("ignored");
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "PENDING_PAYMENT",
    );
    const result = await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: { object: paidSession(registration) },
    });
    expect(result.status).toBe("success");
    const confirmed = await EventRegistration.findById(registration._id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.tickets).toHaveLength(2);
    // Vu deux fois (retour + webhook) : e-mails une seule fois
    await dispatchConnectEvent({
      type: "checkout.session.completed",
      account: "acct_vendeur",
      data: { object: paidSession(registration) },
    });
    await vi.waitFor(() => expect(mail.sent).toHaveLength(2));
    expect(
      (await EventRegistration.findById(registration._id)).tickets,
    ).toHaveLength(2);
  });

  it("expiration : places rendues après 30 min, session fermée", async () => {
    await startPaid();
    const registration = await EventRegistration.findOne();
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...paidSession(registration),
      status: "open",
      payment_status: "unpaid",
    });
    const result = await sweepEventRegistrations();
    expect(result.expired).toBe(1);
    expect((await EventRegistration.findById(registration._id)).status).toBe(
      "EXPIRED",
    );
    expect((await AppointmentType.findById(concert._id)).seatsTaken ?? 0).toBe(
      0,
    );
    expect(stripeApi.checkout.sessions.expire).toHaveBeenCalledWith(
      "cs_test_concert",
      { stripeAccount: "acct_vendeur" },
    );
  });

  it("paiement après expiration : confirmé s'il reste des places", async () => {
    await startPaid();
    const registration = await EventRegistration.findOne();
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...paidSession(registration),
      status: "open",
      payment_status: "unpaid",
    });
    await sweepEventRegistrations();
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      paidSession(registration),
    );
    await allowRecheck(registration);
    const expired = await EventRegistration.findById(registration._id);
    await refreshRegistrationPayment(expired, { force: true });
    const confirmed = await EventRegistration.findById(registration._id);
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.seatsHeld).toBe(true);
    expect((await AppointmentType.findById(concert._id)).seatsTaken).toBe(2);
    expect(stripeApi.refunds.create).not.toHaveBeenCalled();
  });

  it("paiement après expiration sans place : remboursé", async () => {
    await startPaid();
    const registration = await EventRegistration.findOne();
    await EventRegistration.updateOne(
      { _id: registration._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue({
      ...paidSession(registration),
      status: "open",
      payment_status: "unpaid",
    });
    await sweepEventRegistrations();
    // Places reprises par quelqu'un d'autre
    await AppointmentType.updateOne(
      { _id: concert._id },
      { $set: { seatsTaken: 2 } },
    );
    stripeApi.checkout.sessions.retrieve.mockResolvedValue(
      paidSession(registration),
    );
    stripeApi.refunds.create.mockResolvedValue({ id: "re_1" });
    await allowRecheck(registration);
    await refreshRegistrationPayment(
      await EventRegistration.findById(registration._id),
      { force: true },
    );
    const late = await EventRegistration.findById(registration._id);
    expect(late.status).toBe("EXPIRED");
    expect(late.payment.refundedAt).toBeInstanceOf(Date);
    expect(late.tickets).toHaveLength(0);
    expect(stripeApi.refunds.create).toHaveBeenCalledWith(
      expect.objectContaining({ payment_intent: "pi_concert" }),
      expect.objectContaining({ stripeAccount: "acct_vendeur" }),
    );
  });
});
