/**
 * Synchronisation Bridge : ce que l'utilisateur a saisi sur une transaction
 * survit à la resynchronisation (catégorie, libellé, notes, fournisseur,
 * étiquettes, compte comptable, justificatifs, statut ignoré, rapprochements),
 * une transaction supprimée n'est pas recréée, et une transaction manuelle
 * n'est fusionnée qu'avec une transaction bancaire du même montant signé.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import Transaction from "../../src/models/Transaction.js";
import { BridgeProvider } from "../../src/services/banking/providers/BridgeProvider.js";

const { ObjectId } = mongoose.Types;
const ws = String(buildOrganizationId());
let provider;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  provider = new BridgeProvider();
});

/** Transaction telle que renvoyée par Bridge à la resynchronisation. */
const fromBridge = (id, fields = {}) =>
  provider._mapTransaction(
    {
      id,
      account_id: 4242,
      amount: -64.8,
      currency_code: "EUR",
      date: "2026-10-15",
      clean_description: "TOTALENERGIES",
      provider_description: "CB TOTALENERGIES 75 PARIS",
      category_id: 270,
      ...fields,
    },
    ws,
    "webhook-sync",
  );

async function insertBank(id, fields = {}) {
  const _id = new ObjectId();
  await Transaction.collection.insertOne({
    _id,
    externalId: String(id),
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -64.8,
    currency: "EUR",
    description: "TOTALENERGIES",
    workspaceId: ws,
    fromAccount: "4242",
    date: new Date("2026-10-15T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    ...fields,
  });
  return _id;
}

describe("_saveTransactionsToDatabase : données saisies conservées", () => {
  it("catégorie, libellé, notes, fournisseur, étiquettes et compte comptable manuels restent", async () => {
    const id = await insertBank(5001, {
      category: "carburant",
      expenseCategory: "TRAVEL",
      categoryIsManual: true,
      description: "Plein camionnette chantier",
      descriptionIsManual: true,
      metadata: {
        notes: "Chantier Dupont",
        vendor: "Total Énergies",
        paymentMethod: "CARD",
        tags: ["chantier"],
        bridgeCategoryMapped: "OTHER",
      },
      pcgAccount: {
        numero: "6061",
        intitule: "Fournitures non stockables",
        isManual: true,
        manuallySetAt: new Date("2026-10-16T00:00:00.000Z"),
      },
    });

    await provider._saveTransactionsToDatabase([fromBridge(5001)], ws);

    const tx = await Transaction.collection.findOne({ _id: id });
    expect(tx.category).toBe("carburant");
    expect(tx.expenseCategory).toBe("TRAVEL");
    expect(tx.description).toBe("Plein camionnette chantier");
    expect(tx.reference).toBe("CB TOTALENERGIES 75 PARIS");
    expect(tx.metadata).toMatchObject({
      notes: "Chantier Dupont",
      vendor: "Total Énergies",
      paymentMethod: "CARD",
      tags: ["chantier"],
    });
    expect(tx.pcgAccount).toMatchObject({ numero: "6061", isManual: true });
  });

  it("justificatifs, statut ignoré et rapprochements restent", async () => {
    const purchaseId = new ObjectId();
    const receiptId = new ObjectId();
    const id = await insertBank(5002, {
      reconciliationStatus: "ignored",
      receiptFiles: [{ _id: receiptId, key: `${ws}/ticket.pdf` }],
      linkedPurchaseInvoiceIds: [purchaseId],
    });

    await provider._saveTransactionsToDatabase([fromBridge(5002)], ws);

    const tx = await Transaction.collection.findOne({ _id: id });
    expect(tx.reconciliationStatus).toBe("ignored");
    expect(tx.receiptFiles.map((f) => String(f._id))).toEqual([
      String(receiptId),
    ]);
    expect(tx.linkedPurchaseInvoiceIds.map(String)).toEqual([
      String(purchaseId),
    ]);
  });

  it("une transaction supprimée par l'utilisateur n'est ni recréée ni modifiée", async () => {
    const deletedAt = new Date("2026-10-20T00:00:00.000Z");
    const id = await insertBank(5003, {
      deletedAt,
      description: "Ancien libellé",
    });

    await provider._saveTransactionsToDatabase([fromBridge(5003)], ws);

    const all = await Transaction.collection
      .find({ externalId: "5003" })
      .toArray();
    expect(all).toHaveLength(1);
    expect(all[0]._id).toEqual(id);
    expect(all[0].deletedAt).toEqual(deletedAt);
    expect(all[0].description).toBe("Ancien libellé");
  });

  it("une catégorie sans saisie manuelle suit Bridge", async () => {
    const id = await insertBank(5004, {
      category: "OTHER",
      metadata: { bridgeCategoryMapped: "OTHER" },
    });
    const data = fromBridge(5004);

    await provider._saveTransactionsToDatabase([data], ws);

    expect((await Transaction.collection.findOne({ _id: id })).category).toBe(
      data.category,
    );
  });
});

describe("_saveTransactionsToDatabase : fusion d'une transaction manuelle", () => {
  async function insertManual(fields = {}) {
    const _id = new ObjectId();
    await Transaction.collection.insertOne({
      _id,
      externalId: `manuelle-${_id}`,
      provider: "manual",
      type: "debit",
      status: "completed",
      amount: -64.8,
      currency: "EUR",
      description: "Plein essence (saisi à la main)",
      workspaceId: ws,
      date: new Date("2026-10-14T00:00:00.000Z"),
      category: "carburant",
      metadata: { notes: "Note manuelle" },
      ...fields,
    });
    return _id;
  }

  it("même montant signé et date proche : fusionnée, saisies reprises", async () => {
    const manualId = await insertManual();

    await provider._saveTransactionsToDatabase([fromBridge(6001)], ws);

    expect(await Transaction.collection.findOne({ _id: manualId })).toBeNull();
    const bank = await Transaction.collection.findOne({ externalId: "6001" });
    expect(bank.category).toBe("carburant");
    expect(bank.categoryIsManual).toBe(true);
    expect(bank.metadata.notes).toBe("Note manuelle");
  });

  it("montant de sens opposé : jamais fusionnée", async () => {
    const manualId = await insertManual({ amount: 64.8, type: "credit" });

    await provider._saveTransactionsToDatabase([fromBridge(6002)], ws);

    expect(
      await Transaction.collection.findOne({ _id: manualId }),
    ).not.toBeNull();
  });

  it("transaction manuelle d'un autre espace : jamais fusionnée", async () => {
    const manualId = await insertManual({
      workspaceId: String(buildOrganizationId()),
    });

    await provider._saveTransactionsToDatabase([fromBridge(6003)], ws);

    expect(
      await Transaction.collection.findOne({ _id: manualId }),
    ).not.toBeNull();
  });
});
