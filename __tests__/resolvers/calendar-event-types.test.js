/**
 * Types d'événements créés par un espace : liste vide au départ, enregistrée
 * pour l'espace seulement, bornée, et rattachée aux événements.
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
import { buildASTSchema } from "graphql";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Event from "../../src/models/Event.js";
import eventResolvers from "../../src/resolvers/event.js";
import typesResolvers from "../../src/resolvers/calendarEventTypes.js";
import typeDefs from "../../src/schemas/index.js";

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const viewer = buildUserId();
const ctx = (userId = owner, ws = workspaceId) =>
  buildContext({ userId, organizationId: String(ws) });

const list = (userId, ws) =>
  typesResolvers.Query.getCalendarEventTypes(
    null,
    { workspaceId: String(ws || workspaceId) },
    ctx(userId, ws),
    { fieldName: "getCalendarEventTypes" },
  );
const save = (types, userId, ws) =>
  typesResolvers.Mutation.updateCalendarEventTypes(
    null,
    { types, workspaceId: String(ws || workspaceId) },
    ctx(userId, ws),
    { fieldName: "updateCalendarEventTypes" },
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({ userId: owner, organizationId: otherWorkspace });
  await seedOrgMembership({
    userId: viewer,
    organizationId: workspaceId,
    role: "viewer",
  });
});

const RDV = { id: "type_rdv", name: "Rendez-vous client", color: "#3B82F6" };

describe("types d'événements de l'espace", () => {
  it("aucun type au départ", async () => {
    expect((await list()).types).toEqual([]);
  });

  it("enregistre, relit, modifie et supprime", async () => {
    await save([
      RDV,
      { id: "type_salon", name: "Salon", color: "#F59E0B", allDay: true },
    ]);
    expect((await list()).types).toEqual([
      { ...RDV, allDay: false },
      { id: "type_salon", name: "Salon", color: "#F59E0B", allDay: true },
    ]);
    await save([{ ...RDV, name: "Rendez-vous" }]);
    expect((await list()).types.map((t) => t.name)).toEqual(["Rendez-vous"]);
    await save([]);
    expect((await list()).types).toEqual([]);
  });

  it("propres à chaque espace", async () => {
    await save([RDV]);
    expect((await list(owner, otherWorkspace)).types).toEqual([]);
  });

  it("refuse un type sans nom et plus de 30 types", async () => {
    await expect(save([{ ...RDV, name: "  " }])).rejects.toThrow(/nom/);
    const many = Array.from({ length: 31 }, (_, i) => ({
      id: `t${i}`,
      name: `Type ${i}`,
      color: "#000000",
    }));
    await expect(save(many)).rejects.toThrow(/30/);
  });

  it("un membre en lecture seule ne les modifie pas", async () => {
    await expect(save([RDV], viewer)).rejects.toThrow();
    expect((await list(viewer)).types).toEqual([]);
  });

  it("l'événement garde son type", async () => {
    const result = await eventResolvers.Mutation.createEvent(
      null,
      {
        input: {
          title: "Rendez-vous client",
          start: new Date("2026-11-24T09:00:00Z"),
          end: new Date("2026-11-24T10:00:00Z"),
          eventTypeId: "type_rdv",
        },
        workspaceId: String(workspaceId),
      },
      ctx(),
      { fieldName: "createEvent" },
    );
    const id = result?.event?.id || result?.id;
    const stored = await Event.collection.findOne({
      _id: new mongoose.Types.ObjectId(String(id)),
    });
    expect(stored.eventTypeId).toBe("type_rdv");
  });

  it("le schéma expose les types et le champ de l'événement", () => {
    const schema = buildASTSchema(typeDefs);
    expect(schema.getQueryType().getFields()).toHaveProperty(
      "getCalendarEventTypes",
    );
    expect(schema.getMutationType().getFields()).toHaveProperty(
      "updateCalendarEventTypes",
    );
    for (const name of ["Event", "CreateEventInput", "UpdateEventInput"]) {
      expect(Object.keys(schema.getType(name).getFields())).toContain(
        "eventTypeId",
      );
    }
  });
});
