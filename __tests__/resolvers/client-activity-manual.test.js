/**
 * Journal d'un contact : addClientActivity n'accepte que le rappel créé par
 * le site. Les autres événements (facture créée, e-mail envoyé, blocage…)
 * sont écrits par l'API elle-même et ne peuvent pas être inventés.
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
import clientResolvers from "../../src/resolvers/client.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let client;
const addActivity = (input) =>
  clientResolvers.Mutation.addClientActivity(
    null,
    { clientId: client._id.toString(), input },
    ctx(),
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
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  client = await Client.create(
    buildClientDoc({ workspaceId: organizationId, createdBy: userId }),
  );
});

describe("addClientActivity", () => {
  it("ajoute un rappel au journal", async () => {
    await addActivity({
      type: "reminder_created",
      description: "a créé un rappel : Relancer le devis",
      metadata: { eventTitle: "Relancer le devis" },
    });
    const stored = await Client.findById(client._id);
    expect(stored.activity.map((a) => a.type)).toEqual(["reminder_created"]);
  });

  for (const type of [
    "invoice_created",
    "crm_email_sent",
    "blocked",
    "automation_executed",
    "note_added",
  ]) {
    it(`refuse un événement « ${type} » inventé, journal inchangé`, async () => {
      await expect(
        addActivity({ type, description: "a payé 12 000 €" }),
      ).rejects.toThrow(/ne peut pas être ajouté manuellement/);
      const stored = await Client.findById(client._id);
      expect(stored.activity).toHaveLength(0);
    });
  }
});
