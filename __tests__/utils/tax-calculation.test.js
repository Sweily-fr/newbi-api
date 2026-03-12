import { describe, it, expect } from 'vitest';

/**
 * Tests for calculateInvoiceTotals from src/resolvers/invoice.js
 * We replicate the function here since it's not exported separately.
 */

// Replicate the exact logic from invoice.js lines 46-134
const calculateInvoiceTotals = (
  items,
  discount = 0,
  discountType = "FIXED",
  shipping = null,
  isReverseCharge = false
) => {
  let totalHT = 0;
  let totalVAT = 0;

  items.forEach((item) => {
    let itemHT = item.quantity * item.unitPrice;

    const progressPercentage =
      item.progressPercentage !== undefined && item.progressPercentage !== null
        ? item.progressPercentage
        : 100;
    itemHT = itemHT * (progressPercentage / 100);

    if (item.discount) {
      if (
        item.discountType === "PERCENTAGE" ||
        item.discountType === "percentage"
      ) {
        const discountPercent = Math.min(item.discount, 100);
        itemHT = itemHT * (1 - discountPercent / 100);
      } else {
        itemHT = Math.max(0, itemHT - item.discount);
      }
    }

    const itemVAT = isReverseCharge ? 0 : itemHT * (item.vatRate / 100);
    totalHT += itemHT;
    totalVAT += itemVAT;
  });

  if (shipping && shipping.billShipping) {
    const shippingHT = shipping.shippingAmountHT || 0;
    const shippingVAT = isReverseCharge
      ? 0
      : shippingHT * (shipping.shippingVatRate / 100);

    totalHT += shippingHT;
    totalVAT += shippingVAT;
  }

  const totalTTC = totalHT + totalVAT;

  let discountAmount = 0;
  if (discount) {
    if (discountType === "PERCENTAGE" || discountType === "percentage") {
      const discountPercent = Math.min(discount, 100);
      discountAmount = (totalHT * discountPercent) / 100;
    } else {
      discountAmount = discount;
    }
  }

  const finalTotalHT = totalHT - discountAmount;

  let finalTotalVAT = 0;
  if (!isReverseCharge && finalTotalHT > 0 && totalHT > 0) {
    finalTotalVAT = totalVAT * (finalTotalHT / totalHT);
  }
  const finalTotalTTC = finalTotalHT + finalTotalVAT;

  return {
    totalHT,
    totalVAT,
    totalTTC,
    finalTotalHT,
    finalTotalVAT,
    finalTotalTTC,
    discountAmount,
  };
};

describe('calculateInvoiceTotals', () => {
  describe('basic calculations', () => {
    it('should calculate totals for a single item with 20% VAT', () => {
      const items = [
        { quantity: 2, unitPrice: 100, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(200);
      expect(result.totalVAT).toBe(40);
      expect(result.totalTTC).toBe(240);
      expect(result.finalTotalHT).toBe(200);
      expect(result.finalTotalVAT).toBe(40);
      expect(result.finalTotalTTC).toBe(240);
      expect(result.discountAmount).toBe(0);
    });

    it('should calculate totals for multiple items with different VAT rates', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20 },
        { quantity: 3, unitPrice: 50, vatRate: 10 },
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(250); // 100 + 150
      expect(result.totalVAT).toBe(35); // 20 + 15
      expect(result.totalTTC).toBe(285);
    });

    it('should handle zero quantity', () => {
      const items = [
        { quantity: 0, unitPrice: 100, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(0);
      expect(result.totalVAT).toBe(0);
      expect(result.totalTTC).toBe(0);
    });

    it('should handle empty items array', () => {
      const result = calculateInvoiceTotals([]);

      expect(result.totalHT).toBe(0);
      expect(result.totalVAT).toBe(0);
      expect(result.totalTTC).toBe(0);
    });
  });

  describe('item-level discount', () => {
    it('should apply a fixed item discount', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20, discount: 10, discountType: 'FIXED' }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(90);
      expect(result.totalVAT).toBe(18); // 90 * 0.20
    });

    it('should apply a percentage item discount', () => {
      const items = [
        { quantity: 1, unitPrice: 200, vatRate: 20, discount: 25, discountType: 'PERCENTAGE' }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(150); // 200 * (1 - 25/100)
      expect(result.totalVAT).toBe(30); // 150 * 0.20
    });

    it('should cap percentage discount at 100%', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20, discount: 150, discountType: 'PERCENTAGE' }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(0);
      expect(result.totalVAT).toBe(0);
    });

    it('should not produce negative HT with fixed discount exceeding item total', () => {
      const items = [
        { quantity: 1, unitPrice: 50, vatRate: 20, discount: 100, discountType: 'FIXED' }
      ];

      const result = calculateInvoiceTotals(items);

      // Math.max(0, 50 - 100) = 0
      expect(result.totalHT).toBe(0);
    });
  });

  describe('global discount', () => {
    it('should apply a fixed global discount', () => {
      const items = [
        { quantity: 1, unitPrice: 500, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items, 50, 'FIXED');

      expect(result.totalHT).toBe(500);
      expect(result.discountAmount).toBe(50);
      expect(result.finalTotalHT).toBe(450);
      // VAT is proportionally reduced: 100 * (450/500) = 90
      expect(result.finalTotalVAT).toBe(90);
      expect(result.finalTotalTTC).toBe(540);
    });

    it('should apply a percentage global discount', () => {
      const items = [
        { quantity: 1, unitPrice: 1000, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items, 10, 'PERCENTAGE');

      expect(result.discountAmount).toBe(100); // 1000 * 10%
      expect(result.finalTotalHT).toBe(900);
      // VAT proportionally: 200 * (900/1000) = 180
      expect(result.finalTotalVAT).toBe(180);
      expect(result.finalTotalTTC).toBe(1080);
    });

    it('should set VAT to 0 when global discount makes finalTotalHT <= 0', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items, 200, 'FIXED');

      expect(result.finalTotalHT).toBe(-100);
      expect(result.finalTotalVAT).toBe(0);
    });
  });

  describe('progress percentage (situation invoices)', () => {
    it('should apply progress percentage to item total', () => {
      const items = [
        { quantity: 1, unitPrice: 1000, vatRate: 20, progressPercentage: 50 }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(500); // 1000 * 50%
      expect(result.totalVAT).toBe(100); // 500 * 20%
    });

    it('should default to 100% when progressPercentage is undefined', () => {
      const items = [
        { quantity: 1, unitPrice: 1000, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(1000);
    });

    it('should handle 0% progress', () => {
      const items = [
        { quantity: 1, unitPrice: 1000, vatRate: 20, progressPercentage: 0 }
      ];

      const result = calculateInvoiceTotals(items);

      expect(result.totalHT).toBe(0);
    });
  });

  describe('shipping', () => {
    it('should add shipping costs when billShipping is true', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20 }
      ];
      const shipping = {
        billShipping: true,
        shippingAmountHT: 15,
        shippingVatRate: 20,
      };

      const result = calculateInvoiceTotals(items, 0, 'FIXED', shipping);

      expect(result.totalHT).toBe(115); // 100 + 15
      expect(result.totalVAT).toBe(23); // 20 + 3
      expect(result.totalTTC).toBe(138);
    });

    it('should not add shipping when billShipping is false', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20 }
      ];
      const shipping = {
        billShipping: false,
        shippingAmountHT: 15,
        shippingVatRate: 20,
      };

      const result = calculateInvoiceTotals(items, 0, 'FIXED', shipping);

      expect(result.totalHT).toBe(100);
    });

    it('should handle null shipping', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items, 0, 'FIXED', null);

      expect(result.totalHT).toBe(100);
    });
  });

  describe('reverse charge (auto-liquidation)', () => {
    it('should set all VAT to 0 when isReverseCharge is true', () => {
      const items = [
        { quantity: 2, unitPrice: 100, vatRate: 20 }
      ];

      const result = calculateInvoiceTotals(items, 0, 'FIXED', null, true);

      expect(result.totalHT).toBe(200);
      expect(result.totalVAT).toBe(0);
      expect(result.totalTTC).toBe(200);
      expect(result.finalTotalVAT).toBe(0);
      expect(result.finalTotalTTC).toBe(200);
    });

    it('should set shipping VAT to 0 when isReverseCharge is true', () => {
      const items = [
        { quantity: 1, unitPrice: 100, vatRate: 20 }
      ];
      const shipping = {
        billShipping: true,
        shippingAmountHT: 20,
        shippingVatRate: 20,
      };

      const result = calculateInvoiceTotals(items, 0, 'FIXED', shipping, true);

      expect(result.totalHT).toBe(120);
      expect(result.totalVAT).toBe(0);
      expect(result.totalTTC).toBe(120);
    });
  });
});
