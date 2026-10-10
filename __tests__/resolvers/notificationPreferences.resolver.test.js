import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { buildContext } from "../helpers/auth.js";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import resolvers from "../../src/resolvers/notificationPreferences.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

const usersCollection = () => mongoose.connection.db.collection("user");

// Utilisateur existant tel qu'en base : préférences enregistrées avant
// l'arrivée de kanban_mention (clé absente du document)
const seedLegacyUser = (notificationPreferences) =>
  usersCollection().insertOne({
    _id: userId,
    email: "membre@test.fr",
    password: "hash",
    notificationPreferences,
  });

const getPreferences = () =>
  resolvers.Query.getNotificationPreferences(null, {}, ctx());

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

describe("notificationPreferences.Query.getNotificationPreferences", () => {
  it("renvoie kanban_mention activée par défaut quand la clé est absente", async () => {
    await seedLegacyUser({
      kanban_task_assigned: { email: false, push: true },
    });

    const prefs = await getPreferences();

    expect(prefs.kanban_mention).toEqual({ email: true, push: true });
    // Les préférences enregistrées restent celles du compte
    expect(prefs.kanban_task_assigned).toEqual({ email: false, push: true });
  });

  it("renvoie les valeurs par défaut sans aucune préférence enregistrée", async () => {
    await seedLegacyUser(undefined);

    const prefs = await getPreferences();

    expect(prefs.kanban_mention).toEqual({ email: true, push: true });
    expect(prefs.kanban_task_assigned).toEqual({ email: true, push: true });
  });
});

describe("notificationPreferences.Mutation.updateNotificationPreferences", () => {
  it("enregistre kanban_mention canal par canal", async () => {
    await seedLegacyUser({
      kanban_task_assigned: { email: true, push: true },
    });

    const result = await resolvers.Mutation.updateNotificationPreferences(
      null,
      { input: { kanban_mention: { push: false } } },
      ctx(),
    );
    expect(result.success).toBe(true);

    // Lu tel quel par le resolver kanban (collection brute) : seul le canal
    // modifié est écrit, l'e-mail absent reste activé (!== false)
    const raw = await usersCollection().findOne({ _id: userId });
    expect(raw.notificationPreferences.kanban_mention.push).toBe(false);
    expect(raw.notificationPreferences.kanban_mention.email).not.toBe(false);
    expect(raw.notificationPreferences.kanban_task_assigned).toEqual({
      email: true,
      push: true,
    });

    const prefs = await getPreferences();
    expect(prefs.kanban_mention).toEqual({ email: true, push: false });

    await resolvers.Mutation.updateNotificationPreferences(
      null,
      { input: { kanban_mention: { email: false } } },
      ctx(),
    );
    expect((await getPreferences()).kanban_mention).toEqual({
      email: false,
      push: false,
    });
  });
});
