import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Transaction from "../../src/models/Transaction.js";
// Implémentation réelle : à importer, pas à ré-écrire.
import {
  ensureReceiptFileIds,
  findTransactionReceiptFile,
  syntheticReceiptFileId,
} from "../../src/utils/transactionReceiptFiles.js";

/**
 * Justificatifs de transaction sans `_id` (incident 21/09/2026 : écrits par
 * une ancienne migration via le driver brut). Le résolveur servait un
 * identifiant de repli que suppression et aperçu ne retrouvaient pas.
 */

const workspaceId = new mongoose.Types.ObjectId().toString();

const receipt = (name) => ({
  url: `https://r2.example/${name}`,
  key: `ws/${name}`,
  filename: name,
  mimetype: "application/pdf",
  size: 10,
});

// Insertion par le driver brut : Mongoose n'ajoute pas les _id.
const insertRawTransaction = async (receiptFiles) => {
  const _id = new mongoose.Types.ObjectId();
  await mongoose.connection.db.collection("transactions").insertOne({
    _id,
    externalId: `tx-${_id}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -10,
    currency: "EUR",
    workspaceId,
    date: new Date("2026-09-01"),
    receiptFiles,
  });
  return _id;
};

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

describe("ensureReceiptFileIds", () => {
  it("attribue et persiste un _id aux justificatifs qui n'en ont pas", async () => {
    const withId = { _id: new mongoose.Types.ObjectId(), ...receipt("a.pdf") };
    const txId = await insertRawTransaction([withId, receipt("b.pdf")]);

    const tx = await Transaction.findById(txId).lean();
    expect(tx.receiptFiles[1]._id).toBeUndefined();

    await ensureReceiptFileIds(tx);

    // En mémoire : l'appelant peut servir le vrai id tout de suite
    expect(tx.receiptFiles[0]._id.toString()).toBe(withId._id.toString());
    expect(tx.receiptFiles[1]._id).toBeDefined();

    // En base : persisté, et l'id existant n'a pas bougé
    const saved = await Transaction.findById(txId).lean();
    expect(saved.receiptFiles[0]._id.toString()).toBe(withId._id.toString());
    expect(saved.receiptFiles[1]._id.toString()).toBe(
      tx.receiptFiles[1]._id.toString(),
    );
    expect(saved.receiptFiles[1].url).toBe("https://r2.example/b.pdf");
  });

  it("ne réécrit rien quand tous les justificatifs ont déjà un _id", async () => {
    const tx = await Transaction.create({
      externalId: "tx-ok",
      description: "Test",
      provider: "bridge",
      type: "debit",
      status: "completed",
      amount: -10,
      currency: "EUR",
      workspaceId,
      date: new Date("2026-09-01"),
      receiptFiles: [receipt("a.pdf")],
    });
    const before = await Transaction.findById(tx._id).lean();

    const files = await ensureReceiptFileIds(before);

    expect(files).toBe(before.receiptFiles);
    const after = await Transaction.findById(tx._id).lean();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("ne touche pas un index déjà pourvu d'un _id entre-temps (écriture concurrente)", async () => {
    const txId = await insertRawTransaction([receipt("a.pdf")]);
    const stale = await Transaction.findById(txId).lean();

    // Un autre process attribue un _id avant nous
    const concurrent = new mongoose.Types.ObjectId();
    await Transaction.updateOne(
      { _id: txId },
      { $set: { "receiptFiles.0._id": concurrent } },
    );

    await ensureReceiptFileIds(stale);

    const saved = await Transaction.findById(txId).lean();
    expect(saved.receiptFiles[0]._id.toString()).toBe(concurrent.toString());
  });
});

describe("findTransactionReceiptFile", () => {
  it("retrouve un justificatif par _id", async () => {
    const id = new mongoose.Types.ObjectId();
    const tx = {
      _id: new mongoose.Types.ObjectId(),
      receiptFiles: [{ _id: id, ...receipt("a.pdf") }],
    };
    expect(findTransactionReceiptFile(tx, id.toString())?.filename).toBe(
      "a.pdf",
    );
  });

  it("accepte l'identifiant de repli <tx>-receipt-<index> de la bonne transaction", async () => {
    const tx = {
      _id: new mongoose.Types.ObjectId(),
      receiptFiles: [receipt("a.pdf"), receipt("b.pdf")],
    };
    const fallback = syntheticReceiptFileId(tx._id.toString(), 1);
    expect(findTransactionReceiptFile(tx, fallback)?.filename).toBe("b.pdf");
  });

  it("refuse l'identifiant de repli d'une autre transaction ou hors bornes", async () => {
    const tx = {
      _id: new mongoose.Types.ObjectId(),
      receiptFiles: [receipt("a.pdf")],
    };
    const other = new mongoose.Types.ObjectId().toString();
    expect(
      findTransactionReceiptFile(tx, syntheticReceiptFileId(other, 0)),
    ).toBeNull();
    expect(
      findTransactionReceiptFile(
        tx,
        syntheticReceiptFileId(tx._id.toString(), 5),
      ),
    ).toBeNull();
    expect(findTransactionReceiptFile(tx, "n-importe-quoi")).toBeNull();
  });
});
