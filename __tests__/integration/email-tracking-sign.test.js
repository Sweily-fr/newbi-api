import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo } from "../helpers/mongo.js";
import emailTrackingRoutes from "../../src/routes/emailTracking.js";
import Quote from "../../src/models/Quote.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";

const { ObjectId } = mongoose.Types;

const TOKEN = "a".repeat(64);
const SIGNING_URL = "https://sign.provider.test/session/xyz";

let server;
let baseUrl;
let quoteId;

async function seedQuote({ withTracking = true } = {}) {
  const workspaceId = new ObjectId();
  const quote = await Quote.create({
    number: "0041",
    prefix: "D-082026",
    status: "PENDING",
    issueDate: new Date(),
    client: {
      name: "Client Test",
      email: "client@test.fr",
      type: "COMPANY",
      address: {
        street: "1 rue du Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    companyInfo: {
      name: "Holany Courcier",
      email: "contact@test.fr",
      address: {
        street: "1 rue du Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    items: [
      {
        description: "Prestation",
        quantity: 1,
        unitPrice: 100,
        vatRate: 20,
        unit: "unité",
      },
    ],
    totalHT: 100,
    totalTTC: 120,
    totalVAT: 20,
    finalTotalHT: 100,
    finalTotalTTC: 120,
    workspaceId,
    createdBy: new ObjectId(),
    emailTracking: withTracking
      ? {
          trackingToken: TOKEN,
          emailSentAt: new Date(),
          emailOpenedAt: null,
          emailOpenCount: 0,
          emailClickedAt: null,
          emailClickCount: 0,
        }
      : undefined,
  });
  return quote;
}

beforeAll(async () => {
  await startMongo();

  const quote = await seedQuote();
  quoteId = quote._id;

  await SignatureRequest.create({
    organizationId: quote.workspaceId.toString(),
    workspaceId: quote.workspaceId,
    documentType: "quote",
    documentId: quote._id,
    documentNumber: quote.number,
    signatureType: "SES",
    status: "WAIT_SIGNER",
    signers: [
      {
        name: "Jean",
        surname: "Dupont",
        email: "client@test.fr",
        signingUrl: SIGNING_URL,
      },
    ],
    signingUrl: SIGNING_URL,
  });

  const app = express();
  app.use("/tracking", emailTrackingRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

describe("GET /tracking/sign/:token/:signerIndex", () => {
  it("redirige vers l'URL de signature du signataire et enregistre clic + ouverture", async () => {
    const res = await fetch(`${baseUrl}/tracking/sign/${TOKEN}/0`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(SIGNING_URL);

    const quote = await Quote.findById(quoteId).lean();
    expect(quote.emailTracking.emailClickCount).toBe(1);
    expect(quote.emailTracking.emailClickedAt).toBeTruthy();
    // Un clic implique une ouverture, même si le pixel a été bloqué
    expect(quote.emailTracking.emailOpenCount).toBe(1);
    expect(quote.emailTracking.emailOpenedAt).toBeTruthy();
  });

  it("incrémente les compteurs sans écraser les premières dates", async () => {
    const before = await Quote.findById(quoteId).lean();
    const res = await fetch(`${baseUrl}/tracking/sign/${TOKEN}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const after = await Quote.findById(quoteId).lean();
    expect(after.emailTracking.emailClickCount).toBe(2);
    expect(new Date(after.emailTracking.emailClickedAt).getTime()).toBe(
      new Date(before.emailTracking.emailClickedAt).getTime(),
    );
  });

  it("redirige vers le site Newbi pour un token inconnu", async () => {
    const res = await fetch(`${baseUrl}/tracking/sign/${"f".repeat(64)}/0`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      process.env.FRONTEND_URL || "https://www.newbi.fr",
    );
  });
});

describe("GET /tracking/open/:token (pixel)", () => {
  it("sert le pixel et enregistre l'ouverture", async () => {
    const res = await fetch(`${baseUrl}/tracking/open/${TOKEN}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/gif");

    const quote = await Quote.findById(quoteId).lean();
    expect(quote.emailTracking.emailOpenCount).toBeGreaterThanOrEqual(2);
  });
});
