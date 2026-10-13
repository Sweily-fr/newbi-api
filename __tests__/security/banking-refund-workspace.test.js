/**
 * Banque : un remboursement ne vise qu'une transaction de l'espace.
 *
 * BankingService.processRefund relisait la transaction d'origine par son
 * seul id : depuis l'espace A, un id de transaction de B était trouvé (oracle
 * d'existence) puis, si le prestataire acceptait, passé en « refunded ».
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Transaction from "../../src/models/Transaction.js";
import { BankingService } from "../../src/services/banking/BankingService.js";

const orgA = new mongoose.Types.ObjectId().toString();
const orgB = new mongoose.Types.ObjectId().toString();
const userId = new mongoose.Types.ObjectId();

// Prestataire simulé : accepte tout remboursement
const fakeProvider = {
  providerName: "mock",
  async processRefund() {
    return { id: `refund_${Date.now()}` };
  },
  mapToStandardFormat(raw) {
    return {
      externalId: raw.id,
      amount: -50,
      currency: "EUR",
      description: "Remboursement",
      status: "completed",
      date: new Date(),
    };
  },
  handleProviderError(error) {
    return error;
  },
};

function buildService() {
  const service = new BankingService();
  service.currentProvider = fakeProvider;
  service.initialized = true;
  return service;
}

async function insertPayment(workspaceId) {
  const { insertedId } = await Transaction.collection.insertOne({
    externalId: `ext_${workspaceId}`,
    provider: "mock",
    type: "payment",
    status: "completed",
    amount: 50,
    currency: "EUR",
    description: "Paiement",
    workspaceId,
    date: new Date(),
  });
  return insertedId;
}

const refund = (transactionId, workspaceId) =>
  buildService().processRefund({
    transactionId: transactionId.toString(),
    workspaceId,
    userId,
    amount: 50,
  });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("processRefund", () => {
  it("refuse la transaction d'un autre espace et ne la modifie pas", async () => {
    const paymentB = await insertPayment(orgB);

    await expect(refund(paymentB, orgA)).rejects.toThrow(
      "Transaction originale non trouvée",
    );

    const after = await Transaction.collection.findOne({ _id: paymentB });
    expect(after.status).toBe("completed");
    expect(await Transaction.countDocuments({ workspaceId: orgA })).toBe(0);
  });

  it("rembourse une transaction de l'espace", async () => {
    const paymentA = await insertPayment(orgA);

    const refundTx = await refund(paymentA, orgA);

    expect(refundTx.workspaceId).toBe(orgA);
    const after = await Transaction.collection.findOne({ _id: paymentA });
    expect(after.status).toBe("refunded");
  });
});
