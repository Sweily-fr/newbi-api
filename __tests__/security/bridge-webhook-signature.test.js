/**
 * Webhooks bancaires : signature obligatoire, périmètre limité à l'espace
 * de l'utilisateur Bridge, et page de test publique muette.
 *   - POST /webhook/bridge : sans signature, ou signée pour un autre corps,
 *     refusé (401) sans aucun effet ; corps brut signé : traité ;
 *   - account.disconnected : seul le compte de l'espace de l'utilisateur
 *     Bridge est retiré, ses transactions et justificatifs restent ;
 *   - GET /webhook/bridge/test ne révèle ni l'URL ni la présence du secret ;
 *   - POST /banking/webhook/* : routes retirées (toujours refusées, le corps
 *     était déjà lu), aucun traitement.
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
  process.env.BRIDGE_WEBHOOK_SECRET = "secret-webhook-test";
  process.env.BRIDGE_WEBHOOK_URL = "https://api.newbi.test/webhook/bridge";
  process.env.PAYPAL_WEBHOOK_SECRET = "secret-paypal-test";
});

const bridge = vi.hoisted(() => ({
  workspaceByUuid: {},
  syncs: 0,
  handled: 0,
}));
vi.mock("../../src/services/banking/index.js", () => ({
  bankingService: {
    initialize: async () => {},
    handleWebhook: async () => {
      bridge.handled += 1;
      return true;
    },
    currentProvider: {
      getBridgeUserByUuid: async (uuid) =>
        bridge.workspaceByUuid[uuid]
          ? { uuid, external_user_id: bridge.workspaceByUuid[uuid] }
          : null,
      syncUserAccounts: async () => {
        bridge.syncs += 1;
      },
      syncAllTransactions: async () => {
        bridge.syncs += 1;
      },
      syncTransactions: async () => {
        bridge.syncs += 1;
      },
    },
  },
}));

import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import Transaction from "../../src/models/Transaction.js";
import webhookRoutes from "../../src/routes/webhook.js";
import bankingRoutes from "../../src/routes/banking.js";

const { ObjectId } = mongoose.Types;
const wsA = String(buildOrganizationId());
const wsB = String(buildOrganizationId());

let server;
let baseUrl;

const sign = (body, secret = process.env.BRIDGE_WEBHOOK_SECRET) =>
  `v1=${crypto.createHmac("sha256", secret).update(body).digest("hex").toUpperCase()}`;

const postWebhook = (path, body, headers = {}) =>
  fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });

beforeAll(async () => {
  await startMongo();
  const app = express();
  // Même ordre que server.js : /webhook avant express.json, /banking après.
  app.use("/webhook", webhookRoutes);
  app.use(express.json());
  app.use("/banking", bankingRoutes);
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
  bridge.workspaceByUuid = { "uuid-a": wsA };
  bridge.syncs = 0;
  bridge.handled = 0;
});

const account = (workspaceId, externalId) => ({
  _id: new ObjectId(),
  externalId,
  provider: "bridge",
  name: "Compte courant",
  type: "checking",
  status: "active",
  balance: 100,
  currency: "EUR",
  workspaceId,
});

describe("POST /webhook/bridge : signature", () => {
  const body = JSON.stringify({
    type: "account.disconnected",
    content: { user_uuid: "uuid-a", account_id: 777 },
  });

  beforeEach(async () => {
    await AccountBanking.collection.insertOne(account(wsA, "777"));
  });

  it("sans en-tête de signature : 401, rien ne change", async () => {
    const res = await postWebhook("/webhook/bridge", body);
    expect(res.status).toBe(401);
    expect((await AccountBanking.collection.findOne({})).status).toBe("active");
  });

  it("signature d'un autre corps : 401, rien ne change", async () => {
    const res = await postWebhook("/webhook/bridge", body, {
      "bridgeapi-signature": sign('{"type":"TEST_EVENT"}'),
    });
    expect(res.status).toBe(401);
    expect((await AccountBanking.collection.findOne({})).status).toBe("active");
  });

  it("signature faite avec un autre secret : 401", async () => {
    const res = await postWebhook("/webhook/bridge", body, {
      "bridgeapi-signature": sign(body, "autre-secret"),
    });
    expect(res.status).toBe(401);
  });

  it("corps brut signé : 200", async () => {
    const test = JSON.stringify({ type: "TEST_EVENT" });
    const res = await postWebhook("/webhook/bridge", test, {
      "bridgeapi-signature": sign(test),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });
});

describe("account.disconnected : périmètre et conservation", () => {
  it("seul le compte de l'espace de l'utilisateur Bridge est retiré, ses transactions restent", async () => {
    // Index unique provider + externalId : le compte d'un autre espace a son
    // propre identifiant Bridge, visé plus bas par un second webhook
    const own = account(wsA, "888");
    const elsewhere = account(wsB, "890");
    const otherOwn = account(wsA, "889");
    await AccountBanking.collection.insertMany([own, elsewhere, otherOwn]);
    const txId = new ObjectId();
    await Transaction.collection.insertOne({
      _id: txId,
      externalId: "tx-webhook-1",
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -12,
      currency: "EUR",
      workspaceId: wsA,
      fromAccount: "888",
      date: new Date(),
      receiptFiles: [{ _id: new ObjectId(), key: `${wsA}/ticket.pdf` }],
    });

    const body = JSON.stringify({
      type: "account.disconnected",
      content: { user_uuid: "uuid-a", account_id: 888 },
    });
    const res = await postWebhook("/webhook/bridge", body, {
      "bridgeapi-signature": sign(body),
    });
    expect(res.status).toBe(200);

    expect(
      await AccountBanking.collection.findOne({ _id: own._id }),
    ).toBeNull();
    expect(
      (await AccountBanking.collection.findOne({ _id: elsewhere._id })).status,
    ).toBe("active");
    expect(
      (await AccountBanking.collection.findOne({ _id: otherOwn._id })).status,
    ).toBe("active");
    const tx = await Transaction.collection.findOne({ _id: txId });
    expect(tx.receiptFiles).toHaveLength(1);

    // Le compte d'un autre espace visé par l'utilisateur Bridge de l'espace A
    const foreign = JSON.stringify({
      type: "account.disconnected",
      content: { user_uuid: "uuid-a", account_id: 890 },
    });
    const resForeign = await postWebhook("/webhook/bridge", foreign, {
      "bridgeapi-signature": sign(foreign),
    });
    expect(resForeign.status).toBe(200);
    expect(
      (await AccountBanking.collection.findOne({ _id: elsewhere._id })).status,
    ).toBe("active");
  });

  it("utilisateur Bridge inconnu : rien ne change", async () => {
    await AccountBanking.collection.insertOne(account(wsB, "999"));
    const body = JSON.stringify({
      type: "account.disconnected",
      content: { user_uuid: "uuid-inconnu", account_id: 999 },
    });
    const res = await postWebhook("/webhook/bridge", body, {
      "bridgeapi-signature": sign(body),
    });
    expect(res.status).toBe(200);
    expect((await AccountBanking.collection.findOne({})).status).toBe("active");
  });
});

describe("GET /webhook/bridge/test", () => {
  it("ne révèle ni l'URL configurée ni la présence du secret", async () => {
    const res = await fetch(`${baseUrl}/webhook/bridge/test`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("api.newbi.test");
    expect(text).not.toMatch(/secret/i);
  });
});

describe("POST /banking/webhook/* : routes retirées", () => {
  for (const [path, header] of [
    ["/banking/webhook/bridge", "bridgeapi-signature"],
    ["/banking/webhook/stripe", "stripe-signature"],
    ["/banking/webhook/paypal", "paypal-transmission-sig"],
  ]) {
    // Plus de route : la requête tombe sur le contrôle de session des
    // routes bancaires (401), jamais sur un traitement
    it(`${path} : n'existe plus, refusé sans traitement`, async () => {
      const body = JSON.stringify({ type: "account.disconnected" });
      expect([401, 404]).toContain((await postWebhook(path, body)).status);
      expect([401, 404]).toContain(
        (await postWebhook(path, body, { [header]: "v1=FORGEE" })).status,
      );
      expect(bridge.handled).toBe(0);
    });
  }
});
