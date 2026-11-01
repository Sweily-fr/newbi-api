/**
 * quoteByNumber : retrouver un devis par sa référence affichée
 * (« D-202610-0001 ») ou par son seul numéro (« 0001 »), y compris avec un
 * préfixe à plusieurs tirets ; jamais un devis d'une autre organisation.
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

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Quote from "../../src/models/Quote.js";
import quoteResolvers from "../../src/resolvers/quote.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherUserId = buildUserId();
const otherOrganizationId = buildOrganizationId();

async function insertQuote(workspaceId, prefix, number, fields = {}) {
  const { insertedId } = await Quote.collection.insertOne({
    workspaceId,
    createdBy: workspaceId === organizationId ? userId : otherUserId,
    status: "PENDING",
    prefix,
    number,
    issueDate: new Date("2026-10-01T00:00:00.000Z"),
    items: [
      { description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20 },
    ],
    finalTotalHT: 100,
    finalTotalVAT: 20,
    finalTotalTTC: 120,
    client: { name: "Acme", email: "acme@test.fr" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return String(insertedId);
}

const search = (number, workspaceId = organizationId) =>
  quoteResolvers.Query.quoteByNumber(
    null,
    { workspaceId: String(workspaceId), number },
    buildContext({ userId, organizationId }),
  );

let ids;

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
  await seedOrgMembership({
    userId: otherUserId,
    organizationId: otherOrganizationId,
    role: "owner",
  });
  ids = {
    first: await insertQuote(organizationId, "D-202610", "0001"),
    previousMonth: await insertQuote(organizationId, "D-202609", "0007"),
    manyDashes: await insertQuote(organizationId, "D-2026-10-A", "0002"),
    imported: await insertQuote(organizationId, "", "DEV-IMP-042", {
      status: "IMPORTED",
    }),
    foreign: await insertQuote(otherOrganizationId, "D-202610", "0009"),
  };
});

describe("quoteByNumber", () => {
  it("par la référence affichée « préfixe-numéro »", async () => {
    expect((await search("D-202610-0001"))?.id).toBe(ids.first);
    expect((await search("D-202609-0007"))?.id).toBe(ids.previousMonth);
  });

  it("par le seul numéro", async () => {
    expect((await search("0001"))?.id).toBe(ids.first);
  });

  it("avec un préfixe à plusieurs tirets", async () => {
    expect((await search("D-2026-10-A-0002"))?.id).toBe(ids.manyDashes);
  });

  it("espaces autour de la référence ignorés", async () => {
    expect((await search("  D-202610-0001  "))?.id).toBe(ids.first);
  });

  it("devis importé : par sa référence d'origine", async () => {
    expect((await search("DEV-IMP-042"))?.id).toBe(ids.imported);
  });

  it("référence inconnue ou vide : null", async () => {
    expect(await search("D-202610-9999")).toBeNull();
    expect(await search("9999")).toBeNull();
    expect(await search("   ")).toBeNull();
  });

  it("un numéro voisin ne suffit pas (le préfixe compte)", async () => {
    expect(await search("D-202609-0001")).toBeNull();
  });

  it("devis d'une autre organisation : null, même en donnant son espace", async () => {
    expect(await search("D-202610-0009")).toBeNull();
    expect(await search("0009")).toBeNull();
    expect(await search("D-202610-0009", otherOrganizationId)).toBeNull();
  });
});
