import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock logger ────────────────────────────────────────────────────

vi.mock('../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ─── Mock errors (use actual) ───────────────────────────────────────

vi.mock('../../src/utils/errors.js', async () => {
  const actual = await vi.importActual('../../src/utils/errors.js');
  return actual;
});

// ─── Mock mongoose ──────────────────────────────────────────────────

// Use vi.hoisted to declare mocks that are referenced inside vi.mock factories
const { mockCollection, mockDb } = vi.hoisted(() => {
  const mockCollection = {
    findOne: vi.fn(),
  };
  const mockDb = {
    collection: vi.fn().mockReturnValue(mockCollection),
  };
  return { mockCollection, mockDb };
});

vi.mock('mongoose', () => ({
  default: {
    connection: {
      db: mockDb,
    },
    Types: {
      ObjectId: class ObjectId {
        constructor(id) { this.id = id; }
        toString() { return this.id; }
      },
    },
  },
}));

// ─── Import ─────────────────────────────────────────────────────────

import { isCompanyInfoComplete, getOrganizationInfo } from '../../src/middlewares/company-info-guard.js';

beforeEach(() => {
  vi.clearAllMocks();
  // Re-setup collection mock since clearAllMocks resets mockReturnValue
  mockDb.collection.mockReturnValue(mockCollection);
});

// ─── isCompanyInfoComplete ──────────────────────────────────────────

describe('Company Info Guard - isCompanyInfoComplete', () => {
  it('should return true when all required fields are present', () => {
    const org = {
      companyName: 'Test SASU',
      companyEmail: 'contact@test.fr',
      addressStreet: '1 rue du Test',
      addressCity: 'Paris',
      addressZipCode: '75001',
      addressCountry: 'France',
      siret: '12345678901234',
      legalForm: 'SASU',
    };

    expect(isCompanyInfoComplete(org)).toBe(true);
  });

  it('should return false when companyName is missing', () => {
    const org = {
      companyEmail: 'contact@test.fr',
      addressStreet: '1 rue du Test',
      addressCity: 'Paris',
      addressZipCode: '75001',
      addressCountry: 'France',
      siret: '12345678901234',
      legalForm: 'SASU',
    };

    expect(isCompanyInfoComplete(org)).toBe(false);
  });

  it('should return false when siret is missing', () => {
    const org = {
      companyName: 'Test SASU',
      companyEmail: 'contact@test.fr',
      addressStreet: '1 rue du Test',
      addressCity: 'Paris',
      addressZipCode: '75001',
      addressCountry: 'France',
      legalForm: 'SASU',
    };

    expect(isCompanyInfoComplete(org)).toBe(false);
  });

  it('should return false when legalForm is missing', () => {
    const org = {
      companyName: 'Test SASU',
      companyEmail: 'contact@test.fr',
      addressStreet: '1 rue du Test',
      addressCity: 'Paris',
      addressZipCode: '75001',
      addressCountry: 'France',
      siret: '12345678901234',
    };

    expect(isCompanyInfoComplete(org)).toBe(false);
  });

  it('should return false when address fields are missing', () => {
    const org = {
      companyName: 'Test SASU',
      companyEmail: 'contact@test.fr',
      siret: '12345678901234',
      legalForm: 'SASU',
    };

    expect(isCompanyInfoComplete(org)).toBe(false);
  });

  it('should return false for null organization', () => {
    expect(isCompanyInfoComplete(null)).toBe(false);
  });

  it('should return false for empty object', () => {
    expect(isCompanyInfoComplete({})).toBe(false);
  });
});

// ─── getOrganizationInfo ────────────────────────────────────────────

describe('Company Info Guard - getOrganizationInfo', () => {
  it('should return organization info when found', async () => {
    const mockOrg = {
      _id: 'org-1',
      companyName: 'Test SASU',
      companyEmail: 'contact@test.fr',
      siret: '12345678901234',
    };
    mockCollection.findOne.mockResolvedValue(mockOrg);

    const result = await getOrganizationInfo('org-1');

    expect(result).toEqual(mockOrg);
    expect(mockDb.collection).toHaveBeenCalledWith('organization');
  });

  it('should throw when organization is not found', async () => {
    mockCollection.findOne.mockResolvedValue(null);

    await expect(
      getOrganizationInfo('nonexistent')
    ).rejects.toThrow();
  });

  it('should throw when workspaceId is not provided', async () => {
    await expect(
      getOrganizationInfo(null)
    ).rejects.toThrow('workspaceId requis');
  });
});
