/**
 * Fichiers d'utilisateur servis pour l'aperçu et justificatifs envoyés.
 *
 * Le type servi vient du contenu du fichier : seuls les PDF et les images
 * matricielles s'affichent en ligne, tout autre contenu (SVG, HTML…) est
 * servi en téléchargement, avec nosniff et une CSP sandbox. Les justificatifs
 * (factures d'achat, transactions) doivent être un PDF ou une image d'après
 * leur contenu, et sont stockés sous l'extension de ce type.
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

const state = vi.hoisted(() => ({
  user: null,
  object: null,
  uploads: [],
}));

vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    validateJWT: (req, res, next) => {
      if (!state.user)
        return res.status(401).json({ error: "Non authentifié" });
      req.user = String(state.user);
      return next();
    },
  };
});
vi.mock("../../src/services/cloudflareService.js", async (importOriginal) => {
  const original = await importOriginal();
  const service = original.default;
  service.getObjectByUrl = async () => state.object;
  service.uploadImage = async (buffer, name, userId, type, orgId) => {
    state.uploads.push({ name, type });
    return { key: `${orgId}/${name}`, url: `https://r2.test/${orgId}/${name}` };
  };
  return original;
});
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/transactionReceiptOcrService.js", () => ({
  default: {
    processReceiptsForTransaction: vi.fn().mockResolvedValue(undefined),
    processUploadedReceipts: vi.fn().mockResolvedValue(undefined),
  },
}));

import express from "express";
import mongoose from "mongoose";
import { Readable } from "stream";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Transaction from "../../src/models/Transaction.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import bankingResolvers from "../../src/resolvers/banking.js";
import importedDocumentFileRoutes from "../../src/routes/importedDocumentFile.js";
import {
  detectFileType,
  filePreviewHeaders,
  SHARED_PREVIEW_EXTRA_TYPES,
  storedFileName,
} from "../../src/utils/fileSignature.js";

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "latin1");
const HEIC = Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00", "latin1");

const userId = buildUserId();
const orgA = buildOrganizationId();
const ctxA = () => buildContext({ userId, organizationId: orgA });

let server;
let baseUrl;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/documents", importedDocumentFileRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  state.user = null;
  state.object = null;
  state.uploads = [];
  await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
});

describe("detectFileType", () => {
  it("reconnaît les PDF et les images matricielles", () => {
    expect(detectFileType(PDF)?.mime).toBe("application/pdf");
    expect(detectFileType(PNG)?.mime).toBe("image/png");
    expect(detectFileType(JPEG)?.mime).toBe("image/jpeg");
    expect(detectFileType(GIF)?.mime).toBe("image/gif");
    expect(detectFileType(WEBP)?.mime).toBe("image/webp");
    expect(detectFileType(HEIC)?.mime).toBe("image/heic");
  });

  it("accepte quelques octets avant la signature PDF", () => {
    const padded = Buffer.concat([Buffer.from("\n\n  "), PDF]);
    expect(detectFileType(padded)?.mime).toBe("application/pdf");
  });

  it("ne reconnaît ni SVG, ni HTML, ni texte, ni fichier vide", () => {
    expect(detectFileType(SVG)).toBeNull();
    expect(detectFileType(HTML)).toBeNull();
    expect(detectFileType(Buffer.from("bonjour"))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(null)).toBeNull();
  });

  it("storedFileName remplace l'extension par celle du type réel", () => {
    expect(storedFileName("facture.svg", ".pdf")).toBe("facture.pdf");
    expect(storedFileName("facture.pdf.svg", ".pdf")).toBe("facture.pdf.pdf");
    expect(storedFileName("scan", ".png")).toBe("scan.png");
    expect(storedFileName("", ".pdf")).toBe("fichier.pdf");
  });
});

describe("filePreviewHeaders (type annoncé)", () => {
  it("sert un PDF en ligne, sans CSP sandbox", () => {
    const headers = filePreviewHeaders({
      contentType: "application/pdf",
      filename: "a.pdf",
      frameAncestors: "'self'",
    });
    expect(headers["Content-Type"]).toBe("application/pdf");
    expect(headers["Content-Disposition"]).toMatch(/^inline;/);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Content-Security-Policy"]).toBe("frame-ancestors 'self'");
  });

  it("sert une image en ligne sous CSP sandbox", () => {
    const headers = filePreviewHeaders({
      contentType: "image/png; charset=binary",
      filename: "a.png",
    });
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["Content-Disposition"]).toMatch(/^inline;/);
    expect(headers["Content-Security-Policy"]).toMatch(/^sandbox;/);
  });

  for (const type of [
    "image/svg+xml",
    "text/html",
    "application/xhtml+xml",
    "text/xml",
    "application/javascript",
    "",
  ]) {
    it(`télécharge le type « ${type || "vide"} »`, () => {
      const headers = filePreviewHeaders({
        contentType: type,
        filename: "x",
        extraInlineTypes: SHARED_PREVIEW_EXTRA_TYPES,
      });
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Content-Disposition"]).toMatch(/^attachment;/);
      expect(headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(headers["Content-Security-Policy"]).toMatch(/sandbox/);
    });
  }

  it("garde audio, vidéo et texte brut pour l'aperçu des documents partagés", () => {
    for (const type of ["video/mp4", "audio/mpeg", "text/plain"]) {
      const headers = filePreviewHeaders({
        contentType: type,
        filename: "x",
        extraInlineTypes: SHARED_PREVIEW_EXTRA_TYPES,
      });
      expect(headers["Content-Disposition"]).toMatch(/^inline;/);
      expect(headers["Content-Type"].startsWith(type)).toBe(true);
      expect(headers["Content-Security-Policy"]).toMatch(/sandbox/);
    }
    // Sans la liste des documents partagés, la vidéo se télécharge
    expect(
      filePreviewHeaders({ contentType: "video/mp4", filename: "x" })[
        "Content-Type"
      ],
    ).toBe("application/octet-stream");
  });

  it("neutralise les guillemets et caractères non ASCII du nom", () => {
    const headers = filePreviewHeaders({
      contentType: "application/pdf",
      filename: 'fa"cture é.pdf',
    });
    expect(headers["Content-Disposition"]).toContain(
      'filename="facture _.pdf"',
    );
    expect(headers["Content-Disposition"]).toContain(
      "filename*=UTF-8''fa%22cture%20%C3%A9.pdf",
    );
  });
});

describe("GET /documents/imported/:docType/:id/file", () => {
  async function insertPurchaseInvoice(file) {
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: orgA,
      createdBy: userId,
      supplierName: "Fournisseur",
      amountTTC: 10,
      status: "TO_PAY",
      files: [{ _id: new mongoose.Types.ObjectId(), ...file }],
    });
    return insertedId.toString();
  }

  it("sert en téléchargement un SVG stocké comme PDF", async () => {
    const id = await insertPurchaseInvoice({
      url: "https://r2.test/a/facture.svg",
      originalFilename: "facture.svg",
      mimetype: "application/pdf",
    });
    state.user = userId;
    state.object = { buffer: SVG, contentType: "image/svg+xml" };
    const res = await fetch(
      `${baseUrl}/documents/imported/purchaseInvoice/${id}/file`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
    expect(res.headers.get("content-security-policy")).toContain(
      "frame-ancestors",
    );
  });

  it("sert en téléchargement un HTML annoncé image", async () => {
    const id = await insertPurchaseInvoice({
      url: "https://r2.test/a/x.png",
      originalFilename: "x.png",
      mimetype: "image/png",
    });
    state.user = userId;
    state.object = { buffer: HTML, contentType: "image/png" };
    const res = await fetch(
      `${baseUrl}/documents/imported/purchaseInvoice/${id}/file`,
    );
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("sert un vrai PDF en ligne, quel que soit le type R2", async () => {
    const id = await insertPurchaseInvoice({
      url: "https://r2.test/a/scan.bin",
      originalFilename: "scan.bin",
      mimetype: "application/octet-stream",
    });
    state.user = userId;
    state.object = { buffer: PDF, contentType: "application/octet-stream" };
    const res = await fetch(
      `${baseUrl}/documents/imported/purchaseInvoice/${id}/file`,
    );
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("content-security-policy")).not.toMatch(/sandbox/);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
  });

  it("sert une image PNG en ligne sous CSP sandbox", async () => {
    const id = await insertPurchaseInvoice({
      url: "https://r2.test/a/scan.png",
      originalFilename: "scan.png",
      mimetype: "image/png",
    });
    state.user = userId;
    state.object = { buffer: PNG, contentType: "image/png" };
    const res = await fetch(
      `${baseUrl}/documents/imported/purchaseInvoice/${id}/file`,
    );
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  });
});

describe("addPurchaseInvoiceFile (fichier envoyé)", () => {
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
  const upload = (buffer, filename, mimetype) =>
    Promise.resolve({
      createReadStream: () => Readable.from([buffer]),
      filename,
      mimetype,
    });

  it("refuse un SVG annoncé comme PDF", async () => {
    const id = await insertInvoice();
    await expect(
      purchaseInvoiceResolvers.Mutation.addPurchaseInvoiceFile(
        null,
        {
          purchaseInvoiceId: id,
          input: { file: upload(SVG, "facture.svg", "application/pdf") },
        },
        ctxA(),
      ),
    ).rejects.toThrow("Type de fichier non supporté");
    expect(state.uploads).toHaveLength(0);
    const invoice = await PurchaseInvoice.findById(id).lean();
    expect(invoice.files).toHaveLength(0);
  });

  it("enregistre le type réel et stocke le fichier sous son extension", async () => {
    const id = await insertInvoice();
    const result =
      await purchaseInvoiceResolvers.Mutation.addPurchaseInvoiceFile(
        null,
        {
          purchaseInvoiceId: id,
          input: { file: upload(PDF, "facture.svg", "image/svg+xml") },
        },
        ctxA(),
      );
    expect(state.uploads).toEqual([{ name: "facture.pdf", type: "ocr" }]);
    expect(result.files.at(-1).mimetype).toBe("application/pdf");
    expect(result.files.at(-1).originalFilename).toBe("facture.svg");
  });
});

describe("uploadTransactionReceipt", () => {
  async function insertTransaction() {
    const { insertedId } = await Transaction.collection.insertOne({
      workspaceId: String(orgA),
      amount: -10,
      receiptFiles: [],
    });
    return insertedId.toString();
  }
  const upload = (buffer, filename, mimetype) =>
    Promise.resolve({
      createReadStream: () => Readable.from([buffer]),
      filename,
      mimetype,
    });

  it("refuse un SVG annoncé comme PDF", async () => {
    const transactionId = await insertTransaction();
    const result = await bankingResolvers.Mutation.uploadTransactionReceipt(
      null,
      {
        transactionId,
        workspaceId: String(orgA),
        files: [upload(SVG, "facture.svg", "application/pdf")],
      },
      ctxA(),
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Type de fichier non supporté");
    expect(state.uploads).toHaveLength(0);
  });

  it("accepte un vrai PDF et le stocke sous l'extension .pdf", async () => {
    const transactionId = await insertTransaction();
    const result = await bankingResolvers.Mutation.uploadTransactionReceipt(
      null,
      {
        transactionId,
        workspaceId: String(orgA),
        files: [upload(PDF, "releve.svg", "application/pdf")],
      },
      ctxA(),
    );
    expect(result.success).toBe(true);
    expect(state.uploads).toEqual([{ name: "releve.pdf", type: "receipt" }]);
    const tx = await Transaction.findById(transactionId).lean();
    expect(tx.receiptFiles[0].mimetype).toBe("application/pdf");
  });
});
