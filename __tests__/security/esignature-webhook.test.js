/**
 * Webhook de la signature électronique (POST /api/esignature/webhook).
 *
 * - Avec un secret configuré : sans en-tête, avec un mauvais secret ou un
 *   secret plus long, refus 401 et aucune demande modifiée.
 * - En production sans secret configuré : refus 401.
 * - Identifiants hostiles : un opérateur MongoDB à la place d'un identifiant,
 *   ou l'identifiant interne d'une demande dont l'identifiant chez le
 *   prestataire n'est pas celui du message, ne modifient aucune demande et
 *   n'acceptent aucun devis.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
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
vi.mock("../../src/services/esignatureDocuments.js", () => ({
  storeSignedDocuments: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/esignaturePubsub.js", () => ({
  publishSignatureStatus: vi.fn(),
  signatureChannel: () => "signature",
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Quote from "../../src/models/Quote.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";
import { quoteContentHash } from "../../src/utils/quoteContentHash.js";
import esignatureWebhookRoutes from "../../src/routes/esignature-webhook.js";

const { ObjectId } = mongoose.Types;
const userId = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();

const SECRET = "secret-du-webhook-de-test";
const ENV_AVANT = {
  NODE_ENV: process.env.NODE_ENV,
  ESIGNATURE_WEBHOOK_SECRET: process.env.ESIGNATURE_WEBHOOK_SECRET,
};

let server;
let baseUrl;

async function insertQuote(workspaceId = organizationId, fields = {}) {
  const { insertedId } = await Quote.collection.insertOne({
    workspaceId,
    createdBy: userId,
    status: "PENDING",
    number: "000001",
    prefix: "D-202610",
    issueDate: new Date("2026-10-01T00:00:00.000Z"),
    validUntil: new Date("2026-11-01T00:00:00.000Z"),
    items: [
      { description: "Prestation", quantity: 1, unitPrice: 1000, vatRate: 20 },
    ],
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

async function insertSignature(
  quoteId,
  workspaceId = organizationId,
  fields = {},
) {
  const quote = await Quote.findById(quoteId);
  return SignatureRequest.create({
    organizationId: String(workspaceId),
    workspaceId,
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
}

/** Demande et devis tels qu'en base, sans les dates de mise à jour. */
async function snapshot() {
  const requests = await SignatureRequest.collection
    .find({})
    .sort({ _id: 1 })
    .toArray();
  const quotes = await Quote.collection.find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify({
    requests: requests.map(({ updatedAt, ...r }) => r),
    quotes: quotes.map(({ updatedAt, ...q }) => q),
  });
}

function post(body, headers = {}) {
  return fetch(`${baseUrl}/api/esignature/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
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
  process.env.NODE_ENV = "test";
  process.env.ESIGNATURE_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  for (const [key, value] of Object.entries(ENV_AVANT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("webhook e-signature : authentification", () => {
  const cases = [
    ["sans en-tête", {}],
    [
      "avec un mauvais secret",
      { "x-webhook-secret": "pas-le-bon-secret-du-webhook" },
    ],
    ["avec un secret plus long", { "x-webhook-secret": `${SECRET}-et-plus` }],
    ["avec un secret plus court", { "x-webhook-secret": SECRET.slice(0, -1) }],
  ];

  for (const [label, headers] of cases) {
    it(`${label} : 401, demande et devis inchangés`, async () => {
      const quoteId = await insertQuote();
      const request = await insertSignature(quoteId);
      const before = await snapshot();

      const response = await post(
        {
          id: request.externalSignatureId,
          state: "DONE",
          custom: { signatureRequestId: String(request._id) },
        },
        headers,
      );

      expect(response.status).toBe(401);
      expect(await snapshot()).toBe(before);
    });
  }

  it("avec le bon secret : la demande passe à l'état reçu et le devis est accepté", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId);

    const response = await post(
      {
        id: request.externalSignatureId,
        state: "DONE",
        custom: { signatureRequestId: String(request._id) },
      },
      { "x-webhook-secret": SECRET },
    );

    expect(response.status).toBe(200);
    expect((await SignatureRequest.findById(request._id)).status).toBe("DONE");
    expect((await Quote.collection.findOne({ _id: quoteId })).status).toBe(
      "COMPLETED",
    );
  });

  it("en production sans secret configuré : 401, rien de modifié", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.ESIGNATURE_WEBHOOK_SECRET;
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId);
    const before = await snapshot();

    const response = await post({
      id: request.externalSignatureId,
      state: "DONE",
      custom: { signatureRequestId: String(request._id) },
    });

    expect(response.status).toBe(401);
    expect(await snapshot()).toBe(before);
  });

  it("en préproduction (staging) sans secret configuré : 401, rien de modifié", async () => {
    process.env.NODE_ENV = "staging";
    delete process.env.ESIGNATURE_WEBHOOK_SECRET;
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId);
    const before = await snapshot();

    const response = await post({
      id: request.externalSignatureId,
      state: "DONE",
      custom: { signatureRequestId: String(request._id) },
    });

    expect(response.status).toBe(401);
    expect(await snapshot()).toBe(before);
  });
});

describe("webhook e-signature : identifiants hostiles", () => {
  // Hors production sans secret, le webhook est ouvert : les identifiants
  // reçus ne doivent jamais servir de filtre MongoDB.
  beforeEach(() => {
    delete process.env.ESIGNATURE_WEBHOOK_SECRET;
  });

  it("un opérateur à la place de l'identifiant interne ne modifie aucune demande", async () => {
    const quoteId = await insertQuote();
    await insertSignature(quoteId);
    const otherQuoteId = await insertQuote(otherOrganizationId, {
      number: "000002",
    });
    await insertSignature(otherQuoteId, otherOrganizationId);
    const before = await snapshot();

    const response = await post({
      state: "DONE",
      custom: { signatureRequestId: { $ne: null } },
    });

    expect(response.status).toBeLessThan(500);
    expect(await snapshot()).toBe(before);
  });

  it("un opérateur à la place de l'identifiant du prestataire ne modifie aucune demande", async () => {
    const quoteId = await insertQuote();
    await insertSignature(quoteId);
    const before = await snapshot();

    const response = await post({ id: { $ne: null }, state: "DONE" });

    expect(response.status).toBeLessThan(500);
    expect(await snapshot()).toBe(before);
  });

  it("un opérateur dans data.id ne modifie aucune demande", async () => {
    const quoteId = await insertQuote();
    await insertSignature(quoteId);
    const before = await snapshot();

    const response = await post({ data: { id: { $gt: "" }, state: "DONE" } });

    expect(response.status).toBeLessThan(500);
    expect(await snapshot()).toBe(before);
  });

  it("l'identifiant interne d'une demande d'une autre organisation, avec un autre identifiant prestataire : rien de modifié", async () => {
    const quoteId = await insertQuote();
    const ownRequest = await insertSignature(quoteId);
    const otherQuoteId = await insertQuote(otherOrganizationId, {
      number: "000002",
    });
    const otherRequest = await insertSignature(
      otherQuoteId,
      otherOrganizationId,
    );
    const before = await snapshot();

    const response = await post({
      id: ownRequest.externalSignatureId,
      state: "DONE",
      custom: { signatureRequestId: String(otherRequest._id) },
    });

    expect(response.status).toBe(200);
    expect(await snapshot()).toBe(before);
  });

  it("un identifiant interne mal formé n'interrompt pas le traitement par l'identifiant du prestataire", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId);

    const response = await post({
      id: request.externalSignatureId,
      state: "DONE",
      custom: { signatureRequestId: "pas-un-identifiant" },
    });

    expect(response.status).toBe(200);
    expect((await SignatureRequest.findById(request._id)).status).toBe("DONE");
  });

  it("l'identifiant du prestataire seul retrouve sa demande", async () => {
    const quoteId = await insertQuote();
    const request = await insertSignature(quoteId);

    const response = await post({
      id: request.externalSignatureId,
      state: "ERROR",
    });

    expect(response.status).toBe(200);
    expect((await SignatureRequest.findById(request._id)).status).toBe("ERROR");
    expect((await Quote.collection.findOne({ _id: quoteId })).status).toBe(
      "PENDING",
    );
  });
});
