/**
 * Import Gmail des factures : une pièce jointe annoncée PDF par
 * l'expéditeur n'est importée que si son contenu est un PDF, et elle est
 * toujours stockée sous une extension .pdf, quel que soit son nom
 * (« facture.pdf.svg », « x.html »…). Sinon un SVG ou un HTML piégé
 * finirait affiché sur l'origine du site après conversion en facture d'achat.
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
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
});

const state = vi.hoisted(() => ({ uploads: [], attachments: {}, parts: [] }));

vi.mock("../../src/services/gmail/GmailOAuthProvider.js", () => ({
  translateGmailError: (error) => error?.message || "Erreur Gmail",
  default: class {
    async ensureValidToken() {
      return "jeton";
    }
    getGmailClient() {
      return {
        users: {
          messages: {
            list: async () => ({ data: { messages: [{ id: "msg-1" }] } }),
            get: async () => ({
              data: {
                id: "msg-1",
                threadId: "thread-1",
                payload: {
                  headers: [
                    { name: "Subject", value: "Votre facture" },
                    { name: "From", value: "fournisseur@exemple.test" },
                  ],
                  parts: state.parts,
                },
              },
            }),
            attachments: {
              get: async ({ id }) => ({
                data: {
                  data: state.attachments[id]
                    .toString("base64")
                    .replace(/\+/g, "-")
                    .replace(/\//g, "_"),
                },
              }),
            },
          },
        },
      };
    }
  },
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    uploadImage: async (buffer, name, userId, type, orgId) => {
      state.uploads.push(name);
      return {
        key: `${orgId}/${name}`,
        url: `https://imported.r2.test/${orgId}/${name}`,
      };
    },
  },
}));
vi.mock("../../src/services/hybridOcrService.js", () => ({
  default: {
    processDocumentFromUrl: async () => ({ success: false, error: "test" }),
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import GmailConnection from "../../src/models/GmailConnection.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import { scanGmailConnection } from "../../src/services/gmail/GmailScannerService.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();

const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF");
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

let connectionId;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  state.uploads = [];
  state.attachments = {};
  state.parts = [];
  connectionId = new mongoose.Types.ObjectId();
  await GmailConnection.collection.insertOne({
    _id: connectionId,
    userId,
    workspaceId,
    accountEmail: "compta@exemple.test",
    isActive: true,
    scanPeriodMonths: 3,
    status: "active",
    totalEmailsScanned: 0,
    totalInvoicesFound: 0,
  });
});

function attach(id, filename, mimeType, content) {
  state.attachments[id] = content;
  state.parts.push({
    filename,
    mimeType,
    body: { attachmentId: id, size: content.length },
  });
}

const scan = () => scanGmailConnection(connectionId, { isInitialScan: true });

describe("import Gmail : pièces jointes annoncées PDF", () => {
  it("« facture.pdf.svg » au contenu SVG : ignorée, rien envoyé ni importé", async () => {
    attach("a1", "facture.pdf.svg", "application/pdf", SVG);
    const result = await scan();
    expect(result.success).toBe(true);
    expect(state.uploads).toEqual([]);
    expect(await ImportedInvoice.countDocuments({})).toBe(0);
  });

  it("« x.html » annoncée PDF : ignorée", async () => {
    attach("a2", "x.html", "application/pdf", HTML);
    await scan();
    expect(state.uploads).toEqual([]);
    expect(await ImportedInvoice.countDocuments({})).toBe(0);
  });

  it("vrai PDF nommé « facture.pdf.svg » : importé et stocké en .pdf", async () => {
    attach("a3", "facture.pdf.svg", "application/pdf", PDF);
    await scan();
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]).toMatch(/\.pdf$/);
    expect(state.uploads[0]).not.toMatch(/svg/);
    const imported = await ImportedInvoice.findOne({}).lean();
    expect(imported.file.mimeType).toBe("application/pdf");
    expect(imported.file.cloudflareKey).toMatch(/\.pdf$/);
  });

  it("PDF envoyé en application/octet-stream avec un nom en .pdf : importé", async () => {
    attach("a4", "releve.pdf", "application/octet-stream", PDF);
    await scan();
    expect(state.uploads).toEqual(["releve.pdf"]);
    expect(await ImportedInvoice.countDocuments({})).toBe(1);
  });

  it("dans un même courriel, seule la pièce PDF est importée", async () => {
    attach("a5", "piege.pdf", "application/pdf", SVG);
    attach("a6", "facture.pdf", "application/pdf", PDF);
    await scan();
    expect(state.uploads).toEqual(["facture.pdf"]);
    expect(await ImportedInvoice.countDocuments({})).toBe(1);
  });
});
