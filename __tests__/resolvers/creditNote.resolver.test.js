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

// Événement de calendrier créé avec l'avoir (CREDIT_NOTE_CREATED) : simulé,
// le test vérifie seulement qu'aucun n'est créé à la modification
vi.mock("../../src/models/Event.js", () => ({
  default: {
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
  },
}));

// Archivage R2 (Puppeteer côté NewbiV2) : on vérifie seulement l'appel
vi.mock("../../src/services/creditNoteFacturXArchiveService.js", () => ({
  triggerCreditNoteFacturXArchive: vi.fn(),
}));

import CreditNote from "../../src/models/CreditNote.js";
import Event from "../../src/models/Event.js";
import Invoice from "../../src/models/Invoice.js";
import creditNoteResolvers from "../../src/resolvers/creditNote.js";
import { triggerCreditNoteFacturXArchive } from "../../src/services/creditNoteFacturXArchiveService.js";

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

// Adresse exigée par le modèle dès que le port est facturé
const SHIPPING_ADDRESS = {
  fullName: "Client Test",
  street: "1 rue",
  city: "Paris",
  postalCode: "75001",
  country: "France",
};

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
  await db.collection("organization").updateOne(
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

  it("accepte un article à prix unitaire 0 (ligne offerte reprise de la facture)", async () => {
    const inv = await insertInvoice({
      items: [
        { description: "Service", quantity: 1, unitPrice: 1000, vatRate: 20 },
        { description: "Offert", quantity: 1, unitPrice: 0, vatRate: 20 },
      ],
    });
    const input = buildCreditNoteInput(inv._id, {
      items: [
        { description: "Retour", quantity: -1, unitPrice: -500, vatRate: 20 },
        { description: "Offert", quantity: -1, unitPrice: 0, vatRate: 20 },
      ],
    });

    const resolver = creditNoteResolvers.Mutation.createCreditNote;
    const result = await resolver(null, { input }, ctx());

    expect(result.items).toHaveLength(2);
    expect(result.items[1].unitPrice).toBe(0);
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

  it("reprend les frais de port de la facture d'origine, sans remise globale", async () => {
    // Facture : 1000 HT à 20 % + port 50 HT à 5,5 % = 1252,75 TTC
    const inv = await insertInvoice({
      shipping: {
        billShipping: true,
        shippingAddress: SHIPPING_ADDRESS,
        shippingAmountHT: 50,
        shippingVatRate: 5.5,
      },
      finalTotalTTC: 1252.75,
    });
    const input = buildCreditNoteInput(inv._id, {
      // Convention de stockage des avoirs : quantité et PU négatifs
      items: [
        { description: "Retour", quantity: -1, unitPrice: -500, vatRate: 20 },
      ],
      discount: 10,
      discountType: "PERCENTAGE",
    });

    const result = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input },
      ctx(),
    );

    // Articles : 500 − 10 % = 450 HT, TVA 90 ; port 50 HT, TVA 2,75
    expect(result.totalHT).toBeCloseTo(-550, 2);
    expect(result.finalTotalHT).toBeCloseTo(-500, 2);
    expect(result.finalTotalVAT).toBeCloseTo(-92.75, 2);
    expect(result.finalTotalTTC).toBeCloseTo(-592.75, 2);
  });

  it("plafonne une remise fixe au HT des articles", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id, {
      discount: 800,
      discountType: "FIXED",
    });

    const result = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input },
      ctx(),
    );

    // 500 HT, remise fixe plafonnée à 500 : rien à rembourser
    expect(result.finalTotalHT).toBeCloseTo(0, 2);
    expect(result.finalTotalTTC).toBeCloseTo(0, 2);
  });

  it("applique la remise de ligne fixe sur des articles stockés en négatif", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id, {
      items: [
        {
          description: "Retour",
          quantity: -2,
          unitPrice: -100,
          vatRate: 20,
          discount: 50,
          discountType: "FIXED",
        },
      ],
    });

    const result = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input },
      ctx(),
    );

    // 2 × 100 − 50 = 150 HT → 180 TTC
    expect(result.finalTotalHT).toBeCloseTo(-150, 2);
    expect(result.finalTotalTTC).toBeCloseTo(-180, 2);
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

describe("CreditNote Resolver — client et émetteur de la facture d'origine", () => {
  const invoiceClient = {
    id: "client-lumiere",
    name: "Boulangerie Lumière",
    email: "compta@lumiere.test",
    type: "COMPANY",
    address: {
      street: "12 rue de la République",
      city: "Lyon",
      postalCode: "69002",
      country: "France",
    },
  };
  const invoiceCompany = {
    name: "Studio Émetteur",
    email: "studio@test.fr",
    siret: "98765432100012",
    address: {
      street: "1 rue de la Paix",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
  };
  const otherClient = {
    name: "Cabinet Dumas",
    email: "contact@dumas.test",
    address: {
      street: "7 boulevard Haussmann",
      city: "Paris",
      postalCode: "75009",
      country: "France",
    },
  };
  const otherCompany = {
    name: "Société fictive",
    email: "fictive@test.fr",
    siret: "12345678900011",
    address: {
      street: "2 rue Ailleurs",
      city: "Nantes",
      postalCode: "44000",
      country: "France",
    },
  };

  it("à la création, client et émetteur saisis sont ignorés : ceux de la facture", async () => {
    const inv = await insertInvoice({
      client: invoiceClient,
      companyInfo: invoiceCompany,
    });
    const input = buildCreditNoteInput(inv._id, {
      client: otherClient,
      companyInfo: otherCompany,
    });

    const result = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input },
      ctx(),
    );

    const saved = await CreditNote.collection.findOne({ _id: result._id });
    expect(saved.client.name).toBe(invoiceClient.name);
    expect(saved.client.email).toBe(invoiceClient.email);
    expect(saved.client.address.city).toBe("Lyon");
    expect(saved.companyInfo.name).toBe(invoiceCompany.name);
    expect(saved.companyInfo.siret).toBe(invoiceCompany.siret);
  });

  it("à la modification, client et émetteur ne changent pas", async () => {
    const inv = await insertInvoice({
      client: invoiceClient,
      companyInfo: invoiceCompany,
    });
    const created = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );

    await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      {
        id: created._id.toString(),
        input: {
          client: otherClient,
          companyInfo: otherCompany,
          reason: "Motif corrigé",
        },
      },
      ctx(),
    );

    const saved = await CreditNote.collection.findOne({ _id: created._id });
    expect(saved.reason).toBe("Motif corrigé");
    expect(saved.client.name).toBe(invoiceClient.name);
    expect(saved.companyInfo.name).toBe(invoiceCompany.name);
  });
});

describe("CreditNote Resolver — avoirs simultanés", () => {
  const sumCredited = async (invoiceId) =>
    (await CreditNote.collection.find({ originalInvoice: invoiceId }).toArray())
      .map((c) => Math.abs(c.finalTotalTTC))
      .reduce((a, b) => a + b, 0);

  it("deux avoirs de 100 % créés au même instant : un seul passe, l'autre est refusé", async () => {
    // Facture de 1 200 € TTC ; chaque avoir vaut 1 200 € TTC
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id, {
      items: [
        { description: "Total", quantity: 1, unitPrice: 1000, vatRate: 20 },
      ],
    });
    const create = () =>
      creditNoteResolvers.Mutation.createCreditNote(null, { input }, ctx());

    const results = await Promise.allSettled([create(), create(), create()]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected")) {
      expect(r.reason.message).toMatch(/dépasse le montant restant/);
    }
    expect(await sumCredited(inv._id)).toBeCloseTo(1200, 2);
  });

  it("deux avoirs modifiés au même instant ne dépassent pas la facture", async () => {
    const inv = await insertInvoice();
    const small = buildCreditNoteInput(inv._id, {
      items: [
        { description: "Part", quantity: 1, unitPrice: 100, vatRate: 20 },
      ],
    });
    const a = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: small },
      ctx(),
    );
    const b = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: small },
      ctx(),
    );
    // Chacun passe à 900 € HT (1 080 € TTC) : ensemble 2 160 € > 1 200 €
    const grow = (cn) =>
      creditNoteResolvers.Mutation.updateCreditNote(
        null,
        {
          id: cn._id.toString(),
          input: {
            items: [
              { description: "Part", quantity: 1, unitPrice: 900, vatRate: 20 },
            ],
          },
        },
        ctx(),
      );

    const results = await Promise.allSettled([grow(a), grow(b)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await sumCredited(inv._id)).toBeLessThanOrEqual(1200);
  });
});

describe("CreditNote Resolver — numérotation", () => {
  const smallCredit = (inv, overrides = {}) =>
    buildCreditNoteInput(inv._id, {
      prefix: "AV-TEST",
      items: [{ description: "R", quantity: 1, unitPrice: 10, vatRate: 20 }],
      ...overrides,
    });

  it("lire le prochain numéro ne le consomme pas : l'avoir suivant ne saute aucun numéro", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 100000 });
    const create = (overrides) =>
      creditNoteResolvers.Mutation.createCreditNote(
        null,
        { input: smallCredit(inv, overrides) },
        ctx(),
      );
    const next = () =>
      creditNoteResolvers.Query.nextCreditNoteNumber(
        null,
        { workspaceId: organizationId.toString(), prefix: "AV-TEST" },
        ctx(),
      );

    expect((await create()).number).toBe("0001");
    const counters = () =>
      mongoose.connection.db.collection("documentcounters").find().toArray();
    const avant = JSON.stringify(await counters());
    expect([await next(), await next(), await next()]).toEqual([
      "0002",
      "0002",
      "0002",
    ]);
    expect(JSON.stringify(await counters())).toBe(avant);

    expect((await create()).number).toBe("0002");
  });

  it("un avoir refusé à l'enregistrement ne consomme pas de numéro", async () => {
    const inv = await insertInvoice({ finalTotalTTC: 100000 });
    const create = (overrides) =>
      creditNoteResolvers.Mutation.createCreditNote(
        null,
        { input: smallCredit(inv, overrides) },
        ctx(),
      );

    expect((await create()).number).toBe("0001");
    await expect(create({ refundMethod: "INCONNU" })).rejects.toThrow();
    expect((await create()).number).toBe("0002");
  });

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
          items: [
            { description: "R1", quantity: 1, unitPrice: 10, vatRate: 20 },
          ],
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
          items: [
            { description: "R2", quantity: 1, unitPrice: 10, vatRate: 20 },
          ],
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
          items: [
            { description: "R", quantity: 1, unitPrice: 10, vatRate: 20 },
          ],
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

  it("modifie le motif sans créer d'événement de calendrier", async () => {
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );
    Event.create.mockClear();

    const updated = await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      { id: cn._id.toString(), input: { reason: "Motif corrigé" } },
      ctx(),
    );

    expect(updated.reason).toBe("Motif corrigé");
    expect(Event.create).not.toHaveBeenCalled();
  });

  it("le montant restant d'un avoir modifié ne compte pas l'avoir lui-même", async () => {
    // Facture de 1 200 € TTC, un seul avoir de 600 € : il peut passer à 840 €
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );

    const updated = await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      {
        id: cn._id.toString(),
        input: {
          items: [
            { description: "Retour", quantity: 1, unitPrice: 700, vatRate: 20 },
          ],
        },
      },
      ctx(),
    );

    expect(updated.finalTotalTTC).toBeCloseTo(-840, 2);
  });

  it("une remise remise à 0 n'est plus reprise de l'ancienne valeur", async () => {
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      {
        input: buildCreditNoteInput(inv._id, {
          discount: 10,
          discountType: "PERCENTAGE",
        }),
      },
      ctx(),
    );
    // 500 − 10 % = 450 HT → 540 TTC
    expect(cn.finalTotalTTC).toBeCloseTo(-540, 2);

    const updated = await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      {
        id: cn._id.toString(),
        input: {
          items: buildCreditNoteInput(inv._id).items,
          discount: 0,
        },
      },
      ctx(),
    );

    expect(updated.discount).toBe(0);
    expect(updated.finalTotalTTC).toBeCloseTo(-600, 2);
  });

  it("recalcule les totaux quand seule la remise change, port compris", async () => {
    const inv = await insertInvoice({
      shipping: {
        billShipping: true,
        shippingAddress: SHIPPING_ADDRESS,
        shippingAmountHT: 100,
        shippingVatRate: 0,
      },
      finalTotalTTC: 1300,
    });
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );
    // 500 HT à 20 % (600 TTC) + port 100 HT à 0 % (taux conservé)
    expect(cn.finalTotalTTC).toBeCloseTo(-700, 2);

    const updated = await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      {
        id: cn._id.toString(),
        input: { discount: 100, discountType: "FIXED" },
      },
      ctx(),
    );

    // 400 HT à 20 % (480 TTC) + port 100 HT non remisé
    expect(updated.finalTotalHT).toBeCloseTo(-500, 2);
    expect(updated.finalTotalTTC).toBeCloseTo(-580, 2);
  });

  it("oublie le PDF en cache des envois quand l'avoir est modifié", async () => {
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );
    await CreditNote.collection.updateOne(
      { _id: cn._id },
      {
        $set: {
          cachedPdf: {
            key: "cache/cn.pdf",
            url: "https://r2.example/cn.pdf",
            generatedAt: new Date(),
          },
        },
      },
    );

    await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      { id: cn._id.toString(), input: { headerNotes: "Modifié" } },
      ctx(),
    );

    const stored = await CreditNote.collection.findOne({ _id: cn._id });
    expect(stored.cachedPdf?.url).toBeUndefined();
  });
});

describe("CreditNote Resolver — updateCreditNote (archive)", () => {
  it("régénère l'archive PDF de l'avoir modifié", async () => {
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );
    await CreditNote.collection.updateOne(
      { _id: cn._id },
      {
        $set: {
          archivedPdfKey: "credit-notes/ws/old.pdf",
          archivedPdfStoredAt: new Date("2026-10-01"),
          archivedPdfSource: "NEWBI",
        },
      },
    );
    triggerCreditNoteFacturXArchive.mockClear();

    await creditNoteResolvers.Mutation.updateCreditNote(
      null,
      { id: cn._id.toString(), input: { headerNotes: "Modifié" } },
      ctx(),
    );

    const stored = await CreditNote.collection.findOne({ _id: cn._id });
    expect(stored.archivedPdfKey).toBeUndefined();
    expect(triggerCreditNoteFacturXArchive).toHaveBeenCalledTimes(1);
    const [archived] = triggerCreditNoteFacturXArchive.mock.calls[0];
    expect(archived._id.toString()).toBe(cn._id.toString());
    expect(archived.headerNotes).toBe("Modifié");
  });
});

describe("CreditNote Resolver — updateCreditNote (e-facturation)", () => {
  it("refuse la modification d'un avoir transmis en facturation électronique", async () => {
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );
    await CreditNote.collection.updateOne(
      { _id: cn._id },
      {
        $set: {
          superPdpInvoiceId: "spdp-cn-1",
          eInvoiceStatus: "SENT_TO_RECIPIENT",
        },
      },
    );

    await expect(
      creditNoteResolvers.Mutation.updateCreditNote(
        null,
        { id: cn._id.toString(), input: { headerNotes: "Modifié" } },
        ctx(),
      ),
    ).rejects.toThrow(/transmis en facturation électronique/);

    const stored = await CreditNote.collection.findOne({ _id: cn._id });
    expect(stored.headerNotes).not.toBe("Modifié");
  });

  it("refuse la suppression d'un avoir transmis en facturation électronique", async () => {
    const inv = await insertInvoice();
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input: buildCreditNoteInput(inv._id) },
      ctx(),
    );
    await CreditNote.collection.updateOne(
      { _id: cn._id },
      { $set: { superPdpInvoiceId: "spdp-cn-2" } },
    );

    await expect(
      creditNoteResolvers.Mutation.deleteCreditNote(
        null,
        { id: cn._id.toString() },
        ctx(),
      ),
    ).rejects.toThrow(
      "Cet avoir a été transmis en facturation électronique : il ne peut pas être supprimé.",
    );
    expect(await CreditNote.collection.findOne({ _id: cn._id })).not.toBeNull();
  });
});

describe("CreditNote Resolver — deleteCreditNote", () => {
  it("refuse de supprimer un avoir : il garde sa place dans la numérotation", async () => {
    const inv = await insertInvoice();
    const input = buildCreditNoteInput(inv._id);
    const cn = await creditNoteResolvers.Mutation.createCreditNote(
      null,
      { input },
      ctx(),
    );

    const resolver = creditNoteResolvers.Mutation.deleteCreditNote;
    await expect(
      resolver(null, { id: cn._id.toString() }, ctx()),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    expect(await CreditNote.findById(cn._id)).not.toBeNull();
  });

  it("répond « introuvable » pour un avoir d'une autre organisation", async () => {
    const resolver = creditNoteResolvers.Mutation.deleteCreditNote;
    await expect(
      resolver(null, { id: new mongoose.Types.ObjectId().toString() }, ctx()),
    ).rejects.toThrow(/non trouvé/);
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
