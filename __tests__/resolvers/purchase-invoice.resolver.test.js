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

// External side effects we don't exercise here
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    uploadImage: vi.fn().mockResolvedValue({
      url: "https://test.r2.dev/test.pdf",
      key: "test.pdf",
    }),
  },
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: {
    getReceivedInvoices: vi.fn(),
    transformReceivedInvoiceToPurchaseInvoice: vi.fn(),
    submitInvoiceEvent: vi.fn(),
  },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { isEInvoicingEnabled: vi.fn() },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Transaction from "../../src/models/Transaction.js";
import Supplier from "../../src/models/Supplier.js";
import superPdpService from "../../src/services/superPdpService.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

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

const insertPurchaseInvoice = (overrides = {}) =>
  PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    supplierName: "Acme Supplier",
    invoiceNumber: "PI-001",
    issueDate: new Date(),
    amountTTC: 1200,
    amountHT: 1000,
    vatAmount: 200,
    status: "TO_PAY",
    files: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });

describe("PurchaseInvoice Resolver - Query.purchaseInvoice", () => {
  const resolver = purchaseInvoiceResolvers.Query.purchaseInvoice;

  it("returns a purchase invoice by id", async () => {
    const { insertedId } = await insertPurchaseInvoice({
      invoiceNumber: "PI-042",
    });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(result.invoiceNumber).toBe("PI-042");
  });

  it("throws NOT_FOUND when document does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      /non trouvée/i,
    );
  });

  it("does not leak across workspaces", async () => {
    const otherOrg = buildOrganizationId();
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: otherOrg,
      createdBy: userId,
      supplierName: "Other Supplier",
      invoiceNumber: "PI-9999",
      issueDate: new Date(),
      amountTTC: 100,
      status: "TO_PAY",
      files: [],
    });

    await expect(
      resolver(null, { id: insertedId.toString() }, ctx()),
    ).rejects.toThrow(/non trouvée/i);
  });
});

describe("PurchaseInvoice Resolver - Query.purchaseInvoices", () => {
  const resolver = purchaseInvoiceResolvers.Query.purchaseInvoices;

  it("returns paginated list", async () => {
    for (let i = 0; i < 25; i++) {
      await insertPurchaseInvoice({ invoiceNumber: `PI-${i}` });
    }

    const result = await resolver(
      null,
      { workspaceId: organizationId.toString(), page: 1, limit: 10 },
      ctx(),
    );

    expect(result.totalCount).toBe(25);
    expect(result.totalPages).toBe(3);
    expect(result.items).toHaveLength(10);
  });

  it("filters by status", async () => {
    await insertPurchaseInvoice({ status: "TO_PAY" });
    await insertPurchaseInvoice({ status: "PAID" });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        status: "PAID",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("filters by amount range", async () => {
    await insertPurchaseInvoice({ amountTTC: 100 });
    await insertPurchaseInvoice({ amountTTC: 500 });
    await insertPurchaseInvoice({ amountTTC: 1000 });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        minAmount: 200,
        maxAmount: 800,
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("supports search on supplierName/invoiceNumber", async () => {
    await insertPurchaseInvoice({
      supplierName: "Acme Co",
      invoiceNumber: "X1",
    });
    await insertPurchaseInvoice({
      supplierName: "Beta Inc",
      invoiceNumber: "Y1",
    });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        search: "Acme",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
  });

  it("cherche une saisie avec parenthèses sans planter", async () => {
    await insertPurchaseInvoice({
      supplierName: "Acme (UK)",
      invoiceNumber: "X1",
    });
    await insertPurchaseInvoice({
      supplierName: "Acme Co",
      invoiceNumber: "Y1",
    });

    const result = await resolver(
      null,
      {
        workspaceId: organizationId.toString(),
        search: "(UK",
        page: 1,
        limit: 10,
      },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
    expect(result.items[0].supplierName).toBe("Acme (UK)");
  });
});

describe("PurchaseInvoice Resolver - Mutation.deletePurchaseInvoice", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.deletePurchaseInvoice;

  it("deletes a purchase invoice", async () => {
    const { insertedId } = await insertPurchaseInvoice();

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(result).toEqual({
      success: true,
      message: "Facture d'achat supprimée",
    });
    expect(
      await PurchaseInvoice.collection.findOne({ _id: insertedId }),
    ).toBeNull();
  });

  it("throws when document does not exist", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    await expect(resolver(null, { id: fakeId }, ctx())).rejects.toThrow(
      /non trouvée/i,
    );
  });

  it("blocks viewer role from deleting", async () => {
    const viewerUserId = buildUserId();
    const viewerOrg = buildOrganizationId();
    await seedOrgMembership({
      userId: viewerUserId,
      organizationId: viewerOrg,
      role: "viewer",
    });
    const { insertedId } = await PurchaseInvoice.collection.insertOne({
      workspaceId: viewerOrg,
      createdBy: viewerUserId,
      supplierName: "x",
      invoiceNumber: "x",
      issueDate: new Date(),
      amountTTC: 1,
      status: "TO_PAY",
      files: [],
    });

    const viewerCtx = buildContext({
      userId: viewerUserId,
      organizationId: viewerOrg,
    });

    await expect(
      resolver(null, { id: insertedId.toString() }, viewerCtx),
    ).rejects.toThrow(/permission|delete/i);
  });
});

describe("PurchaseInvoice Resolver - Mutation.updatePurchaseInvoice (OCR à compléter)", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.updatePurchaseInvoice;

  it("une facture « À compléter » (partial) devient vérifiée à l'enregistrement", async () => {
    const { insertedId } = await insertPurchaseInvoice({
      ocrMetadata: { provider: "tesseract", extractionQuality: "partial" },
    });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        input: { supplierName: "Blue Harbor Supply Co." },
      },
      ctx(),
    );

    expect(result.supplierName).toBe("Blue Harbor Supply Co.");
    expect(result.ocrMetadata.extractionQuality).toBe("reviewed");
    expect(result.ocrMetadata.provider).toBe("tesseract");
    const saved = await PurchaseInvoice.findById(insertedId);
    expect(saved.ocrMetadata.extractionQuality).toBe("reviewed");
  });

  it("une facture « none » devient vérifiée aussi, une facture « full » ne change pas", async () => {
    const none = await insertPurchaseInvoice({
      ocrMetadata: { extractionQuality: "none" },
    });
    const full = await insertPurchaseInvoice({
      invoiceNumber: "PI-002",
      ocrMetadata: { provider: "claude-vision", extractionQuality: "full" },
    });

    const r1 = await resolver(
      null,
      { id: none.insertedId.toString(), input: { notes: "vérifiée" } },
      ctx(),
    );
    const r2 = await resolver(
      null,
      { id: full.insertedId.toString(), input: { notes: "ok" } },
      ctx(),
    );

    expect(r1.ocrMetadata.extractionQuality).toBe("reviewed");
    expect(r2.ocrMetadata.extractionQuality).toBe("full");
  });
});

describe("PurchaseInvoice Resolver - TVA à plusieurs taux", () => {
  const create = purchaseInvoiceResolvers.Mutation.createPurchaseInvoice;
  const update = purchaseInvoiceResolvers.Mutation.updatePurchaseInvoice;
  // Note de restaurant : plats à 10 %, boissons alcoolisées à 20 %
  const RESTAURANT = [
    { rate: 10, baseHT: 80, amountTVA: 8 },
    { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
  ];
  const insertMultiRate = () =>
    insertPurchaseInvoice({
      amountHT: 115.36,
      amountTVA: 15.07,
      vatRate: 10,
      amountTTC: 130.43,
      vatBreakdown: [
        { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
        { rate: 10, baseHT: 80, amountTVA: 8 },
      ],
    });

  it("création : le détail par taux est gardé et résume HT / TVA / taux", async () => {
    const invoice = await create(
      null,
      {
        input: {
          workspaceId: organizationId.toString(),
          supplierName: "Brasserie du Port",
          issueDate: "2026-10-01",
          amountHT: 0,
          amountTVA: 0,
          vatRate: 20,
          amountTTC: 130.43,
          vatBreakdown: RESTAURANT,
          forceCreate: true,
        },
      },
      ctx(),
    );

    const saved = await PurchaseInvoice.findById(invoice._id).lean();
    expect(saved.vatBreakdown).toEqual([
      { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
      { rate: 10, baseHT: 80, amountTVA: 8 },
    ]);
    expect(saved.amountHT).toBe(115.36);
    expect(saved.amountTVA).toBe(15.07);
    expect(saved.vatRate).toBe(10);
  });

  it("mise à jour depuis l'app mobile (montants renvoyés inchangés) : détail conservé", async () => {
    const { insertedId } = await insertMultiRate();

    await update(
      null,
      {
        id: insertedId.toString(),
        input: {
          amountHT: 115.36,
          amountTVA: 15.07,
          vatRate: 10,
          amountTTC: 130.43,
          notes: "relu sur mobile",
        },
      },
      ctx(),
    );

    const saved = await PurchaseInvoice.findById(insertedId).lean();
    expect(saved.vatBreakdown).toHaveLength(2);
    expect(saved.notes).toBe("relu sur mobile");
  });

  it("TVA modifiée à un seul taux sans détail : le détail périmé est effacé", async () => {
    const { insertedId } = await insertMultiRate();

    await update(
      null,
      {
        id: insertedId.toString(),
        input: { amountHT: 108.69, amountTVA: 21.74, vatRate: 20 },
      },
      ctx(),
    );

    const saved = await PurchaseInvoice.findById(insertedId).lean();
    expect(saved.vatBreakdown).toEqual([]);
    expect(saved.vatRate).toBe(20);
    expect(saved.amountTVA).toBe(21.74);
  });

  it("mise à jour avec un nouveau détail : HT / TVA / taux recalculés, TTC intact", async () => {
    const { insertedId } = await insertMultiRate();

    const result = await update(
      null,
      {
        id: insertedId.toString(),
        input: {
          vatBreakdown: [
            { rate: 20, baseHT: 35.36, amountTVA: 7.07 },
            { rate: 10, baseHT: 70, amountTVA: 7 },
            { rate: 5.5, baseHT: 10, amountTVA: 0.55 },
          ],
        },
      },
      ctx(),
    );

    expect(result.vatBreakdown).toHaveLength(3);
    expect(result.amountHT).toBe(115.36);
    expect(result.amountTVA).toBe(14.62);
    expect(result.vatRate).toBe(10);
    expect(result.amountTTC).toBe(130.43);
  });

  it("facture antérieure lue en .lean() : vatBreakdown vaut une liste vide", () => {
    expect(
      purchaseInvoiceResolvers.PurchaseInvoice.vatBreakdown({ vatRate: 20 }),
    ).toEqual([]);
  });
});

describe("PurchaseInvoice Resolver - Mutation.markPurchaseInvoiceAsPaid", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.markPurchaseInvoiceAsPaid;

  it("marks invoice as paid with payment date and method", async () => {
    const { insertedId } = await insertPurchaseInvoice({ status: "TO_PAY" });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        paymentDate: "2026-03-10",
        paymentMethod: "BANK_TRANSFER",
      },
      ctx(),
    );

    expect(result.status).toBe("PAID");
    expect(result.paymentMethod).toBe("BANK_TRANSFER");
  });
});

describe("PurchaseInvoice Resolver - Mutation.bulkUpdatePurchaseInvoiceStatus", () => {
  const resolver =
    purchaseInvoiceResolvers.Mutation.bulkUpdatePurchaseInvoiceStatus;

  it("bulk updates statuses for ids in workspace", async () => {
    const { insertedId: a } = await insertPurchaseInvoice({ status: "TO_PAY" });
    const { insertedId: b } = await insertPurchaseInvoice({ status: "TO_PAY" });
    const { insertedId: c } = await insertPurchaseInvoice({ status: "TO_PAY" });

    const result = await resolver(
      null,
      { ids: [a.toString(), b.toString(), c.toString()], status: "PAID" },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.updatedCount).toBe(3);

    const remaining = await PurchaseInvoice.collection.countDocuments({
      _id: { $in: [a, b, c] },
      status: "PAID",
    });
    expect(remaining).toBe(3);
  });
});

describe("PurchaseInvoice Resolver - submitPurchaseInvoiceEInvoiceEvent", () => {
  const resolver =
    purchaseInvoiceResolvers.Mutation.submitPurchaseInvoiceEInvoiceEvent;

  it("émet fr:207 et passe l'e-facture en DISPUTED", async () => {
    superPdpService.submitInvoiceEvent.mockReset();
    superPdpService.submitInvoiceEvent.mockResolvedValue({ success: true });
    const { insertedId } = await insertPurchaseInvoice({
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-77",
      eInvoiceStatus: "RECEIVED",
    });

    const result = await resolver(
      null,
      {
        id: insertedId.toString(),
        statusCode: "fr:207",
        reason: "Montant erroné",
      },
      ctx(),
    );

    const call = superPdpService.submitInvoiceEvent.mock.calls[0];
    expect(call[1]).toBe("sp-77");
    expect(call[2]).toBe("fr:207");
    expect(call[3]).toEqual({ reason: "Montant erroné" });
    expect(result.eInvoiceStatus).toBe("DISPUTED");
  });

  it("rejette un code de statut non supporté", async () => {
    const { insertedId } = await insertPurchaseInvoice({
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-78",
      eInvoiceStatus: "RECEIVED",
    });

    await expect(
      resolver(
        null,
        { id: insertedId.toString(), statusCode: "fr:999" },
        ctx(),
      ),
    ).rejects.toThrow(/non supporté/i);
  });

  it("rejette une facture non liée à SuperPDP", async () => {
    const { insertedId } = await insertPurchaseInvoice();
    await expect(
      resolver(
        null,
        { id: insertedId.toString(), statusCode: "fr:205" },
        ctx(),
      ),
    ).rejects.toThrow(/SuperPDP/i);
  });
});

describe("PurchaseInvoice Resolver - markPurchaseInvoiceAsPaid (e-invoicing)", () => {
  const resolver = purchaseInvoiceResolvers.Mutation.markPurchaseInvoiceAsPaid;

  it("signale le paiement à SuperPDP et passe l'e-facture en PAID", async () => {
    superPdpService.submitInvoiceEvent.mockReset();
    superPdpService.submitInvoiceEvent.mockResolvedValue({ success: true });
    const { insertedId } = await insertPurchaseInvoice({
      source: "SUPERPDP",
      superPdpInvoiceId: "sp-90",
      eInvoiceStatus: "ACCEPTED",
    });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    const call = superPdpService.submitInvoiceEvent.mock.calls[0];
    expect(call[1]).toBe("sp-90");
    expect(call[2]).toBe("fr:211");
    expect(result.status).toBe("PAID");
    expect(result.eInvoiceStatus).toBe("PAID");
  });

  it("ne touche pas SuperPDP pour une facture saisie manuellement", async () => {
    superPdpService.submitInvoiceEvent.mockReset();
    const { insertedId } = await insertPurchaseInvoice({ source: "MANUAL" });

    const result = await resolver(null, { id: insertedId.toString() }, ctx());

    expect(superPdpService.submitInvoiceEvent).not.toHaveBeenCalled();
    expect(result.status).toBe("PAID");
  });
});

describe("PurchaseInvoice Resolver - rapprochement N↔N", () => {
  const reconcile = purchaseInvoiceResolvers.Mutation.reconcilePurchaseInvoice;
  const unlink =
    purchaseInvoiceResolvers.Mutation.unlinkPurchaseInvoiceFromTransaction;
  const unreconcile =
    purchaseInvoiceResolvers.Mutation.unreconcilePurchaseInvoice;

  let txCounter = 0;
  const createDebit = (overrides = {}) => {
    txCounter += 1;
    return Transaction.create({
      externalId: `tx-pi-${txCounter}`,
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -1200,
      currency: "EUR",
      description: "PRLV ACME",
      workspaceId: organizationId,
      date: new Date("2026-08-02T00:00:00.000Z"),
      ...overrides,
    });
  };

  it("ajoute une transaction aux liens existants au lieu de les remplacer", async () => {
    const { insertedId } = await insertPurchaseInvoice();
    const tx1 = await createDebit();
    const tx2 = await createDebit({ amount: -30 });

    await reconcile(
      null,
      { purchaseInvoiceId: insertedId.toString(), transactionIds: [tx1._id] },
      ctx(),
    );
    const result = await reconcile(
      null,
      { purchaseInvoiceId: insertedId.toString(), transactionIds: [tx2._id] },
      ctx(),
    );

    expect(result.linkedTransactionIds.map(String).sort()).toEqual(
      [tx1._id.toString(), tx2._id.toString()].sort(),
    );
    expect(result.status).toBe("PAID");
    expect(result.isReconciled).toBe(true);

    for (const tx of [tx1, tx2]) {
      const fresh = await Transaction.findById(tx._id);
      expect(fresh.reconciliationStatus).toBe("matched");
      expect(fresh.linkedPurchaseInvoiceIds.map(String)).toEqual([
        insertedId.toString(),
      ]);
    }
  });

  it("refuse une paire déjà liée (pas de doublon silencieux)", async () => {
    const { insertedId } = await insertPurchaseInvoice();
    const tx = await createDebit();
    await reconcile(
      null,
      { purchaseInvoiceId: insertedId.toString(), transactionIds: [tx._id] },
      ctx(),
    );
    await expect(
      reconcile(
        null,
        { purchaseInvoiceId: insertedId.toString(), transactionIds: [tx._id] },
        ctx(),
      ),
    ).rejects.toThrow(/déjà rapprochée/);
  });

  it("une transaction peut porter plusieurs factures d'achat", async () => {
    const a = await insertPurchaseInvoice({ invoiceNumber: "A" });
    const b = await insertPurchaseInvoice({ invoiceNumber: "B" });
    const tx = await createDebit();

    await reconcile(
      null,
      { purchaseInvoiceId: a.insertedId.toString(), transactionIds: [tx._id] },
      ctx(),
    );
    await reconcile(
      null,
      { purchaseInvoiceId: b.insertedId.toString(), transactionIds: [tx._id] },
      ctx(),
    );

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.linkedPurchaseInvoiceIds.map(String).sort()).toEqual(
      [a.insertedId.toString(), b.insertedId.toString()].sort(),
    );
  });

  it("délie une seule transaction : la facture reste payée tant qu'il en reste une", async () => {
    const { insertedId } = await insertPurchaseInvoice();
    const tx1 = await createDebit();
    const tx2 = await createDebit({ amount: -30 });
    await reconcile(
      null,
      {
        purchaseInvoiceId: insertedId.toString(),
        transactionIds: [tx1._id, tx2._id],
      },
      ctx(),
    );

    const afterFirst = await unlink(
      null,
      { purchaseInvoiceId: insertedId.toString(), transactionId: tx1._id },
      ctx(),
    );
    expect(afterFirst.linkedTransactionIds.map(String)).toEqual([
      tx2._id.toString(),
    ]);
    expect(afterFirst.status).toBe("PAID");
    expect(afterFirst.isReconciled).toBe(true);

    const freshTx1 = await Transaction.findById(tx1._id);
    expect(freshTx1.reconciliationStatus).toBe("unmatched");
    expect(freshTx1.linkedPurchaseInvoiceIds).toHaveLength(0);
    const freshTx2 = await Transaction.findById(tx2._id);
    expect(freshTx2.reconciliationStatus).toBe("matched");

    const afterSecond = await unlink(
      null,
      { purchaseInvoiceId: insertedId.toString(), transactionId: tx2._id },
      ctx(),
    );
    expect(afterSecond.linkedTransactionIds).toHaveLength(0);
    expect(afterSecond.status).toBe("TO_PAY");
    expect(afterSecond.isReconciled).toBe(false);
    expect(afterSecond.paymentDate).toBeNull();
  });

  it("délier ne repasse pas 'unmatched' une transaction qui porte encore une autre facture d'achat", async () => {
    const a = await insertPurchaseInvoice({ invoiceNumber: "A" });
    const b = await insertPurchaseInvoice({ invoiceNumber: "B" });
    const tx = await createDebit();
    for (const id of [a.insertedId, b.insertedId]) {
      await reconcile(
        null,
        { purchaseInvoiceId: id.toString(), transactionIds: [tx._id] },
        ctx(),
      );
    }

    await unlink(
      null,
      { purchaseInvoiceId: a.insertedId.toString(), transactionId: tx._id },
      ctx(),
    );

    const fresh = await Transaction.findById(tx._id);
    expect(fresh.reconciliationStatus).toBe("matched");
    expect(fresh.linkedPurchaseInvoiceIds.map(String)).toEqual([
      b.insertedId.toString(),
    ]);
  });

  it("unreconcilePurchaseInvoice retire toujours tous les liens", async () => {
    const { insertedId } = await insertPurchaseInvoice();
    const tx1 = await createDebit();
    const tx2 = await createDebit({ amount: -30 });
    await reconcile(
      null,
      {
        purchaseInvoiceId: insertedId.toString(),
        transactionIds: [tx1._id, tx2._id],
      },
      ctx(),
    );
    const result = await unreconcile(
      null,
      { purchaseInvoiceId: insertedId.toString() },
      ctx(),
    );
    expect(result.linkedTransactionIds).toHaveLength(0);
    expect(result.status).toBe("TO_PAY");
    for (const tx of [tx1, tx2]) {
      const fresh = await Transaction.findById(tx._id);
      expect(fresh.reconciliationStatus).toBe("unmatched");
    }
  });
});

describe("PurchaseInvoice Resolver - Query.purchaseInvoiceDuplicates", () => {
  const query = purchaseInvoiceResolvers.Query.purchaseInvoiceDuplicates;

  it("remonte une facture existante au même numéro", async () => {
    const { insertedId } = await insertPurchaseInvoice({
      invoiceNumber: "HOST-2026-0721",
      supplierName: "Hostinger",
      amountTTC: 30.98,
    });
    const result = await query(
      null,
      {
        workspaceId: organizationId.toString(),
        input: {
          supplierName: "hostinger",
          invoiceNumber: "HOST-2026-0721",
          amountTTC: 30.98,
        },
      },
      ctx(),
    );
    expect(result.map((r) => r.id)).toEqual([insertedId.toString()]);
  });
});

describe("PurchaseInvoice Resolver - Query.suppliers (recherche)", () => {
  it("cherche une saisie avec parenthèses sans planter", async () => {
    await Supplier.collection.insertMany([
      { workspaceId: organizationId, name: "Orange (Business)" },
      { workspaceId: organizationId, name: "Orange" },
    ]);

    const result = await purchaseInvoiceResolvers.Query.suppliers(
      null,
      { workspaceId: organizationId.toString(), search: "(Business" },
      ctx(),
    );

    expect(result.totalCount).toBe(1);
    expect(result.items[0].name).toBe("Orange (Business)");
  });
});
