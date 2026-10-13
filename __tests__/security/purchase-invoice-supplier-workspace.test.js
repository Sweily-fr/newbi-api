/**
 * Factures d'achat : la fiche fournisseur rattachée doit être de l'espace.
 *
 * createPurchaseInvoice et updatePurchaseInvoice acceptaient n'importe quel
 * supplierId, et le champ supplier le relisait par son seul id : la fiche
 * d'un fournisseur d'un autre espace (coordonnées, IBAN, BIC) et le total de
 * ses achats chez lui devenaient lisibles.
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

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    uploadImage: vi.fn(),
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

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Supplier from "../../src/models/Supplier.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId: orgA });

async function insertSupplier(workspaceId, name) {
  const { insertedId } = await Supplier.collection.insertOne({
    workspaceId,
    name,
    iban: "FR7630006000011234567890189",
    createdBy: userId,
  });
  return insertedId;
}

async function insertInvoice(workspaceId, extra = {}) {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    supplierName: "Fournisseur",
    invoiceNumber: "PI-001",
    issueDate: new Date(),
    amountTTC: 120,
    amountHT: 100,
    vatAmount: 20,
    status: "TO_PAY",
    files: [],
    ...extra,
  });
  return insertedId;
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
  await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
});

describe("rattachement d'un fournisseur", () => {
  it("refuse le fournisseur d'un autre espace à la modification", async () => {
    const supplierB = await insertSupplier(orgB, "Fournisseur B");
    const invoiceA = await insertInvoice(orgA);

    await expect(
      purchaseInvoiceResolvers.Mutation.updatePurchaseInvoice(
        null,
        {
          id: invoiceA.toString(),
          input: { supplierId: supplierB.toString() },
        },
        ctx(),
      ),
    ).rejects.toThrow("Fournisseur non trouvé");

    const after = await PurchaseInvoice.collection.findOne({ _id: invoiceA });
    expect(after.supplierId).toBeUndefined();
  });

  it("refuse le fournisseur d'un autre espace à la création", async () => {
    const supplierB = await insertSupplier(orgB, "Fournisseur B");

    await expect(
      purchaseInvoiceResolvers.Mutation.createPurchaseInvoice(
        null,
        {
          input: {
            supplierId: supplierB.toString(),
            supplierName: "Fournisseur B",
            amountTTC: 120,
            forceCreate: true,
          },
        },
        ctx(),
      ),
    ).rejects.toThrow("Fournisseur non trouvé");
    expect(await PurchaseInvoice.countDocuments({})).toBe(0);
  });

  it("refuse un supplierId objet (opérateur Mongo)", async () => {
    const invoiceA = await insertInvoice(orgA);
    await expect(
      purchaseInvoiceResolvers.Mutation.updatePurchaseInvoice(
        null,
        { id: invoiceA.toString(), input: { supplierId: { $ne: null } } },
        ctx(),
      ),
    ).rejects.toThrow("Fournisseur non trouvé");
  });

  it("accepte un fournisseur de l'espace", async () => {
    const supplierA = await insertSupplier(orgA, "Fournisseur A");
    const invoiceA = await insertInvoice(orgA);

    const updated =
      await purchaseInvoiceResolvers.Mutation.updatePurchaseInvoice(
        null,
        {
          id: invoiceA.toString(),
          input: { supplierId: supplierA.toString() },
        },
        ctx(),
      );
    expect(String(updated.supplierId)).toBe(supplierA.toString());
  });
});

describe("lecture de la fiche fournisseur", () => {
  it("ne renvoie pas la fiche d'un autre espace déjà rattachée", async () => {
    const supplierB = await insertSupplier(orgB, "Fournisseur B");
    const invoiceA = await insertInvoice(orgA, { supplierId: supplierB });
    const parent = await PurchaseInvoice.findById(invoiceA).lean();

    const supplier =
      await purchaseInvoiceResolvers.PurchaseInvoice.supplier(parent);
    expect(supplier).toBeNull();
  });

  it("ne compte que les factures de l'espace du fournisseur", async () => {
    const supplierB = await insertSupplier(orgB, "Fournisseur B");
    await insertInvoice(orgB, { supplierId: supplierB, amountTTC: 50 });
    await insertInvoice(orgA, { supplierId: supplierB, amountTTC: 999 });
    const parent = await Supplier.findById(supplierB).lean();

    expect(await purchaseInvoiceResolvers.Supplier.invoiceCount(parent)).toBe(
      1,
    );
    expect(await purchaseInvoiceResolvers.Supplier.totalAmount(parent)).toBe(
      50,
    );
  });
});
