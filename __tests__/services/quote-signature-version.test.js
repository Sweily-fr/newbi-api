/**
 * Signature électronique d'un devis : la version signée est celle acceptée.
 * - Un devis dont une demande de signature client est en cours ne se
 *   modifie pas et ne repasse pas en brouillon.
 * - La demande garde l'empreinte du devis envoyé : une signature terminée
 *   n'accepte automatiquement le devis que s'il n'a pas changé.
 * - Un état reçu pour une demande annulée ne la réactive pas.
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

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/qontoSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/abbySyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/esignatureService.js", () => ({
  default: {
    deleteSignature: vi.fn().mockResolvedValue(undefined),
    downloadSignedDocument: vi.fn().mockRejectedValue(new Error("hors test")),
  },
}));
vi.mock("../../src/services/esignaturePubsub.js", () => ({
  publishSignatureStatus: vi.fn(),
  signatureChannel: () => "signature",
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Quote from "../../src/models/Quote.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import { acceptQuoteOnSignature } from "../../src/services/quoteSignatureSync.js";
import { quoteContentHash } from "../../src/utils/quoteContentHash.js";
import esignatureWebhookRoutes from "../../src/routes/esignature-webhook.js";

const { ObjectId } = mongoose.Types;
const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

let server;
let baseUrl;
const WEBHOOK_SECRET = "secret-webhook-test";
process.env.ESIGNATURE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const item = (unitPrice) => ({
  description: "Prestation",
  quantity: 1,
  unitPrice,
  vatRate: 20,
});

async function insertQuote(fields = {}) {
  const { insertedId } = await Quote.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    status: "PENDING",
    number: "000004",
    prefix: "D-202610",
    issueDate: new Date("2026-10-01T00:00:00.000Z"),
    validUntil: new Date("2026-11-01T00:00:00.000Z"),
    items: [item(1000)],
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalVAT: 200,
    finalTotalTTC: 1200,
    discount: 0,
    discountType: "FIXED",
    client: {
      id: "client-1",
      name: "Acme",
      email: "acme@test.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return insertedId;
}

async function insertSignature(quoteId, fields = {}) {
  const quote = await Quote.findById(quoteId);
  const doc = await SignatureRequest.create({
    organizationId: String(organizationId),
    workspaceId: organizationId,
    documentType: "quote",
    documentId: quoteId,
    documentNumber: quote.number,
    signatureType: "SES",
    status: "WAIT_SIGNER",
    externalSignatureId: `ext-${new ObjectId()}`,
    documentHash: quoteContentHash(quote),
    signers: [{ name: "Jean", surname: "Client", email: "jean@acme.fr" }],
    ...fields,
  });
  return doc;
}

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use("/api/esignature/webhook", esignatureWebhookRoutes);
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
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

describe("modification pendant une signature en cours", () => {
  it("updateQuote refuse, le devis reste celui envoyé", async () => {
    const quoteId = await insertQuote();
    await insertSignature(quoteId);

    await expect(
      quoteResolvers.Mutation.updateQuote(
        null,
        { id: String(quoteId), input: { items: [item(10000)] } },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
      message:
        "Une demande de signature est en cours pour ce devis : annulez-la avant de le modifier.",
    });
    const stored = await Quote.collection.findOne({ _id: quoteId });
    expect(stored.finalTotalTTC).toBe(1200);
  });

  it("updateQuote reste permis sans demande active (annulée ou cachet seul)", async () => {
    const quoteId = await insertQuote();
    await insertSignature(quoteId, { status: "CANCELLED" });
    await insertSignature(quoteId, {
      signatureType: "QES_automatic",
      status: "WAIT_SIGN",
    });

    const result = await quoteResolvers.Mutation.updateQuote(
      null,
      { id: String(quoteId), input: { headerNotes: "Notes corrigées" } },
      ctx(),
    );
    expect(result.headerNotes).toBe("Notes corrigées");
  });

  it("changeQuoteStatus refuse le retour en brouillon", async () => {
    const quoteId = await insertQuote();
    await insertSignature(quoteId);

    await expect(
      quoteResolvers.Mutation.changeQuoteStatus(
        null,
        {
          id: String(quoteId),
          workspaceId: String(organizationId),
          status: "DRAFT",
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    expect((await Quote.collection.findOne({ _id: quoteId })).status).toBe(
      "PENDING",
    );
  });
});

describe("acceptation automatique à la signature", () => {
  it("accepte le devis signé tel qu'envoyé", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId, { status: "DONE" });

    expect(await acceptQuoteOnSignature(request)).toBe(true);
    expect((await Quote.collection.findOne({ _id: quoteId })).status).toBe(
      "COMPLETED",
    );
  });

  it("n'accepte pas un devis modifié depuis l'envoi en signature", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId, { status: "DONE" });
    await Quote.collection.updateOne(
      { _id: quoteId },
      { $set: { "items.0.unitPrice": 10000, finalTotalTTC: 12000 } },
    );

    expect(await acceptQuoteOnSignature(request)).toBe(false);
    expect((await Quote.collection.findOne({ _id: quoteId })).status).toBe(
      "PENDING",
    );
    expect(
      (await SignatureRequest.findById(request._id)).autoAcceptBlockedReason,
    ).toBe("DOCUMENT_CHANGED");
  });

  it("l'empreinte ignore les champs techniques du devis", async () => {
    const quoteId = await insertQuote();
    const before = quoteContentHash(await Quote.findById(quoteId));
    await Quote.collection.updateOne(
      { _id: quoteId },
      {
        $set: {
          emailTracking: { emailSentAt: new Date() },
          cachedPdf: { key: "k", url: "u" },
          archivedPdfKey: "archive",
          updatedAt: new Date(),
        },
      },
    );
    expect(quoteContentHash(await Quote.findById(quoteId))).toBe(before);
  });

  it("une demande sans empreinte (antérieure) garde le comportement d'avant", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId, {
      status: "DONE",
      documentHash: undefined,
    });
    await Quote.collection.updateOne(
      { _id: quoteId },
      { $set: { finalTotalTTC: 12000 } },
    );

    expect(await acceptQuoteOnSignature(request)).toBe(true);
  });
});

describe("webhook : demande annulée", () => {
  it("un état DONE reçu après annulation ne réactive pas la demande ni n'accepte le devis", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId, { status: "CANCELLED" });

    const response = await fetch(`${baseUrl}/api/esignature/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        id: request.externalSignatureId,
        state: "DONE",
        custom: { signatureRequestId: String(request._id) },
      }),
    });

    expect(response.status).toBe(200);
    expect((await SignatureRequest.findById(request._id)).status).toBe(
      "CANCELLED",
    );
    expect((await Quote.collection.findOne({ _id: quoteId })).status).toBe(
      "PENDING",
    );
  });
});
