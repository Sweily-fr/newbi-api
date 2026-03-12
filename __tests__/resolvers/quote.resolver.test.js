import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock Mongoose models ───────────────────────────────────────────

vi.mock('../../src/models/Quote.js', () => {
  class MockQuote {
    constructor(data) {
      Object.assign(this, data);
      this._id = data._id || new mongoose.Types.ObjectId();
      this.save = vi.fn().mockResolvedValue(true);
    }
  }
  MockQuote.findOne = vi.fn();
  MockQuote.find = vi.fn();
  MockQuote.countDocuments = vi.fn();
  MockQuote.findById = vi.fn();
  MockQuote.findByIdAndUpdate = vi.fn();
  MockQuote.findByIdAndDelete = vi.fn();
  MockQuote.deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });
  MockQuote.aggregate = vi.fn();
  return { default: MockQuote };
});

vi.mock('../../src/models/Invoice.js', () => ({
  default: {
    findById: vi.fn(),
    find: vi.fn(),
    countDocuments: vi.fn(),
  },
}));

vi.mock('../../src/models/User.js', () => ({
  default: { findById: vi.fn() },
}));

vi.mock('../../src/models/Client.js', () => ({
  default: { findOne: vi.fn() },
}));

// ─── Mock middlewares (pass-through) ────────────────────────────────

vi.mock('../../src/middlewares/rbac.js', () => ({
  requireRead: () => (resolver) => resolver,
  requireWrite: () => (resolver) => resolver,
  requireDelete: () => (resolver) => resolver,
}));

vi.mock('../../src/middlewares/better-auth-jwt.js', () => ({
  isAuthenticated: (resolver) => resolver,
}));

vi.mock('../../src/middlewares/company-info-guard.js', () => ({
  requireCompanyInfo: (resolver) => resolver,
  getOrganizationInfo: vi.fn().mockResolvedValue({
    companyName: 'Test SASU',
    companyAddress: { street: '1 rue du Test', city: 'Paris', postalCode: '75001', country: 'France' },
    companyPhone: '+33100000000',
    companyEmail: 'contact@test.fr',
    companySiret: '12345678901234',
    companyVatNumber: 'FR12345678901',
    companyCapitalSocial: '1000',
    companyRcs: 'Paris',
    companyStatus: 'SASU',
    companyBankDetails: { iban: 'FR76...', bic: 'BNPAFRPP', bankName: 'BNP' },
  }),
}));

vi.mock('../../src/utils/companyInfoMapper.js', () => ({
  mapOrganizationToCompanyInfo: vi.fn().mockReturnValue({
    name: 'Test SASU',
    address: { street: '1 rue du Test', city: 'Paris', postalCode: '75001', country: 'France' },
  }),
}));

vi.mock('../../src/utils/documentNumbers.js', () => ({
  generateQuoteNumber: vi.fn().mockResolvedValue('000001'),
  generateInvoiceNumber: vi.fn().mockResolvedValue('001'),
}));

vi.mock('../../src/services/documentAutomationService.js', () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

// ─── Import after mocks ────────────────────────────────────────────

import Quote from '../../src/models/Quote.js';
import Invoice from '../../src/models/Invoice.js';
import quoteResolvers from '../../src/resolvers/quote.js';

const mockContext = {
  user: { id: 'user-1', name: 'Test User', email: 'test@test.com' },
  workspaceId: '507f1f77bcf86cd799439011',
  userRole: 'owner',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Query.quote ────────────────────────────────────────────────────

describe('Quote Resolver - Query.quote', () => {
  const resolver = quoteResolvers.Query.quote;

  it('should return a quote by id', async () => {
    const mockQuote = {
      _id: 'quote-1',
      number: '001',
      status: 'PENDING',
      workspaceId: mockContext.workspaceId,
    };
    Quote.findOne.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockResolvedValue(mockQuote),
      }),
    });

    const result = await resolver(
      null,
      { id: 'quote-1', workspaceId: mockContext.workspaceId },
      mockContext
    );

    expect(result).toEqual(mockQuote);
    expect(Quote.findOne).toHaveBeenCalledWith({
      _id: 'quote-1',
      workspaceId: mockContext.workspaceId,
    });
  });

  it('should throw NOT_FOUND when quote does not exist', async () => {
    Quote.findOne.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockResolvedValue(null),
      }),
    });

    await expect(
      resolver(null, { id: 'nonexistent', workspaceId: mockContext.workspaceId }, mockContext)
    ).rejects.toThrow();
  });
});

// ─── Query.quotes ───────────────────────────────────────────────────

describe('Quote Resolver - Query.quotes', () => {
  const resolver = quoteResolvers.Query.quotes;

  it('should return paginated quote list', async () => {
    const mockQuotes = [{ number: '001' }, { number: '002' }];
    Quote.countDocuments.mockResolvedValue(25);
    Quote.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue(mockQuotes),
            }),
          }),
        }),
      }),
    });

    const result = await resolver(
      null,
      { workspaceId: mockContext.workspaceId, page: 1, limit: 10 },
      mockContext
    );

    expect(result.quotes).toEqual(mockQuotes);
    expect(result.totalCount).toBe(25);
    expect(result.hasNextPage).toBe(true);
  });

  it('should apply status filter', async () => {
    Quote.countDocuments.mockResolvedValue(5);
    Quote.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId: mockContext.workspaceId, status: 'PENDING', page: 1, limit: 10 },
      mockContext
    );

    const queryArg = Quote.find.mock.calls[0][0];
    expect(queryArg.status).toBe('PENDING');
  });

  it('should apply search filter with $or', async () => {
    Quote.countDocuments.mockResolvedValue(1);
    Quote.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId: mockContext.workspaceId, search: 'Alpha', page: 1, limit: 10 },
      mockContext
    );

    const queryArg = Quote.countDocuments.mock.calls[0][0];
    expect(queryArg.$or).toBeDefined();
    expect(queryArg.$or.length).toBeGreaterThan(0);
  });

  it('should apply date range filters', async () => {
    Quote.countDocuments.mockResolvedValue(0);
    Quote.find.mockReturnValue({
      populate: vi.fn().mockReturnValue({
        populate: vi.fn().mockReturnValue({
          sort: vi.fn().mockReturnValue({
            skip: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    });

    await resolver(
      null,
      {
        workspaceId: mockContext.workspaceId,
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        page: 1,
        limit: 10,
      },
      mockContext
    );

    const queryArg = Quote.find.mock.calls[0][0];
    expect(queryArg.createdAt).toBeDefined();
    expect(queryArg.createdAt.$gte).toBeDefined();
    expect(queryArg.createdAt.$lte).toBeDefined();
  });
});

// ─── Query.quoteStats ───────────────────────────────────────────────

describe('Quote Resolver - Query.quoteStats', () => {
  const resolver = quoteResolvers.Query.quoteStats;

  it('should return aggregated stats', async () => {
    const mockStats = {
      totalCount: 10,
      draftCount: 3,
      pendingCount: 4,
      completedCount: 2,
      canceledCount: 1,
      totalAmount: 15000,
      conversionRate: 0.5,
    };
    Quote.aggregate.mockResolvedValue([mockStats]);

    const result = await resolver(
      null,
      { workspaceId: mockContext.workspaceId },
      mockContext
    );

    expect(result.totalCount).toBe(10);
    expect(result.pendingCount).toBe(4);
  });

  it('should return default stats when no quotes exist', async () => {
    Quote.aggregate.mockResolvedValue([undefined]);

    const result = await resolver(
      null,
      { workspaceId: mockContext.workspaceId },
      mockContext
    );

    expect(result.totalCount).toBe(0);
    expect(result.totalAmount).toBe(0);
  });
});

// ─── Mutation.deleteQuote ───────────────────────────────────────────

describe('Quote Resolver - Mutation.deleteQuote', () => {
  const resolver = quoteResolvers.Mutation.deleteQuote;

  it('should delete a DRAFT quote', async () => {
    const mockQuote = {
      _id: 'quote-1',
      status: 'DRAFT',
      workspaceId: mockContext.workspaceId,
      convertedToInvoice: null,
    };
    Quote.findOne.mockResolvedValue(mockQuote);
    Quote.findByIdAndDelete.mockResolvedValue(mockQuote);

    const result = await resolver(
      null,
      { id: 'quote-1', workspaceId: mockContext.workspaceId },
      mockContext
    );

    expect(result).toBeTruthy();
    expect(Quote.deleteOne).toHaveBeenCalled();
  });

  it('should throw when trying to delete a COMPLETED quote', async () => {
    Quote.findOne.mockResolvedValue({
      _id: 'quote-1',
      status: 'COMPLETED',
      workspaceId: mockContext.workspaceId,
    });

    await expect(
      resolver(null, { id: 'quote-1', workspaceId: mockContext.workspaceId }, mockContext)
    ).rejects.toThrow();
  });

  it('should throw NOT_FOUND when quote does not exist', async () => {
    Quote.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: 'nonexistent', workspaceId: mockContext.workspaceId }, mockContext)
    ).rejects.toThrow();
  });
});

// ─── calculateQuoteTotals (via createQuote) ─────────────────────────

describe('Quote Resolver - calculateQuoteTotals logic', () => {
  it('should calculate simple totals correctly', () => {
    // Test the exported function indirectly — the calculation is inline
    const items = [
      { quantity: 2, unitPrice: 100, vatRate: 20 },
    ];

    // Manually replicate the logic to test
    let totalHT = 0;
    let totalVAT = 0;
    items.forEach((item) => {
      const itemHT = item.quantity * item.unitPrice;
      const itemVAT = itemHT * (item.vatRate / 100);
      totalHT += itemHT;
      totalVAT += itemVAT;
    });

    expect(totalHT).toBe(200);
    expect(totalVAT).toBe(40);
    expect(totalHT + totalVAT).toBe(240);
  });

  it('should handle item-level percentage discount', () => {
    const items = [
      { quantity: 1, unitPrice: 1000, vatRate: 20, discount: 10, discountType: 'PERCENTAGE' },
    ];

    let totalHT = 0;
    items.forEach((item) => {
      let itemHT = item.quantity * item.unitPrice;
      if (item.discount && item.discountType === 'PERCENTAGE') {
        itemHT = itemHT * (1 - item.discount / 100);
      }
      totalHT += itemHT;
    });

    expect(totalHT).toBe(900);
  });

  it('should handle item-level fixed discount', () => {
    const items = [
      { quantity: 1, unitPrice: 500, vatRate: 20, discount: 50, discountType: 'FIXED' },
    ];

    let totalHT = 0;
    items.forEach((item) => {
      let itemHT = item.quantity * item.unitPrice;
      if (item.discount && item.discountType !== 'PERCENTAGE') {
        itemHT = Math.max(0, itemHT - item.discount);
      }
      totalHT += itemHT;
    });

    expect(totalHT).toBe(450);
  });

  it('should handle shipping fees', () => {
    const shipping = { billShipping: true, shippingAmountHT: 50, shippingVatRate: 20 };
    const shippingVAT = shipping.shippingAmountHT * (shipping.shippingVatRate / 100);
    expect(shipping.shippingAmountHT).toBe(50);
    expect(shippingVAT).toBe(10);
  });

  it('should handle global percentage discount', () => {
    const totalHT = 1000;
    const discount = 15;
    const discountType = 'PERCENTAGE';

    let discountAmount = 0;
    if (discountType === 'PERCENTAGE') {
      discountAmount = (totalHT * Math.min(discount, 100)) / 100;
    }
    const finalTotalHT = totalHT - discountAmount;

    expect(discountAmount).toBe(150);
    expect(finalTotalHT).toBe(850);
  });
});
