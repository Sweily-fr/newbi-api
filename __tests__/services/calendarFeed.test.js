/**
 * Lien d'abonnement au calendrier : jeton par utilisateur et par espace,
 * fichier .ics servi sans session avec les droits recalculés à chaque
 * lecture (membre retiré, lien régénéré ou désactivé : 404).
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
  process.env.CALENDAR_ENCRYPTION_KEY ||= "cle-de-test-agenda";
  process.env.BACKEND_URL = "https://api.example.test";
  process.env.FRONTEND_URL = "https://www.newbi.fr";
});

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";
import ical from "node-ical";
import { buildASTSchema, defaultFieldResolver, graphql } from "graphql";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import {
  recordAttempt,
  resetMemoryAttempts,
} from "../../src/utils/attemptLimiter.js";
import Event from "../../src/models/Event.js";
import Invoice from "../../src/models/Invoice.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import CalendarFeedToken, {
  hashFeedToken,
} from "../../src/models/CalendarFeedToken.js";
import calendarFeedRoutes, {
  FEED_RATE_MAX,
  FEED_RATE_WINDOW_SECONDS,
} from "../../src/routes/calendarFeed.js";
import calendarFeedResolvers from "../../src/resolvers/calendarFeed.js";
import notificationPreferencesResolvers from "../../src/resolvers/notificationPreferences.js";
import {
  buildCalendarFeed,
  findCalendarFeed,
} from "../../src/services/calendar/calendarFeedService.js";
import {
  addDays,
  parisDay,
} from "../../src/utils/invoiceRecurrenceSchedule.js";
import typeDefs from "../../src/schemas/index.js";

const owner = buildUserId();
const colleague = buildUserId();
const workspaceId = buildOrganizationId();
const otherWorkspaceId = buildOrganizationId();
// Mercredi 28 octobre 2026, 10 h à Paris (contenu du calendrier)
const NOW = new Date("2026-10-28T09:00:00Z");

let server;
let baseUrl;

const context = (userId = owner, organizationId = workspaceId) =>
  buildContext({
    userId,
    organizationId,
    extra: { db: mongoose.connection.db },
  });
const info = (fieldName) => ({ fieldName });

const readLink = (userId, organizationId) =>
  calendarFeedResolvers.Query.calendarFeedLink(
    null,
    {},
    context(userId, organizationId),
    info("calendarFeedLink"),
  );
const regenerate = (userId, organizationId) =>
  calendarFeedResolvers.Mutation.regenerateCalendarFeedLink(
    null,
    {},
    context(userId, organizationId),
    info("regenerateCalendarFeedLink"),
  );
const disable = (userId, organizationId) =>
  calendarFeedResolvers.Mutation.disableCalendarFeedLink(
    null,
    {},
    context(userId, organizationId),
    info("disableCalendarFeedLink"),
  );

const tokenOf = (url) =>
  url.match(/\/calendar\/feed\/([A-Za-z0-9_-]{43})\.ics$/)[1];
const fetchFeed = (url) =>
  fetch(url.replace("https://api.example.test", baseUrl));

async function readFeed(url) {
  const res = await fetchFeed(url);
  expect(res.status).toBe(200);
  const text = await res.text();
  const events = Object.values(ical.sync.parseICS(text)).filter(
    (c) => c.type === "VEVENT",
  );
  return { res, text, events, summaries: events.map((e) => e.summary) };
}

// Contenu servi à une date fixée (le fichier est recalculé à chaque lecture)
async function feedContent(url, now = NOW) {
  const feed = await findCalendarFeed(tokenOf(url));
  const result = await buildCalendarFeed(feed, { now });
  expect(result).not.toBeNull();
  const events = Object.values(ical.sync.parseICS(result.ics)).filter(
    (c) => c.type === "VEVENT",
  );
  return {
    text: result.ics.replace(/\r\n /g, ""),
    events,
    summaries: events.map((e) => String(e.summary).replace(/\s/g, " ")),
  };
}

async function seedUser(userId, fields = {}) {
  await mongoose.connection.db.collection("user").insertOne({
    _id: userId,
    email: `${userId}@test.fr`,
    name: "Léa Martin",
    emailVerified: true,
    ...fields,
  });
}

async function setRole(userId, role) {
  await mongoose.connection.db
    .collection("member")
    .updateOne({ userId, organizationId: workspaceId }, { $set: { role } });
  invalidateOrganizationRoles();
  invalidateOrgCache();
}

async function setCustomRole(userId, role, actions) {
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne(
      { organizationId: workspaceId, role },
      { $set: { actions, name: role, permission: "{}" } },
      { upsert: true },
    );
  await setRole(userId, role);
}

// Jour de Paris décalé de `days` par rapport à NOW (contenu) ou à
// aujourd'hui (lecture par la route), à midi UTC
const dayAt = (days, from = NOW) =>
  new Date(`${addDays(parisDay(from), days)}T12:00:00Z`);
const dayFromToday = (days) => dayAt(days, new Date());

async function insertInvoice(fields = {}) {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId,
    prefix: "F-202610",
    number: "0001",
    status: "PENDING",
    finalTotalTTC: 1200,
    client: { name: "Atelier Lumière", type: "COMPANY" },
    dueDate: dayAt(5),
    ...fields,
  });
  return insertedId;
}

async function insertEvent(fields = {}) {
  const start = fields.start || dayAt(3);
  const { insertedId } = await Event.collection.insertOne({
    workspaceId,
    userId: owner,
    title: "Réunion client",
    start,
    end: new Date(start.getTime() + 60 * 60 * 1000),
    allDay: false,
    type: "MANUAL",
    source: "newbi",
    visibility: "workspace",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return insertedId;
}

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/calendar/feed", calendarFeedRoutes);
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
  invalidateOrganizationRoles();
  resetMemoryAttempts();
  await seedUser(owner);
  await seedUser(colleague, { name: "Sam Petit" });
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Studio Nord",
  });
});

describe("gestion du lien (GraphQL)", () => {
  it("désactivé par défaut, puis créé avec une adresse secrète", async () => {
    expect(await readLink()).toMatchObject({ enabled: false, url: null });

    const created = await regenerate();

    expect(created.enabled).toBe(true);
    expect(created.url).toMatch(
      /^https:\/\/api\.example\.test\/calendar\/feed\/[A-Za-z0-9_-]{43}\.ics$/,
    );
    expect(created.lastAccessedAt).toBeNull();
    expect((await readLink()).url).toBe(created.url);
  });

  it("stocke le jeton haché et chiffré, jamais en clair", async () => {
    const { url } = await regenerate();
    const token = tokenOf(url);

    const doc = await CalendarFeedToken.findOne({ userId: owner }).lean();

    expect(doc.tokenHash).toBe(
      crypto.createHash("sha256").update(token).digest("hex"),
    );
    expect(doc.tokenEncrypted).not.toContain(token);
    expect(JSON.stringify(doc)).not.toContain(token);
  });

  it("un lien par utilisateur et par espace", async () => {
    await seedOrgMembership({
      userId: colleague,
      organizationId: workspaceId,
      role: "viewer",
    });
    await seedOrgMembership({
      userId: owner,
      organizationId: otherWorkspaceId,
      role: "owner",
    });

    const mine = await regenerate();
    const theirs = await regenerate(colleague);
    const otherSpace = await regenerate(owner, otherWorkspaceId);

    expect(new Set([mine.url, theirs.url, otherSpace.url]).size).toBe(3);
    expect(await CalendarFeedToken.countDocuments()).toBe(3);
  });

  it("refuse un espace dont on n'est pas membre", async () => {
    await expect(regenerate(owner, otherWorkspaceId)).rejects.toThrow();
    await expect(readLink(owner, otherWorkspaceId)).rejects.toThrow();
  });

  it("refuse un rôle sans accès au calendrier", async () => {
    await seedOrgMembership({
      userId: colleague,
      organizationId: workspaceId,
      role: "viewer",
    });
    await setCustomRole(colleague, "role_sans_agenda", {});

    await expect(regenerate(colleague)).rejects.toThrow(
      "Vous n'avez pas la permission",
    );
  });
});

describe("lecture du fichier .ics", () => {
  it("sert un calendrier privé, jamais mis en cache", async () => {
    await insertEvent({ start: dayFromToday(3) });
    const { url } = await regenerate();

    const { res, text, summaries } = await readFeed(url);

    expect(res.headers.get("content-type")).toMatch(/^text\/calendar/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(text.replace(/\r\n /g, "")).toContain(
      "X-WR-CALNAME:Newbi - Studio Nord",
    );
    expect(summaries).toEqual(["Réunion client"]);
  });

  it("note la dernière lecture", async () => {
    const { url } = await regenerate();
    await readFeed(url);

    await vi.waitFor(async () => {
      expect((await readLink()).lastAccessedAt).toBeInstanceOf(Date);
    });
  });

  it("jeton régénéré ou désactivé : l'ancienne adresse renvoie 404", async () => {
    const first = await regenerate();
    const second = await regenerate();

    expect((await fetchFeed(first.url)).status).toBe(404);
    expect((await fetchFeed(second.url)).status).toBe(200);

    expect(await disable()).toMatchObject({ enabled: false, url: null });
    expect((await fetchFeed(second.url)).status).toBe(404);
  });

  it("membre retiré de l'espace : 404 aussitôt", async () => {
    const { url } = await regenerate();
    expect((await fetchFeed(url)).status).toBe(200);

    await mongoose.connection.db
      .collection("member")
      .deleteOne({ userId: owner, organizationId: workspaceId });

    expect((await fetchFeed(url)).status).toBe(404);
  });

  it("rôle qui ne voit plus le calendrier, compte banni ou supprimé : 404", async () => {
    await seedOrgMembership({
      userId: colleague,
      organizationId: workspaceId,
      role: "viewer",
    });
    const { url } = await regenerate(colleague);
    expect((await fetchFeed(url)).status).toBe(200);

    await setCustomRole(colleague, "role_sans_agenda", { invoices: ["view"] });
    expect((await fetchFeed(url)).status).toBe(404);

    const ownerLink = await regenerate();
    await mongoose.connection.db
      .collection("user")
      .updateOne({ _id: owner }, { $set: { banned: true } });
    expect((await fetchFeed(ownerLink.url)).status).toBe(404);

    await mongoose.connection.db.collection("user").deleteOne({ _id: owner });
    expect((await fetchFeed(ownerLink.url)).status).toBe(404);
  });

  it("adresse mal formée ou inconnue : 404 identique", async () => {
    const unknown = await fetch(
      `${baseUrl}/calendar/feed/${"a".repeat(43)}.ics`,
    );
    const malformed = await fetch(`${baseUrl}/calendar/feed/abc.ics`);

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await unknown.text()).toBe(await malformed.text());
  });

  it("limite les lectures d'un même lien", async () => {
    const { url } = await regenerate();
    for (let i = 0; i < FEED_RATE_MAX; i += 1) {
      await recordAttempt(
        `calendar-feed:${hashFeedToken(tokenOf(url))}`,
        FEED_RATE_WINDOW_SECONDS,
      );
    }

    const res = await fetchFeed(url);

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(
      String(FEED_RATE_WINDOW_SECONDS),
    );
  });
});

describe("contenu du calendrier", () => {
  it("événements de l'espace et privés à soi, jamais ceux des agendas externes", async () => {
    await insertEvent({ title: "Point d'équipe" });
    await insertEvent({ title: "Note privée", visibility: "private" });
    await insertEvent({
      title: "Privé d'un collègue",
      visibility: "private",
      userId: colleague,
    });
    await insertEvent({
      title: "Copie Google",
      source: "google",
      visibility: "private",
    });
    await insertEvent({ title: "Autre espace", workspaceId: otherWorkspaceId });
    const { url } = await regenerate();

    const { summaries } = await feedContent(url);

    expect(summaries.sort()).toEqual(["Note privée", "Point d'équipe"]);
  });

  it("journée entière : jours de Paris, fin exclue", async () => {
    // Saisie dans le navigateur à Paris : 00:00 → 23:59:59 le lendemain
    await insertEvent({
      title: "Salon",
      allDay: true,
      start: new Date("2026-11-04T23:00:00Z"),
      end: new Date("2026-11-06T22:59:59.999Z"),
    });
    const { url } = await regenerate();

    const { text, events } = await feedContent(url);

    expect(events).toHaveLength(1);
    expect(text).toContain("DTSTART;VALUE=DATE:20261105\r\n");
    expect(text).toContain("DTEND;VALUE=DATE:20261107\r\n");
  });

  it("échéances des factures avec leur libellé, copie d'échéance masquée", async () => {
    const invoiceId = await insertInvoice();
    await insertEvent({
      title: "Échéance facture F-202610-0001",
      type: "INVOICE_DUE",
      allDay: true,
      invoiceId,
    });
    await insertEvent({
      title: "Échéance enrichie",
      type: "INVOICE_DUE",
      allDay: true,
      assignedMembers: [String(colleague)],
    });
    const { url } = await regenerate();

    const { events, summaries } = await feedContent(url);

    expect(summaries.sort()).toEqual([
      "Facture à encaisser · Atelier Lumière · 1 200 €",
      "Échéance enrichie",
    ]);
    const invoice = events.find((e) => e.summary.startsWith("Facture"));
    expect(invoice.uid).toBe(`newbi-invoice-${invoiceId}@newbi.fr`);
    expect(invoice.datetype).toBe("date");
    expect(invoice.url).toBe(
      `https://www.newbi.fr/dashboard/outils/factures?id=${invoiceId}`,
    );
    expect(invoice.description).toContain("Ouvrir dans Newbi");
  });

  it("chaque source suit le droit « Voir » de sa page", async () => {
    await seedOrgMembership({
      userId: colleague,
      organizationId: workspaceId,
      role: "viewer",
    });
    await insertInvoice();
    await insertEvent({ title: "Point d'équipe" });
    await insertEvent({
      title: "Échéance enrichie",
      type: "INVOICE_DUE",
      allDay: true,
      assignedMembers: [String(owner)],
    });
    const { insertedId: boardId } = await Board.collection.insertOne({
      workspaceId,
      userId: owner,
      title: "Site vitrine",
      members: [],
    });
    const { insertedId: columnId } = await Column.collection.insertOne({
      workspaceId,
      boardId,
      title: "En cours",
    });
    await Task.collection.insertOne({
      workspaceId,
      boardId,
      columnId: String(columnId),
      title: "Maquettes",
      status: "todo",
      dueDate: dayAt(4),
    });
    const { url } = await regenerate(colleague);

    // Calendrier seul : ni factures, ni copie d'échéance, ni tâches
    await setCustomRole(colleague, "role_agenda", { calendar: ["view"] });
    expect((await feedContent(url)).summaries).toEqual(["Point d'équipe"]);

    // Comptable : factures oui, projets non
    await setRole(colleague, "accountant");
    const accountant = (await feedContent(url)).summaries;
    expect(accountant.sort()).toEqual([
      "Facture à encaisser · Atelier Lumière · 1 200 €",
      "Point d'équipe",
      "Échéance enrichie",
    ]);

    // Membre (lecture partout) : les tâches arrivent aussi
    await setRole(colleague, "viewer");
    expect((await feedContent(url)).summaries).toContain("Tâche · Maquettes");
  });

  it("fenêtre de 60 jours passés à un an à venir, lue par tranches", async () => {
    await insertInvoice({ number: "0001", dueDate: dayAt(-30) });
    await insertInvoice({ number: "0002", dueDate: dayAt(-70) });
    await insertInvoice({ number: "0003", dueDate: dayAt(150) });
    await insertInvoice({ number: "0004", dueDate: dayAt(330) });
    await insertInvoice({ number: "0005", dueDate: dayAt(400) });
    const { url } = await regenerate();

    const { events } = await feedContent(url);

    expect(
      events.map((e) => e.description.match(/F-202610-(\d+)/)[1]).sort(),
    ).toEqual(["0001", "0003", "0004"]);
  });
});

describe("préférence du récap du lundi", () => {
  const readDigest = () =>
    calendarFeedResolvers.Query.calendarWeeklyDigest(null, {}, context());
  const setDigest = (enabled) =>
    calendarFeedResolvers.Mutation.setCalendarWeeklyDigest(
      null,
      { enabled },
      context(),
    );
  const preferences = () =>
    notificationPreferencesResolvers.Query.getNotificationPreferences(
      null,
      {},
      context(),
    );

  it("désactivée par défaut, partout", async () => {
    expect(await readDigest()).toBe(false);
    expect((await preferences()).calendar_weekly_digest).toEqual({
      email: false,
      push: false,
    });
  });

  it("même clé que l'écran des notifications, dans les deux sens", async () => {
    expect(await setDigest(true)).toBe(true);
    expect(await readDigest()).toBe(true);
    expect((await preferences()).calendar_weekly_digest.email).toBe(true);

    await notificationPreferencesResolvers.Mutation.updateNotificationPreferences(
      null,
      { input: { calendar_weekly_digest: { email: false } } },
      context(),
    );
    expect(await readDigest()).toBe(false);
  });

  it("refuse un appel sans session", async () => {
    expect(() =>
      calendarFeedResolvers.Query.calendarWeeklyDigest(null, {}, {}),
    ).toThrow("Vous devez être connecté");
  });
});

describe("schéma GraphQL", () => {
  const schema = buildASTSchema(typeDefs, { assumeValidSDL: true });

  it("expose l'état du lien et ses mutations", async () => {
    const res = await graphql({
      schema,
      source: `mutation { regenerateCalendarFeedLink { enabled url createdAt lastAccessedAt } }`,
      contextValue: context(),
      fieldResolver: (parent, args, ctx, resolveInfo) => {
        const resolver =
          calendarFeedResolvers[resolveInfo.parentType.name]?.[
            resolveInfo.fieldName
          ];
        return resolver
          ? resolver(parent, args, ctx, resolveInfo)
          : defaultFieldResolver(parent, args, ctx, resolveInfo);
      },
    });

    expect(res.errors).toBeUndefined();
    expect(res.data.regenerateCalendarFeedLink.enabled).toBe(true);
    expect(
      schema.getType("NotificationPreferences").getFields(),
    ).toHaveProperty("calendar_weekly_digest");
  });
});
