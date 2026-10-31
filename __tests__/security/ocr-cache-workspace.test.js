/**
 * Cache OCR et fichiers des espaces.
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
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import OcrDocument from "../../src/models/OcrDocument.js";
import ocrResolvers from "../../src/resolvers/ocr.js";

const owner = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const A = String(orgA);
const B = String(orgB);

const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
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
  ocr.hybridCalls.length = 0;
  await seedOrgMembership({ userId: owner, organizationId: orgA });
  await seedOrgMembership({ userId: owner, organizationId: orgB });
});

const ctx = (org) => buildContext({ userId: owner, organizationId: org });

const fileUpload = (name = "facture.pdf") =>
  Promise.resolve({
    filename: name,
    mimetype: "application/pdf",
    createReadStream: () => Readable.from([PDF]),
  });

const importPdf = (org) =>
  ocrResolvers.Mutation.processDocumentOcr(
    null,
    { file: fileUpload(), workspaceId: String(org) },
    ctx(org),
  );

// Le cache est écrit en tâche de fond, après l'enregistrement de l'analyse.
async function waitForCache() {
  for (let i = 0; i < 100 && cache.store.size === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(cache.store.size).toBe(1);
}

describe("processDocumentOcr : cache par empreinte", () => {
  it("le même PDF envoyé par un autre espace est rangé dans cet espace", async () => {
    const first = await importPdf(orgA);
    await waitForCache();
    const second = await importPdf(orgB);

    expect(first.metadata.cloudflareKey.startsWith(`${A}/`)).toBe(true);
    expect(second.metadata.cloudflareKey.startsWith(`${B}/`)).toBe(true);
    expect(second.metadata.documentUrl).toBe(
      `https://ocr.newbi.test/${second.metadata.cloudflareKey}`,
    );
    expect(JSON.stringify(second)).not.toContain(A);
    expect(second.metadata.documentId).not.toBe(first.metadata.documentId);
    // L'extraction vient du cache : une seule analyse.
    expect(ocr.claudeCalls).toBe(1);
    expect(second.extractedText).toBe(first.extractedText);
    expect(second.financialAnalysis).toBe(first.financialAnalysis);
  });

  it("le cache ne garde ni URL, ni clé, ni identifiant", async () => {
    await importPdf(orgA);
    await waitForCache();
    const [stored] = [...cache.store.values()];
    const text = JSON.stringify(stored);
    expect(text).not.toContain("ocr.newbi.test");
    expect(text).not.toContain(A);
    expect(stored.metadata).toBeUndefined();
  });

  it("même espace, nouvel envoi (facture supprimée entre-temps) : nouveau fichier", async () => {
    const first = await importPdf(orgA);
    await waitForCache();
    const second = await importPdf(orgA);

    expect(r2.uploads).toHaveLength(2);
    expect(second.metadata.cloudflareKey).not.toBe(
      first.metadata.cloudflareKey,
    );
    expect(second.metadata.cloudflareKey.startsWith(`${A}/`)).toBe(true);
  });

  it("une entrée de cache à l'ancien format (réponse complète d'un autre espace) n'est pas resservie", async () => {
    await importPdf(orgA);
    await waitForCache();
    const [hash] = [...cache.store.keys()];
    cache.store.set(hash, {
      success: true,
      extractedText: "ANCIEN",
      metadata: {
        documentUrl: `https://ocr.newbi.test/${A}/ancien.pdf`,
        cloudflareKey: `${A}/ancien.pdf`,
        documentId: "0123456789abcdef01234567",
      },
    });

    const result = await importPdf(orgB);

    expect(result.metadata.cloudflareKey.startsWith(`${B}/`)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(A);
  });

  it("l'analyse est enregistrée dans l'espace de l'appelant", async () => {
    await importPdf(orgA);
    await waitForCache();
    const result = await importPdf(orgB);
    for (let i = 0; i < 100; i++) {
      if (await OcrDocument.exists({ _id: result.metadata.documentId })) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const doc = await OcrDocument.findById(result.metadata.documentId).lean();
    expect(String(doc.workspaceId)).toBe(B);
    expect(doc.cloudflareKey.startsWith(`${B}/`)).toBe(true);
  });
});

describe("processDocumentOcrFromUrl : URL contrôlée", () => {
  const fromUrl = (org, cloudflareUrl) =>
    ocrResolvers.Mutation.processDocumentOcrFromUrl(
      null,
      {
        cloudflareUrl,
        fileName: "facture.pdf",
        mimeType: "application/pdf",
        workspaceId: String(org),
      },
      ctx(org),
    );

  it("un fichier OCR de l'espace est analysé", async () => {
    const url = `https://ocr.newbi.test/${A}/facture.pdf`;
    const result = await fromUrl(orgA, url);
    expect(result.success).toBe(true);
    expect(ocr.hybridCalls).toEqual([url]);
  });

  const refused = [
    ["un fichier d'un autre espace", `https://ocr.newbi.test/${B}/facture.pdf`],
    ["un chemin qui remonte", `https://ocr.newbi.test/${A}/../${B}/x.pdf`],
    ["les métadonnées du cloud", "http://169.254.169.254/latest/meta-data/"],
    ["une adresse locale", "http://[::ffff:127.0.0.1]/facture.pdf"],
    ["une adresse décimale", "http://2130706433/facture.pdf"],
    ["un hôte hors stockage", `https://exemple.test/${A}/facture.pdf`],
    ["un bucket public quelconque", `https://pub-123.r2.dev/${A}/facture.pdf`],
  ];
  for (const [label, url] of refused) {
    it(`${label} : refusé sans lecture`, async () => {
      await expect(fromUrl(orgA, url)).rejects.toThrow(
        "Fichier invalide pour cet espace de travail",
      );
      expect(ocr.hybridCalls).toHaveLength(0);
    });
  }

  it("le résultat mis en cache pour un autre espace n'est jamais servi", async () => {
    const urlB = `https://ocr.newbi.test/${B}/facture.pdf`;
    await fromUrl(orgB, urlB);
    await expect(fromUrl(orgA, urlB)).rejects.toThrow(
      "Fichier invalide pour cet espace de travail",
    );
  });
});
