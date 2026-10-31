/**
 * Déliaison transaction ↔ facture de vente : elle n'agit que sur un lien
 * existant, et ne rétablit « en attente » que si c'est le rapprochement qui
 * avait passé la facture en « payée ».
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
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: vi.fn().mockResolvedValue(true) },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Transaction from "../../src/models/Transaction.js";
import Invoice from "../../src/models/Invoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import reconciliationResolvers from "../../src/resolvers/reconciliationResolvers.js";

const { ObjectId } = mongoose.Types;
const owner = buildUserId();
const editor = buildUserId();
const accountant = buildUserId();
const organizationId = buildOrganizationId();
const workspaceId = organizationId.toString();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
  await seedOrgMembership({ userId: editor, organizationId, role: "member" });
  await seedOrgMembership({
    userId: accountant,
    organizationId,
    role: "accountant",
  });
});

const ctx = (userId = owner) => buildContext({ userId, organizationId });

let n = 0;
async function createTransaction(fields = {}) {
  n += 1;
  const _id = new ObjectId();
  await Transaction.collection.insertOne({
    _id,
    externalId: `tx-unlink-${n}`,
    provider: "bridge",
    type: "credit",
    status: "completed",
    amount: 1200,
    currency: "EUR",
    description: "VIR CLIENT",
    workspaceId,
    date: new Date("2026-09-20T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    linkedInvoiceIds: [],
    ...fields,
  });
  return String(_id);
}

async function createInvoice(fields = {}) {
  const _id = new ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId: organizationId,
    number: "000010",
    prefix: "F-2026-",
    status: "PENDING",
    linkedTransactionIds: [],
    finalTotalTTC: 1200,
    ...fields,
  });
  return String(_id);
}

const link = (transactionId, invoiceId, userId = owner) =>
  reconciliationResolvers.Mutation.linkTransactionToInvoice(
    null,
    { input: { transactionId, invoiceId } },
    ctx(userId),
  );
const unlink = (transactionId, invoiceId, userId = owner) =>
  reconciliationResolvers.Mutation.unlinkTransactionFromInvoice(
    null,
    { input: { transactionId, invoiceId } },
    ctx(userId),
  );
const rawInvoice = (id) =>
  Invoice.collection.findOne({ _id: new ObjectId(id) });
const rawTransaction = (id) =>
  Transaction.collection.findOne({ _id: new ObjectId(id) });

describe("unlinkTransactionFromInvoice : lien inexistant", () => {
  const paidAt = new Date("2026-09-01T00:00:00.000Z");
  const cases = [
    ["annulée", { status: "CANCELED" }],
    ["brouillon", { status: "DRAFT", number: "DRAFT-0003" }],
    ["payée hors rapprochement", { status: "COMPLETED", paymentDate: paidAt }],
  ];

  for (const [role, userId] of [
    ["Éditeur", editor],
    ["Comptable", accountant],
  ]) {
    for (const [label, fields] of cases) {
      it(`${role} : facture ${label} inchangée, transaction ignorée inchangée`, async () => {
        const invoiceId = await createInvoice(fields);
        const transactionId = await createTransaction({
          reconciliationStatus: "ignored",
        });

        const result = await unlink(transactionId, invoiceId, userId);

        expect(result.success).toBe(false);
        expect(result.message).toBe(
          "Cette transaction n'est pas rattachée à cette facture",
        );
        const invoice = await rawInvoice(invoiceId);
        expect(invoice.status).toBe(fields.status);
        expect(invoice.number).toBe(fields.number || "000010");
        if (fields.paymentDate) {
          expect(invoice.paymentDate).toEqual(fields.paymentDate);
        }
        expect((await rawTransaction(transactionId)).reconciliationStatus).toBe(
          "ignored",
        );
      });
    }
  }

  it("refuse une transaction d'un autre espace", async () => {
    const invoiceId = await createInvoice({ status: "COMPLETED" });
    const foreign = await createTransaction({
      workspaceId: buildOrganizationId().toString(),
    });

    const result = await unlink(foreign, invoiceId);

    expect(result).toMatchObject({
      success: false,
      message: "Transaction ou facture introuvable",
    });
    expect((await rawInvoice(invoiceId)).status).toBe("COMPLETED");
  });
});

describe("unlinkTransactionFromInvoice : lien existant", () => {
  it("facture payée par le rapprochement : repasse en attente à la dernière déliaison", async () => {
    const invoiceId = await createInvoice({ status: "PENDING" });
    const t1 = await createTransaction();
    const t2 = await createTransaction();
    expect((await link(t1, invoiceId)).success).toBe(true);
    expect((await link(t2, invoiceId)).success).toBe(true);
    expect((await rawInvoice(invoiceId)).paidByReconciliation).toBe(true);

    expect((await unlink(t1, invoiceId)).success).toBe(true);
    expect((await rawInvoice(invoiceId)).status).toBe("COMPLETED");

    const result = await unlink(t2, invoiceId);
    expect(result.success).toBe(true);
    const invoice = await rawInvoice(invoiceId);
    expect(invoice.status).toBe("PENDING");
    expect(invoice.paymentDate).toBeNull();
    expect(invoice.linkedTransactionIds).toEqual([]);
    expect(invoice.paidByReconciliation).toBeUndefined();
    expect((await rawTransaction(t2)).reconciliationStatus).toBe("unmatched");
  });

  it("facture déjà payée avant le rapprochement : reste payée après déliaison", async () => {
    const paidAt = new Date("2026-09-01T00:00:00.000Z");
    const invoiceId = await createInvoice({
      status: "COMPLETED",
      paymentDate: paidAt,
    });
    const t1 = await createTransaction();
    await link(t1, invoiceId);
    expect((await rawInvoice(invoiceId)).paidByReconciliation).toBe(false);

    const result = await unlink(t1, invoiceId);

    expect(result.success).toBe(true);
    const invoice = await rawInvoice(invoiceId);
    expect(invoice.status).toBe("COMPLETED");
    expect(invoice.paymentDate).toEqual(paidAt);
    expect(invoice.linkedTransactionIds).toEqual([]);
    expect((await rawTransaction(t1)).reconciliationStatus).toBe("unmatched");
  });

  it("lien antérieur sans indicateur : comportement inchangé (retour en attente)", async () => {
    const t1 = await createTransaction({ reconciliationStatus: "matched" });
    const invoiceId = await createInvoice({
      status: "COMPLETED",
      paymentDate: new Date("2026-09-20T00:00:00.000Z"),
      linkedTransactionIds: [new ObjectId(t1)],
    });
    await Transaction.collection.updateOne(
      { _id: new ObjectId(t1) },
      { $set: { linkedInvoiceIds: [new ObjectId(invoiceId)] } },
    );

    expect((await unlink(t1, invoiceId)).success).toBe(true);
    const invoice = await rawInvoice(invoiceId);
    expect(invoice.status).toBe("PENDING");
    expect(invoice.paymentDate).toBeNull();
  });
});

describe("unlinkTransactionFromImportedInvoice : lien inexistant", () => {
  it("facture importée encaissée hors rapprochement : statut inchangé", async () => {
    const imported = await ImportedInvoice.collection.insertOne({
      workspaceId: organizationId,
      status: "COMPLETED",
      paymentDate: new Date("2026-09-01T00:00:00.000Z"),
      linkedTransactionIds: [],
      originalInvoiceNumber: "Q-1",
    });
    const transactionId = await createTransaction();

    const result =
      await reconciliationResolvers.Mutation.unlinkTransactionFromImportedInvoice(
        null,
        {
          input: {
            transactionId,
            importedInvoiceId: String(imported.insertedId),
          },
        },
        ctx(editor),
      );

    expect(result.success).toBe(false);
    const after = await ImportedInvoice.collection.findOne({
      _id: imported.insertedId,
    });
    expect(after.status).toBe("COMPLETED");
  });
});
