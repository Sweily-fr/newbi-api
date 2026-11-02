/**
 * Valeurs impossibles refusées par l'API pour une facture d'achat, une fiche
 * fournisseur ou une transaction : devise hors code ISO, taux de TVA hors
 * 0-100 %, montants négatifs, TVA au-delà du TTC, longueurs démesurées,
 * e-mail, SIRET ou IBAN mal formés. Refus avec un message et rien en base ;
 * les saisies ordinaires (« usd », « € », IBAN avec espaces) passent.
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
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    resolveWorkspaceFileUrl: vi.fn(() => ({ bucket: "ocr", key: "k" })),
    resolveBucketAndKeyFromUrl: vi.fn(() => null),
    deleteImage: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/qontoSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncPurchaseInvoicePaidToQonto: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Supplier from "../../src/models/Supplier.js";
import Transaction from "../../src/models/Transaction.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import bankingResolvers from "../../src/resolvers/banking.js";
import {
  normalizeCurrency,
  validateSupplierInput,
} from "../../src/utils/purchaseInputValidation.js";

const owner = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);
const M = purchaseInvoiceResolvers.Mutation;
const ctx = () => buildContext({ userId: owner, organizationId });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
});

const base = (supplierName, extra = {}) => ({
  workspaceId: ws,
  supplierName,
  issueDate: "2026-10-01",
  amountHT: 50,
  amountTVA: 10,
  vatRate: 20,
  amountTTC: 60,
  forceCreate: true,
  ...extra,
});

describe("Devise : code à trois lettres", () => {
  it("normalise « usd » et les symboles courants", () => {
    expect(normalizeCurrency("usd")).toBe("USD");
    expect(normalizeCurrency(" € ")).toBe("EUR");
    expect(normalizeCurrency("£")).toBe("GBP");
  });
  it.each(["EURO", "<b>EUR</b>", "E", "ZZZ"])("refuse « %s »", (c) => {
    expect(() => normalizeCurrency(c)).toThrow(/Devise invalide/);
  });
});

describe("createPurchaseInvoice : valeurs impossibles refusées, rien en base", () => {
  it.each([
    ["devise « EURO »", { currency: "EURO" }, /Devise invalide/],
    ["taux de 150 %", { vatRate: 150 }, /Taux de TVA invalide/],
    ["HT négatif", { amountHT: -50 }, /HT ne peut pas être négatif/],
    [
      "TVA au-delà du TTC",
      { amountHT: 0, amountTVA: 80 },
      /TVA ne peut pas dépasser/,
    ],
    ["date illisible", { issueDate: "abc" }, /Date invalide/],
    [
      "détail de TVA à 300 %",
      {
        vatBreakdown: [
          { rate: 300, baseHT: 10, amountTVA: 30 },
          { rate: 20, baseHT: 10, amountTVA: 2 },
        ],
      },
      /Taux de TVA invalide/,
    ],
    [
      "détail avec une base négative",
      {
        vatBreakdown: [
          { rate: 20, baseHT: -10, amountTVA: -2 },
          { rate: 5.5, baseHT: 100, amountTVA: 5.5 },
        ],
      },
      /négatif/,
    ],
    [
      "numéro de 10 000 caractères",
      { invoiceNumber: "9".repeat(10000) },
      /100 caractères/,
    ],
  ])("%s", async (_nom, extra, motif) => {
    const supplierName = `Fournisseur ${Math.random()}`;
    await expect(
      M.createPurchaseInvoice(
        null,
        { input: base(supplierName, extra) },
        ctx(),
      ),
    ).rejects.toThrow(motif);
    expect(await PurchaseInvoice.countDocuments({ supplierName })).toBe(0);
  });

  it("nom de fournisseur de 10 000 caractères : ni facture ni fiche", async () => {
    const supplierName = "x".repeat(10000);
    await expect(
      M.createPurchaseInvoice(null, { input: base(supplierName) }, ctx()),
    ).rejects.toThrow(/200 caractères/);
    expect(await PurchaseInvoice.countDocuments({})).toBe(0);
    expect(await Supplier.countDocuments({})).toBe(0);
  });

  it("devise « usd » enregistrée « USD », « € » enregistrée « EUR »", async () => {
    await M.createPurchaseInvoice(
      null,
      { input: base("Dollar", { currency: "usd" }) },
      ctx(),
    );
    await M.createPurchaseInvoice(
      null,
      { input: base("Euro", { currency: "€" }) },
      ctx(),
    );
    expect(
      (await PurchaseInvoice.findOne({ supplierName: "Dollar" })).currency,
    ).toBe("USD");
    expect(
      (await PurchaseInvoice.findOne({ supplierName: "Euro" })).currency,
    ).toBe("EUR");
  });

  it("TTC à zéro (facture gratuite) reste accepté", async () => {
    await M.createPurchaseInvoice(
      null,
      { input: base("Gratuit", { amountHT: 0, amountTVA: 0, amountTTC: 0 }) },
      ctx(),
    );
    expect(
      await PurchaseInvoice.countDocuments({ supplierName: "Gratuit" }),
    ).toBe(1);
  });
});

describe("updatePurchaseInvoice : rien ne change sur une valeur impossible", () => {
  it.each([
    ["devise « EURO »", { currency: "EURO" }],
    ["taux négatif", { vatRate: -5 }],
    ["TVA au-delà du TTC existant", { amountTVA: 500 }],
    ["nom de 10 000 caractères", { supplierName: "y".repeat(10000) }],
  ])("%s", async (_nom, input) => {
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: organizationId,
      createdBy: owner,
      supplierName: "Existante",
      issueDate: new Date("2026-10-01"),
      amountHT: 49.92,
      amountTVA: 9.98,
      vatRate: 20,
      amountTTC: 59.9,
      currency: "EUR",
      status: "TO_PROCESS",
      files: [],
      linkedTransactionIds: [],
    });
    const avant = await PurchaseInvoice.collection.findOne({ _id: insertedId });
    await expect(
      M.updatePurchaseInvoice(null, { id: String(insertedId), input }, ctx()),
    ).rejects.toThrow();
    expect(
      await PurchaseInvoice.collection.findOne({ _id: insertedId }),
    ).toEqual(avant);
  });

  it("une facture existante incohérente reste modifiable sur un autre champ", async () => {
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: organizationId,
      createdBy: owner,
      supplierName: "Ancienne",
      issueDate: new Date("2026-01-01"),
      amountHT: 10,
      amountTVA: 90,
      vatRate: 20,
      amountTTC: 60,
      currency: "€",
      status: "TO_PROCESS",
      files: [],
      linkedTransactionIds: [],
    });
    await M.updatePurchaseInvoice(
      null,
      { id: String(insertedId), input: { notes: "Note ajoutée" } },
      ctx(),
    );
    const doc = await PurchaseInvoice.collection.findOne({ _id: insertedId });
    expect({
      notes: doc.notes,
      currency: doc.currency,
      tva: doc.amountTVA,
    }).toEqual({
      notes: "Note ajoutée",
      currency: "€",
      tva: 90,
    });
  });
});

describe("Fiches fournisseurs : e-mail, SIRET, IBAN", () => {
  it.each([
    ["e-mail invalide", { email: "pas-un-email" }, /e-mail/],
    ["SIRET à 13 chiffres", { siret: "1234567890123" }, /SIRET/],
    ["IBAN trop court", { iban: "FR00 1234" }, /IBAN/],
  ])("createSupplier, %s : refusée", async (_nom, extra, motif) => {
    await expect(
      M.createSupplier(
        null,
        { input: { workspaceId: ws, name: "Fiche", ...extra } },
        ctx(),
      ),
    ).rejects.toThrow(motif);
    expect(await Supplier.countDocuments({})).toBe(0);
  });

  it("IBAN et SIRET saisis avec des espaces : enregistrés sans espaces", async () => {
    await M.createSupplier(
      null,
      {
        input: {
          workspaceId: ws,
          name: "Fiche espaces",
          iban: "fr76 3000 6000 0112 3456 7890 189",
          siret: "123 456 789 00011",
          email: "compta@fournisseur.test",
        },
      },
      ctx(),
    );
    const fiche = await Supplier.findOne({ name: "Fiche espaces" });
    expect({ iban: fiche.iban, siret: fiche.siret }).toEqual({
      iban: "FR7630006000011234567890189",
      siret: "12345678900011",
    });
  });

  it("updateSupplier avec un e-mail invalide : la fiche ne change pas", async () => {
    const fiche = await Supplier.create({
      name: "Fiche existante",
      workspaceId: organizationId,
      createdBy: owner,
    });
    await expect(
      M.updateSupplier(
        null,
        { id: String(fiche._id), input: { email: "pas-un-email" } },
        ctx(),
      ),
    ).rejects.toThrow(/e-mail/);
    expect((await Supplier.findById(fiche._id)).email).toBeUndefined();
  });

  it("SIREN à 9 chiffres (saisie de l'app mobile) : accepté", () => {
    expect(validateSupplierInput({ siret: "123 456 789" }).siret).toBe(
      "123456789",
    );
  });

  it("validateSupplierInput laisse passer des champs vides", () => {
    expect(() =>
      validateSupplierInput({ email: "", siret: "", iban: "" }),
    ).not.toThrow();
  });
});

describe("updateTransaction : libellé et notes bornés", () => {
  const insertTx = async () => {
    const _id = new mongoose.Types.ObjectId();
    await Transaction.collection.insertOne({
      _id,
      externalId: `tx-${_id}`,
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -19.1,
      currency: "EUR",
      description: "CB LIBELLE",
      workspaceId: ws,
      date: new Date("2026-10-01"),
      reconciliationStatus: "unmatched",
      linkedInvoiceIds: [],
      linkedPurchaseInvoiceIds: [],
      linkedImportedInvoiceIds: [],
      receiptFiles: [],
      deletedAt: null,
    });
    return _id;
  };

  it.each([
    [
      "libellé de 10 000 caractères",
      { description: "L".repeat(10000) },
      /500 caractères/,
    ],
    [
      "notes de 2 001 caractères",
      { notes: "n".repeat(2001) },
      /2000 caractères/,
    ],
  ])("%s : refusé, rien ne change", async (_nom, input, motif) => {
    const id = await insertTx();
    const avant = await Transaction.collection.findOne({ _id: id });
    await expect(
      bankingResolvers.Mutation.updateTransaction(
        null,
        { id: String(id), input },
        ctx(),
      ),
    ).rejects.toThrow(motif);
    expect(await Transaction.collection.findOne({ _id: id })).toEqual(avant);
  });
});
