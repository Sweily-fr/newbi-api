/**
 * Notes d'un contact : une note très longue est refusée avec un message, le
 * contact reste modifiable ensuite.
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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import clientResolvers, {
  NOTE_MAX_LENGTH,
} from "../../src/resolvers/client.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let client;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  client = await Client.create(
    buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
  );
});

const addNote = (content) =>
  clientResolvers.Mutation.addClientNote(
    null,
    { clientId: client._id.toString(), input: { content } },
    ctx(),
  );

describe("addClientNote / updateClientNote : taille", () => {
  it("20 000 caractères : enregistrée", async () => {
    await addNote("n".repeat(NOTE_MAX_LENGTH));
    const stored = await Client.findById(client._id);
    expect(stored.notes).toHaveLength(1);
  });

  it("2 Mo : refusée avec un message, rien en base", async () => {
    await expect(addNote("n".repeat(2 * 1024 * 1024))).rejects.toThrow(
      "Une note ne peut pas dépasser 20 000 caractères.",
    );
    const stored = await Client.findById(client._id);
    expect(stored.notes).toHaveLength(0);
    expect(stored.activity).toHaveLength(0);
  });

  it("une note modifiée au-delà de la limite est refusée, l'ancienne reste", async () => {
    const withNote = await addNote("Première version");
    const noteId = withNote.notes[0].id;
    await expect(
      clientResolvers.Mutation.updateClientNote(
        null,
        {
          clientId: client._id.toString(),
          noteId,
          content: "n".repeat(NOTE_MAX_LENGTH + 1),
        },
        ctx(),
      ),
    ).rejects.toThrow("Une note ne peut pas dépasser 20 000 caractères.");
    const stored = await Client.findById(client._id);
    expect(stored.notes[0].content).toBe("Première version");
  });
});
