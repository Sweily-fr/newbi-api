/**
 * Calendrier : ce qu'un membre ne voit pas, il ne le touche pas.
 *
 *   - L'événement privé d'un autre membre (rendez-vous pris sur sa page de
 *     réservation compris) n'est ni modifié, ni supprimé, ni envoyé vers un
 *     agenda externe : « Événement non trouvé », comme à la lecture.
 *   - Sans « Voir » des factures, une échéance de facture n'est ni modifiée
 *     (ni transformée en événement ordinaire), ni supprimée, ni envoyée.
 *   - Les membres assignés sont des membres de l'espace : l'id d'un
 *     utilisateur d'une autre entreprise est écarté, et son nom ni son
 *     e-mail ne sont jamais renvoyés.
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

// Requise au chargement du modèle CalendarConnection (importé par event.js)
vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
});
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
  cleanupWebhookForConnection: vi.fn(),
  registerWebhookForConnection: vi.fn(),
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  pushEventToCalendar: vi.fn(async () => ({})),
  autoPushEventToConnections: vi.fn(async () => {}),
  updateEventInExternalCalendars: vi.fn(async () => {}),
  deleteEventFromExternalCalendars: vi.fn(async () => {}),
  syncConnection: vi.fn(async () => {}),
  disconnectCalendar: vi.fn(async () => {}),
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Event from "../../src/models/Event.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import eventResolvers from "../../src/resolvers/event.js";
import calendarConnectionResolvers from "../../src/resolvers/calendarConnection.js";
import { pushEventToCalendar } from "../../src/services/calendar/CalendarSyncService.js";

const { Query, Mutation } = eventResolvers;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
const admin = buildUserId();
const noInvoices = buildUserId();
const outsider = buildUserId();
const ROLE_SANS_FACTURES = "role_agenda_sans_factures";

const ws = () => String(workspaceId);
const ctx = (userId) => buildContext({ userId, organizationId: ws() });
const info = (fieldName) => ({ fieldName });
const day = new Date("2026-11-20T09:00:00Z");

async function seedEvent(fields = {}) {
  const _id = new mongoose.Types.ObjectId();
  await Event.collection.insertOne({
    _id,
    title: "Événement",
    type: "MANUAL",
    start: day,
    end: day,
    workspaceId,
    userId: owner,
    visibility: "workspace",
    source: "newbi",
    assignedMembers: [],
    externalCalendarLinks: [],
    ...fields,
  });
  return String(_id);
}

const snapshot = (id) =>
  Event.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

const update = (userId, input) =>
  Mutation.updateEvent(
    null,
    { input, workspaceId: ws() },
    ctx(userId),
    info("updateEvent"),
  );
const remove = (userId, id) =>
  Mutation.deleteEvent(
    null,
    { id, workspaceId: ws() },
    ctx(userId),
    info("deleteEvent"),
  );

async function seedConnection(userId) {
  const { insertedId } = await CalendarConnection.collection.insertOne({
    userId,
    provider: "google",
    status: "active",
    accessToken: "x",
    refreshToken: "y",
    selectedCalendars: [],
    externalCalendarLinks: [],
    autoSync: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(insertedId);
}
const push = (userId, eventId, connectionId) =>
  calendarConnectionResolvers.Mutation.pushEventToCalendar(
    null,
    { input: { eventId, connectionId } },
    ctx(userId),
    info("pushEventToCalendar"),
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: editor,
    organizationId: workspaceId,
    role: "member",
  });
  await seedOrgMembership({
    userId: admin,
    organizationId: workspaceId,
    role: "admin",
  });
  await seedOrgMembership({
    userId: noInvoices,
    organizationId: workspaceId,
    role: ROLE_SANS_FACTURES,
  });
  await seedOrgMembership({
    userId: outsider,
    organizationId: otherWorkspace,
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE_SANS_FACTURES,
    name: "Agenda sans factures",
    permission: "{}",
    actions: { calendar: ["view", "create", "edit", "delete"] },
    createdAt: new Date(),
  });
  await mongoose.connection.db.collection("user").insertMany([
    { _id: editor, name: "Eli Agenda", email: "eli@agenda.test" },
    { _id: outsider, name: "Ivan Intrus", email: "ivan@intrus.test" },
  ]);
  invalidateOrganizationRoles();
  invalidateOrgCache();
});

describe("Événement privé d'un autre membre", () => {
  it("l'Éditeur ne le modifie pas : introuvable, base inchangée", async () => {
    const id = await seedEvent({ visibility: "private", title: "Bilan privé" });
    const before = await snapshot(id);

    const result = await update(editor, { id, title: "Modifié" });

    expect(result.success).toBe(false);
    expect(result.message).toBe("Événement non trouvé");
    expect(await snapshot(id)).toEqual(before);
  });

  it("le rendez-vous de l'organisateur reste introuvable, sans révéler qu'il s'agit d'un rendez-vous", async () => {
    const id = await seedEvent({
      visibility: "private",
      type: "APPOINTMENT",
      description: "Invitée : zoe@client.test",
    });

    const result = await update(editor, { id, title: "Déplacé" });

    expect(result).toMatchObject({
      success: false,
      message: "Événement non trouvé",
    });
  });

  it("l'Administrateur ne le supprime pas", async () => {
    const id = await seedEvent({ visibility: "private" });

    const result = await remove(admin, id);

    expect(result).toMatchObject({
      success: false,
      message: "Événement non trouvé",
    });
    expect(await snapshot(id)).toBeTruthy();
  });

  it("l'Éditeur ne l'envoie pas vers son propre agenda", async () => {
    const id = await seedEvent({ visibility: "private", type: "APPOINTMENT" });
    const connectionId = await seedConnection(editor);

    const result = await push(editor, id, connectionId);

    expect(result).toMatchObject({
      success: false,
      message: "Événement non trouvé",
    });
    expect(pushEventToCalendar).not.toHaveBeenCalled();
  });

  it("son auteur le modifie, le supprime et l'envoie", async () => {
    const id = await seedEvent({ visibility: "private", userId: admin });
    const connectionId = await seedConnection(admin);

    const updated = await update(admin, { id, title: "Relu" });
    expect(updated.success).toBe(true);
    expect((await snapshot(id)).title).toBe("Relu");

    const pushed = await push(admin, id, connectionId);
    expect(pushed.success).toBe(true);
    expect(pushEventToCalendar).toHaveBeenCalledTimes(1);

    const removed = await remove(admin, id);
    expect(removed.success).toBe(true);
    expect(await snapshot(id)).toBeNull();
  });

  it("un événement de l'espace reste modifiable par l'Éditeur", async () => {
    const id = await seedEvent({ title: "Point mensuel" });

    const result = await update(editor, {
      id,
      title: "Point mensuel (déplacé)",
    });

    expect(result.success).toBe(true);
    expect((await snapshot(id)).title).toBe("Point mensuel (déplacé)");
  });
});

describe("Échéance de facture et rôle sans « Voir » des factures", () => {
  it("n'est pas transformée en événement ordinaire", async () => {
    const id = await seedEvent({
      type: "INVOICE_DUE",
      title: "F-0001 1 200 €",
    });
    const before = await snapshot(id);

    const result = await update(noInvoices, {
      id,
      type: "MANUAL",
      title: "Réunion",
    });

    expect(result).toMatchObject({
      success: false,
      message: "Événement non trouvé",
    });
    expect(await snapshot(id)).toEqual(before);
  });

  it("n'est ni supprimée ni envoyée", async () => {
    const id = await seedEvent({ type: "INVOICE_DUE" });
    const connectionId = await seedConnection(noInvoices);

    expect((await remove(noInvoices, id)).success).toBe(false);
    expect((await push(noInvoices, id, connectionId)).success).toBe(false);
    expect(await snapshot(id)).toBeTruthy();
    expect(pushEventToCalendar).not.toHaveBeenCalled();
  });

  it("un événement ordinaire ne devient pas une échéance de facture", async () => {
    const id = await seedEvent({ title: "Réunion" });

    const result = await update(noInvoices, { id, type: "INVOICE_DUE" });

    expect(result.success).toBe(false);
    expect((await snapshot(id)).type).toBe("MANUAL");
  });

  it("le propriétaire modifie l'échéance", async () => {
    const id = await seedEvent({ type: "INVOICE_DUE" });

    const result = await update(owner, { id, title: "Échéance relue" });

    expect(result.success).toBe(true);
  });
});

describe("Membres assignés limités à l'espace", () => {
  const create = (assignedMembers) =>
    Mutation.createEvent(
      null,
      {
        input: {
          title: "Atelier",
          start: day,
          end: day,
          assignedMembers,
        },
        workspaceId: ws(),
      },
      ctx(owner),
      info("createEvent"),
    );

  it("à la création, l'utilisateur d'une autre entreprise est écarté", async () => {
    const result = await create([String(outsider), String(editor)]);

    expect(result.success).toBe(true);
    const saved = await Event.collection.findOne({ title: "Atelier" });
    expect(saved.assignedMembers.map(String)).toEqual([String(editor)]);
  });

  it("à la modification, l'utilisateur d'une autre entreprise est écarté", async () => {
    const id = await seedEvent();

    const result = await update(owner, {
      id,
      assignedMembers: [String(outsider)],
    });

    expect(result.success).toBe(true);
    expect((await snapshot(id)).assignedMembers).toEqual([]);
  });

  it("un id étranger déjà enregistré n'est jamais décrit (nom, e-mail)", async () => {
    const id = await seedEvent({
      assignedMembers: [String(outsider), String(editor)],
    });

    const list = await Query.getEvents(
      null,
      { workspaceId: ws() },
      { ...ctx(owner), db: mongoose.connection.db },
      info("getEvents"),
    );
    const listed = list.events.find((e) => e.id === id);
    expect(listed.assignedMembers).toEqual([String(editor)]);
    expect(listed.assignedMembersInfo.map((m) => m.email)).toEqual([
      "eli@agenda.test",
    ]);
    expect(JSON.stringify(list)).not.toContain("ivan@intrus.test");

    const single = await Query.getEvent(
      null,
      { id, workspaceId: ws() },
      ctx(owner),
      info("getEvent"),
    );
    const members = await eventResolvers.Event.assignedMembersInfo(
      single.event,
      {},
      { db: mongoose.connection.db },
    );
    expect(members.map((m) => m.email)).toEqual(["eli@agenda.test"]);
  });
});
