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

// Mock fire-and-forget automations
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

// Mock Event model to avoid schema validation errors on audit events
// (the resolver uses fields not matching the Event schema for update/delete)
vi.mock("../../src/models/Event.js", () => ({
  default: {
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
  },
}));

import CreditNote from "../../src/models/CreditNote.js";
import Invoice from "../../src/models/Invoice.js";
import creditNoteResolvers from "../../src/resolvers/creditNote.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userId = buildUserId();
const organizationId = buildOrganizationId();

async function insertInvoice(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  const doc = {
    _id,
    workspaceId: organizationId,
    createdBy: userId,
    number: `INV-${_id.toString().slice(-6)}`,
    prefix: "F-202605",
    status: "COMPLETED",
    items: [
      { description: "Service", quantity: 1, unitPrice: 1000, vatRate: 20 },
    ],
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalVAT: 200,
    finalTotalTTC: 1200,
    issueDate: new Date(),
    createdAt: new Date(),
    isReverseCharge: false,
    ...overrides,
  };
  await Invoice.collection.insertOne(doc);
  return doc;
}

function buildCreditNoteInput(invoiceId, overrides = {}) {
  return {
    originalInvoiceId: invoiceId.toString(),
    creditType: "CORRECTION",
    items: [
      { description: "Retour", quantity: 1, unitPrice: 500, vatRate: 20 },
    ],
    client: {
      name: "Client Test",
      email: "client@test.fr",
      address: {
        street: "1 rue",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  // requireCompanyInfo validates capitalSocial + rcs for SASU
  const db = mongoose.connection.db;
  await db
    .collection("organization")
    .updateOne(
      { _id: organizationId },
      {
        $set: {
          capitalSocial: "10000",
          rcs: "Paris B 123 456 789",
          vatNumber: "FR12345678901",
        },
      },
    );
});

const ctx = () => buildContext({ userId, organizationId });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CreditNote Resolver — createCreditNote", () => {
  it("creates a credit note with negative totals", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id);

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    const result = await resolver(null, { input }, ctx());

    expect(result).toBeDefined();
    expect(result.finalTotalHT).toBeLessThan(0);
    expect(result.finalTotalVAT).toBeLessThan(0);
    expect(result.finalTotalTTC).toBeLessThan(0);
    // 500 HT * 20% = 100 VAT → TTC = 600 → stored as -600
    expect(result.finalTotalTTC).toBeCloseTo(-600, 0);
  });

  it("applies percentage global discount with VAT scaling", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id, {
      discount: 10,
      discountType: "PERCENTAGE",
    });

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    const result = await resolver(null, { input }, ctx());

    // 500 HT - 10% = 450 → VAT scaled: 100 * (450/500) = 90 → TTC = 540
    expect(result.finalTotalHT).toBeCloseTo(-450, 0);
    expect(result.finalTotalVAT).toBeCloseTo(-90, 0);
    expect(result.finalTotalTTC).toBeCloseTo(-540, 0);
  });

  it("sets VAT to 0 for reverse-charge invoice", async () => {
    const inv = await insertInvoice({ isReverseCharge: true });
    const input = buildCreditNoteInput(inv._id);

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    const result = await resolver(null, { input }, ctx());

    expect(result.finalTotalVAT).toBeCloseTo(0, 0);
    expect(result.finalTotalHT).toBeCloseTo(-500, 0);
    expect(result.finalTotalTTC).toBeCloseTo(-500, 0);
  });

  it("rejects when invoice status is DRAFT", async () => {
    const inv = await insertInvoice({ status: "DRAFT" });
    const input = buildCreditNoteInput(inv._id);

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    await expect(resolver(null, { input }, ctx())).rejects.toThrow();
  });

  it("rejects when credit note amount exceeds invoice total", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 200 });
    const input = buildCreditNoteInput(inv._id, {
      items: [
        { description: "Over", quantity: 1, unitPrice: 300, vatRate: 20 },
      ],
    });

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    await expect(resolver(null, { input }, ctx())).rejects.toThrow(/dépasse/i);
  });

  it("respects remaining amount after first credit note", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 1200 });
    const input1 = buildCreditNoteInput(inv._id, {
      items: [
        { description: "Part 1", quantity: 1, unitPrice: 800, vatRate: 20 },
      ],
    });

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    await resolver(null, { input: input1 }, ctx());

    // Second credit note: 800 * 1.2 = 960 first, remaining = 1200 - 960 = 240
    // This one: 300 * 1.2 = 360 > 240 → should fail
    const input2 = buildCreditNoteInput(inv._id, {
      items: [
        { description: "Part 2", quantity: 1, unitPrice: 300, vatRate: 20 },
      ],
    });

    await expect(resolver(null, { input: input2 }, ctx())).rejects.toThrow(
      /dépasse/i,
    );
  });
});

describe("CreditNote Resolver — numérotation", () => {
  it("accepte un avoir 0001 sous deux préfixes mensuels distincts la même année (index avec prefix)", async () => {
    // Le bug d'origine : l'index unique (number, workspaceId, issueYear) sans
    // prefix rejetait le 2e "0001" d'une même année alors que le préfixe
    // mensuel diffère. L'index inclut désormais prefix.
    await CreditNote.syncIndexes();
    const inv = await insertInvoice({ finalTotalTTC: 100000 });

    const resolver = creditNoteResolvers.Mutation.createCreditNote;

    const cn1 = await resolver(
      null,
      {
        input: buildCreditNoteInput(inv._id, {
          prefix: "AV-202601",
          number: "0001",
          issueDate: new Date("2026-01-15"),
          items: [{ description: "R1", quantity: 1, unitPrice: 10, vatRate: 20 }],
        }),
      },
      ctx(),
    );
    expect(cn1.number).toBe("0001");
    expect(cn1.prefix).toBe("AV-202601");

    // Même numéro, même année, préfixe mensuel différent → doit passer
    const cn2 = await resolver(
      null,
      {
        input: buildCreditNoteInput(inv._id, {
          prefix: "AV-202602",
          number: "0001",
          issueDate: new Date("2026-02-15"),
          items: [{ description: "R2", quantity: 1, unitPrice: 10, vatRate: 20 }],
        }),
      },
      ctx(),
    );
    expect(cn2.number).toBe("0001");
    expect(cn2.prefix).toBe("AV-202602");
  });

  it("rejette un numéro manuel hors séquence (trou)", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 100000 });
    const resolver = creditNoteResolvers.Mutation.createCreditNote;

    await resolver(
      null,
      {
        input: buildCreditNoteInput(inv._id, {
          prefix: "AV",
          number: "0001",
          items: [{ description: "R", quantity: 1, unitPrice: 10, vatRate: 20 }],
        }),
      },
      ctx(),
    );

    // Sauter à 0050 alors que le max est 0001 → refusé
    await expect(
      resolver(
        null,
        {
          input: buildCreditNoteInput(inv._id, {
            prefix: "AV",
            number: "0050",
            items: [
              { description: "R", quantity: 1, unitPrice: 10, vatRate: 20 },
            ],
          }),
        },
        ctx(),
      ),
    ).rejects.toThrow(/0002/);
  });

  it("verrouille le numéro et le préfixe d'un avoir existant", async () => {
    const inv = await insertInvoice();
    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    const cn = await resolver(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );

    const updateResolver = creditNoteResolvers.Mutation.updateCreditNote;
    await expect(
      updateResolver(
        null,
        { id: cn._id.toString(), input: { number: "9999" } },
        ctx(),
      ),
    ).rejects.toThrow(/verrouillé/i);

    await expect(
      updateResolver(
        null,
        { id: cn._id.toString(), input: { prefix: "AV-209912" } },
        ctx(),
      ),
    ).rejects.toThrow(/verrouillé/i);
  });
});

describe("CreditNote Resolver — updateCreditNote", () => {
  it("recalculates totals when items changed", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id);
    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    const cn = await resolver(null, { input }, ctx());

    const updateResolver = creditNoteResolvers.Mutation.updateCreditNote;
    const updated = await updateResolver(
      null,
      {
        id: cn._id.toString(),
        input: {
          items: [
            {
              description: "Updated",
              quantity: 2,
              unitPrice: 100,
              vatRate: 20,
            },
          ],
        },
      },
      ctx(),
    );

    // 2 * 100 = 200 HT, VAT = 40, TTC = 240 → stored as -240
    expect(updated.finalTotalTTC).toBeCloseTo(-240, 0);
  });
});

describe("CreditNote Resolver — deleteCreditNote", () => {
  it("deletes a credit note", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id);
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input },
      ctx(),
    );

    const resolver = creditNoteResolvers.Mutation.deleteCreditNote;
    const result = await resolver(null, { id: cn._id.toString() }, ctx());

    expect(result).toBe(true);
    const deleted = await CreditNote.findById(cn._id);
    expect(deleted).toBeNull();
  });
});

describe("CreditNote Resolver — Queries", () => {
  it("creditNotes returns paginated list", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 10000 });
    const resolver = creditNoteResolvers.Mutation.createCreditNote;

    for (let i = 0; i < 3; i++) {
      await resolver(
        null,
        {
          input: buildCreditNoteInput(inv._id, {
            number: String(i + 1).padStart(4, "0"),
            items: [
              {
                description: `Item ${i}`,
                quantity: 1,
                unitPrice: 100,
                vatRate: 20,
              },
            ],
          }),
        },
        ctx(),
      );
    }

    const listResolver = creditNoteResolvers.Query.creditNotes;
    const result = await listResolver(null, { page: 1, limit: 10 }, ctx());

    expect(result.creditNotes).toHaveLength(3);
    expect(result.totalCount).toBe(3);
  });

  it("creditNotesByInvoice returns only credit notes for given invoice", async () => {
    const inv1 = await insertInvoice({ finalTotalTTC: 10000 });
    const inv2 = await insertInvoice({ finalTotalTTC: 10000 });
    const resolver = creditNoteResolvers.Mutation.createCreditNote;

    await resolver(
      null,
      { input: buildCreditNoteInput(inv1._id, { number: "0010" }) },
      ctx(),
    );
    await resolver(
      null,
      { input: buildCreditNoteInput(inv2._id, { number: "0011" }) },
      ctx(),
    );

    const byInvResolver = creditNoteResolvers.Query.creditNotesByInvoice;
    const result = await byInvResolver(
      null,
      { invoiceId: inv1._id.toString() },
      ctx(),
    );

    expect(result).toHaveLength(1);
  });

  it("creditNoteStats returns correct aggregation", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 10000 });
    const resolver = creditNoteResolvers.Mutation.createCreditNote;

    await resolver(
      null,
      {
        input: buildCreditNoteInput(inv._id, {
          items: [
            { description: "A", quantity: 1, unitPrice: 200, vatRate: 20 },
          ],
        }),
      },
      ctx(),
    );

    const statsResolver = creditNoteResolvers.Query.creditNoteStats;
    const stats = await statsResolver(null, {}, ctx());

    expect(stats.totalCount).toBe(1);
    expect(stats.createdCount).toBe(1);
    expect(stats.totalAmount).toBeLessThan(0);
  });
});
