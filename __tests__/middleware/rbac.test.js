import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../../src/utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/models/User.js', () => ({
  default: { findById: vi.fn() },
}));

vi.mock('../../src/services/jwks-validator.js', () => ({
  getJWKSValidator: vi.fn().mockResolvedValue({
    validateJWT: vi.fn(),
  }),
}));

vi.mock('../../src/middlewares/better-auth.js', () => ({
  betterAuthMiddleware: vi.fn(),
}));

import {
  hasPermission,
  hasPermissionLevel,
  ROLE_PERMISSIONS,
} from '../../src/middlewares/rbac.js';

describe('hasPermission', () => {
  it('should allow owner to view invoices', () => {
    expect(hasPermission('owner', 'invoices', 'view')).toBe(true);
  });

  it('should allow owner to delete invoices', () => {
    expect(hasPermission('owner', 'invoices', 'delete')).toBe(true);
  });

  it('should allow owner to manage billing', () => {
    expect(hasPermission('owner', 'billing', 'manage')).toBe(true);
  });

  it('should allow admin to view invoices', () => {
    expect(hasPermission('admin', 'invoices', 'view')).toBe(true);
  });

  it('should NOT allow admin to manage billing', () => {
    expect(hasPermission('admin', 'billing', 'manage')).toBe(false);
  });

  it('should allow admin to read billing', () => {
    expect(hasPermission('admin', 'billing', 'view')).toBe(true);
  });

  it('should allow member to create invoices', () => {
    expect(hasPermission('member', 'invoices', 'create')).toBe(true);
  });

  it('should NOT allow member to delete invoices', () => {
    expect(hasPermission('member', 'invoices', 'delete')).toBe(false);
  });

  it('should NOT allow member to edit invoices', () => {
    expect(hasPermission('member', 'invoices', 'edit')).toBe(false);
  });

  it('should allow accountant to view invoices', () => {
    expect(hasPermission('accountant', 'invoices', 'view')).toBe(true);
  });

  it('should allow accountant to mark invoice as paid', () => {
    expect(hasPermission('accountant', 'invoices', 'mark-paid')).toBe(true);
  });

  it('should NOT allow accountant to create invoices', () => {
    expect(hasPermission('accountant', 'invoices', 'create')).toBe(false);
  });

  it('should allow viewer to view invoices', () => {
    expect(hasPermission('viewer', 'invoices', 'view')).toBe(true);
  });

  it('should NOT allow viewer to create anything', () => {
    expect(hasPermission('viewer', 'invoices', 'create')).toBe(false);
    expect(hasPermission('viewer', 'clients', 'create')).toBe(false);
    expect(hasPermission('viewer', 'expenses', 'create')).toBe(false);
  });

  it('should return false for unknown role', () => {
    expect(hasPermission('unknown_role', 'invoices', 'view')).toBe(false);
  });

  it('should return false for null role', () => {
    expect(hasPermission(null, 'invoices', 'view')).toBe(false);
  });

  it('should return false for undefined resource', () => {
    expect(hasPermission('owner', 'nonexistent', 'view')).toBe(false);
  });

  it('should handle case-insensitive role matching', () => {
    // The code normalizes role to lowercase
    expect(hasPermission('Owner', 'invoices', 'view')).toBe(true);
    expect(hasPermission('ADMIN', 'invoices', 'view')).toBe(true);
    expect(hasPermission('Member', 'clients', 'view')).toBe(true);
  });
});

describe('hasPermissionLevel', () => {
  it('should check read level (maps to "view")', () => {
    expect(hasPermissionLevel('owner', 'invoices', 'read')).toBe(true);
    expect(hasPermissionLevel('viewer', 'invoices', 'read')).toBe(true);
  });

  it('should check write level (maps to "create", "edit")', () => {
    expect(hasPermissionLevel('owner', 'invoices', 'write')).toBe(true);
    expect(hasPermissionLevel('member', 'invoices', 'write')).toBe(true);
    expect(hasPermissionLevel('viewer', 'invoices', 'write')).toBe(false);
  });

  it('should check delete level', () => {
    expect(hasPermissionLevel('owner', 'invoices', 'delete')).toBe(true);
    expect(hasPermissionLevel('admin', 'invoices', 'delete')).toBe(true);
    expect(hasPermissionLevel('member', 'invoices', 'delete')).toBe(false);
  });

  it('should check admin level (maps to "manage", "approve", etc.)', () => {
    expect(hasPermissionLevel('owner', 'team', 'admin')).toBe(true);
    expect(hasPermissionLevel('admin', 'team', 'admin')).toBe(true);
    expect(hasPermissionLevel('member', 'team', 'admin')).toBe(false);
  });

  it('should return false for unknown permission level', () => {
    expect(hasPermissionLevel('owner', 'invoices', 'nonexistent')).toBe(false);
  });
});

describe('ROLE_PERMISSIONS structure', () => {
  it('should define owner, admin, member, accountant, viewer roles', () => {
    expect(ROLE_PERMISSIONS).toHaveProperty('owner');
    expect(ROLE_PERMISSIONS).toHaveProperty('admin');
    expect(ROLE_PERMISSIONS).toHaveProperty('member');
    expect(ROLE_PERMISSIONS).toHaveProperty('accountant');
    expect(ROLE_PERMISSIONS).toHaveProperty('viewer');
  });

  it('owner should have all resources', () => {
    const ownerResources = Object.keys(ROLE_PERMISSIONS.owner);
    expect(ownerResources).toContain('invoices');
    expect(ownerResources).toContain('quotes');
    expect(ownerResources).toContain('expenses');
    expect(ownerResources).toContain('clients');
    expect(ownerResources).toContain('billing');
    expect(ownerResources).toContain('team');
  });

  it('member should NOT have billing or orgSettings', () => {
    expect(ROLE_PERMISSIONS.member).not.toHaveProperty('billing');
    expect(ROLE_PERMISSIONS.member).not.toHaveProperty('orgSettings');
  });

  it('accountant should have expense approval permission', () => {
    expect(ROLE_PERMISSIONS.accountant.expenses).toContain('approve');
  });

  it('accountant should NOT have invoice create permission', () => {
    expect(ROLE_PERMISSIONS.accountant.invoices).not.toContain('create');
  });

  it('viewer should have only view permissions on key resources', () => {
    expect(ROLE_PERMISSIONS.viewer.invoices).toEqual(['view']);
    expect(ROLE_PERMISSIONS.viewer.quotes).toEqual(['view']);
    expect(ROLE_PERMISSIONS.viewer.clients).toEqual(['view']);
  });

  it('member should be able to export invoices', () => {
    expect(ROLE_PERMISSIONS.member.invoices).toContain('export');
  });
});
