import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    resolveBucketAndKeyFromUrl: vi.fn().mockReturnValue(null),
    importedInvoicesBucketName: "imported",
  },
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";

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
const createDebit = (overrides = {}) => {
  n += 1;
  return Transaction.create({
    externalId: `tx-pi-${n}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -30.98,
    currency: "EUR",
    description: "CB HOSTINGER",
    workspaceId,
    date: new Date("2026-07-21T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    ...overrides,
  });
};

const baseInput = (overrides = {}) => ({
  workspaceId,
  supplierName: "Hostinger",
  invoiceNumber: "HOST-2026-0721",
  issueDate: "2026-07-21",
  amountHT: 25.82,
  amountTVA: 5.16,
  vatRate: 20,
  amountTTC: 30.98,
  currency: "EUR",
  status: "TO_PAY",
  ...overrides,
});

const create = (input) =>
  purchaseInvoiceResolvers.Mutation.createPurchaseInvoice(
    null,
    { input },
    ctx(),
  );

const candidate = (purchaseInvoiceId) =>
  purchaseInvoiceResolvers.Query.purchaseInvoiceReconcileCandidate(
    null,
    { purchaseInvoiceId },
    ctx(),
  );

describe("createPurchaseInvoice : filet anti-doublon et rapprochement automatique", () => {
  it("refuse une facture similaire (même numéro + fournisseur) sans forceCreate, l'accepte avec", async () => {
    await create(baseInput());

    await expect(create(baseInput())).rejects.toThrow(
      /Une facture similaire existe déjà : Hostinger - HOST-2026-0721/,
    );
    expect(await PurchaseInvoice.countDocuments({})).toBe(1);

    const forced = await create(baseInput({ forceCreate: true }));
    expect(forced.invoiceNumber).toBe("HOST-2026-0721");
    expect(await PurchaseInvoice.countDocuments({})).toBe(2);
  });

  it("facture ajoutée après le paiement : rien n'est lié à la création, la transaction passée est proposée pour confirmation", async () => {
    const tx = await createDebit();
    await createDebit({ amount: -12, description: "PRLV QONTO" });

    const invoice = await create(baseInput());

    expect(invoice.status).toBe("TO_PAY");
    expect(invoice.linkedTransactionIds).toHaveLength(0);
    const freshTx = await Transaction.findById(tx._id);
    expect(freshTx.reconciliationStatus).toBe("unmatched");

    const proposed = await candidate(invoice._id.toString());
    expect(proposed?.id).toBe(tx._id.toString());
    expect(proposed.description).toBe("CB HOSTINGER");
  });

  it("ne propose rien sans correspondance sûre (fournisseur absent du libellé) ni quand la facture est déjà liée", async () => {
    const tx = await createDebit({ description: "CB 4512XXXX" });
    const invoice = await create(baseInput());
    expect(await candidate(invoice._id.toString())).toBeNull();

    await purchaseInvoiceResolvers.Mutation.reconcilePurchaseInvoice(
      null,
      {
        purchaseInvoiceId: invoice._id.toString(),
        transactionIds: [tx._id.toString()],
      },
      ctx(),
    );
    await createDebit();
    expect(await candidate(invoice._id.toString())).toBeNull();
  });

  it("reconcilePurchaseInvoice reste additif et refuse une paire déjà liée", async () => {
    const tx1 = await createDebit({ description: "CB 4512XXXX" });
    const tx2 = await createDebit({
      amount: -2,
      description: "FRAIS",
      date: new Date("2026-07-25T00:00:00.000Z"),
    });
    const invoice = await create(baseInput());

    const reconcile = (ids) =>
      purchaseInvoiceResolvers.Mutation.reconcilePurchaseInvoice(
        null,
        { purchaseInvoiceId: invoice._id.toString(), transactionIds: ids },
        ctx(),
      );

    await reconcile([tx1._id.toString()]);
    const after = await reconcile([tx2._id.toString()]);
    expect(after.linkedTransactionIds.map(String).sort()).toEqual(
      [tx1._id.toString(), tx2._id.toString()].sort(),
    );
    expect(after.status).toBe("PAID");

    await expect(reconcile([tx1._id.toString()])).rejects.toThrow(
      /déjà rapprochée/,
    );
    for (const tx of [tx1, tx2]) {
      const fresh = await Transaction.findById(tx._id);
      expect(fresh.reconciliationStatus).toBe("matched");
      expect(fresh.linkedPurchaseInvoiceIds.map(String)).toEqual([
        invoice._id.toString(),
      ]);
    }
  });
});

describe("convertImportedInvoiceToPurchaseInvoice : filet anti-doublon", () => {
  const createImported = (overrides = {}) =>
    ImportedInvoice.create({
      workspaceId: organizationId,
      importedBy: userId,
      status: "PENDING_REVIEW",
      source: "GMAIL",
      originalInvoiceNumber: "HOST-2026-0721",
      vendor: { name: "Hostinger" },
      invoiceDate: new Date("2026-07-21T00:00:00.000Z"),
      totalHT: 25.82,
      totalVAT: 5.16,
      totalTTC: 30.98,
      file: {
        url: "https://r2.example.com/hostinger.pdf",
        cloudflareKey: `${workspaceId}/hostinger.pdf`,
        originalFileName: "hostinger.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
      },
      ...overrides,
    });

  const convert = (id, forceCreate) =>
    importedInvoiceResolvers.Mutation.convertImportedInvoiceToPurchaseInvoice(
      null,
      { id, forceCreate },
      buildContext({ userId, organizationId }),
    );

  it("rattache le fichier à la facture d'achat existante au lieu d'en créer une deuxième", async () => {
    const existing = await create(baseInput());
    const imported = await createImported();

    const result = await convert(imported._id.toString());

    expect(result._id.toString()).toBe(existing._id.toString());
    expect(await PurchaseInvoice.countDocuments({})).toBe(1);
    const fresh = await PurchaseInvoice.findById(existing._id);
    expect(fresh.files.map((f) => f.url)).toEqual([
      "https://r2.example.com/hostinger.pdf",
    ]);
    const freshImported = await ImportedInvoice.findById(imported._id);
    expect(freshImported.status).toBe("VALIDATED");
  });

  it("crée une nouvelle facture avec forceCreate, sans la lier automatiquement (la transaction reste proposée)", async () => {
    await create(baseInput());
    const tx = await createDebit();
    const imported = await createImported();

    const created = await convert(imported._id.toString(), true);

    expect(await PurchaseInvoice.countDocuments({})).toBe(2);
    expect(created.source).toBe("OCR");
    expect(created.status).toBe("TO_PROCESS");
    expect(created.linkedTransactionIds).toHaveLength(0);
    const freshTx = await Transaction.findById(tx._id);
    expect(freshTx.reconciliationStatus).toBe("unmatched");
    const proposed = await candidate(created._id.toString());
    expect(proposed?.id).toBe(tx._id.toString());
  });
});
