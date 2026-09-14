import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";
import Transaction from "../../src/models/Transaction.js";
import Invoice from "../../src/models/Invoice.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import {
  findReconciliationSuggestions,
  findTransactionsForInvoice,
  findInvoicesForTransaction,
  findTransactionsForPurchaseInvoice,
  findPurchaseInvoicesForTransaction,
  findAutoReconcileTransactionForPurchaseInvoice,
  setReconciliationIgnored,
} from "../../src/utils/reconciliationMatching.js";

const orgId = buildOrganizationId();
const workspaceId = orgId.toString();

let counter = 0;

async function createTransaction(overrides = {}) {
  counter += 1;
  return Transaction.create({
    externalId: `tx-matching-${counter}`,
    provider: "bridge",
    type: "credit",
    status: "completed",
    amount: 899.99,
    currency: "EUR",
    description: "Lab Developpements F F",
    workspaceId,
    date: new Date("2026-06-02T00:00:00.000Z"),
    ...overrides,
  });
}

// Insertion raw : la logique de matching ne lit que ces champs, inutile de
// satisfaire toute la validation Mongoose d'une facture complète.
async function insertInvoice(overrides = {}) {
  counter += 1;
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    workspaceId: orgId,
    status: "PENDING",
    prefix: "F-202605",
    number: String(counter).padStart(4, "0"),
    issueDate: new Date("2026-05-15T00:00:00.000Z"),
    dueDate: new Date("2026-06-15T00:00:00.000Z"),
    totalTTC: 899.99,
    finalTotalTTC: 899.99,
    client: { name: "Lab Developpements" },
    linkedTransactionIds: [],
    ...overrides,
  };
  await Invoice.collection.insertOne(doc);
  return doc;
}

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

describe("findReconciliationSuggestions", () => {
  it("suggère une facture PENDING au montant correspondant", async () => {
    await createTransaction();
    const invoice = await insertInvoice({ client: { name: "Autre Client" } });

    const { suggestions } = await findReconciliationSuggestions(workspaceId);

    expect(suggestions).toHaveLength(1);
    expect(
      suggestions[0].matchingInvoices.map((i) => i._id.toString()),
    ).toEqual([invoice._id.toString()]);
    expect(suggestions[0].confidence).toBe("high");
  });

  it("exclut une transaction antérieure de plusieurs mois à la facture", async () => {
    await createTransaction({ date: new Date("2026-01-10T00:00:00.000Z") });
    await insertInvoice();

    const { suggestions } = await findReconciliationSuggestions(workspaceId);

    expect(suggestions).toHaveLength(0);
  });

  it("suggère une facture COMPLETED non liée sur correspondance de référence", async () => {
    await createTransaction({
      reference: "VIR LAB DEVELOPPEMENTS F-202605-0016 F-202605-0013",
    });
    const byRef = await insertInvoice({
      status: "COMPLETED",
      number: "0016",
      totalTTC: 500,
      finalTotalTTC: 500,
      client: { name: "Personne" },
    });

    const { suggestions } = await findReconciliationSuggestions(workspaceId);

    expect(suggestions).toHaveLength(1);
    expect(
      suggestions[0].matchingInvoices.map((i) => i._id.toString()),
    ).toEqual([byRef._id.toString()]);
    expect(suggestions[0].confidence).toBe("high");
  });

  it("ne suggère PAS une facture COMPLETED sur simple correspondance de montant ou de nom", async () => {
    await createTransaction();
    // Payée hors banque (espèces) : montant et nom du client matchent, mais
    // sans référence elle ne doit jamais être re-suggérée.
    await insertInvoice({ status: "COMPLETED" });

    const { suggestions } = await findReconciliationSuggestions(workspaceId);

    expect(suggestions).toHaveLength(0);
  });

  it("ignore les factures COMPLETED déjà liées à une transaction", async () => {
    const tx = await createTransaction({
      reference: "F-202605-0016",
    });
    await insertInvoice({
      status: "COMPLETED",
      number: "0016",
      linkedTransactionIds: [tx._id.toString()],
    });

    const { suggestions } = await findReconciliationSuggestions(workspaceId);

    expect(suggestions).toHaveLength(0);
  });

  it("ne compte que les PENDING dans pendingInvoicesCount", async () => {
    await insertInvoice();
    await insertInvoice({ status: "COMPLETED", number: "0016" });

    const { pendingInvoicesCount } =
      await findReconciliationSuggestions(workspaceId);

    expect(pendingInvoicesCount).toBe(1);
  });
});

describe("findTransactionsForInvoice", () => {
  it("applique la fenêtre de dates par défaut et la contourne en recherche", async () => {
    const invoice = await insertInvoice();
    const recent = await createTransaction();
    const early = await createTransaction({
      date: new Date("2026-01-10T00:00:00.000Z"),
      description: "Acompte Lab Developpements",
    });

    const byDefault = await findTransactionsForInvoice(invoice, workspaceId);
    expect(byDefault.scored.map((s) => s.transaction._id.toString())).toEqual([
      recent._id.toString(),
    ]);

    const bySearch = await findTransactionsForInvoice(
      invoice,
      workspaceId,
      "acompte",
    );
    expect(bySearch.scored.map((s) => s.transaction._id.toString())).toEqual([
      early._id.toString(),
    ]);
  });

  it("score la référence de facture trouvée dans le libellé brut", async () => {
    const invoice = await insertInvoice({ number: "0016" });
    await createTransaction({
      amount: 123.45,
      description: "Sans rapport",
      reference: "VIR F-202605-0016",
    });
    await createTransaction({ amount: 123.45, description: "Sans rapport" });

    const { scored } = await findTransactionsForInvoice(invoice, workspaceId);

    expect(scored[0].transaction.reference).toBe("VIR F-202605-0016");
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });
});

describe("findInvoicesForTransaction", () => {
  it("propose les PENDING et les COMPLETED non liées, pas les COMPLETED liées", async () => {
    const tx = await createTransaction();
    const pending = await insertInvoice({ client: { name: "Autre" } });
    const completedUnlinked = await insertInvoice({
      status: "COMPLETED",
      number: "0016",
      client: { name: "Autre" },
    });
    await insertInvoice({
      status: "COMPLETED",
      number: "0017",
      linkedTransactionIds: [new mongoose.Types.ObjectId().toString()],
      client: { name: "Autre" },
    });

    const { scored } = await findInvoicesForTransaction(tx, workspaceId);
    const ids = scored.map((s) => s.invoice._id.toString());

    expect(ids).toContain(pending._id.toString());
    expect(ids).toContain(completedUnlinked._id.toString());
    expect(ids).toHaveLength(2);
  });

  it("exclut par défaut une facture émise après la transaction, sauf en recherche", async () => {
    const tx = await createTransaction();
    const future = await insertInvoice({
      issueDate: new Date("2026-07-15T00:00:00.000Z"),
      dueDate: new Date("2026-08-15T00:00:00.000Z"),
      number: "0042",
    });

    const byDefault = await findInvoicesForTransaction(tx, workspaceId);
    expect(byDefault.scored).toHaveLength(0);

    const bySearch = await findInvoicesForTransaction(tx, workspaceId, "0042");
    expect(bySearch.scored.map((s) => s.invoice._id.toString())).toEqual([
      future._id.toString(),
    ]);
  });
});

describe("findTransactionsForInvoice — paiement groupé", () => {
  it("n'inclut une transaction déjà rapprochée qu'en recherche explicite, jamais celles liées à la facture", async () => {
    const invoice = await insertInvoice();
    const matched = await createTransaction({
      reconciliationStatus: "matched",
      description: "Virement groupe Lab Developpements",
    });
    const linked = await createTransaction({
      reconciliationStatus: "matched",
      description: "Lab Developpements deja lie",
    });
    await Invoice.collection.updateOne(
      { _id: invoice._id },
      { $set: { linkedTransactionIds: [linked._id] } },
    );
    const freshInvoice = await Invoice.findById(invoice._id);

    const byDefault = await findTransactionsForInvoice(
      freshInvoice,
      workspaceId,
    );
    expect(byDefault.scored.map((s) => s.transaction._id.toString())).toEqual(
      [],
    );

    const withSearch = await findTransactionsForInvoice(
      freshInvoice,
      workspaceId,
      "Lab",
    );
    expect(withSearch.scored.map((s) => s.transaction._id.toString())).toEqual([
      matched._id.toString(),
    ]);
  });
});

async function insertPurchaseInvoice(overrides = {}) {
  counter += 1;
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    workspaceId: orgId,
    supplierName: "Qonto",
    invoiceNumber: `QONTO-2026-${String(counter).padStart(4, "0")}`,
    issueDate: new Date("2026-07-31T00:00:00.000Z"),
    amountTTC: 29,
    status: "TO_PAY",
    isReconciled: false,
    linkedTransactionIds: [],
    ...overrides,
  };
  await PurchaseInvoice.collection.insertOne(doc);
  return PurchaseInvoice.findById(doc._id);
}

const createDebit = (overrides = {}) =>
  createTransaction({
    type: "debit",
    amount: -29,
    description: "PRLV QONTO",
    date: new Date("2026-08-02T00:00:00.000Z"),
    ...overrides,
  });

describe("findTransactionsForPurchaseInvoice", () => {
  it("propose les débits à rapprocher, score montant + fournisseur, exclut les crédits et les liés", async () => {
    const pi = await insertPurchaseInvoice();
    const good = await createDebit();
    await createDebit({ amount: 29, type: "credit" });
    const other = await createDebit({ amount: -500, description: "OVH" });
    const linked = await createDebit({ description: "PRLV QONTO deja lie" });
    await PurchaseInvoice.collection.updateOne(
      { _id: pi._id },
      { $set: { linkedTransactionIds: [linked._id] } },
    );
    const fresh = await PurchaseInvoice.findById(pi._id);

    const { scored, invoiceAmount } = await findTransactionsForPurchaseInvoice(
      fresh,
      workspaceId,
    );
    expect(invoiceAmount).toBe(29);
    expect(scored.map((s) => s.transaction._id.toString())).toEqual([
      good._id.toString(),
      other._id.toString(),
    ]);
    expect(scored[0].score).toBe(150);
    expect(scored[1].score).toBe(0);
  });

  it("hors fenêtre de dates : proposée par défaut si elle ressemble à la facture (montant), sinon seulement en recherche", async () => {
    const pi = await insertPurchaseInvoice({
      issueDate: new Date("2026-08-15T00:00:00.000Z"),
    });
    // Facture créée après le paiement : même montant, antérieure à l'émission
    const before = await createDebit({
      date: new Date("2026-07-21T00:00:00.000Z"),
      description: "CB HOSTINGER",
    });
    // Antérieure aussi, mais rien à voir avec la facture
    const unrelated = await createDebit({
      date: new Date("2026-07-20T00:00:00.000Z"),
      amount: -500,
      description: "OVH",
    });

    const byDefault = await findTransactionsForPurchaseInvoice(pi, workspaceId);
    expect(byDefault.scored.map((s) => s.transaction._id.toString())).toEqual([
      before._id.toString(),
    ]);

    const withSearch = await findTransactionsForPurchaseInvoice(
      pi,
      workspaceId,
      "ovh",
    );
    expect(withSearch.scored.map((s) => s.transaction._id.toString())).toEqual([
      unrelated._id.toString(),
    ]);
  });

  it("déjà rapprochée : proposée par défaut si elle ressemble à la facture (fournisseur), après les transactions à rapprocher à score égal ; jamais une ignorée", async () => {
    const pi = await insertPurchaseInvoice();
    const pending = await createDebit();
    const matched = await createDebit({
      reconciliationStatus: "matched",
      amount: -12,
      description: "PRLV QONTO frais",
    });
    await createDebit({ reconciliationStatus: "ignored" });
    await createDebit({
      reconciliationStatus: "matched",
      amount: -500,
      description: "OVH",
    });

    const byDefault = await findTransactionsForPurchaseInvoice(pi, workspaceId);
    expect(byDefault.scored.map((s) => s.transaction._id.toString())).toEqual([
      pending._id.toString(),
      matched._id.toString(),
    ]);

    const withSearch = await findTransactionsForPurchaseInvoice(
      pi,
      workspaceId,
      "frais",
    );
    expect(withSearch.scored.map((s) => s.transaction._id.toString())).toEqual([
      matched._id.toString(),
    ]);
  });
});

describe("findAutoReconcileTransactionForPurchaseInvoice", () => {
  it("retient le débit au même montant et au fournisseur reconnu, jamais un rapproché, un ignoré ou un autre montant", async () => {
    const pi = await insertPurchaseInvoice();
    const good = await createDebit();
    await createDebit({ reconciliationStatus: "matched" });
    await createDebit({ reconciliationStatus: "ignored" });
    await createDebit({ amount: -28 });
    await createDebit({ description: "CB AMAZON" });

    const found = await findAutoReconcileTransactionForPurchaseInvoice(
      pi,
      workspaceId,
    );
    expect(found?._id.toString()).toBe(good._id.toString());
  });

  it("retient le débit reconnu par numéro de facture dans le libellé", async () => {
    const pi = await insertPurchaseInvoice({ invoiceNumber: "F-2026-001234" });
    const byRef = await createDebit({
      description: "PRLV SEPA F2026001234 SOCIETE X",
    });

    const found = await findAutoReconcileTransactionForPurchaseInvoice(
      pi,
      workspaceId,
    );
    expect(found?._id.toString()).toBe(byRef._id.toString());
  });

  it("ne lie rien avant l'émission ni trop longtemps après l'échéance", async () => {
    const pi = await insertPurchaseInvoice({
      issueDate: new Date("2026-07-31T00:00:00.000Z"),
      dueDate: new Date("2026-08-15T00:00:00.000Z"),
    });
    await createDebit({ date: new Date("2026-07-20T00:00:00.000Z") });
    await createDebit({ date: new Date("2026-10-15T00:00:00.000Z") });

    expect(
      await findAutoReconcileTransactionForPurchaseInvoice(pi, workspaceId),
    ).toBeNull();

    const inWindow = await createDebit({
      date: new Date("2026-09-10T00:00:00.000Z"),
    });
    const found = await findAutoReconcileTransactionForPurchaseInvoice(
      pi,
      workspaceId,
    );
    expect(found?._id.toString()).toBe(inWindow._id.toString());
  });

  it("date de paiement déclarée : fenêtre serrée autour du paiement, la plus proche gagne", async () => {
    const pi = await insertPurchaseInvoice({
      issueDate: new Date("2026-07-01T00:00:00.000Z"),
      paymentDate: new Date("2026-08-02T00:00:00.000Z"),
    });
    await createDebit({ date: new Date("2026-07-02T00:00:00.000Z") });
    const paid = await createDebit({
      date: new Date("2026-08-03T00:00:00.000Z"),
    });

    const found = await findAutoReconcileTransactionForPurchaseInvoice(
      pi,
      workspaceId,
    );
    expect(found?._id.toString()).toBe(paid._id.toString());
  });

  it("abonnement mensuel : deux candidates proches = ambigu, rien n'est lié", async () => {
    const pi = await insertPurchaseInvoice({
      issueDate: new Date("2026-08-01T00:00:00.000Z"),
    });
    await createDebit({ date: new Date("2026-08-02T00:00:00.000Z") });
    await createDebit({ date: new Date("2026-08-04T00:00:00.000Z") });

    expect(
      await findAutoReconcileTransactionForPurchaseInvoice(pi, workspaceId),
    ).toBeNull();
  });

  it("abonnement mensuel : la candidate la plus proche gagne si la suivante est à plus de 7 jours", async () => {
    const pi = await insertPurchaseInvoice({
      issueDate: new Date("2026-08-01T00:00:00.000Z"),
    });
    const august = await createDebit({
      date: new Date("2026-08-02T00:00:00.000Z"),
    });
    await createDebit({ date: new Date("2026-09-02T00:00:00.000Z") });

    const found = await findAutoReconcileTransactionForPurchaseInvoice(
      pi,
      workspaceId,
    );
    expect(found?._id.toString()).toBe(august._id.toString());
  });
});

describe("findPurchaseInvoicesForTransaction", () => {
  it("propose les factures non rapprochées d'abord, puis les rapprochées (signalées), sans celles déjà liées ni archivées", async () => {
    const tx = await createDebit();
    const unlinked = await insertPurchaseInvoice();
    const reconciledElsewhere = await insertPurchaseInvoice({
      isReconciled: true,
      status: "PAID",
      linkedTransactionIds: [new mongoose.Types.ObjectId()],
    });
    const linkedToTx = await insertPurchaseInvoice({
      linkedTransactionIds: [tx._id],
    });
    await insertPurchaseInvoice({ status: "ARCHIVED" });
    await Transaction.updateOne(
      { _id: tx._id },
      { $set: { linkedPurchaseInvoiceIds: [linkedToTx._id] } },
    );
    const freshTx = await Transaction.findById(tx._id);

    const { scored, transactionAmount } =
      await findPurchaseInvoicesForTransaction(freshTx, workspaceId);
    expect(transactionAmount).toBe(-29);
    const ids = scored.map((s) => s.invoice._id.toString());
    expect(ids).toHaveLength(2);
    expect(ids).toContain(unlinked._id.toString());
    expect(ids).toContain(reconciledElsewhere._id.toString());
    expect(scored.every((s) => s.score === 150)).toBe(true);
  });

  it("recherche par fournisseur, numéro ou montant", async () => {
    const tx = await createDebit();
    const qonto = await insertPurchaseInvoice();
    const ovh = await insertPurchaseInvoice({
      supplierName: "OVH",
      invoiceNumber: "FR-OVH-123456",
      amountTTC: 120,
    });

    const byName = await findPurchaseInvoicesForTransaction(
      tx,
      workspaceId,
      "ovh",
    );
    expect(byName.scored.map((s) => s.invoice._id.toString())).toEqual([
      ovh._id.toString(),
    ]);

    const byAmount = await findPurchaseInvoicesForTransaction(
      tx,
      workspaceId,
      "29",
    );
    expect(byAmount.scored.map((s) => s.invoice._id.toString())).toEqual([
      qonto._id.toString(),
    ]);
  });
});

describe("setReconciliationIgnored", () => {
  it("ignore puis réintègre une transaction", async () => {
    const tx = await createTransaction();

    const ignored = await setReconciliationIgnored(tx._id, workspaceId, true);
    expect(ignored.reconciliationStatus).toBe("ignored");

    const unignored = await setReconciliationIgnored(
      tx._id,
      workspaceId,
      false,
    );
    expect(unignored.reconciliationStatus).toBe("unmatched");
  });

  it("ne dé-ignore pas une transaction matched", async () => {
    const tx = await createTransaction({ reconciliationStatus: "matched" });

    const result = await setReconciliationIgnored(tx._id, workspaceId, false);

    expect(result).toBeNull();
    const reloaded = await Transaction.findById(tx._id);
    expect(reloaded.reconciliationStatus).toBe("matched");
  });
});
