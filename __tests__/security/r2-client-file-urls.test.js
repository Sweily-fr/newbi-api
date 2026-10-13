/**
 * URL et clés de fichiers R2 envoyées par le client.
 *
 * Plusieurs mutations enregistraient telle quelle une URL de fichier reçue du
 * client (pièces de factures d'achat et de dépenses, imports de factures,
 * logo). Le serveur relisait ensuite cet objet avec ses propres identifiants
 * (aperçu, relance OCR, automatisations) ou le supprimait : avec l'URL d'un
 * objet d'un autre espace (archive de facture, justificatif, logo), on le
 * lisait ou on l'effaçait.
 *
 * uploadDocument rangeait aussi le fichier dans le premier espace de
 * l'utilisateur et non dans l'espace actif : bloquant pour un utilisateur de
 * plusieurs espaces (cabinet comptable).
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

vi.hoisted(() => {
  process.env.OCR_BUCKET = "ocr-test";
  process.env.OCR_URL = "https://ocr.newbi.test";
  process.env.RECEIPTS_BUCKET = "receipts-test";
  process.env.RECEIPTS_URL = "https://receipts.newbi.test";
  process.env.IMPORTED_INVOICES_BUCKET = "imported-test";
  process.env.IMPORTED_INVOICES_URL = "https://imported.newbi.test";
  process.env.COMPANY_IMAGE_BUCKET = "company-test";
  process.env.COMPANY_IMAGE_URL = "https://company.newbi.test";
});

const r2 = vi.hoisted(() => ({ deleted: [], uploads: [] }));
vi.mock("../../src/services/cloudflareService.js", async (importOriginal) => {
  const original = await importOriginal();
  const service = original.default;
  service.deleteImage = async (key, bucket) => {
    r2.deleted.push({ key, bucket });
    return true;
  };
  service.uploadImage = async (buffer, name, userId, type, orgId) => {
    r2.uploads.push({ type, orgId });
    return {
      key: `${orgId}/x.pdf`,
      url: `https://ocr.newbi.test/${orgId}/x.pdf`,
    };
  };
  return original;
});
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import mongoose from "mongoose";
import { Readable } from "stream";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import cloudflareService from "../../src/services/cloudflareService.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";
import userResolvers from "../../src/resolvers/user.js";
import documentUploadResolvers from "../../src/resolvers/documentUpload.js";

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const ctxA = () => buildContext({ userId, organizationId: orgA });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  r2.deleted = [];
  r2.uploads = [];
  await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
});

describe("resolveWorkspaceFileUrl", () => {
  const ws = orgA.toString();
  const check = (url, types = ["ocr"]) =>
    cloudflareService.resolveWorkspaceFileUrl(url, ws, types);

  it("accepte un objet de l'espace dans un bucket attendu", () => {
    expect(check(`https://ocr.newbi.test/${ws}/a.pdf`)).toEqual({
      bucket: "ocr-test",
      key: `${ws}/a.pdf`,
    });
  });

  it("refuse l'objet d'un autre espace", () => {
    expect(check(`https://ocr.newbi.test/${orgB}/a.pdf`)).toBeNull();
  });

  it("refuse un autre bucket, un hôte voisin ou un r2.dev quelconque", () => {
    expect(check(`https://imported.newbi.test/${ws}/a.pdf`)).toBeNull();
    expect(check(`https://ocr.newbi.test.evil.com/${ws}/a.pdf`)).toBeNull();
    expect(check(`https://app-invoices-prod.x.r2.dev/${ws}/a.pdf`)).toBeNull();
  });

  it("refuse les remontées de dossier et les valeurs non textuelles", () => {
    expect(check(`https://ocr.newbi.test/${ws}/../${orgB}/a.pdf`)).toBeNull();
    expect(
      check(`https://ocr.newbi.test/${ws}/%2e%2e/${orgB}/a.pdf`),
    ).toBeNull();
    expect(check({ $ne: null })).toBeNull();
  });
});

describe("pièce d'une facture d'achat", () => {
  async function insertInvoice() {
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: orgA,
      createdBy: userId,
      supplierName: "Fournisseur",
      amountTTC: 10,
      status: "TO_PAY",
      files: [],
    });
    return insertedId.toString();
  }

  it("refuse l'URL d'un fichier d'un autre espace", async () => {
    const id = await insertInvoice();
    await expect(
      purchaseInvoiceResolvers.Mutation.addPurchaseInvoiceFile(
        null,
        {
          purchaseInvoiceId: id,
          input: {
            cloudflareUrl: `https://imported.newbi.test/invoices/${orgB}/archive.pdf`,
          },
        },
        ctxA(),
      ),
    ).rejects.toThrow("Fichier invalide pour cet espace");
  });

  it("accepte le fichier OCR de l'espace", async () => {
    const id = await insertInvoice();
    const url = `https://ocr.newbi.test/${orgA}/scan.pdf`;
    const result =
      await purchaseInvoiceResolvers.Mutation.addPurchaseInvoiceFile(
        null,
        {
          purchaseInvoiceId: id,
          input: { cloudflareUrl: url, fileSize: 1200 },
        },
        ctxA(),
      );
    expect(result.files.map((f) => f.url)).toContain(url);
  });
});

describe("import de factures par URL", () => {
  it("importInvoice refuse une URL qui ne correspond pas à la clé", async () => {
    await expect(
      importedInvoiceResolvers.Mutation.importInvoice(
        null,
        {
          workspaceId: orgA.toString(),
          cloudflareUrl: `https://imported.newbi.test/${orgB}/b.pdf`,
          cloudflareKey: `${orgA}/a.pdf`,
          fileName: "a.pdf",
          mimeType: "application/pdf",
        },
        ctxA(),
      ),
    ).rejects.toThrow("Clé de fichier invalide");
  });

  it("batchImportInvoices contrôle chaque fichier", async () => {
    await expect(
      importedInvoiceResolvers.Mutation.batchImportInvoices(
        null,
        {
          workspaceId: orgA.toString(),
          files: [
            {
              cloudflareUrl: `https://imported.newbi.test/${orgB}/b.pdf`,
              cloudflareKey: `${orgB}/b.pdf`,
              fileName: "b.pdf",
              mimeType: "application/pdf",
            },
          ],
        },
        ctxA(),
      ),
    ).rejects.toThrow("Clé de fichier invalide");
  });
});

describe("suppression du logo", () => {
  const setLogo = (logo) =>
    mongoose.connection.db
      .collection("organization")
      .updateOne({ _id: orgA }, { $set: { logo } });

  it("ne supprime pas l'objet d'un autre espace", async () => {
    await setLogo(`https://company.newbi.test/${orgB}/logo.png`);
    await userResolvers.Mutation.updateCompanyLogo(
      null,
      { logoUrl: null },
      ctxA(),
    );
    expect(r2.deleted).toEqual([]);
  });

  it("supprime le logo de l'espace", async () => {
    await setLogo(`https://company.newbi.test/${orgA}/logo.png`);
    await userResolvers.Mutation.updateCompanyLogo(
      null,
      { logoUrl: null },
      ctxA(),
    );
    expect(r2.deleted).toEqual([
      { key: `${orgA}/logo.png`, bucket: "company-test" },
    ]);
  });
});

describe("uploadDocument", () => {
  const file = () =>
    Promise.resolve({
      createReadStream: () => Readable.from([Buffer.from("%PDF-1.4")]),
      filename: "scan.pdf",
      mimetype: "application/pdf",
    });

  it("range le fichier dans l'espace actif, pas dans le premier espace", async () => {
    await seedOrgMembership({ userId, organizationId: orgB, role: "member" });
    const ctx = buildContext({ userId, organizationId: orgB });
    await documentUploadResolvers.Mutation.uploadDocument(
      null,
      { file: file(), folderType: "ocr" },
      ctx,
    );
    expect(r2.uploads).toEqual([{ type: "ocr", orgId: orgB.toString() }]);
  });

  it("refuse un espace dont l'utilisateur n'est pas membre", async () => {
    const ctx = buildContext({ userId, organizationId: orgB });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await documentUploadResolvers.Mutation.uploadDocument(
      null,
      { file: file(), folderType: "ocr" },
      ctx,
    );
    console.error.mockRestore();
    expect(result.success).toBe(false);
    expect(r2.uploads).toEqual([]);
  });
});
