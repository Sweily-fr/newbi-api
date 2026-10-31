/**
 * Sens du rapprochement : une facture de vente (émise ou importée) se
 * rapproche d'une entrée d'argent, une facture d'achat d'une sortie. Une
 * transaction rattachée ne peut pas être ignorée sans être déliée. Mêmes
 * gardes par GraphQL et par les routes REST /reconciliation/*.
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
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    importedInvoicesBucketName: "imported",
  },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Transaction from "../../src/models/Transaction.js";
import Invoice from "../../src/models/Invoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import reconciliationResolvers from "../../src/resolvers/reconciliationResolvers.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import reconciliationRoutes from "../../src/routes/reconciliation.js";

const { ObjectId } = mongoose.Types;
const owner = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);
const R = reconciliationResolvers.Mutation;

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
  auth.user = { _id: owner, id: String(owner), email: "owner@test.fr" };
});

const ctx = () => buildContext({ userId: owner, organizationId });
const post = (path, body) =>
  fetch(`${baseUrl}/reconciliation${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-workspace-id": ws },
    body: JSON.stringify(body),
  });

let n = 0;
async function transaction(fields = {}) {
  n += 1;
  const _id = new ObjectId();
  await Transaction.collection.insertOne({
    _id,
    externalId: `tx-sens-${n}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -400,
    currency: "EUR",
    description: "PRLV FOURNISSEUR",
    workspaceId: ws,
    date: new Date("2026-10-01T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    linkedInvoiceIds: [],
    linkedPurchaseInvoiceIds: [],
    linkedImportedInvoiceIds: [],
    reconciliationLinks: [],
    deletedAt: null,
    ...fields,
  });
  return _id;
}

async function salesInvoice(fields = {}) {
  const _id = new ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId: organizationId,
    number: "000042",
    prefix: "F-2026-",
    status: "PENDING",
    linkedTransactionIds: [],
    finalTotalTTC: 1000,
    ...fields,
  });
  return _id;
}

async function purchaseInvoice(fields = {}) {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: owner,
    supplierName: "Fournisseur Sens",
    invoiceNumber: "SENS-1",
    issueDate: new Date("2026-09-20T00:00:00.000Z"),
    amountTTC: 400,
    status: "TO_PAY",
    files: [],
    linkedTransactionIds: [],
    isReconciled: false,
    ...fields,
  });
  return insertedId;
}

const rawInvoice = (id) => Invoice.collection.findOne({ _id: id });
const rawTransaction = (id) => Transaction.collection.findOne({ _id: id });

describe("facture de vente : une sortie d'argent est refusée", () => {
  it("linkTransactionToInvoice avec un prélèvement : refus, rien ne change", async () => {
    const tx = await transaction({ amount: -49.99 });
    const invoiceId = await salesInvoice();

    const result = await R.linkTransactionToInvoice(
      null,
      { input: { transactionId: String(tx), invoiceId: String(invoiceId) } },
      ctx(),
    );

    expect(result).toMatchObject({
      success: false,
      message:
        "Une sortie d'argent ne peut pas être rapprochée d'une facture de vente.",
    });
    const invoice = await rawInvoice(invoiceId);
    expect(invoice.status).toBe("PENDING");
    expect(invoice.linkedTransactionIds).toHaveLength(0);
    const fresh = await rawTransaction(tx);
    expect(fresh.reconciliationStatus).toBe("unmatched");
    expect(fresh.linkedInvoiceIds).toHaveLength(0);
  });

  it("un encaissement reste rapprochable (paiement partiel : facture payée)", async () => {
    const tx = await transaction({ type: "credit", amount: 400 });
    const invoiceId = await salesInvoice();

    const result = await R.linkTransactionToInvoice(
      null,
      { input: { transactionId: String(tx), invoiceId: String(invoiceId) } },
      ctx(),
    );

    expect(result.success).toBe(true);
    // Comportement actuel documenté : 400 € sur 1 000 € passent la facture
    // en « payée » (pas de statut partiel).
    expect((await rawInvoice(invoiceId)).status).toBe("COMPLETED");
  });

  it("une transaction saisie à la main n'est pas contrôlée", async () => {
    const tx = await transaction({ provider: "manual", amount: -400 });
    const invoiceId = await salesInvoice();

    const result = await R.linkTransactionToInvoice(
      null,
      { input: { transactionId: String(tx), invoiceId: String(invoiceId) } },
      ctx(),
    );
    expect(result.success).toBe(true);
  });

  it("linkTransactionToImportedInvoice avec un prélèvement : refus", async () => {
    const tx = await transaction({ amount: -1200 });
    const imported = await ImportedInvoice.create({
      workspaceId: organizationId,
      importedBy: owner,
      status: "VALIDATED",
      source: "QONTO",
      originalInvoiceNumber: "Q-2026-0099",
      vendor: { name: "Ma Société" },
      client: { name: "Client Importé" },
      invoiceDate: new Date("2026-09-10T00:00:00.000Z"),
      totalHT: 1000,
      totalVAT: 200,
      totalTTC: 1200,
      file: {
        url: "https://r2.example.com/x.pdf",
        cloudflareKey: `${ws}/x.pdf`,
        originalFileName: "x.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
      },
    });

    const result = await R.linkTransactionToImportedInvoice(
      null,
      {
        input: {
          transactionId: String(tx),
          importedInvoiceId: String(imported._id),
        },
      },
      ctx(),
    );

    expect(result).toMatchObject({
      success: false,
      message:
        "Une sortie d'argent ne peut pas être rapprochée d'une facture de vente.",
    });
    expect(
      (await ImportedInvoice.collection.findOne({ _id: imported._id })).status,
    ).toBe("VALIDATED");
  });

  it("REST /reconciliation/link avec un prélèvement : 400, rien ne change", async () => {
    const tx = await transaction({ amount: -400 });
    const invoiceId = await salesInvoice();

    const res = await post("/link", {
      transactionId: String(tx),
      invoiceId: String(invoiceId),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error:
        "Une sortie d'argent ne peut pas être rapprochée d'une facture de vente.",
    });
    expect((await rawInvoice(invoiceId)).status).toBe("PENDING");
    expect((await rawTransaction(tx)).linkedInvoiceIds).toHaveLength(0);
  });

  it("REST /reconciliation/link sur une facture annulée : 400, rien ne change", async () => {
    const tx = await transaction({ type: "credit", amount: 1000 });
    const invoiceId = await salesInvoice({ status: "CANCELED" });

    const res = await post("/link", {
      transactionId: String(tx),
      invoiceId: String(invoiceId),
    });

    expect(res.status).toBe(400);
    expect((await rawInvoice(invoiceId)).status).toBe("CANCELED");
  });
});

describe("facture d'achat : une entrée d'argent est refusée", () => {
  it("reconcilePurchaseInvoice avec un virement reçu : refus, rien ne change", async () => {
    const tx = await transaction({ type: "credit", amount: 400 });
    const invoiceId = await purchaseInvoice();

    await expect(
      purchaseInvoiceResolvers.Mutation.reconcilePurchaseInvoice(
        null,
        { purchaseInvoiceId: String(invoiceId), transactionIds: [String(tx)] },
        ctx(),
      ),
    ).rejects.toThrow(
      "Une entrée d'argent ne peut pas être rapprochée d'une facture d'achat.",
    );

    const invoice = await PurchaseInvoice.collection.findOne({
      _id: invoiceId,
    });
    expect(invoice.status).toBe("TO_PAY");
    expect(invoice.linkedTransactionIds).toHaveLength(0);
    expect((await rawTransaction(tx)).reconciliationStatus).toBe("unmatched");
  });

  it("un prélèvement reste rapprochable", async () => {
    const tx = await transaction({ amount: -400 });
    const invoiceId = await purchaseInvoice();

    const result =
      await purchaseInvoiceResolvers.Mutation.reconcilePurchaseInvoice(
        null,
        { purchaseInvoiceId: String(invoiceId), transactionIds: [String(tx)] },
        ctx(),
      );
    expect(result.status).toBe("PAID");
  });
});

describe("ignorer une transaction rattachée : refusé", () => {
  it("ignoreTransaction sur une transaction rapprochée : refus, liens et statut gardés", async () => {
    const invoiceId = await salesInvoice({ status: "COMPLETED" });
    const tx = await transaction({
      type: "credit",
      amount: 1000,
      reconciliationStatus: "matched",
      linkedInvoiceIds: [invoiceId],
    });

    const result = await R.ignoreTransaction(
      null,
      { input: { transactionId: String(tx) } },
      ctx(),
    );

    expect(result).toEqual({
      success: false,
      message:
        "Cette transaction est rattachée à une facture : déliez-la avant de l'ignorer.",
    });
    const fresh = await rawTransaction(tx);
    expect(fresh.reconciliationStatus).toBe("matched");
    expect(fresh.linkedInvoiceIds.map(String)).toEqual([String(invoiceId)]);
  });

  it("REST /reconciliation/ignore sur une transaction rattachée à une facture d'achat : 400", async () => {
    const purchaseId = await purchaseInvoice({ status: "PAID" });
    const tx = await transaction({
      reconciliationStatus: "matched",
      linkedPurchaseInvoiceIds: [purchaseId],
    });

    const res = await post("/ignore", { transactionId: String(tx) });

    expect(res.status).toBe(400);
    expect((await rawTransaction(tx)).reconciliationStatus).toBe("matched");
  });

  it("une transaction sans lien est ignorée, puis réintégrée", async () => {
    const tx = await transaction();

    const ignored = await R.ignoreTransaction(
      null,
      { input: { transactionId: String(tx) } },
      ctx(),
    );
    expect(ignored.success).toBe(true);
    expect((await rawTransaction(tx)).reconciliationStatus).toBe("ignored");

    const back = await R.unignoreTransaction(
      null,
      { input: { transactionId: String(tx) } },
      ctx(),
    );
    expect(back.success).toBe(true);
    expect((await rawTransaction(tx)).reconciliationStatus).toBe("unmatched");
  });
});
