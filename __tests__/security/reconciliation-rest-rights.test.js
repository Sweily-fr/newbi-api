/**
 * Routes REST /reconciliation/* (link, unlink, ignore) : mêmes garde-fous
 * que les mutations GraphQL.
 *   - Membre (lecture seule), autre entreprise, visiteur : refusés, rien ne
 *     change ;
 *   - délier une paire jamais liée (transaction inexistante, facture
 *     annulée) : refus, statut inchangé ;
 *   - délier la facture de vente d'une transaction aussi rattachée à une
 *     facture importée : la transaction reste rapprochée.
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

const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, betterAuthJWTMiddleware: async () => auth.user };
});

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Transaction from "../../src/models/Transaction.js";
import Invoice from "../../src/models/Invoice.js";
import reconciliationRoutes from "../../src/routes/reconciliation.js";

const { ObjectId } = mongoose.Types;
const owner = buildUserId();
const viewer = buildUserId();
const intruder = buildUserId();
const organizationId = buildOrganizationId();
const intruderOrg = buildOrganizationId();
const ws = String(organizationId);

let server;
let baseUrl;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/reconciliation", reconciliationRoutes);
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
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
  await seedOrgMembership({ userId: viewer, organizationId, role: "viewer" });
  await seedOrgMembership({
    userId: intruder,
    organizationId: intruderOrg,
    role: "owner",
  });
});

const as = (userId) => {
  auth.user = userId ? { _id: userId, id: String(userId) } : null;
};
const post = (path, body, workspaceId = ws) =>
  fetch(`${baseUrl}/reconciliation${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-workspace-id": workspaceId,
    },
    body: JSON.stringify(body),
  });

async function transaction(fields = {}) {
  const _id = new ObjectId();
  await Transaction.collection.insertOne({
    _id,
    externalId: `tx-rest-${_id}`,
    provider: "bridge",
    type: "credit",
    status: "completed",
    amount: 1200,
    currency: "EUR",
    workspaceId: ws,
    date: new Date("2026-10-01T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    linkedInvoiceIds: [],
    linkedPurchaseInvoiceIds: [],
    linkedImportedInvoiceIds: [],
    deletedAt: null,
    ...fields,
  });
  return _id;
}
async function invoice(fields = {}) {
  const _id = new ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId: organizationId,
    number: "000077",
    prefix: "F-2026-",
    status: "PENDING",
    linkedTransactionIds: [],
    finalTotalTTC: 1200,
    ...fields,
  });
  return _id;
}
const snapshot = async (txId, invId) =>
  JSON.stringify([
    await Transaction.collection.findOne({ _id: txId }),
    await Invoice.collection.findOne({ _id: invId }),
  ]);

describe("REST /reconciliation : droits", () => {
  const cases = [
    ["Membre (lecture seule)", () => as(viewer), ws, 403],
    ["autre entreprise", () => as(intruder), ws, 403],
    ["visiteur sans session", () => as(null), ws, 401],
  ];
  for (const [label, login, workspaceId, status] of cases) {
    it(`${label} : link, unlink et ignore refusés, rien ne change`, async () => {
      const linkedInvoice = await invoice({ status: "COMPLETED" });
      const tx = await transaction({
        reconciliationStatus: "matched",
        linkedInvoiceIds: [linkedInvoice],
      });
      await Invoice.collection.updateOne(
        { _id: linkedInvoice },
        { $set: { linkedTransactionIds: [tx] } },
      );
      const freeTx = await transaction();
      const freeInvoice = await invoice();
      const before = [
        await snapshot(tx, linkedInvoice),
        await snapshot(freeTx, freeInvoice),
      ];
      login();

      for (const [path, body] of [
        [
          "/link",
          { transactionId: String(freeTx), invoiceId: String(freeInvoice) },
        ],
        [
          "/unlink",
          { transactionId: String(tx), invoiceId: String(linkedInvoice) },
        ],
        ["/ignore", { transactionId: String(freeTx) }],
      ]) {
        const res = await post(path, body, workspaceId);
        expect(res.status, `${path} (${label})`).toBe(status);
      }

      expect([
        await snapshot(tx, linkedInvoice),
        await snapshot(freeTx, freeInvoice),
      ]).toEqual(before);
    });
  }
});

describe("REST /reconciliation/unlink : paires jamais liées", () => {
  beforeEach(() => as(owner));

  it("transaction inexistante et facture annulée : refus, facture inchangée", async () => {
    const canceled = await invoice({ status: "CANCELED" });
    const res = await post("/unlink", {
      transactionId: "000000000000000000000000",
      invoiceId: String(canceled),
    });
    expect(res.status).toBe(400);
    expect((await Invoice.collection.findOne({ _id: canceled })).status).toBe(
      "CANCELED",
    );
  });

  it("transaction ignorée sans lien et facture payée à la main : refus, rien ne change", async () => {
    const paidAt = new Date("2026-09-01T00:00:00.000Z");
    const paid = await invoice({ status: "COMPLETED", paymentDate: paidAt });
    const ignored = await transaction({ reconciliationStatus: "ignored" });
    const before = await snapshot(ignored, paid);

    const res = await post("/unlink", {
      transactionId: String(ignored),
      invoiceId: String(paid),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(
      "Cette transaction n'est pas rattachée à cette facture",
    );
    expect(await snapshot(ignored, paid)).toBe(before);
  });

  it("transaction aussi rattachée à une facture importée : reste rapprochée", async () => {
    const importedId = new ObjectId();
    const linked = await invoice({ status: "COMPLETED" });
    const tx = await transaction({
      reconciliationStatus: "matched",
      linkedInvoiceIds: [linked],
      linkedImportedInvoiceIds: [importedId],
    });
    await Invoice.collection.updateOne(
      { _id: linked },
      { $set: { linkedTransactionIds: [tx] } },
    );

    const res = await post("/unlink", {
      transactionId: String(tx),
      invoiceId: String(linked),
    });

    expect(res.status).toBe(200);
    const after = await Transaction.collection.findOne({ _id: tx });
    expect(after.linkedInvoiceIds).toHaveLength(0);
    expect(after.linkedImportedInvoiceIds.map(String)).toEqual([
      String(importedId),
    ]);
    expect(after.reconciliationStatus).toBe("matched");
  });
});
