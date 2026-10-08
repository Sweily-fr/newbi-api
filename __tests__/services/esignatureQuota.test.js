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
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {},
}));

vi.mock("../../src/services/esignatureService.js", () => ({
  default: {
    buildCallbackConfig: vi.fn(() => ({})),
    createSESSignature: vi.fn(),
    deleteSignature: vi.fn(),
  },
}));

import esignatureService from "../../src/services/esignatureService.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";
import Quote from "../../src/models/Quote.js";
import esignatureResolvers from "../../src/resolvers/esignatureResolvers.js";
import {
  parisMonthBounds,
  getWorkspacePlan,
  getEsignatureQuota,
  assertEsignatureQuotaAvailable,
} from "../../src/services/esignatureQuota.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const organizationId = buildOrganizationId();

async function setPlan(plan, extra = {}) {
  await mongoose.connection.db
    .collection("subscription")
    .updateOne(
      { referenceId: organizationId.toString() },
      { $set: { plan, ...extra } },
    );
}

async function seedSignatures(count, overrides = {}) {
  const docs = Array.from({ length: count }, (_, i) => ({
    organizationId: organizationId.toString(),
    workspaceId: organizationId,
    documentType: "quote",
    documentId: new ObjectId(),
    externalSignatureId: `ext-${i}-${Math.random()}`,
    signatureType: "SES",
    status: "WAIT_SIGN",
    signers: [{ name: "Jean", surname: "Client", email: "jean@client.fr" }],
    ...overrides,
  }));
  await SignatureRequest.insertMany(docs);
}

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  vi.clearAllMocks();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

describe("parisMonthBounds", () => {
  it("cale le mois sur minuit heure de Paris (hiver)", () => {
    const { start, end } = parisMonthBounds(new Date("2026-01-15T12:00:00Z"));
    expect(start.toISOString()).toBe("2025-12-31T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-31T23:00:00.000Z");
  });

  it("cale le mois sur minuit heure de Paris (été)", () => {
    const { start, end } = parisMonthBounds(new Date("2026-07-10T08:00:00Z"));
    expect(start.toISOString()).toBe("2026-06-30T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-31T22:00:00.000Z");
  });

  it("le 1er à 00h30 à Paris appartient déjà au nouveau mois", () => {
    // 31/10 23:30 UTC = 01/11 00:30 à Paris (heure d'hiver)
    const { start } = parisMonthBounds(new Date("2026-10-31T23:30:00Z"));
    expect(start.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });

  it("passe d'une année à l'autre en décembre", () => {
    const { end } = parisMonthBounds(new Date("2026-12-20T10:00:00Z"));
    expect(end.toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });
});

describe("getWorkspacePlan", () => {
  it("lit le plan de l'abonnement actif", async () => {
    expect(await getWorkspacePlan(organizationId.toString())).toBe("pme");
  });

  it("garde le plan d'un abonnement résilié encore dans sa période payée", async () => {
    await setPlan("entreprise", { status: "canceled" });
    expect(await getWorkspacePlan(organizationId.toString())).toBe(
      "entreprise",
    );
  });

  it("retombe sur freelance sans abonnement valable", async () => {
    await setPlan("entreprise", {
      status: "canceled",
      periodEnd: new Date(Date.now() - 1000),
    });
    expect(await getWorkspacePlan(organizationId.toString())).toBe("freelance");
    expect(await getWorkspacePlan(new ObjectId().toString())).toBe("freelance");
  });
});

describe("getEsignatureQuota", () => {
  it("Freelance : 10 par mois", async () => {
    await setPlan("freelance");
    await seedSignatures(3);
    const quota = await getEsignatureQuota(organizationId.toString());
    expect(quota).toMatchObject({
      plan: "freelance",
      unlimited: false,
      monthlyQuota: 10,
      used: 3,
      remaining: 7,
    });
  });

  it("TPE : 100 par mois", async () => {
    const quota = await getEsignatureQuota(organizationId.toString());
    expect(quota.monthlyQuota).toBe(100);
    expect(quota.remaining).toBe(100);
  });

  it("Entreprise : illimité", async () => {
    await setPlan("entreprise");
    await seedSignatures(250);
    const quota = await getEsignatureQuota(organizationId.toString());
    expect(quota).toMatchObject({
      unlimited: true,
      monthlyQuota: null,
      remaining: null,
      used: 250,
    });
  });

  it("compte les demandes annulées mais pas les erreurs, les envois non transmis ni le cachet", async () => {
    await setPlan("freelance");
    await seedSignatures(1, { status: "DONE" });
    await seedSignatures(1, { status: "CANCELLED" });
    await seedSignatures(1, { status: "ERROR" });
    await seedSignatures(1, { status: "CANCELLED", externalSignatureId: null });
    await seedSignatures(1, { signatureType: "QES_automatic", status: "DONE" });
    const quota = await getEsignatureQuota(organizationId.toString());
    expect(quota.used).toBe(2);
  });

  it("ne compte que le mois en cours et l'espace courant", async () => {
    await setPlan("freelance");
    await seedSignatures(2);
    const old = await SignatureRequest.create({
      organizationId: organizationId.toString(),
      workspaceId: organizationId,
      documentType: "quote",
      documentId: new ObjectId(),
      externalSignatureId: "ext-old",
      status: "DONE",
      signers: [{ name: "A", surname: "B", email: "a@b.fr" }],
    });
    await SignatureRequest.collection.updateOne(
      { _id: old._id },
      { $set: { createdAt: new Date("2020-01-10T10:00:00Z") } },
    );
    await seedSignatures(4, { workspaceId: new ObjectId() });
    const quota = await getEsignatureQuota(organizationId.toString());
    expect(quota.used).toBe(2);
  });

  it("assertEsignatureQuotaAvailable refuse une fois le quota atteint", async () => {
    await setPlan("freelance");
    await seedSignatures(9);
    await expect(
      assertEsignatureQuotaAvailable(organizationId.toString()),
    ).resolves.toMatchObject({ remaining: 1 });
    await seedSignatures(1);
    await expect(
      assertEsignatureQuotaAvailable(organizationId.toString()),
    ).rejects.toThrow(/10 signatures électroniques de ce mois/);
  });
});

describe("Resolvers e-signature et quota", () => {
  const ctx = () => buildContext({ userId, organizationId });

  it("esignatureQuota renvoie le reste du mois", async () => {
    await setPlan("freelance");
    await seedSignatures(4);
    const quota = await esignatureResolvers.Query.esignatureQuota(
      null,
      {},
      ctx(),
    );
    expect(quota).toMatchObject({ monthlyQuota: 10, used: 4, remaining: 6 });
    expect(typeof quota.resetsAt).toBe("string");
  });

  it("requestDocumentSignature refuse sans appeler le prestataire quand le quota est atteint", async () => {
    await setPlan("freelance");
    await seedSignatures(10);
    const quoteId = new ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      status: "PENDING",
      number: "000042",
    });

    await expect(
      esignatureResolvers.Mutation.requestDocumentSignature(
        null,
        {
          input: {
            documentType: "quote",
            documentId: quoteId.toString(),
            signers: [
              { name: "Jean", surname: "Client", email: "jean@client.fr" },
            ],
            documentBase64: "JVBERi0=",
          },
        },
        ctx(),
      ),
    ).rejects.toThrow(/10 signatures électroniques de ce mois/);

    expect(esignatureService.createSESSignature).not.toHaveBeenCalled();
    expect(await SignatureRequest.countDocuments({ documentId: quoteId })).toBe(
      0,
    );
  });
});
