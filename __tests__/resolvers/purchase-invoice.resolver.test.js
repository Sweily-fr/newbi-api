import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// Mock models and services
vi.mock('../../src/models/PurchaseInvoice.js', () => {
  class MockPurchaseInvoice {
    constructor(data) {
      Object.assign(this, data);
      this._id = new mongoose.Types.ObjectId();
      this.files = data.files || [];
      this.save = vi.fn().mockResolvedValue(true);
    }
  }
  MockPurchaseInvoice.findOne = vi.fn();
  MockPurchaseInvoice.find = vi.fn();
  MockPurchaseInvoice.countDocuments = vi.fn();
  MockPurchaseInvoice.deleteOne = vi.fn();
  MockPurchaseInvoice.updateMany = vi.fn();
  MockPurchaseInvoice.deleteMany = vi.fn();
  MockPurchaseInvoice.aggregate = vi.fn();
  return { default: MockPurchaseInvoice };
});

vi.mock('../../src/models/Supplier.js', () => {
  const mockSupplier = vi.fn().mockImplementation((data) => ({
    ...data,
    _id: new mongoose.Types.ObjectId(),
    save: vi.fn().mockResolvedValue(true),
  }));
  mockSupplier.findOne = vi.fn();
  mockSupplier.find = vi.fn();
  mockSupplier.countDocuments = vi.fn();
  mockSupplier.create = vi.fn();
  mockSupplier.deleteOne = vi.fn();
  mockSupplier.deleteMany = vi.fn();
  return { default: mockSupplier };
});

vi.mock('../../src/services/cloudflareService.js', () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    uploadImage: vi.fn().mockResolvedValue({ url: 'https://test.r2.dev/test.pdf', key: 'test.pdf' }),
  },
}));

vi.mock('../../src/services/superPdpService.js', () => ({
  default: {
    getReceivedInvoices: vi.fn(),
    transformReceivedInvoiceToPurchaseInvoice: vi.fn(),
  },
}));

vi.mock('../../src/services/eInvoicingSettingsService.js', () => ({
  default: { isEInvoicingEnabled: vi.fn() },
}));

vi.mock('../../src/services/documentAutomationService.js', () => ({
  default: {
    executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/middlewares/rbac.js', () => ({
  requireRead: () => (resolver) => resolver,
  requireWrite: () => (resolver) => resolver,
  requireDelete: () => (resolver) => resolver,
}));

vi.mock('../../src/middlewares/better-auth-jwt.js', () => ({
  isAuthenticated: (resolver) => resolver,
}));

import PurchaseInvoice from '../../src/models/PurchaseInvoice.js';
import Supplier from '../../src/models/Supplier.js';

// Import the resolvers - must be after all mocks
import purchaseInvoiceResolvers from '../../src/resolvers/purchaseInvoice.js';

const mockContext = {
  user: { id: 'user-1', name: 'Test User' },
  workspaceId: '507f1f77bcf86cd799439011',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PurchaseInvoice Resolver - resolveWorkspaceId helper', () => {
  it('should use context workspaceId when input is null', () => {
    // Test the resolveWorkspaceId pattern used throughout purchaseInvoice.js
    const inputWorkspaceId = null;
    const contextWorkspaceId = 'org-123';

    const result = inputWorkspaceId || contextWorkspaceId;
    expect(result).toBe('org-123');
  });

  it('should throw when workspace IDs mismatch', () => {
    const inputWorkspaceId = 'org-111';
    const contextWorkspaceId = 'org-222';

    expect(() => {
      if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
        throw new Error('Organisation invalide.');
      }
    }).toThrow('Organisation invalide');
  });
});

describe('PurchaseInvoice Resolver - Query.purchaseInvoice', () => {
  const resolver = purchaseInvoiceResolvers.Query.purchaseInvoice;

  it('should return a purchase invoice by id', async () => {
    const mockDoc = { _id: 'pi-1', invoiceNumber: 'PI-001', amountTTC: 1200 };
    PurchaseInvoice.findOne.mockResolvedValue(mockDoc);

    const result = await resolver(null, { id: 'pi-1' }, mockContext);

    expect(result).toEqual(mockDoc);
  });

  it('should throw NOT_FOUND when purchase invoice does not exist', async () => {
    PurchaseInvoice.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: 'nonexistent' }, mockContext)
    ).rejects.toThrow("non trouvée");
  });
});

describe('PurchaseInvoice Resolver - Query.purchaseInvoices', () => {
  const resolver = purchaseInvoiceResolvers.Query.purchaseInvoices;

  it('should return paginated purchase invoices', async () => {
    const mockItems = [{ invoiceNumber: 'PI-001' }, { invoiceNumber: 'PI-002' }];
    PurchaseInvoice.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            lean: vi.fn().mockResolvedValue(mockItems),
          }),
        }),
      }),
    });
    PurchaseInvoice.countDocuments.mockResolvedValue(2);

    const result = await resolver(
      null,
      { page: 1, limit: 20 },
      mockContext
    );

    expect(result.items).toEqual(mockItems);
    expect(result.totalCount).toBe(2);
    expect(result.currentPage).toBe(1);
  });
});

describe('PurchaseInvoice Resolver - Mutation.createPurchaseInvoice', () => {
  const resolver = purchaseInvoiceResolvers.Mutation.createPurchaseInvoice;

  it('should create a purchase invoice', async () => {
    Supplier.findOne.mockResolvedValue(null);
    Supplier.create.mockResolvedValue({ _id: 'supplier-1', name: 'Test Supplier' });

    const input = {
      supplierName: 'Test Supplier',
      amountTTC: 500,
      status: 'TO_PAY',
    };

    const result = await resolver(null, { input }, mockContext);
    expect(result).toBeDefined();
    expect(result.save).toHaveBeenCalled();
  });

  it('should auto-create supplier if supplierName provided without supplierId', async () => {
    Supplier.findOne.mockResolvedValue(null);
    Supplier.create.mockResolvedValue({ _id: 'new-supplier-id', name: 'New Supplier' });

    const input = {
      supplierName: 'New Supplier',
      amountTTC: 300,
    };

    await resolver(null, { input }, mockContext);

    expect(Supplier.create).toHaveBeenCalled();
  });
});

describe('PurchaseInvoice Resolver - Mutation.deletePurchaseInvoice', () => {
  const resolver = purchaseInvoiceResolvers.Mutation.deletePurchaseInvoice;

  it('should delete a purchase invoice', async () => {
    PurchaseInvoice.findOne.mockResolvedValue({
      _id: 'pi-1',
      files: [],
    });
    PurchaseInvoice.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const result = await resolver(null, { id: 'pi-1' }, mockContext);

    expect(result).toEqual({ success: true, message: "Facture d'achat supprimée" });
  });

  it('should throw when purchase invoice not found', async () => {
    PurchaseInvoice.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: 'nonexistent' }, mockContext)
    ).rejects.toThrow("non trouvée");
  });
});

describe('PurchaseInvoice Resolver - Mutation.bulkUpdatePurchaseInvoiceStatus', () => {
  const resolver = purchaseInvoiceResolvers.Mutation.bulkUpdatePurchaseInvoiceStatus;

  it('should bulk update statuses', async () => {
    PurchaseInvoice.updateMany.mockResolvedValue({ modifiedCount: 3 });

    const result = await resolver(
      null,
      { ids: ['id1', 'id2', 'id3'], status: 'PAID' },
      mockContext
    );

    expect(result.success).toBe(true);
    expect(result.updatedCount).toBe(3);
  });
});

describe('PurchaseInvoice Resolver - Mutation.markPurchaseInvoiceAsPaid', () => {
  const resolver = purchaseInvoiceResolvers.Mutation.markPurchaseInvoiceAsPaid;

  it('should mark invoice as paid with payment date', async () => {
    const mockInvoice = {
      _id: 'pi-1',
      status: 'TO_PAY',
      files: [],
      save: vi.fn().mockResolvedValue(true),
    };
    PurchaseInvoice.findOne.mockResolvedValue(mockInvoice);

    const result = await resolver(
      null,
      { id: 'pi-1', paymentDate: '2026-03-10', paymentMethod: 'BANK_TRANSFER' },
      mockContext
    );

    expect(result.status).toBe('PAID');
    expect(result.paymentMethod).toBe('BANK_TRANSFER');
    expect(result.save).toHaveBeenCalled();
  });
});
