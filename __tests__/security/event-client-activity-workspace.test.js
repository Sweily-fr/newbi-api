/**
 * Agenda : l'activité « rappel créé » ne s'écrit que sur un client de
 * l'espace.
 *
 * createEvent ajoutait l'activité au client lu par son seul id : un membre
 * de A écrivait dans la chronologie du client d'un autre espace.
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
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import Event from "../../src/models/Event.js";
import eventResolvers from "../../src/resolvers/event.js";

const { Mutation } = eventResolvers;

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId: orgA });

async function insertClient(workspaceId, name) {
  const { insertedId } = await Client.collection.insertOne({
    workspaceId,
    name,
    email: `${name.toLowerCase().replace(/\s/g, "")}@test.fr`,
    type: "COMPANY",
    activity: [],
  });
  return insertedId;
}

const createEvent = (clientId) =>
  Mutation.createEvent(
    null,
    {
      input: {
        title: "Relance",
        start: new Date("2026-11-02T09:00:00Z"),
        end: new Date("2026-11-02T10:00:00Z"),
        clientId: clientId.toString(),
      },
    },
    ctx(),
    { fieldName: "createEvent" },
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
  await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
});

describe("createEvent et chronologie du client", () => {
  it("n'écrit pas dans la chronologie d'un client d'un autre espace", async () => {
    const clientB = await insertClient(orgB, "Client B");

    const result = await createEvent(clientB);

    expect(result.success).toBe(true);
    const after = await Client.collection.findOne({ _id: clientB });
    expect(after.activity).toEqual([]);
  });

  it("ajoute l'activité au client de l'espace", async () => {
    const clientA = await insertClient(orgA, "Client A");

    const result = await createEvent(clientA);

    expect(result.success).toBe(true);
    expect(await Event.countDocuments({ workspaceId: orgA })).toBe(1);
    const after = await Client.collection.findOne({ _id: clientA });
    expect(after.activity).toHaveLength(1);
    expect(after.activity[0]).toMatchObject({
      type: "reminder_created",
      description: 'a créé un rappel "Relance"',
    });
  });
});
