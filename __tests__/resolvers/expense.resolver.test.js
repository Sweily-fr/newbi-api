import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

// ─── Mock Mongoose models ───────────────────────────────────────────

vi.mock('../../src/models/Expense.js', () => {
  class MockExpense {
    constructor(data) {
      Object.assign(this, data);
      this._id = data._id || new mongoose.Types.ObjectId();
      this.save = vi.fn().mockResolvedValue(true);
    }
  }
  MockExpense.findOne = vi.fn();
  MockExpense.find = vi.fn();
  MockExpense.countDocuments = vi.fn();
  MockExpense.findById = vi.fn();
  MockExpense.findByIdAndUpdate = vi.fn();
  MockExpense.findByIdAndDelete = vi.fn();
  MockExpense.aggregate = vi.fn();
  return { default: MockExpense };
});

// ─── Mock external services ─────────────────────────────────────────

vi.mock('../../src/services/cloudflareService.js', () => ({
  default: { deleteImage: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/utils/ocrProcessor.js', () => ({
  processFileWithOCR: vi.fn().mockResolvedValue({ text: 'OCR result' }),
}));

// ─── Mock middlewares (pass-through) ────────────────────────────────

vi.mock('../../src/middlewares/rbac.js', () => ({
  requireRead: () => (resolver) => resolver,
  requireWrite: () => (resolver) => resolver,
  requireDelete: () => (resolver) => resolver,
  requirePermission: () => (resolver) => resolver,
  withOrganization: (resolver) => resolver,
}));

// ─── Import after mocks ────────────────────────────────────────────

import Expense from '../../src/models/Expense.js';
import expenseResolvers from '../../src/resolvers/expense.js';

const workspaceId = '507f1f77bcf86cd799439011';

const mockContext = {
  user: { id: 'user-1', name: 'Test User', email: 'test@test.com' },
  workspaceId,
  userRole: 'owner',
};

const memberContext = {
  user: { id: 'member-1', name: 'Member', email: 'member@test.com' },
  workspaceId,
  userRole: 'member',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Query.expense ──────────────────────────────────────────────────

describe('Expense Resolver - Query.expense', () => {
  const resolver = expenseResolvers.Query.expense;

  it('should return an expense by id for owner', async () => {
    const mockExpense = {
      _id: 'expense-1',
      title: 'Facture OVH',
      amount: 119.88,
      workspaceId,
    };
    Expense.findOne.mockResolvedValue(mockExpense);

    const result = await resolver(
      null,
      { id: 'expense-1', workspaceId },
      mockContext
    );

    expect(result).toEqual(mockExpense);
    expect(Expense.findOne).toHaveBeenCalled();
  });

  it('should add createdBy filter for member role', async () => {
    const mockExpense = { _id: 'expense-1', title: 'Test', workspaceId };
    Expense.findOne.mockResolvedValue(mockExpense);

    await resolver(null, { id: 'expense-1', workspaceId }, memberContext);

    const queryArg = Expense.findOne.mock.calls[0][0];
    expect(queryArg.createdBy).toBe('member-1');
  });

  it('should throw NOT_FOUND when expense does not exist', async () => {
    Expense.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: 'nonexistent', workspaceId }, mockContext)
    ).rejects.toThrow();
  });

  it('should throw FORBIDDEN when workspaceId mismatches', async () => {
    await expect(
      resolver(
        null,
        { id: 'expense-1', workspaceId: 'different-ws' },
        mockContext
      )
    ).rejects.toThrow('Organisation invalide');
  });
});

// ─── Query.expenses ─────────────────────────────────────────────────

describe('Expense Resolver - Query.expenses', () => {
  const resolver = expenseResolvers.Query.expenses;

  it('should return paginated expense list', async () => {
    const mockExpenses = [{ title: 'Expense A' }, { title: 'Expense B' }];
    Expense.countDocuments.mockResolvedValue(20);
    Expense.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(mockExpenses),
        }),
      }),
    });

    const result = await resolver(
      null,
      { workspaceId, page: 1, limit: 10 },
      mockContext
    );

    expect(result.expenses).toEqual(mockExpenses);
    expect(result.totalCount).toBe(20);
    expect(result.hasNextPage).toBe(true);
  });

  it('should filter by member createdBy', async () => {
    Expense.countDocuments.mockResolvedValue(0);
    Expense.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await resolver(null, { workspaceId, page: 1, limit: 10 }, memberContext);

    const queryArg = Expense.find.mock.calls[0][0];
    expect(queryArg.createdBy).toBe('member-1');
  });

  it('should apply category filter', async () => {
    Expense.countDocuments.mockResolvedValue(0);
    Expense.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId, category: 'SOFTWARE', page: 1, limit: 10 },
      mockContext
    );

    const queryArg = Expense.find.mock.calls[0][0];
    expect(queryArg.category).toBe('SOFTWARE');
  });

  it('should apply search filter with $or', async () => {
    Expense.countDocuments.mockResolvedValue(0);
    Expense.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId, search: 'OVH', page: 1, limit: 10 },
      mockContext
    );

    const queryArg = Expense.find.mock.calls[0][0];
    expect(queryArg.$or).toBeDefined();
    expect(queryArg.$or.length).toBe(4); // title, description, vendor, invoiceNumber
  });

  it('should apply date range filters', async () => {
    Expense.countDocuments.mockResolvedValue(0);
    Expense.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId, startDate: '2026-01-01', endDate: '2026-12-31', page: 1, limit: 10 },
      mockContext
    );

    const queryArg = Expense.find.mock.calls[0][0];
    expect(queryArg.date).toBeDefined();
    expect(queryArg.date.$gte).toBeDefined();
  });

  it('should apply tags filter', async () => {
    Expense.countDocuments.mockResolvedValue(0);
    Expense.find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        skip: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    await resolver(
      null,
      { workspaceId, tags: ['serveur', 'hosting'], page: 1, limit: 10 },
      mockContext
    );

    const queryArg = Expense.find.mock.calls[0][0];
    expect(queryArg.tags).toEqual({ $in: ['serveur', 'hosting'] });
  });
});

// ─── Mutation.createExpense ─────────────────────────────────────────

describe('Expense Resolver - Mutation.createExpense', () => {
  const resolver = expenseResolvers.Mutation.createExpense;

  it('should create an expense successfully', async () => {
    const input = {
      title: 'Facture AWS',
      amount: 250,
      currency: 'EUR',
      date: '2026-03-01',
      category: 'SOFTWARE',
      vendor: 'AWS',
      workspaceId,
    };

    const result = await resolver(null, { input }, mockContext);

    expect(result).toBeDefined();
    expect(result.save).toHaveBeenCalled();
    expect(result.title).toBe('Facture AWS');
    expect(result.createdBy).toBe('user-1');
  });

  it('should throw FORBIDDEN on workspace mismatch', async () => {
    const input = {
      title: 'Test',
      amount: 100,
      workspaceId: 'different-workspace',
    };

    await expect(
      resolver(null, { input }, mockContext)
    ).rejects.toThrow('Organisation invalide');
  });

  it('should throw BAD_REQUEST when no workspace provided', async () => {
    const contextNoWs = { ...mockContext, workspaceId: undefined };
    const input = { title: 'Test', amount: 100 };

    await expect(
      resolver(null, { input }, contextNoWs)
    ).rejects.toThrow('workspaceId requis');
  });

  it('should parse ISO date format correctly', async () => {
    const input = {
      title: 'Test date',
      amount: 100,
      date: '2026-06-15',
      workspaceId,
    };

    const result = await resolver(null, { input }, mockContext);
    expect(result.date).toBeInstanceOf(Date);
  });
});

// ─── Mutation.updateExpense ─────────────────────────────────────────

describe('Expense Resolver - Mutation.updateExpense', () => {
  const resolver = expenseResolvers.Mutation.updateExpense;

  it('should update an expense', async () => {
    Expense.findOne.mockResolvedValue({ _id: 'expense-1', workspaceId });
    const updatedExpense = { _id: 'expense-1', title: 'Updated', amount: 300 };
    Expense.findByIdAndUpdate.mockResolvedValue(updatedExpense);

    const result = await resolver(
      null,
      { id: 'expense-1', input: { title: 'Updated', amount: 300 } },
      mockContext
    );

    expect(result.title).toBe('Updated');
    expect(Expense.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('should throw when expense not found for access check', async () => {
    Expense.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: 'nonexistent', input: { title: 'X' } }, mockContext)
    ).rejects.toThrow();
  });
});

// ─── Mutation.deleteExpense ─────────────────────────────────────────

describe('Expense Resolver - Mutation.deleteExpense', () => {
  const resolver = expenseResolvers.Mutation.deleteExpense;

  it('should delete an expense with no files', async () => {
    Expense.findOne.mockResolvedValue({ _id: 'expense-1', files: [], workspaceId });
    Expense.findByIdAndDelete.mockResolvedValue(true);

    const result = await resolver(
      null,
      { id: 'expense-1', workspaceId },
      mockContext
    );

    expect(result.success).toBe(true);
    expect(Expense.findByIdAndDelete).toHaveBeenCalledWith('expense-1');
  });

  it('should delete associated files before deleting expense', async () => {
    const cloudflareService = (await import('../../src/services/cloudflareService.js')).default;
    Expense.findOne.mockResolvedValue({
      _id: 'expense-1',
      files: [{ url: 'https://pub-xxx.r2.dev/expenses/file.pdf' }],
      workspaceId,
    });
    Expense.findByIdAndDelete.mockResolvedValue(true);

    await resolver(null, { id: 'expense-1', workspaceId }, mockContext);

    expect(cloudflareService.deleteImage).toHaveBeenCalled();
  });

  it('should throw NOT_FOUND when expense does not exist', async () => {
    Expense.findOne.mockResolvedValue(null);

    await expect(
      resolver(null, { id: 'nonexistent', workspaceId }, mockContext)
    ).rejects.toThrow();
  });
});

// ─── Mutation.deleteMultipleExpenses ────────────────────────────────

describe('Expense Resolver - Mutation.deleteMultipleExpenses', () => {
  const resolver = expenseResolvers.Mutation.deleteMultipleExpenses;

  it('should delete multiple expenses successfully', async () => {
    Expense.findOne.mockResolvedValue({ _id: 'expense-1', files: [], workspaceId });
    Expense.findByIdAndDelete.mockResolvedValue(true);

    const result = await resolver(
      null,
      { ids: ['expense-1', 'expense-2'], workspaceId },
      mockContext
    );

    expect(result.success).toBe(true);
    expect(result.deletedCount).toBe(2);
  });

  it('should handle partial failures', async () => {
    Expense.findOne
      .mockResolvedValueOnce({ _id: 'expense-1', files: [], workspaceId })
      .mockResolvedValueOnce(null); // second one not found
    Expense.findByIdAndDelete.mockResolvedValue(true);

    const result = await resolver(
      null,
      { ids: ['expense-1', 'expense-2'], workspaceId },
      mockContext
    );

    expect(result.deletedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  it('should throw when no ids provided', async () => {
    await expect(
      resolver(null, { ids: [], workspaceId }, mockContext)
    ).rejects.toThrow('Aucun ID');
  });
});

// ─── Query.expenseStats ─────────────────────────────────────────────

describe('Expense Resolver - Query.expenseStats', () => {
  const resolver = expenseResolvers.Query.expenseStats;

  it('should return aggregated expense stats', async () => {
    Expense.aggregate.mockResolvedValue([{
      totalStats: [{ totalAmount: 5000, totalCount: 15 }],
      categoryStats: [{ _id: 'SOFTWARE', amount: 3000, count: 8 }],
      monthStats: [{ month: '2026-03', amount: 2000, count: 5 }],
      statusStats: [{ _id: 'PENDING', amount: 1500, count: 4 }],
    }]);

    const result = await resolver(
      null,
      { workspaceId },
      mockContext
    );

    expect(result.totalAmount).toBe(5000);
    expect(result.totalCount).toBe(15);
    expect(result.byCategory).toHaveLength(1);
    expect(result.byMonth).toHaveLength(1);
  });

  it('should return zero stats when no expenses', async () => {
    Expense.aggregate.mockResolvedValue([{
      totalStats: [],
      categoryStats: [],
      monthStats: [],
      statusStats: [],
    }]);

    const result = await resolver(null, { workspaceId }, mockContext);

    expect(result.totalAmount).toBe(0);
    expect(result.totalCount).toBe(0);
  });
});
