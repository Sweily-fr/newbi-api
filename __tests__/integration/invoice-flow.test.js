import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Invoice from "../../src/models/Invoice.js";
// Real implementation — must import, not re-implement.
import { calculateInvoiceTotals } from "../../src/resolvers/invoice.js";

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

const workspaceId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

const insertInvoice = (data) =>
  Invoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    status: "DRAFT",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  });

const findInvoice = (filter) => Invoice.collection.findOne(filter);

describe("Invoice CRUD lifecycle (real Mongo)", () => {
  it("creates a draft invoice with totals computed by the real calculator", async () => {
    const items = [
      {
        description: "Web development",
        quantity: 10,
        unitPrice: 500,
        vatRate: 20,
      },
      { description: "Design", quantity: 5, unitPrice: 300, vatRate: 20 },
    ];

    const totals = calculateInvoiceTotals(items);

    const { insertedId } = await insertInvoice({
      number: "DRAFT-0001",
      prefix: "F-202603",
      items,
      ...totals,
      client: { id: "client-1", name: "Acme Corp" },
    });

    const stored = await findInvoice({ _id: insertedId });
    expect(stored.status).toBe("DRAFT");
    expect(stored.totalHT).toBe(6500);
    expect(stored.totalVAT).toBe(1300);
    expect(stored.totalTTC).toBe(7800);
  });

  it("transitions a draft invoice to PENDING", async () => {
    const totals = calculateInvoiceTotals([
      { description: "Consulting", quantity: 8, unitPrice: 600, vatRate: 20 },
    ]);
    const { insertedId } = await insertInvoice({
      number: "DRAFT-0001",
      items: [
        { description: "Consulting", quantity: 8, unitPrice: 600, vatRate: 20 },
      ],
      ...totals,
    });

    await Invoice.collection.updateOne(
      { _id: insertedId },
      { $set: { status: "PENDING", number: "0001" } },
    );

    const stored = await findInvoice({ _id: insertedId });
    expect(stored.status).toBe("PENDING");
    expect(stored.number).toBe("0001");
  });

  it("marks an invoice as COMPLETED", async () => {
    const { insertedId } = await insertInvoice({
      number: "0001",
      status: "PENDING",
      totalHT: 1000,
      totalTTC: 1200,
    });

    const paymentDate = new Date();
    await Invoice.collection.updateOne(
      { _id: insertedId },
      {
        $set: {
          status: "COMPLETED",
          paymentDate,
          paymentMethod: "BANK_TRANSFER",
        },
      },
    );

    const stored = await findInvoice({ _id: insertedId });
    expect(stored.status).toBe("COMPLETED");
    expect(stored.paymentMethod).toBe("BANK_TRANSFER");
  });

  it("cancels an invoice", async () => {
    const { insertedId } = await insertInvoice({
      number: "0002",
      status: "PENDING",
    });

    await Invoice.collection.updateOne(
      { _id: insertedId },
      { $set: { status: "CANCELED" } },
    );

    const stored = await findInvoice({ _id: insertedId });
    expect(stored.status).toBe("CANCELED");
  });

  it("deletes a draft invoice and cannot find it again", async () => {
    const { insertedId } = await insertInvoice({ number: "DRAFT-0003" });

    const { deletedCount } = await Invoice.collection.deleteOne({
      _id: insertedId,
    });
    expect(deletedCount).toBe(1);
    expect(await findInvoice({ _id: insertedId })).toBeNull();
  });
});

describe("Invoice totals — real calculator edge cases", () => {
  it("applies global percentage discount and shipping", () => {
    const items = [
      { description: "Service A", quantity: 1, unitPrice: 10000, vatRate: 20 },
    ];
    const shipping = {
      billShipping: true,
      shippingAmountHT: 250,
      shippingVatRate: 20,
    };

    const totals = calculateInvoiceTotals(items, 5, "PERCENTAGE", shipping);

    expect(totals.totalHT).toBe(10250);
    expect(totals.discountAmount).toBe(512.5);
    expect(totals.finalTotalHT).toBe(9737.5);
  });

  it("zeroes VAT when reverse charge is on", () => {
    const items = [
      {
        description: "EU Export Service",
        quantity: 1,
        unitPrice: 5000,
        vatRate: 20,
      },
    ];

    const totals = calculateInvoiceTotals(items, 0, "FIXED", null, true);

    expect(totals.totalVAT).toBe(0);
    expect(totals.finalTotalVAT).toBe(0);
    expect(totals.finalTotalTTC).toBe(5000);
  });

  it("applies progressPercentage for situation invoices", () => {
    const items = [
      {
        description: "Construction Phase 1",
        quantity: 1,
        unitPrice: 50000,
        vatRate: 20,
        progressPercentage: 30,
      },
    ];

    const totals = calculateInvoiceTotals(items);

    expect(totals.totalHT).toBe(15000);
    expect(totals.totalVAT).toBe(3000);
    expect(totals.totalTTC).toBe(18000);
  });
});
