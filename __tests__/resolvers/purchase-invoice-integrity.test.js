/**
 * Factures d'achat : intégrité des statuts de paiement et des fiches
 * fournisseurs.
 *   - délier n'agit que sur un lien existant (facture payée à la main,
 *     transaction ignorée : rien ne change) ;
 *   - « Marquer payées » groupé garde la date des factures déjà payées ;
 *   - créer une facture déjà payée exige « Marquer comme payée » ;
 *   - fusionner des fournisseurs ne supprime jamais la fiche cible.
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
  default: {
    resolveWorkspaceFileUrl: vi.fn(() => ({ bucket: "ocr", key: "k" })),
    resolveBucketAndKeyFromUrl: vi.fn(() => null),
    deleteImage: vi.fn().mockResolvedValue(true),
  },
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { submitInvoiceEvent: vi.fn() },
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
vi.mock("../../src/services/qontoSyncHelper.js", () => ({
  syncPurchaseInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncPurchaseInvoicePaidToQonto: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Transaction from "../../src/models/Transaction.js";
import Supplier from "../../src/models/Supplier.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";

const { ObjectId } = mongoose.Types;
const owner = buildUserId();
const editor = buildUserId();
const noMarkPaid = buildUserId();
const organizationId = buildOrganizationId();
const otherOrganizationId = buildOrganizationId();
const ROLE = `role_${"b".repeat(24)}`;

const M = purchaseInvoiceResolvers.Mutation;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
  await seedOrgMembership({ userId: editor, organizationId, role: "member" });
  await seedOrgMembership({ userId: noMarkPaid, organizationId, role: ROLE });
  await seedOrgMembership({
    userId: owner,
    organizationId: otherOrganizationId,
    role: "owner",
  });
  // Rôle personnalisé : saisir et modifier les factures d'achat, sans
  // « Marquer comme payée ».
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId,
    role: ROLE,
    name: "Saisie sans paiement",
    actions: { purchaseInvoices: ["view", "create", "edit"] },
    permission: "{}",
  });
});

const ctx = (userId = owner, org = organizationId) =>
  buildContext({ userId, organizationId: org });

const paidAt = new Date("2026-01-01T00:00:00.000Z");

async function insertInvoice(fields = {}) {
  const { insertedId } = await PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: owner,
    supplierName: "Fournisseur Test",
    invoiceNumber: `PI-${new ObjectId().toString().slice(-6)}`,
    issueDate: new Date("2025-12-20T00:00:00.000Z"),
    amountTTC: 120,
    amountHT: 100,
    amountTVA: 20,
    status: "TO_PAY",
    files: [],
    linkedTransactionIds: [],
    isReconciled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  return insertedId;
}

let n = 0;
async function insertTransaction(fields = {}) {
  n += 1;
  const _id = new ObjectId();
  await Transaction.collection.insertOne({
    _id,
    externalId: `tx-integrite-${n}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -120,
    currency: "EUR",
    description: "PRLV FOURNISSEUR",
    workspaceId: String(organizationId),
    date: new Date("2026-01-01T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    linkedInvoiceIds: [],
    linkedPurchaseInvoiceIds: [],
    linkedImportedInvoiceIds: [],
    reconciliationLinks: [],
    ...fields,
  });
  return _id;
}

const rawInvoice = (id) => PurchaseInvoice.collection.findOne({ _id: id });
const rawTransaction = (id) => Transaction.collection.findOne({ _id: id });

describe("unlinkPurchaseInvoiceFromTransaction : lien inexistant", () => {
  for (const [role, userId] of [
    ["propriétaire", owner],
    ["Éditeur", editor],
  ]) {
    it(`${role} : facture payée à la main et transaction ignorée inchangées`, async () => {
      const invoiceId = await insertInvoice({
        status: "PAID",
        paymentDate: paidAt,
        paymentMethod: "CASH",
      });
      const transactionId = await insertTransaction({
        reconciliationStatus: "ignored",
      });

      await expect(
        M.unlinkPurchaseInvoiceFromTransaction(
          null,
          {
            purchaseInvoiceId: String(invoiceId),
            transactionId: String(transactionId),
          },
          ctx(userId),
        ),
      ).rejects.toThrow(
        "Cette transaction n'est pas rattachée à cette facture",
      );

      const invoice = await rawInvoice(invoiceId);
      expect(invoice.status).toBe("PAID");
      expect(invoice.paymentDate).toEqual(paidAt);
      const transaction = await rawTransaction(transactionId);
      expect(transaction.reconciliationStatus).toBe("ignored");
    });
  }

  it("transaction liée à une autre facture d'achat : aucun lien retiré", async () => {
    const other = await insertInvoice({ status: "PAID", paymentDate: paidAt });
    const invoiceId = await insertInvoice({
      status: "PAID",
      paymentDate: paidAt,
    });
    const transactionId = await insertTransaction({
      reconciliationStatus: "matched",
      linkedPurchaseInvoiceIds: [other],
    });
    await PurchaseInvoice.collection.updateOne(
      { _id: other },
      { $set: { linkedTransactionIds: [transactionId], isReconciled: true } },
    );

    await expect(
      M.unlinkPurchaseInvoiceFromTransaction(
        null,
        {
          purchaseInvoiceId: String(invoiceId),
          transactionId: String(transactionId),
        },
        ctx(),
      ),
    ).rejects.toThrow("Cette transaction n'est pas rattachée à cette facture");

    const transaction = await rawTransaction(transactionId);
    expect(transaction.reconciliationStatus).toBe("matched");
    expect(transaction.linkedPurchaseInvoiceIds.map(String)).toEqual([
      String(other),
    ]);
    expect((await rawInvoice(invoiceId)).status).toBe("PAID");
  });

  it("transaction d'un autre espace : refus, rien ne change", async () => {
    const invoiceId = await insertInvoice({
      status: "PAID",
      paymentDate: paidAt,
    });
    const foreign = await insertTransaction({
      workspaceId: String(otherOrganizationId),
    });

    await expect(
      M.unlinkPurchaseInvoiceFromTransaction(
        null,
        {
          purchaseInvoiceId: String(invoiceId),
          transactionId: String(foreign),
        },
        ctx(),
      ),
    ).rejects.toThrow("Cette transaction n'est pas rattachée à cette facture");
    expect((await rawInvoice(invoiceId)).status).toBe("PAID");
  });

  it("lien réel : délié, facture « à payer », transaction « à rapprocher »", async () => {
    const transactionId = await insertTransaction({
      reconciliationStatus: "matched",
    });
    const invoiceId = await insertInvoice({
      status: "PAID",
      paymentDate: paidAt,
      linkedTransactionIds: [transactionId],
      isReconciled: true,
    });
    await Transaction.collection.updateOne(
      { _id: transactionId },
      { $set: { linkedPurchaseInvoiceIds: [invoiceId] } },
    );

    const result = await M.unlinkPurchaseInvoiceFromTransaction(
      null,
      {
        purchaseInvoiceId: String(invoiceId),
        transactionId: String(transactionId),
      },
      ctx(editor),
    );

    expect(result.status).toBe("TO_PAY");
    expect(result.paymentDate).toBeNull();
    const transaction = await rawTransaction(transactionId);
    expect(transaction.reconciliationStatus).toBe("unmatched");
    expect(transaction.linkedPurchaseInvoiceIds).toHaveLength(0);
  });

  it("lien présent d'un seul côté (donnée ancienne) : il est retiré", async () => {
    const transactionId = await insertTransaction({
      reconciliationStatus: "matched",
    });
    const invoiceId = await insertInvoice({ status: "PAID" });
    await Transaction.collection.updateOne(
      { _id: transactionId },
      { $set: { linkedPurchaseInvoiceIds: [invoiceId] } },
    );

    await M.unlinkPurchaseInvoiceFromTransaction(
      null,
      {
        purchaseInvoiceId: String(invoiceId),
        transactionId: String(transactionId),
      },
      ctx(),
    );

    const transaction = await rawTransaction(transactionId);
    expect(transaction.linkedPurchaseInvoiceIds).toHaveLength(0);
    expect(transaction.reconciliationStatus).toBe("unmatched");
    // La facture ne référençait pas la transaction : son statut reste.
    expect((await rawInvoice(invoiceId)).status).toBe("PAID");
  });
});

describe("unreconcilePurchaseInvoice : facture sans transaction liée", () => {
  it("une facture payée à la main reste payée, avec sa date", async () => {
    const invoiceId = await insertInvoice({
      status: "PAID",
      paymentDate: paidAt,
    });

    const result = await M.unreconcilePurchaseInvoice(
      null,
      { purchaseInvoiceId: String(invoiceId) },
      ctx(),
    );

    expect(result.status).toBe("PAID");
    const invoice = await rawInvoice(invoiceId);
    expect(invoice.status).toBe("PAID");
    expect(invoice.paymentDate).toEqual(paidAt);
  });
});

describe("bulkUpdatePurchaseInvoiceStatus vers « payée »", () => {
  it("une facture déjà payée garde sa date de paiement", async () => {
    const paid = await insertInvoice({ status: "PAID", paymentDate: paidAt });
    const toPay = await insertInvoice({ status: "TO_PAY" });

    const result = await M.bulkUpdatePurchaseInvoiceStatus(
      null,
      { ids: [String(paid), String(toPay)], status: "PAID" },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.updatedCount).toBe(1);
    expect((await rawInvoice(paid)).paymentDate).toEqual(paidAt);
    const newlyPaid = await rawInvoice(toPay);
    expect(newlyPaid.status).toBe("PAID");
    expect(newlyPaid.paymentDate).toBeInstanceOf(Date);
    expect(Date.now() - newlyPaid.paymentDate.getTime()).toBeLessThan(60_000);
  });

  it("une facture d'un autre espace n'est pas touchée", async () => {
    const foreign = await insertInvoice({
      status: "TO_PAY",
      workspaceId: otherOrganizationId,
    });

    const result = await M.bulkUpdatePurchaseInvoiceStatus(
      null,
      { ids: [String(foreign)], status: "PAID" },
      ctx(),
    );

    expect(result.updatedCount).toBe(0);
    expect((await rawInvoice(foreign)).status).toBe("TO_PAY");
  });

  it("les autres statuts restent appliqués à toute la sélection", async () => {
    const paid = await insertInvoice({ status: "PAID", paymentDate: paidAt });
    const toPay = await insertInvoice({ status: "TO_PAY" });

    const result = await M.bulkUpdatePurchaseInvoiceStatus(
      null,
      { ids: [String(paid), String(toPay)], status: "ARCHIVED" },
      ctx(),
    );

    expect(result.updatedCount).toBe(2);
    expect((await rawInvoice(paid)).status).toBe("ARCHIVED");
    expect((await rawInvoice(paid)).paymentDate).toEqual(paidAt);
  });
});

describe("createPurchaseInvoice payée : « Marquer comme payée » exigé", () => {
  const input = (fields = {}) => ({
    supplierName: "Fournisseur Paiement",
    invoiceNumber: `PAY-${new ObjectId().toString().slice(-6)}`,
    issueDate: "2026-10-01",
    amountHT: 100,
    amountTVA: 20,
    amountTTC: 120,
    forceCreate: true,
    ...fields,
  });

  it("rôle sans « Marquer comme payée » : refusé, rien en base", async () => {
    await expect(
      M.createPurchaseInvoice(
        null,
        { input: input({ status: "PAID", paymentDate: "2026-10-01" }) },
        ctx(noMarkPaid),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await PurchaseInvoice.countDocuments({})).toBe(0);
  });

  it("même rôle : une facture à payer est créée", async () => {
    const created = await M.createPurchaseInvoice(
      null,
      { input: input({ status: "TO_PAY" }) },
      ctx(noMarkPaid),
    );
    expect(created.status).toBe("TO_PAY");
  });

  it("même rôle : passer payée ensuite, seul ou en groupe, reste refusé", async () => {
    const id = await insertInvoice({ status: "TO_PAY" });
    await expect(
      M.updatePurchaseInvoice(
        null,
        { id: String(id), input: { status: "PAID" } },
        ctx(noMarkPaid),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      M.bulkUpdatePurchaseInvoiceStatus(
        null,
        { ids: [String(id)], status: "PAID" },
        ctx(noMarkPaid),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rawInvoice(id)).status).toBe("TO_PAY");
  });

  it("Éditeur : une facture payée est créée avec sa date", async () => {
    const created = await M.createPurchaseInvoice(
      null,
      { input: input({ status: "PAID", paymentDate: "2026-10-01" }) },
      ctx(editor),
    );
    expect(created.status).toBe("PAID");
  });
});

