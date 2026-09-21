import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Transaction from "../../src/models/Transaction.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
// Implémentation réelle : à importer, pas à ré-écrire.
import {
  findExistingPurchaseInvoiceForReceipt,
  purchaseInvoiceCanAbsorbTransaction,
} from "../../src/services/transactionReceiptOcrService.js";

/**
 * Déduplication des justificatifs déposés sur une transaction.
 *
 * Incident du 21/09/2026 : 23 justificatifs Canva (un par mois, 2024-2025)
 * déposés chacun sur sa transaction. L'OCR lisait « Canva » et 11,99 € mais
 * ni date ni numéro ; la règle « même fournisseur + même montant, date
 * inconnue = on ne tranche pas » les a tous pris pour des doublons de la
 * facture d'août 2026, qui s'est retrouvée avec 24 fichiers et 24 débits.
 */

const workspaceId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

let seq = 0;
const makeTransaction = async ({ date, amount = -11.99, linkedTo = [] }) =>
  Transaction.create({
    externalId: `tx-${++seq}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount,
    currency: "EUR",
    workspaceId: workspaceId.toString(),
    userId,
    date: new Date(date),
    description: "Canva*",
    linkedPurchaseInvoiceIds: linkedTo,
  });

const makeInvoice = async ({
  issueDate,
  amountTTC = 11.99,
  linkedTransactionIds = [],
  invoiceNumber,
}) =>
  PurchaseInvoice.create({
    supplierName: "Canva Pty. Ltd.",
    invoiceNumber,
    issueDate: new Date(issueDate),
    amountHT: amountTTC,
    amountTVA: 0,
    amountTTC,
    currency: "EUR",
    status: "PAID",
    category: "SUBSCRIPTIONS",
    source: "OCR",
    workspaceId,
    createdBy: userId,
    linkedTransactionIds,
    isReconciled: linkedTransactionIds.length > 0,
  });

// Ce que l'OCR a réellement rendu sur les PDF Canva de l'incident.
const canvaOcrWithoutDate = {
  transaction_data: {
    vendor_name: "Canva",
    amount: 11.99,
    transaction_date: null,
    invoice_date: null,
  },
};

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  seq = 0;
});

describe("findExistingPurchaseInvoiceForReceipt", () => {
  it("ne rattache pas un abonnement d'un autre mois à la facture existante (date OCR absente)", async () => {
    const augustTx = await makeTransaction({ date: "2026-08-25" });
    const augustInvoice = await makeInvoice({
      issueDate: "2026-08-25",
      invoiceNumber: "04984-17985083",
      linkedTransactionIds: [augustTx._id],
    });
    await Transaction.updateOne(
      { _id: augustTx._id },
      { $set: { linkedPurchaseInvoiceIds: [augustInvoice._id] } },
    );

    const januaryTx = await makeTransaction({ date: "2024-01-26" });

    const existing = await findExistingPurchaseInvoiceForReceipt({
      transaction: januaryTx,
      financial: canvaOcrWithoutDate,
      ocrSucceeded: true,
      workspaceId: workspaceId.toString(),
    });

    expect(existing).toBeNull();
  });

  it("rattache encore le même PDF déposé deux fois sur la même transaction", async () => {
    const augustTx = await makeTransaction({ date: "2026-08-25" });
    const augustInvoice = await makeInvoice({
      issueDate: "2026-08-25",
      linkedTransactionIds: [augustTx._id],
    });
    augustTx.linkedPurchaseInvoiceIds = [augustInvoice._id];

    const existing = await findExistingPurchaseInvoiceForReceipt({
      transaction: augustTx,
      financial: canvaOcrWithoutDate,
      ocrSucceeded: true,
      workspaceId: workspaceId.toString(),
    });

    expect(existing?._id.toString()).toBe(augustInvoice._id.toString());
  });

  it("rattache une facture saisie à la main dont le débit tombe quelques jours plus tard", async () => {
    const invoice = await makeInvoice({
      issueDate: "2026-09-01",
      amountTTC: 11.99,
    });
    const tx = await makeTransaction({ date: "2026-09-04" });

    const existing = await findExistingPurchaseInvoiceForReceipt({
      transaction: tx,
      financial: canvaOcrWithoutDate,
      ocrSucceeded: true,
      workspaceId: workspaceId.toString(),
    });

    expect(existing?._id.toString()).toBe(invoice._id.toString());
  });

  it("OCR échoué : garde la facture déjà liée à la transaction", async () => {
    const tx = await makeTransaction({ date: "2026-08-25" });
    const invoice = await makeInvoice({
      issueDate: "2026-08-25",
      linkedTransactionIds: [tx._id],
    });
    tx.linkedPurchaseInvoiceIds = [invoice._id];

    const existing = await findExistingPurchaseInvoiceForReceipt({
      transaction: tx,
      financial: null,
      ocrSucceeded: false,
      workspaceId: workspaceId.toString(),
    });

    expect(existing?._id.toString()).toBe(invoice._id.toString());
  });
});

describe("purchaseInvoiceCanAbsorbTransaction", () => {
  it("refuse un second débit identique sur une facture déjà payée", async () => {
    const paidTx = await makeTransaction({ date: "2026-08-25" });
    const invoice = await makeInvoice({
      issueDate: "2026-08-25",
      linkedTransactionIds: [paidTx._id],
    });
    const otherTx = await makeTransaction({ date: "2026-08-25" });

    expect(await purchaseInvoiceCanAbsorbTransaction(invoice, otherTx)).toBe(
      false,
    );
  });

  it("accepte un paiement en plusieurs fois tant que le total tient dans le TTC", async () => {
    const first = await makeTransaction({ date: "2026-09-01", amount: -1500 });
    const invoice = await makeInvoice({
      issueDate: "2026-09-01",
      amountTTC: 3000,
      linkedTransactionIds: [first._id],
    });
    const second = await makeTransaction({
      date: "2026-09-15",
      amount: -1500,
    });
    const tooMuch = await makeTransaction({
      date: "2026-09-20",
      amount: -1600,
    });

    expect(await purchaseInvoiceCanAbsorbTransaction(invoice, second)).toBe(
      true,
    );
    expect(await purchaseInvoiceCanAbsorbTransaction(invoice, tooMuch)).toBe(
      false,
    );
  });

  it("ne compte pas la transaction elle-même si elle est déjà liée", async () => {
    const tx = await makeTransaction({ date: "2026-08-25" });
    const invoice = await makeInvoice({
      issueDate: "2026-08-25",
      linkedTransactionIds: [tx._id],
    });

    expect(await purchaseInvoiceCanAbsorbTransaction(invoice, tx)).toBe(true);
  });

  it("tolère les arrondis de conversion de devise", async () => {
    const invoice = await makeInvoice({
      issueDate: "2026-08-01",
      amountTTC: 10.59,
    });
    const tx = await makeTransaction({ date: "2026-08-02", amount: -10.64 });

    expect(await purchaseInvoiceCanAbsorbTransaction(invoice, tx)).toBe(true);
  });
});
