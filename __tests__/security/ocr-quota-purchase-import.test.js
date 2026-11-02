/**
 * Quota d'analyses OCR : l'import d'une facture d'achat (processDocumentOcr)
 * compte dans le quota du plan et est refusé quand il est épuisé ; plusieurs
 * analyses simultanées sont toutes décomptées. Mêmes services simulés que
 * ocr-cache-workspace.test.js.
 *
 * (Origine du gabarit : cache OCR et fichiers des espaces.)
 *
 * Le cache (empreinte du contenu) ne partage que l'extraction : deux envois
 * du même fichier, depuis deux espaces ou après la suppression de la
 * facture, reçoivent chacun un fichier rangé dans l'espace de l'appelant,
 * jamais l'URL, la clé ou l'identifiant d'un autre envoi.
 *
 * processDocumentOcrFromUrl ne lit qu'un fichier OCR ou justificatif de
 * l'espace : ni l'URL d'un autre espace, ni une adresse quelconque.
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
});

const r2 = vi.hoisted(() => ({ uploads: [] }));
const cache = vi.hoisted(() => ({ store: new Map() }));
const ocr = vi.hoisted(() => ({ claudeCalls: 0, hybridCalls: [] }));

vi.mock("../../src/services/cloudflareService.js", async (importOriginal) => {
  const original = await importOriginal();
  const service = original.default;
  service.uploadImage = async (buffer, name, userId, type, orgId) => {
    const key = `${orgId}/${r2.uploads.length + 1}-${name}`;
    r2.uploads.push({ type, orgId, key });
    return { key, url: `https://ocr.newbi.test/${key}` };
  };
  service.deleteImage = async () => true;
  return original;
});
vi.mock("../../src/services/ocrCacheService.js", () => ({
  default: {
    get: async (hash) => cache.store.get(hash) ?? null,
    set: async (hash, value) => {
      cache.store.set(hash, JSON.parse(JSON.stringify(value)));
      return true;
    },
    getStats: () => ({}),
  },
}));
vi.mock("../../src/services/claudeVisionOcrService.js", () => ({
  default: {
    processFromBase64: async () => {
      ocr.claudeCalls += 1;
      return {
        success: true,
        extractedText: "FACTURE IMPRIMERIE LUMIERE 120,00 EUR",
        data: { vendor: "Imprimerie Lumière" },
        provider: "claude-vision",
      };
    },
    toInvoiceFormat: () => ({
      transaction_data: { amount: 120, vendor_name: "Imprimerie Lumière" },
      extracted_fields: { invoice_number: "IMP-2026-118" },
      document_analysis: { document_type: "invoice" },
    }),
  },
}));
vi.mock("../../src/services/hybridOcrService.js", () => ({
  default: {
    processDocumentFromUrl: async (url) => {
      ocr.hybridCalls.push(url);
      return {
        success: true,
        provider: "claude-vision",
        extractedText: "FACTURE",
        transaction_data: { amount: 10 },
        extracted_fields: {},
        document_analysis: {},
      };
    },
  },
}));
vi.mock("../../src/services/mistralIntelligentAnalysisService.js", () => ({
  default: { analyzeDocument: async () => ({}) },
}));

import { Readable } from "stream";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import UserOcrQuota from "../../src/models/UserOcrQuota.js";
import ocrResolvers from "../../src/resolvers/ocr.js";

const owner = buildUserId();
const org = buildOrganizationId();
const ORG = String(org);
const month = new Date().toISOString().slice(0, 7);

const PDF = (n = 0) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${n}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
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
  r2.uploads.length = 0;
  cache.store.clear();
  ocr.claudeCalls = 0;
  await seedOrgMembership({ userId: owner, organizationId: org });
  // Offre Freelance : 50 analyses par mois
  await mongoose.connection.db
    .collection("subscription")
    .updateMany({}, { $set: { plan: "freelance" } });
});

const ctx = () => buildContext({ userId: owner, organizationId: org });
const importPdf = (n = 0) =>
  ocrResolvers.Mutation.processDocumentOcr(
    null,
    {
      file: Promise.resolve({
        filename: `facture-${n}.pdf`,
        mimetype: "application/pdf",
        createReadStream: () => Readable.from([PDF(n)]),
      }),
      workspaceId: ORG,
    },
    ctx(),
  );
const quotaDoc = () => UserOcrQuota.findOne({ userId: owner, workspaceId: org, month }).lean();

describe("processDocumentOcr : quota d'analyses OCR", () => {
  it("chaque analyse est décomptée", async () => {
    await importPdf(1);
    await importPdf(2);
    expect((await quotaDoc()).usedQuota).toBe(2);
  });

  it("quota épuisé : refusé avec un message, aucune analyse, compteur inchangé", async () => {
    await UserOcrQuota.create({
      userId: owner,
      workspaceId: org,
      plan: "FREELANCE",
      month,
      usedQuota: 50,
      resetDate: new Date(Date.now() + 86_400_000),
    });
    await expect(importPdf(3)).rejects.toThrow(/Quota OCR épuisé \(50\/50/);
    expect(ocr.claudeCalls).toBe(0);
    expect(r2.uploads).toHaveLength(0);
    expect((await quotaDoc()).usedQuota).toBe(50);
  });

  it("analyses simultanées : toutes comptées (incréments atomiques)", async () => {
    await Promise.all([1, 2, 3, 4].map((n) => importPdf(n)));
    expect((await quotaDoc()).usedQuota).toBe(4);
    expect((await quotaDoc()).importHistory).toHaveLength(4);
  });
});

describe("UserOcrQuota.recordUsage", () => {
  it("au-delà du quota du plan, les imports supplémentaires sont décomptés", async () => {
    await UserOcrQuota.create({
      userId: owner,
      workspaceId: org,
      plan: "FREE",
      month,
      usedQuota: 5,
      extraImportsPurchased: 3,
      resetDate: new Date(Date.now() + 86_400_000),
    });
    const r = await UserOcrQuota.recordUsage(owner, org, "FREE", { fileName: "x.pdf" });
    expect(r).toMatchObject({ isExtra: true, usedQuota: 5, extraImportsUsed: 1 });
  });

  it("l'historique garde les 200 dernières entrées", async () => {
    for (let i = 0; i < 3; i++) {
      await UserOcrQuota.recordUsage(owner, org, "TPE", { fileName: `${i}.pdf` });
    }
    const doc = await quotaDoc();
    expect(doc.importHistory.map((h) => h.fileName)).toEqual(["0.pdf", "1.pdf", "2.pdf"]);
  });
});
