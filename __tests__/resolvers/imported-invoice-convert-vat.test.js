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
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    resolveBucketAndKeyFromUrl: vi.fn().mockReturnValue(null),
    importedInvoicesBucketName: "imported",
  },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

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
});

let n = 0;
// Montants tels qu'enregistrés sur la facture importée : 0 = non lu
const convert = async ({ totalHT, totalVAT, totalTTC }) => {
  n += 1;
  const imported = await ImportedInvoice.create({
    workspaceId: organizationId,
    importedBy: userId,
    status: "PENDING_REVIEW",
    source: "OCR_UPLOAD",
    originalInvoiceNumber: `TVA-${n}`,
    vendor: { name: `Fournisseur ${n}` },
    invoiceDate: new Date("2026-10-01T00:00:00.000Z"),
    totalHT,
    totalVAT,
    totalTTC,
    file: {
      url: `https://r2.example.com/facture-${n}.pdf`,
      cloudflareKey: `${organizationId}/facture-${n}.pdf`,
      originalFileName: `facture-${n}.pdf`,
      mimeType: "application/pdf",
      fileSize: 10,
    },
  });
  const invoice =
    await importedInvoiceResolvers.Mutation.convertImportedInvoiceToPurchaseInvoice(
      null,
      { id: imported._id.toString() },
      buildContext({ userId, organizationId }),
    );
  const { amountHT, amountTVA, vatRate, amountTTC } = invoice;
  return { amountHT, amountTVA, vatRate, amountTTC };
};

describe("convertImportedInvoiceToPurchaseInvoice : montants de TVA complétés", () => {
  it("montants complets : taux légal qui redonne la TVA (20 %, pas 20,05 %)", async () => {
    expect(
      await convert({ totalHT: 8.33, totalVAT: 1.67, totalTTC: 10 }),
    ).toEqual({ amountHT: 8.33, amountTVA: 1.67, vatRate: 20, amountTTC: 10 });
  });

  it("TVA non lue : TVA = TTC - HT (plus « TVA 0 € » avec un HT incohérent)", async () => {
    expect(await convert({ totalHT: 100, totalVAT: 0, totalTTC: 120 })).toEqual(
      { amountHT: 100, amountTVA: 20, vatRate: 20, amountTTC: 120 },
    );
  });

  it("HT non lu : HT = TTC - TVA (plus 0 €)", async () => {
    expect(
      await convert({ totalHT: 0, totalVAT: 1.76, totalTTC: 10.59 }),
    ).toEqual({
      amountHT: 8.83,
      amountTVA: 1.76,
      vatRate: 20,
      amountTTC: 10.59,
    });
  });

  it("seul le TTC lu : sans TVA, HT = TTC et 0 % (plus 20 %)", async () => {
    expect(await convert({ totalHT: 0, totalVAT: 0, totalTTC: 42.87 })).toEqual(
      { amountHT: 42.87, amountTVA: 0, vatRate: 0, amountTTC: 42.87 },
    );
  });

  it("facture vide (TTC 0) : 0 %, pas le défaut du modèle", async () => {
    expect(await convert({ totalHT: 0, totalVAT: 0, totalTTC: 0 })).toEqual({
      amountHT: 0,
      amountTVA: 0,
      vatRate: 0,
      amountTTC: 0,
    });
  });
});
