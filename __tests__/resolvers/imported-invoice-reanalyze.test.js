import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.mock("../../src/utils/logger.js", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const getObjectByUrl = vi.fn();
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    getObjectByUrl: (...args) => getObjectByUrl(...args),
    uploadImage: vi.fn(),
    deleteImage: vi.fn(),
    importedInvoicesBucketName: "imported",
  },
}));

const processFromBase64 = vi.fn();
vi.mock("../../src/services/claudeVisionOcrService.js", () => ({
  default: {
    isAvailable: () => true,
    processFromBase64: (...args) => processFromBase64(...args),
    toInvoiceFormat: (raw) => raw.structured,
  },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
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
  getObjectByUrl.mockReset();
  processFromBase64.mockReset();
});

const ctx = () => buildContext({ userId, organizationId });

const seedInvoice = (overrides = {}) =>
  ImportedInvoice.create({
    workspaceId: organizationId,
    importedBy: userId,
    status: "PENDING_REVIEW",
    originalInvoiceNumber: "202603",
    vendor: { name: "Tricatel" },
    client: { name: "Burger Queen" },
    totalHT: 1000,
    totalVAT: 20,
    totalTTC: 1020,
    file: {
      url: "https://pub.r2.dev/org/facture.pdf",
      cloudflareKey: `${organizationId}/facture.pdf`,
      originalFileName: "facture.pdf",
      mimeType: "application/pdf",
      fileSize: 10,
    },
    ...overrides,
  });

describe("reanalyzeImportedInvoice", () => {
  it("relit le fichier R2, renvoie les valeurs OCR et ne modifie pas la facture", async () => {
    const invoice = await seedInvoice();
    getObjectByUrl.mockResolvedValue({
      buffer: Buffer.from("%PDF-1.4 fake"),
      contentType: "application/pdf",
    });
    processFromBase64.mockResolvedValue({
      success: true,
      provider: "claude-vision",
      structured: {
        transaction_data: {
          document_number: "F-202603-0012",
          vendor_name: "Tricatel",
          client_name: "Burger Queen",
          amount: 1200,
          tax_amount: 200,
          currency: "EUR",
          transaction_date: "2026-03-12",
          due_date: "2026-04-11",
        },
        extracted_fields: {
          client_name: "Burger Queen",
          totals: { total_ht: 1000, total_tax: 200, total_ttc: 1200 },
        },
      },
    });

    const proposal =
      await importedInvoiceResolvers.Mutation.reanalyzeImportedInvoice(
        null,
        { id: String(invoice._id) },
        ctx(),
      );

    expect(getObjectByUrl).toHaveBeenCalledWith(
      "https://pub.r2.dev/org/facture.pdf",
    );
    expect(processFromBase64).toHaveBeenCalledTimes(1);
    expect(proposal.originalInvoiceNumber).toBe("F-202603-0012");
    expect(proposal.totalHT).toBe(1000);
    expect(proposal.totalVAT).toBe(200);
    expect(proposal.totalTTC).toBe(1200);
    expect(proposal.invoiceDate).toMatch(/^2026-03-12/);
    expect(proposal.provider).toBe("claude-vision");

    const unchanged = await ImportedInvoice.findById(invoice._id).lean();
    expect(unchanged.originalInvoiceNumber).toBe("202603");
    expect(unchanged.totalTTC).toBe(1020);
  });

  it("refuse une facture d'un autre workspace", async () => {
    const invoice = await seedInvoice({ workspaceId: buildOrganizationId() });
    await expect(
      importedInvoiceResolvers.Mutation.reanalyzeImportedInvoice(
        null,
        { id: String(invoice._id) },
        ctx(),
      ),
    ).rejects.toThrow();
  });
});
