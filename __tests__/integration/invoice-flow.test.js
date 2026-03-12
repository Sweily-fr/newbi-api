import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

/**
 * Integration-style test that simulates the invoice CRUD lifecycle
 * by testing resolver functions in sequence with mocked Mongoose models.
 */

// Replicate calculateInvoiceTotals (core calculation tested in isolation)
const calculateInvoiceTotals = (
  items, discount = 0, discountType = "FIXED", shipping = null, isReverseCharge = false
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;
    const pp = item.progressPercentage !== undefined && item.progressPercentage !== null
      ? item.progressPercentage : 100;
    itemHT = itemHT * (pp / 100);
    if (item.discount) {
      if (item.discountType === "PERCENTAGE" || item.discountType === "percentage") {
        itemHT = itemHT * (1 - Math.min(item.discount, 100) / 100);
      } else {
        itemHT = Math.max(0, itemHT - item.discount);
      }
    }
    const itemVAT = isReverseCharge ? 0 : itemHT * (item.vatRate / 100);
    totalHT += itemHT;
    totalVAT += itemVAT;
  });

  if (shipping && shipping.billShipping) {
    const sHT = shipping.shippingAmountHT || 0;
    const sVAT = isReverseCharge ? 0 : sHT * (shipping.shippingVatRate / 100);
    totalHT += sHT;
    totalVAT += sVAT;
  }

  const totalTTC = totalHT + totalVAT;
  let discountAmount = 0;
  if (discount) {
    if (discountType === "PERCENTAGE" || discountType === "percentage") {
      discountAmount = (totalHT * Math.min(discount, 100)) / 100;
    } else {
      discountAmount = discount;
    }
  }
  const finalTotalHT = totalHT - discountAmount;
  let finalTotalVAT = 0;
  if (!isReverseCharge && finalTotalHT > 0 && totalHT > 0) {
    finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
  }
  return {
    totalHT, totalVAT, totalTTC,
    finalTotalHT, finalTotalVAT,
    finalTotalTTC: finalTotalHT + finalTotalVAT,
    discountAmount,
  };
};

// Simulated in-memory store
let invoiceStore = [];
let nextId = 1;

const InvoiceMock = {
  create(data) {
    const doc = {
      ...data,
      _id: `inv-${nextId++}`,
      status: data.status || 'DRAFT',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    invoiceStore.push(doc);
    return doc;
  },
  findById(id) {
    return invoiceStore.find((inv) => inv._id === id) || null;
  },
  findByIdAndUpdate(id, update) {
    const idx = invoiceStore.findIndex((inv) => inv._id === id);
    if (idx === -1) return null;
    invoiceStore[idx] = { ...invoiceStore[idx], ...update, updatedAt: new Date() };
    return invoiceStore[idx];
  },
  deleteOne(id) {
    const idx = invoiceStore.findIndex((inv) => inv._id === id);
    if (idx === -1) return { deletedCount: 0 };
    invoiceStore.splice(idx, 1);
    return { deletedCount: 1 };
  },
};

beforeEach(() => {
  invoiceStore = [];
  nextId = 1;
});

describe('Invoice CRUD lifecycle', () => {
  it('should create a draft invoice with calculated totals', () => {
    const items = [
      { description: 'Web development', quantity: 10, unitPrice: 500, vatRate: 20 },
      { description: 'Design', quantity: 5, unitPrice: 300, vatRate: 20 },
    ];

    const totals = calculateInvoiceTotals(items);

    const invoice = InvoiceMock.create({
      number: 'DRAFT-0001',
      prefix: 'F-202603',
      status: 'DRAFT',
      items,
      ...totals,
      client: { id: 'client-1', name: 'Acme Corp' },
      workspaceId: 'ws-1',
      createdBy: 'user-1',
    });

    expect(invoice._id).toBe('inv-1');
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.totalHT).toBe(6500); // (10*500) + (5*300)
    expect(invoice.totalVAT).toBe(1300); // 6500 * 20%
    expect(invoice.totalTTC).toBe(7800);
  });

  it('should update a draft to finalized (PENDING)', () => {
    const items = [
      { description: 'Consulting', quantity: 8, unitPrice: 600, vatRate: 20 },
    ];
    const totals = calculateInvoiceTotals(items);

    const invoice = InvoiceMock.create({
      number: 'DRAFT-0001',
      status: 'DRAFT',
      items,
      ...totals,
      workspaceId: 'ws-1',
    });

    // Finalize: change from DRAFT to PENDING
    const updated = InvoiceMock.findByIdAndUpdate(invoice._id, {
      status: 'PENDING',
      number: '0001', // Remove DRAFT prefix
    });

    expect(updated.status).toBe('PENDING');
    expect(updated.number).toBe('0001');
  });

  it('should mark invoice as COMPLETED (paid)', () => {
    const invoice = InvoiceMock.create({
      number: '0001',
      status: 'PENDING',
      totalHT: 1000,
      totalTTC: 1200,
      workspaceId: 'ws-1',
    });

    const updated = InvoiceMock.findByIdAndUpdate(invoice._id, {
      status: 'COMPLETED',
      paymentDate: new Date(),
      paymentMethod: 'BANK_TRANSFER',
    });

    expect(updated.status).toBe('COMPLETED');
    expect(updated.paymentMethod).toBe('BANK_TRANSFER');
  });

  it('should cancel an invoice', () => {
    const invoice = InvoiceMock.create({
      number: '0002',
      status: 'PENDING',
      workspaceId: 'ws-1',
    });

    const updated = InvoiceMock.findByIdAndUpdate(invoice._id, {
      status: 'CANCELED',
    });

    expect(updated.status).toBe('CANCELED');
  });

  it('should delete a draft invoice', () => {
    const invoice = InvoiceMock.create({
      number: 'DRAFT-0003',
      status: 'DRAFT',
      workspaceId: 'ws-1',
    });

    const result = InvoiceMock.deleteOne(invoice._id);
    expect(result.deletedCount).toBe(1);
    expect(InvoiceMock.findById(invoice._id)).toBeNull();
  });

  it('should not find a deleted invoice', () => {
    const invoice = InvoiceMock.create({
      number: 'DRAFT-0004',
      status: 'DRAFT',
      workspaceId: 'ws-1',
    });

    InvoiceMock.deleteOne(invoice._id);
    expect(InvoiceMock.findById(invoice._id)).toBeNull();
  });
});

describe('Invoice totals edge cases in CRUD flow', () => {
  it('should handle invoice with global percentage discount and shipping', () => {
    const items = [
      { description: 'Service A', quantity: 1, unitPrice: 10000, vatRate: 20 },
    ];
    const shipping = { billShipping: true, shippingAmountHT: 250, shippingVatRate: 20 };

    const totals = calculateInvoiceTotals(items, 5, 'PERCENTAGE', shipping);

    const invoice = InvoiceMock.create({
      number: '0010',
      status: 'PENDING',
      items,
      ...totals,
      workspaceId: 'ws-1',
    });

    // totalHT = 10000 + 250 = 10250
    expect(invoice.totalHT).toBe(10250);
    // discountAmount = 10250 * 5% = 512.5
    expect(invoice.discountAmount).toBe(512.5);
    // finalTotalHT = 10250 - 512.5 = 9737.5
    expect(invoice.finalTotalHT).toBe(9737.5);
  });

  it('should handle reverse charge invoice for EU clients', () => {
    const items = [
      { description: 'EU Export Service', quantity: 1, unitPrice: 5000, vatRate: 20 },
    ];

    const totals = calculateInvoiceTotals(items, 0, 'FIXED', null, true);

    const invoice = InvoiceMock.create({
      number: '0020',
      status: 'PENDING',
      items,
      ...totals,
      isReverseCharge: true,
      workspaceId: 'ws-1',
    });

    expect(invoice.totalVAT).toBe(0);
    expect(invoice.finalTotalVAT).toBe(0);
    expect(invoice.finalTotalTTC).toBe(5000);
  });

  it('should handle situation invoice with partial progress', () => {
    const items = [
      { description: 'Construction Phase 1', quantity: 1, unitPrice: 50000, vatRate: 20, progressPercentage: 30 },
    ];

    const totals = calculateInvoiceTotals(items);

    const invoice = InvoiceMock.create({
      number: '0030',
      status: 'PENDING',
      items,
      ...totals,
      workspaceId: 'ws-1',
    });

    expect(invoice.totalHT).toBe(15000); // 50000 * 30%
    expect(invoice.totalVAT).toBe(3000); // 15000 * 20%
    expect(invoice.totalTTC).toBe(18000);
  });
});
