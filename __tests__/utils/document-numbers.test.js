import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all Mongoose models and DocumentCounter before importing
vi.mock('../../src/models/Invoice.js', () => ({
  default: {
    countDocuments: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  }
}));

vi.mock('../../src/models/Quote.js', () => ({
  default: {
    countDocuments: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  }
}));

vi.mock('../../src/models/CreditNote.js', () => ({
  default: {
    countDocuments: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  }
}));

vi.mock('../../src/models/PurchaseOrder.js', () => ({
  default: {
    countDocuments: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    findByIdAndUpdate: vi.fn(),
  }
}));

vi.mock('../../src/models/DocumentCounter.js', () => ({
  default: {
    getNextNumber: vi.fn(),
  }
}));

import {
  generateInvoiceNumber,
  generateQuoteNumber,
  generateCreditNoteNumber,
  generatePurchaseOrderNumber,
  validateInvoiceNumberSequence,
} from '../../src/utils/documentNumbers.js';

import Invoice from '../../src/models/Invoice.js';
import Quote from '../../src/models/Quote.js';
import CreditNote from '../../src/models/CreditNote.js';
import DocumentCounter from '../../src/models/DocumentCounter.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateInvoiceNumber', () => {
  it('should generate a sequential invoice number using DocumentCounter', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(1);

    const result = await generateInvoiceNumber('F-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result).toBe('0001');
    expect(DocumentCounter.getNextNumber).toHaveBeenCalledWith(
      'invoice', 'F-202601', 'ws1', 2026, { session: undefined }
    );
  });

  it('should use manual number when no finalized invoices exist', async () => {
    Invoice.countDocuments.mockResolvedValue(0);

    const result = await generateInvoiceNumber('F-202601', {
      workspaceId: 'ws1',
      year: 2026,
      manualNumber: '42',
    });

    expect(result).toBe('42');
  });

  it('should generate DRAFT- prefixed number for draft invoices', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(5);
    Invoice.findOne.mockResolvedValue(null);

    const result = await generateInvoiceNumber('F-202601', {
      workspaceId: 'ws1',
      year: 2026,
      isDraft: true,
    });

    expect(result).toBe('DRAFT-0005');
  });

  it('should generate DRAFT- with manual number for drafts', async () => {
    Invoice.findOne.mockResolvedValue(null);

    const result = await generateInvoiceNumber('F-202601', {
      workspaceId: 'ws1',
      year: 2026,
      isDraft: true,
      manualNumber: '0010',
    });

    expect(result).toBe('DRAFT-0010');
  });

  it('should use default prefix when none provided', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(1);

    const result = await generateInvoiceNumber(null, {
      workspaceId: 'ws1',
      year: 2026,
    });

    // Should generate using default prefix F-YYYYMM
    expect(result).toBe('0001');
  });
});

describe('generateQuoteNumber', () => {
  it('should generate a sequential quote number', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(3);

    const result = await generateQuoteNumber('D-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result).toBe('0003');
  });

  it('should generate DRAFT-timestamp for draft quotes without manual number', async () => {
    const result = await generateQuoteNumber('D-202601', {
      workspaceId: 'ws1',
      year: 2026,
      isDraft: true,
    });

    expect(result).toMatch(/^DRAFT-\d+$/);
  });

  it('should use manual number for quote with no existing finalized quotes', async () => {
    Quote.countDocuments.mockResolvedValue(0);

    const result = await generateQuoteNumber('D-202601', {
      workspaceId: 'ws1',
      year: 2026,
      manualNumber: '0050',
    });

    expect(result).toBe('0050');
  });
});

describe('generateCreditNoteNumber', () => {
  it('should generate a sequential credit note number', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(2);

    const result = await generateCreditNoteNumber('AV-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result).toBe('0002');
  });

  it('should generate draft credit note number', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(1);

    const result = await generateCreditNoteNumber('AV-202601', {
      workspaceId: 'ws1',
      year: 2026,
      isDraft: true,
    });

    expect(result).toBe('DRAFT-0001');
  });
});

describe('generatePurchaseOrderNumber', () => {
  it('should generate a sequential purchase order number', async () => {
    DocumentCounter.getNextNumber.mockResolvedValue(7);

    const result = await generatePurchaseOrderNumber('BC-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result).toBe('0007');
  });

  it('should return DRAFT-timestamp for draft purchase orders', async () => {
    const result = await generatePurchaseOrderNumber('BC-202601', {
      workspaceId: 'ws1',
      year: 2026,
      isDraft: true,
    });

    expect(result).toMatch(/^DRAFT-\d+$/);
  });

  it('should return manual number when provided', async () => {
    const result = await generatePurchaseOrderNumber('BC-202601', {
      workspaceId: 'ws1',
      year: 2026,
      manualNumber: '0099',
    });

    expect(result).toBe('0099');
  });
});

describe('validateInvoiceNumberSequence', () => {
  it('should return valid for drafts without checking sequence', async () => {
    const result = await validateInvoiceNumberSequence('0001', 'F-202601', {
      isDraft: true,
    });

    expect(result.isValid).toBe(true);
  });

  it('should return valid when no existing invoices', async () => {
    Invoice.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    });

    const result = await validateInvoiceNumberSequence('0001', 'F-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result.isValid).toBe(true);
  });

  it('should reject already-used number', async () => {
    Invoice.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([{ number: '0001' }]),
    });

    const result = await validateInvoiceNumberSequence('0001', 'F-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result.isValid).toBe(false);
    expect(result.message).toContain('déjà utilisé');
  });

  it('should reject number that breaks sequential order', async () => {
    Invoice.find.mockReturnValue({
      lean: vi.fn().mockResolvedValue([
        { number: '0001' },
        { number: '0002' },
      ]),
    });

    const result = await validateInvoiceNumberSequence('0005', 'F-202601', {
      workspaceId: 'ws1',
      year: 2026,
    });

    expect(result.isValid).toBe(false);
    expect(result.message).toContain('0003');
  });
});
