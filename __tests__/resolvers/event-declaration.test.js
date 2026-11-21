/**
 * Événements Newbi « Déclaration de TVA » et « Déclaration Urssaf » : le type
 * de déclaration est enregistré à la création, modifiable, retirable, et
 * refusé s'il n'est pas connu.
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
import typeDefs from "../../src/schemas/index.js";

const { Mutation } = eventResolvers;
const workspaceId = buildOrganizationId();
const owner = buildUserId();
const ws = () => String(workspaceId);
const ctx = () => buildContext({ userId: owner, organizationId: ws() });

const create = (input) =>
  Mutation.createEvent(null, { input, workspaceId: ws() }, ctx(), {
    fieldName: "createEvent",
  });
const update = (input) =>
  Mutation.updateEvent(null, { input, workspaceId: ws() }, ctx(), {
    fieldName: "updateEvent",
  });
const stored = (id) =>
  Event.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

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
});

const base = {
  title: "Déclaration de TVA",
  start: new Date("2026-11-24T00:00:00Z"),
  end: new Date("2026-11-24T22:59:00Z"),
  allDay: true,
  type: "MANUAL",
};

describe("événements de déclaration", () => {
  it("enregistre le type de déclaration à la création", async () => {
    const result = await create({ ...base, declarationKind: "VAT" });
    const id = result?.event?.id || result?.id;
    expect((await stored(id)).declarationKind).toBe("VAT");
  });

  it("un événement ordinaire n'a pas de type de déclaration", async () => {
    const result = await create({ ...base, title: "Point équipe" });
    const id = result?.event?.id || result?.id;
    expect((await stored(id)).declarationKind ?? null).toBeNull();
  });

  it("se modifie, puis se retire", async () => {
    const result = await create({ ...base, declarationKind: "VAT" });
    const id = String(result?.event?.id || result?.id);
    await update({ id, declarationKind: "URSSAF" });
    expect((await stored(id)).declarationKind).toBe("URSSAF");
    await update({ id, declarationKind: null });
    expect((await stored(id)).declarationKind ?? null).toBeNull();
  });

  it("le schéma n'accepte que TVA et Urssaf", () => {
    const schema = buildASTSchema(typeDefs);
    expect(
      schema
        .getType("DeclarationKind")
        .getValues()
        .map((v) => v.name),
    ).toEqual(["VAT", "URSSAF"]);
    for (const name of ["Event", "CreateEventInput", "UpdateEventInput"]) {
      expect(Object.keys(schema.getType(name).getFields())).toContain(
        "declarationKind",
      );
    }
  });

  it("le modèle refuse une valeur inconnue", async () => {
    const event = new Event({
      ...base,
      declarationKind: "IMPOTS",
      workspaceId,
      userId: owner,
    });
    await expect(event.validate()).rejects.toThrow();
  });
});
