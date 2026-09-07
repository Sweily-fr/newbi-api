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
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    importedInvoicesBucketName: "imported",
  },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Transaction from "../../src/models/Transaction.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import reconciliationResolvers from "../../src/resolvers/reconciliationResolvers.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";
import { detachTransactionsFromDocuments } from "../../src/utils/reconciliation-cleanup.js";
import { buildTabPredicate } from "../../src/utils/transaction-page-query.js";

const userId = buildUserId();
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
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

const ctx = () => buildContext({ userId, organizationId });

let n = 0;
const createCredit = (overrides = {}) => {
  n += 1;
  return Transaction.create({
    externalId: `tx-imp-${n}`,
    provider: "bridge",
    type: "credit",
    status: "completed",
    amount: 1200,
    currency: "EUR",
    description: "VIR SEPA LAB DEVELOPPEMENTS",
    workspaceId,
    date: new Date("2026-08-28T00:00:00.000Z"),
    ...overrides,
  });
};

const createImported = (overrides = {}) =>
  ImportedInvoice.create({
    workspaceId: organizationId,
    importedBy: userId,
    status: "VALIDATED",
    source: "QONTO",
    originalInvoiceNumber: "Q-2026-0042",
    vendor: { name: "Ma Société" },
    client: { name: "Lab Developpements" },
    invoiceDate: new Date("2026-08-10T00:00:00.000Z"),
    dueDate: new Date("2026-09-10T00:00:00.000Z"),
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    file: {
      url: "https://r2.example.com/x.pdf",
      cloudflareKey: `${workspaceId}/x.pdf`,
      originalFileName: "x.pdf",
      mimeType: "application/pdf",
      fileSize: 10,
    },
    ...overrides,
  });

const link = (transactionId, importedInvoiceId) =>
  reconciliationResolvers.Mutation.linkTransactionToImportedInvoice(
    null,
    { input: { transactionId, importedInvoiceId } },
    ctx(),
  );
const unlink = (transactionId, importedInvoiceId) =>
  reconciliationResolvers.Mutation.unlinkTransactionFromImportedInvoice(
    null,
    { input: { transactionId, importedInvoiceId } },
    ctx(),
  );

describe("linkTransactionToImportedInvoice", () => {
  it("lie des deux côtés, passe la facture en COMPLETED à la date du virement", async () => {
    const tx = await createCredit();
    const inv = await createImported();

    const result = await link(tx._id.toString(), inv._id.toString());
    expect(result.success).toBe(true);
    expect(result.invoice.number).toBe("Q-2026-0042");
    expect(result.invoice.clientName).toBe("Lab Developpements");

    const freshTx = await Transaction.findById(tx._id);
    expect(freshTx.reconciliationStatus).toBe("matched");
    expect(freshTx.linkedImportedInvoiceIds.map(String)).toEqual([
      inv._id.toString(),
    ]);
    const freshInv = await ImportedInvoice.findById(inv._id);
    expect(freshInv.status).toBe("COMPLETED");
    expect(freshInv.paymentDate.toISOString()).toBe(
      "2026-08-28T00:00:00.000Z",
    );
    expect(freshInv.linkedTransactionIds.map(String)).toEqual([
      tx._id.toString(),
    ]);
  });

  it("est idempotent et N↔N (un virement pour deux factures, deux virements pour une facture)", async () => {
    const tx = await createCredit();
    const a = await createImported({ originalInvoiceNumber: "A" });
    const b = await createImported({ originalInvoiceNumber: "B" });
    await link(tx._id.toString(), a._id.toString());
    await link(tx._id.toString(), a._id.toString());
    await link(tx._id.toString(), b._id.toString());
    const tx2 = await createCredit({ amount: 300 });
    await link(tx2._id.toString(), a._id.toString());

    const freshTx = await Transaction.findById(tx._id);
    expect(freshTx.linkedImportedInvoiceIds).toHaveLength(2);
    const freshA = await ImportedInvoice.findById(a._id);
    expect(freshA.linkedTransactionIds.map(String).sort()).toEqual(
      [tx._id.toString(), tx2._id.toString()].sort(),
    );
  });

  it("refuse une facture rejetée ou archivée, ou d'un autre workspace", async () => {
    const tx = await createCredit();
    const rejected = await createImported({ status: "REJECTED" });
    const res = await link(tx._id.toString(), rejected._id.toString());
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/REJECTED/);

    const foreign = await ImportedInvoice.create({
      workspaceId: buildOrganizationId(),
      importedBy: userId,
      totalTTC: 10,
      file: {
        url: "https://r2.example.com/y.pdf",
        cloudflareKey: "other/y.pdf",
        originalFileName: "y.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
      },
    });
    const res2 = await link(tx._id.toString(), foreign._id.toString());
    expect(res2.success).toBe(false);
    const freshTx = await Transaction.findById(tx._id);
    expect(freshTx.reconciliationStatus).toBe("unmatched");
  });
});

describe("unlinkTransactionFromImportedInvoice", () => {
  it("retire le lien ; la transaction redevient à rapprocher seulement sans aucun lien", async () => {
    const tx = await createCredit();
    const a = await createImported({ originalInvoiceNumber: "A" });
    const b = await createImported({ originalInvoiceNumber: "B" });
    await link(tx._id.toString(), a._id.toString());
    await link(tx._id.toString(), b._id.toString());

    await unlink(tx._id.toString(), a._id.toString());
    let freshTx = await Transaction.findById(tx._id);
    expect(freshTx.reconciliationStatus).toBe("matched");
    const freshA = await ImportedInvoice.findById(a._id);
    expect(freshA.status).toBe("VALIDATED");
    expect(freshA.paymentDate).toBeNull();
    expect(freshA.linkedTransactionIds).toHaveLength(0);

    await unlink(tx._id.toString(), b._id.toString());
    freshTx = await Transaction.findById(tx._id);
    expect(freshTx.reconciliationStatus).toBe("unmatched");
    expect(freshTx.reconciliationDate).toBeNull();
  });

  it("une facture liée à deux virements reste encaissée après une déliaison", async () => {
    const tx1 = await createCredit();
    const tx2 = await createCredit({ amount: 300 });
    const inv = await createImported();
    await link(tx1._id.toString(), inv._id.toString());
    await link(tx2._id.toString(), inv._id.toString());
    await unlink(tx1._id.toString(), inv._id.toString());
    const fresh = await ImportedInvoice.findById(inv._id);
    expect(fresh.status).toBe("COMPLETED");
    expect(fresh.linkedTransactionIds.map(String)).toEqual([
      tx2._id.toString(),
    ]);
  });
});

describe("filtre « à rapprocher » et nettoyages", () => {
  it("une transaction liée seulement à une facture importée n'est plus « à rapprocher »", async () => {
    const tx = await createCredit();
    const inv = await createImported();
    await link(tx._id.toString(), inv._id.toString());
    const predicate = buildTabPredicate("TO_RECONCILE");
    const count = await Transaction.countDocuments({
      workspaceId,
      ...predicate,
    });
    expect(count).toBe(0);
  });

  it("supprimer la facture importée détache la transaction", async () => {
    const tx = await createCredit();
    const inv = await createImported();
    await link(tx._id.toString(), inv._id.toString());

    await importedInvoiceResolvers.Mutation.deleteImportedInvoice(
      null,
      { id: inv._id.toString() },
      { ...ctx(), workspaceId },
    );

    const freshTx = await Transaction.findById(tx._id);
    expect(freshTx.linkedImportedInvoiceIds).toHaveLength(0);
    expect(freshTx.reconciliationStatus).toBe("unmatched");
  });

  it("supprimer la transaction détache la facture importée", async () => {
    const tx = await createCredit();
    const inv = await createImported();
    await link(tx._id.toString(), inv._id.toString());

    await detachTransactionsFromDocuments([tx._id], workspaceId);

    const fresh = await ImportedInvoice.findById(inv._id);
    expect(fresh.linkedTransactionIds).toHaveLength(0);
    expect(mongoose.isValidObjectId(fresh._id)).toBe(true);
  });
});

describe("queries de rattachement manuel", () => {
  it("importedInvoicesForTransaction et transactionsForImportedInvoice scorent montant + client", async () => {
    const tx = await createCredit();
    const inv = await createImported();
    await createImported({
      originalInvoiceNumber: "OTHER",
      client: { name: "Quelqu'un" },
      totalTTC: 50,
    });

    const byTx =
      await reconciliationResolvers.Query.importedInvoicesForTransaction(
        null,
        { transactionId: tx._id.toString() },
        ctx(),
      );
    expect(byTx.invoices[0].id).toBe(inv._id.toString());
    expect(byTx.invoices[0].score).toBe(150);
    expect(byTx.invoices[1].score).toBe(0);

    const byInv =
      await reconciliationResolvers.Query.transactionsForImportedInvoice(
        null,
        { importedInvoiceId: inv._id.toString() },
        ctx(),
      );
    expect(byInv.transactions.map((t) => t.id)).toEqual([tx._id.toString()]);
    expect(byInv.transactions[0].score).toBe(150);
    expect(byInv.invoiceAmount).toBe(1200);
  });
});
