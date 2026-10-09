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
  assertStatusChangeAllowed,
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

  it('should allow member (Éditeur) to edit invoices', () => {
    expect(hasPermission('member', 'invoices', 'edit')).toBe(true);
  });

  it('should allow accountant to view invoices', () => {
    expect(hasPermission('accountant', 'invoices', 'view')).toBe(true);
  });

  it('should allow accountant to mark invoice as paid (droit d\'avant les rôles)', () => {
    expect(hasPermission('accountant', 'invoices', 'mark-paid')).toBe(true);
    expect(hasPermission('viewer', 'invoices', 'mark-paid')).toBe(false);
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

  it('should check admin level (maps to write on the module)', () => {
    expect(hasPermissionLevel('owner', 'team', 'admin')).toBe(true);
    // Membres et abonnement : réservés au super admin par défaut
    expect(hasPermissionLevel('admin', 'team', 'admin')).toBe(false);
    expect(hasPermissionLevel('member', 'team', 'admin')).toBe(false);
    expect(hasPermissionLevel('admin', 'integrations', 'admin')).toBe(true);
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

  it('owner should have the highest level on every module', () => {
    expect(ROLE_PERMISSIONS.owner.invoices).toBe('delete');
    expect(ROLE_PERMISSIONS.owner.purchaseInvoices).toBe('delete');
    expect(ROLE_PERMISSIONS.owner.billing).toBe('write');
    expect(ROLE_PERMISSIONS.owner.team).toBe('write');
  });

  it('admin should manage everything except members and subscription', () => {
    expect(ROLE_PERMISSIONS.admin.importedInvoices).toBe('delete');
    // Transactions : pas d'action « supprimer », toutes les autres
    expect(hasPermission('admin', 'banking', 'reconcile')).toBe(true);
    expect(ROLE_PERMISSIONS.admin.orgSettings).toBe('write');
    expect(ROLE_PERMISSIONS.admin.team).toBe('read');
    expect(ROLE_PERMISSIONS.admin.billing).toBe('read');
  });

  it('member (Éditeur) should write but not delete nor manage the account', () => {
    expect(ROLE_PERMISSIONS.member.invoices).toBe('write');
    expect(ROLE_PERMISSIONS.member.billing).toBe('none');
    expect(ROLE_PERMISSIONS.member.orgSettings).toBe('read');
    expect(ROLE_PERMISSIONS.member.integrations).toBe('none');
  });

  it('accountant keeps the rights it had before custom roles', () => {
    const can = (resource, action) => hasPermission('accountant', resource, action);
    expect(can('invoices', 'view')).toBe(true);
    expect(can('invoices', 'create')).toBe(false);
    expect(can('invoices', 'mark-paid')).toBe(true);
    expect(can('importedInvoices', 'import')).toBe(true);
    expect(can('importedQuotes', 'edit')).toBe(true);
    expect(can('quotes', 'edit')).toBe(false);
    expect(can('purchaseInvoices', 'create')).toBe(false);
    expect(can('clients', 'edit')).toBe(false);
    expect(can('clientLists', 'delete')).toBe(true);
    expect(can('banking', 'reconcile')).toBe(true);
    expect(can('calendar', 'delete')).toBe(true);
    expect(can('sharedDocuments', 'delete')).toBe(true);
    expect(can('kanban', 'view')).toBe(false);
    expect(can('signatures', 'view')).toBe(false);
    expect(can('integrations', 'view')).toBe(true);
    expect(can('integrations', 'manage')).toBe(false);
    expect(can('orgSettings', 'edit')).toBe(false);
  });

  it('member (Éditeur) works on documents without cancelling invoices', () => {
    expect(hasPermission('member', 'invoices', 'send')).toBe(true);
    expect(hasPermission('member', 'invoices', 'mark-paid')).toBe(true);
    expect(hasPermission('member', 'invoices', 'status')).toBe(false);
    expect(hasPermission('member', 'invoices', 'reminders')).toBe(false);
    expect(hasPermission('member', 'products', 'customFields')).toBe(false);
    expect(hasPermission('member', 'signatures', 'delete')).toBe(true);
  });

  it('viewer (Membre) only views, without export', () => {
    expect(hasPermission('viewer', 'invoices', 'view')).toBe(true);
    expect(hasPermission('viewer', 'invoices', 'export')).toBe(false);
  });

  it('viewer should only read business modules', () => {
    expect(ROLE_PERMISSIONS.viewer.invoices).toBe('read');
    expect(ROLE_PERMISSIONS.viewer.quotes).toBe('read');
    expect(ROLE_PERMISSIONS.viewer.clients).toBe('read');
  });

  it('member should be able to export invoices', () => {
    expect(hasPermission('member', 'invoices', 'export')).toBe(true);
  });
});

describe('legacy resource names', () => {
  it('should map expenses and suppliers to purchase invoices', () => {
    expect(hasPermissionLevel('member', 'expenses', 'write')).toBe(true);
    expect(hasPermissionLevel('member', 'suppliers', 'delete')).toBe(false);
    expect(hasPermissionLevel('admin', 'expenses', 'delete')).toBe(true);
  });

  it('should map imported quotes and purchase orders to their module', () => {
    expect(hasPermissionLevel('viewer', 'importedQuotes', 'read')).toBe(true);
    expect(hasPermissionLevel('viewer', 'importedPurchaseOrders', 'write')).toBe(false);
  });
});

describe('effective grid passed explicitly (custom roles)', () => {
  // Grille d'actions par page (rôle personnalisé ou ajusté)
  const levels = {
    invoices: ['view', 'export'],
    quotes: ['view', 'create', 'edit', 'delete'],
    team: [],
  };

  it('should use the given grid instead of the predefined role', () => {
    expect(hasPermission('role_abc', 'invoices', 'view', levels)).toBe(true);
    expect(hasPermission('role_abc', 'invoices', 'create', levels)).toBe(false);
    expect(hasPermission('role_abc', 'quotes', 'delete', levels)).toBe(true);
    expect(hasPermissionLevel('role_abc', 'team', 'read', levels)).toBe(false);
  });

  it('should deny modules missing from the grid', () => {
    expect(hasPermissionLevel('role_abc', 'banking', 'read', levels)).toBe(false);
  });

  it('should check precise actions independently', () => {
    const grid = { invoices: ['view', 'create', 'send'] };
    expect(hasPermission('role_abc', 'invoices', 'create', grid)).toBe(true);
    expect(hasPermission('role_abc', 'invoices', 'send', grid)).toBe(true);
    // Créer sans modifier : le contrôle « écriture » (modifier) refuse
    expect(hasPermissionLevel('role_abc', 'invoices', 'write', grid)).toBe(false);
    expect(hasPermission('role_abc', 'invoices', 'mark-paid', grid)).toBe(false);
  });
});

describe('assertStatusChangeAllowed', () => {
  const ctxWith = (grid) => ({
    permissions: {
      hasPermission: (resource, action) =>
        hasPermission('role_abc', resource, action, grid),
    },
  });

  it('lets a role that can create finalize its draft', () => {
    const ctx = ctxWith({ quotes: ['view', 'create'] });
    expect(() =>
      assertStatusChangeAllowed(ctx, 'quotes', 'PENDING', 'PENDING'),
    ).not.toThrow();
    // Accepter un devis : case « status »
    expect(() =>
      assertStatusChangeAllowed(ctx, 'quotes', 'COMPLETED', 'PENDING'),
    ).toThrow();
  });

  it('requires markPaid to set an invoice as paid', () => {
    const editOnly = ctxWith({ invoices: ['view', 'edit'] });
    expect(() =>
      assertStatusChangeAllowed(editOnly, 'invoices', 'COMPLETED', 'PENDING'),
    ).toThrow();
    const payer = ctxWith({ invoices: ['view', 'markPaid'] });
    expect(() =>
      assertStatusChangeAllowed(payer, 'invoices', 'COMPLETED', 'PENDING'),
    ).not.toThrow();
  });

  it('requires status to cancel', () => {
    const ctx = ctxWith({ purchaseOrders: ['view', 'edit'] });
    expect(() =>
      assertStatusChangeAllowed(ctx, 'purchaseOrders', 'CANCELED', 'CONFIRMED'),
    ).toThrow();
  });
});
