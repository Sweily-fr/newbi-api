# Security Audit — Tracking

Last updated: 2026-05-09 (Phase 1A test suite committed)

## Overview

Multi-sprint backend security improvement plan based on internal audit.
Each sprint focuses on a specific category of access control or input validation.

## Sprint Status

| Sprint       | Theme                                                                                        | Status         | Deployed     |
| ------------ | -------------------------------------------------------------------------------------------- | -------------- | ------------ |
| 9            | Multi-tenant access checks (imported docs, partner, reconciliation)                          | ✅ Done        | ✅ Prod      |
| 10           | File transfer payment session hardening                                                      | ✅ Done        | ✅ Prod      |
| 11A          | Webhook signature verification + JWT strict                                                  | ✅ Done        | ✅ Prod      |
| 11B          | Public board share password hashing + timing-safe comparison                                 | ✅ Done        | ✅ Prod      |
| 11-CRITICAL  | withWorkspace membership verification (120 resolvers protected)                              | ✅ Done        | ✅ Prod      |
| 11C          | Workspace scope on remaining resolvers                                                       | ✅ Done        | ✅ Prod      |
| 11C-5        | RBAC on imported invoice/PO list, stats, and import resolvers                                | ✅ Done        | 🟡 Committed |
| 11C-6        | Reconcile workspaceId with context across financial document queries (25 resolvers, 4 files) | ✅ Done        | 🟡 Committed |
| Phase 1A     | Multi-tenant isolation test suite (44 cases × 11 resources)                                  | ✅ Done        | 🟡 Committed |
| 11D          | Replace Math.random with crypto.randomBytes (residual)                                       | ✅ Done        | ✅ Prod      |
| 11E+         | High/Medium findings from Pass 1                                                             | ⏸️ Planned     | ❌           |
| Audit Pass 2 | Input validation, data exposure, rate limiting                                               | ⏸️ Not started | -            |
| Audit Pass 3 | CORS, uploads, third-party webhooks, env vars                                                | ⏸️ Not started | -            |

---

## Sprint 9 — Multi-tenant access checks

**Status**: ✅ Done, deployed in prod

### Patches applied

- `importedInvoice.js` — `checkInvoiceAccess(id, workspaceId)` with `findOne({ _id, workspaceId })`
- `importedPurchaseOrder.js` — `checkPurchaseOrderAccess(id, workspaceId)` same pattern
- `partner.js:getOrganizationBankDetails` — auth check + membership verification
- `reconciliationResolvers.js:transactionsForInvoice` — workspaceId filter on Invoice.findOne

### Commits

- fb43cbc — close access scope on imported documents + partner + reconciliation

---

## Sprint 10 — File transfer hardening

**Status**: ✅ Done, deployed in prod

### Patches applied

- accessKey verification with timing-safe comparison
- crypto.randomBytes for share/access tokens (in generateShareCredentials)
- Expiration check in payment session creation
- In-memory rate limit (per-IP + per-transfer)
- Opaque return token in Stripe redirect URLs (instead of exposing shareLink/accessKey)
- (Post-review) downloadLink default uses crypto.randomBytes
- (Post-review) Real client IP extraction with x-forwarded-for fallback chain
- (Post-review) Periodic cleanup of rate limit Maps

### Commits

- 53652e3 — verify accessKey
- 201c87e — token entropy
- 923613d — expiration check
- e07a241 — rate limit
- f63ed3c — opaque return token
- 0b8a395 — downloadLink default + line 485 entropy
- 468195a — real client IP + Maps cleanup

### Known limitations / TODO

- Sprint 10B (future): make accessKey required (currently optional with logging)
- Tests: no unit tests written yet for any Sprint 10 correctifs

---

## Sprint 11A — Webhook signatures + JWT strict

**Status**: ✅ Done, deployed in prod

### Patches applied

- Bridge / Stripe Banking / PayPal webhooks: HMAC signature verification
- JWKS validator: 24h cache replaces permissive issuer-based fallback

### Commits

- f69f73c — banking webhook signatures
- b8e67c4 — JWT strict validation

### Env vars added

- BRIDGE_WEBHOOK_SECRET
- STRIPE_BANKING_WEBHOOK_SECRET
- PAYPAL_WEBHOOK_SECRET

### Known limitations / TODO

- Tests: banking webhook signature tests not written
- Tests: JWKS strict validation tests not written
- Future: add idempotency table (ProcessedBankingWebhook) for full webhook safety

---

## Sprint 11B — Public board share

**Status**: ✅ Done, deployed in prod

### Patches applied

- bcrypt hashing for share passwords (cost 12)
- Silent migration of legacy plaintext passwords on first successful access
- Timing-safe comparison for sessionToken (UserInvited) and share access tokens
- Centralized helper `hasPasswordProtection` (single source of truth)
- Centralized helper `timingSafeStringEqual` in src/utils/timing-safe.js

### Commits

- 957aad3 — share password hashing
- bc1479c — timing-safe comparisons

### Known limitations / TODO

- Phase 2: force re-hash of remaining plaintext passwords + drop password field
- Tests: none written for the new helpers

---

## Sprint 11-CRITICAL — withWorkspace membership verification

**Status**: ✅ Done, deployed in prod (2026-05-06)

### Patches applied

- Rewrote withWorkspace middleware to call getActiveOrganization (Plan C+)
- Removed silent fallback: now throws FORBIDDEN when user is not member of requested org
- Extracted getActiveOrganization to src/middlewares/org-resolver.js (breaks circular dep)
- Removed duplicate local withWorkspace definition in creditNote.js
- Updated auth.test.js: 4 tests rewritten + 1 new FORBIDDEN test

### Files changed

- NEW: src/middlewares/org-resolver.js
- EDIT: src/middlewares/rbac.js (-95 lines, +1 import)
- EDIT: src/middlewares/better-auth-jwt.js (rewrote withWorkspace)
- EDIT: src/resolvers/creditNote.js (removed local copy)
- EDIT: \_\_tests\_\_/middleware/auth.test.js (4 updated + 1 new test)

### Commits

- 858ca1e — verify org membership in withWorkspace middleware
- b77310a — tracking update

### Affected resolvers (now protected)

~120 resolvers across 14 files automatically secured:

- banking.js (24), kanban.js (31), publicBoardShare.js (11)
- creditNote.js (8), event.js (6), taskImage.js (5)
- kanbanTemplate.js (4), dashboardAggregation.js (3)
- quoteTemplate.js (3), invoiceTemplate.js (3)
- purchaseOrderTemplate.js (3), calendarColorLabels.js (2)
- importedInvoice.js (10), importedPurchaseOrder.js (8), user.js (1)

### Tests

- 377 tests pass (vs 376 before patch)
- +1 new test: "should throw FORBIDDEN when no default org found"
- 0 regressions

### Validation

- [x] Unit tests pass
- [x] Smoke test in staging
- [x] Deployed in prod, monitored 1h post-deploy
- [x] Manual test: kanban subscription (websocket flow)
- [x] Manual test: cross-org access attempt rejected with FORBIDDEN

---

## Sprint 11C — Workspace scope on remaining resolvers

**Status**: ✅ Done, deployed in prod (2026-05-07)

### Targets

| #   | File                                                     | Issue                                                                                                  | Status                 |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------- |
| 2   | importedInvoice.js:1413                                  | findByIdAndDelete without workspace filter (defense in depth)                                          | ✅ Committed (53b6ea4) |
| 3   | importedPurchaseOrder.js:590                             | Same pattern                                                                                           | ✅ Committed (82a1765) |
| 1   | importedQuote.js                                         | 10 resolvers migrated to requireRead/Write/Delete + helper filtered by workspaceId                     | ✅ Committed (db5a3c4) |
| 4   | clientAutomation.js                                      | 1 real defense-in-depth fix + 3 cosmetic hardenings (resolver layer already RBAC)                      | ✅ Committed           |
| 5   | importedInvoice.js + importedPurchaseOrder.js            | 11 resolvers migrated to requireRead/Write + resources added to ROLE_PERMISSIONS                       | ✅ Committed (2fbbb57) |
| 6   | invoice.js + quote.js + creditNote.js + purchaseOrder.js | 25 query resolvers reading args.workspaceId without reconciliation, allowing cross-tenant data leakage | ✅ Committed (7fb07d8) |

### Notes

- Correctif 1 scope expanded: initially 7 resolvers, but verification revealed that 3 additional list/stats/create resolvers were trusting workspaceId from GraphQL args (controllable by client). Now 10 resolvers in scope.

### Sprint 11C-1 details

**Status**: ✅ Done, deployed in prod (2026-05-07)

#### Patches applied

- Added `importedQuotes` resource to ROLE_PERMISSIONS (5 roles)
- Migrated 10 resolvers from isAuthenticated to requireRead/requireWrite/requireDelete
- Refactored checkQuoteAccess(quoteId, workspaceId) with findOne filter
- Replaced findByIdAndDelete with findOneAndDelete (workspaceId scoped)
- Added workspaceId filter to batch find + deleteMany
- Permission matrix aligned on Pennylane and Xero patterns

#### Files changed

- src/middlewares/rbac.js (5 lines added)
- src/resolvers/importedQuote.js (~50 lines refactored)

#### Permission matrix

- owner/admin: view, create, edit, delete, approve, import
- accountant: view, create, edit, approve, import, export (no delete — accounting traceability)
- member: view, create, edit, import (no approve — Xero "Invoice Only - Drafts" pattern)
- viewer: view only

### Sprint 11C-4 details

**Status**: ✅ Done, deployed in prod (2026-05-07)

#### Audit findings vs reality

The Pass 1 audit reported 13 occurrences in clientAutomation.js. After
exhaustive read:

- 7 top-level resolvers were ALREADY using requireRead/Write/Delete (clients resource)
- Only 1 real defense-in-depth fix needed: deleteOne without workspaceId filter
- 3 cosmetic hardenings: findById in return paths after create/update/toggle
- 9 occurrences in internal automationService — tracked for Sprint 11E

#### Patches applied

- Line 491 (deleteClientAutomation): deleteOne now filtered by workspaceId
- Line 424 (createClientAutomation): findById return → findOne with workspaceId
- Line 473 (updateClientAutomation): findById return → findOne with workspaceId
- Line 531 (toggleClientAutomation): findById return → findOne with workspaceId
- Service hardening tracked for Sprint 11E (TODO comment added)

#### New documentation

- docs/SECURITY-CONVENTIONS.md (multi-tenant query conventions)

#### Files changed

- src/resolvers/clientAutomation.js (4 lines + 1 comment block)
- docs/SECURITY-CONVENTIONS.md (NEW)

### Sprint 11C-5 details

**Status**: ✅ Committed, pending merge to develop

#### Audit findings vs reality

The Phase 1A test conception (multi-tenant isolation) revealed that 11
resolvers in importedInvoice.js and importedPurchaseOrder.js still used
isAuthenticated with workspaceId from GraphQL args (controllable by
client). This is the same pattern fixed in Sprint 11C-1 for
importedQuote, but missed for these 2 cousin resources.

Sprint 9 had patched the query single and delete operations on these
files, but list/stats/import resolvers were left untouched.

#### Patches applied

**importedInvoice.js (8 resolvers)**

- importedInvoices (line 598): isAuthenticated → requireRead("importedInvoices")
- importedInvoiceStats (line 663): same
- ocrUsageStats (line 694): same
- userOcrQuota (line 724): same
- importInvoice (line 750): isAuthenticated → requireWrite("importedInvoices")
- importInvoiceDirect (line 859): same
- batchImportInvoices (line 1089): same
- purchaseExtraOcrImports (line 1460): same

**importedPurchaseOrder.js (3 resolvers)**

- importedPurchaseOrders (line 254): requireRead("importedPurchaseOrders")
- importedPurchaseOrderStats (line 306): same
- importPurchaseOrderDirect (line 335): requireWrite("importedPurchaseOrders")

**rbac.js (ROLE_PERMISSIONS)**

- Added `importedInvoices` resource for 5 roles
- Added `importedPurchaseOrders` resource for 5 roles
- Matrix aligned on importedQuotes (Sprint 11C-1, Pennylane/Xero pattern)

#### Files changed

- src/middlewares/rbac.js (10 lines added)
- src/resolvers/importedInvoice.js (~35 lines refactored)
- src/resolvers/importedPurchaseOrder.js (~15 lines refactored)

### Sprint 11C-6 details

**Status**: ✅ Committed, pending merge to develop

#### Discovery context

The multi-tenant isolation test suite (Phase 1A) revealed three
resources actively leaking data across tenants when an authenticated
user passed another org's workspaceId in args:

- Quote.quotes
- CreditNote.creditNotes
- PurchaseOrder.purchaseOrders

Audit of the related files revealed 22 additional resolvers with the
same pattern in invoice.js, quote.js, creditNote.js, and
purchaseOrder.js.

#### Patches applied

**invoice.js (8 resolvers)**

- invoice, invoices, invoiceStats, invoiceBalances
- nextInvoiceNumber, latestInvoiceIssueDate
- situationInvoicesByQuoteRef, situationReferences
- checkInvoiceNumberExists

**quote.js (7 resolvers)**

- quote, quotes, quoteStats, quoteBalances
- nextQuoteNumber, quoteByNumber, checkQuoteNumberExists

**purchaseOrder.js (5 resolvers)**

- purchaseOrder, purchaseOrders, purchaseOrderStats
- nextPurchaseOrderNumber, checkPurchaseOrderNumberExists

**creditNote.js (5 resolvers)**

- creditNote, creditNotes, creditNotesByInvoice
- creditNoteStats, nextCreditNoteNumber
- Added resolveWorkspaceId import (was missing)

#### Pattern

For requireRead/Write/Delete wrappers (invoice, quote, purchaseOrder):

```javascript
async (_, { workspaceId: inputWorkspaceId, ...rest }, context) => {
  const workspaceId = resolveWorkspaceId(inputWorkspaceId, context.workspaceId);
};
```

For withWorkspace wrappers (creditNote):

```javascript
async (parent, args, { workspaceId }) => {
  // workspaceId comes from verified context, not args
};
```

#### Files changed

- src/resolvers/invoice.js (~25 lines refactored)
- src/resolvers/quote.js (~25 lines refactored)
- src/resolvers/purchaseOrder.js (~20 lines refactored)
- src/resolvers/creditNote.js (~20 lines refactored + 1 import)

#### Lessons learned

- Pattern was systemic across 4 critical financial resources
- Sprint 11C-5 had focused on imported documents but missed the same
  pattern on the canonical financial documents
- The Phase 1A test suite acted as the discovery mechanism, validating
  the test-driven security approach
- Future audits should grep for `args.workspaceId` direct usage as a
  red flag pattern

---

## Phase 1A — Multi-tenant isolation test suite

**Status**: ✅ Committed, pending merge to develop

### Objective

Build an automated detection mechanism for cross-tenant data leaks
across financial document resources. Each new resolver added to the
codebase should be added to the test suite to maintain coverage.

### Coverage

11 resources × 4 tests = 44 cases:

- Query single cross-tenant deny
- Query list scoping (own org)
- Query list spoof prevention (no leak)
- Mutation delete cross-tenant deny

### Resources covered

- Client, Invoice, Quote, CreditNote
- Product, Expense
- PurchaseInvoice, PurchaseOrder
- ImportedInvoice, ImportedPurchaseOrder, ImportedQuote

### Excluded (tested separately)

- FileTransfer (user-level isolation, not org-level)

### Discoveries triggered by Test 3 (spoof prevention)

The "spoof prevention" test revealed three real cross-tenant data
leaks before any patch:

- Quote.quotes
- CreditNote.creditNotes
- PurchaseOrder.purchaseOrders

Audit of the related files revealed 22 additional vulnerable resolvers
with the same pattern. All 25 were patched in Sprint 11C-6.

### Files changed

- \_\_tests\_\_/integration/multi-tenant-isolation.test.js (NEW, ~540 lines)

### Next phases

- Phase 1B: complete RBAC role tests for CreditNote, PurchaseOrder,
  Imported\*, FileTransfer
- Phase 1C: tests for Sprint 9-11D security patches
- Phase 1D: tests for ~60 resolvers without test coverage

---

## CRITICAL FINDING — withWorkspace wrapper limitation

Discovered during Sprint 11C planning (2026-05-06).

The `withWorkspace` middleware does NOT verify membership: it copies
args.workspaceId into context without checking the user belongs to that
organization. Resolvers patched with this wrapper (Sprint 9 imported
documents, plus ~120 resolvers across 14 files) rely on Mongoose query
filters (`findOne({ _id, workspaceId })`) to prevent cross-tenant access.

This is a partial protection: requires the attacker to know both the
document ID and the target workspaceId. For list queries, knowing only
the workspaceId is sufficient to enumerate all resources.

Affected files: banking.js (24), kanban.js (31), publicBoardShare.js (11),
creditNote.js (8), event.js (6), taskImage.js (5), kanbanTemplate.js (4),
dashboardAggregation.js (3), quoteTemplate.js (3), invoiceTemplate.js (3),
purchaseOrderTemplate.js (3), calendarColorLabels.js (2), user.js (1),
importedInvoice.js (10), importedPurchaseOrder.js (8).

By contrast, `withRBAC` (used by client.js, quote.js, invoice.js) calls
`getActiveOrganization(userId, requestedOrgId)` which verifies membership
in the `member` collection before injecting workspaceId into context.

Recommended action: rewrite `withWorkspace` internally to call
`getActiveOrganization` (Plan C), protecting all 120 resolvers with a
single middleware change. No resolver code changes required.

**Status**: ✅ Patched (Plan C+) — Deployed in prod (2026-05-06)
**Resolution commit**: 858ca1e
**Resolution sprint**: 11-CRITICAL (see section above)

---

## Sprint 11D — Math.random residuals

**Status**: ✅ Done, deployed in prod (2026-05-07)

### Patches applied

- `chunkUpload.js` (line 122): removed dead code (timestamp + randomString unused after previous refactor)
- `expense.js` (line 83): filename uniqueness now uses crypto.randomBytes(8)
- `GoCardlessProvider.js` (line 434): external transaction ID fallback now uses crypto.randomBytes(8)

### Patterns intentionally preserved

- `documentNumbers.js`, `quote.js`, `invoice.js`: Math.random for anti-collision timing offset (0-999ms) — non-identifying
- `MockProvider.js`: Math.random for test fixtures and failure simulation — non-production

### Commits

- 86c13af — use crypto.randomBytes for non-cryptographic random IDs

### Files changed

- src/resolvers/chunkUpload.js (3 lines removed — dead code)
- src/resolvers/expense.js (1 import + 1 line refactored)
- src/services/banking/providers/GoCardlessProvider.js (1 import + 1 line refactored)

---

## Sprint 11E — Service-layer hardening (PLANNED)

**Status**: ⏸️ Planned, not started

### Targets

#### automationService (~9 occurrences in clientAutomation.js)

Internal service used by clientAutomation.js resolvers. Current state:
findById/findByIdAndUpdate without workspaceId filter. Currently safe
because callers pass IDs from already-filtered documents, but adds defense
in depth and avoids future regressions if new callers are added.

Estimated effort: 30-45 min + caller audit.

### Other potential targets

To be audited:

- Other internal services that take IDs without workspaceId
- Cron / scheduled jobs that don't go through GraphQL resolvers

---

## Pass 1 audit — Remaining HIGH findings (BACKLOG)

10 files with field resolver patterns to harden:
invoice.js, quote.js, sharedDocument.js, kanban.js, documentAutomation.js,
expense.js, creditNote.js, banking.js, crmEmailAutomation.js, purchaseInvoice.js

(Most are field resolvers protected by parent — defense in depth needed)

## Pass 1 audit — Remaining MEDIUM findings (BACKLOG)

purchaseInvoice.js, purchaseOrder.js, reconciliationResolvers.js,
calendarConnection.js, fileTransfer.js, event.js, publicBoardShare.js

## Pass 2 audit (NOT STARTED)

Categories to audit:

- 4. Input validation (NoSQL injection, ReDoS, path traversal)
- 5. Sensitive data exposure (fields, logs, errors)
- 6. Rate limiting / DoS

## Pass 3 audit (NOT STARTED)

Categories to audit:

- 7. CORS / CSP / security headers
- 8. File uploads
- 9. Third-party webhooks (beyond banking)
- 10. Environment variables / hardcoded secrets

---

## Pending work branches (not pushed)

### chore/test-factories-phase1

**Status**: 🟡 Local only, awaits Phase 1 resume
**Commit**: c4f60f5 (factories) + 9d75842 (tracking) + ec263d2 (test orphan rapatrié)
**Content**: buildUserDoc, buildAccountDoc, buildSessionDoc factories + dev:e2e script + factory tests
**To resume**: `git checkout chore/test-factories-phase1` when starting Phase 1 tests

---

## Update log

| Date       | Sprint      | Action                                                                               |
| ---------- | ----------- | ------------------------------------------------------------------------------------ |
| 2026-05-06 | Tracking    | Tracking file created                                                                |
| 2026-05-06 | 11C-2       | importedInvoice.js findByIdAndDelete scoped (53b6ea4)                                |
| 2026-05-06 | 11C-3       | importedPurchaseOrder.js findByIdAndDelete scoped (82a1765)                          |
| 2026-05-07 | 11C-1       | importedQuote.js migrated to RBAC (10 resolvers) — db5a3c4                           |
| 2026-05-07 | 11C-4       | clientAutomation defense-in-depth (4 lines)                                          |
| 2026-05-07 | Conventions | docs/SECURITY-CONVENTIONS.md created                                                 |
| 2026-05-07 | 11D         | Math.random replaced with crypto.randomBytes (3 files) — 86c13af                     |
| 2026-05-06 | CRITICAL    | withWorkspace wrapper lacks membership verification — ~120 resolvers affected        |
| 2026-05-06 | 11-CRITICAL | withWorkspace membership verification (858ca1e) — 120 resolvers protected            |
| 2026-05-07 | 11C+11D     | Sprint 11C (1, 2, 3, 4) + 11D deployed in prod, monitored 1h, stable                 |
| 2026-05-09 | 11C-5       | importedInvoice/PO list+stats+import migrated to RBAC (11 resolvers) — 2fbbb57       |
| 2026-05-09 | 11C-6       | Reconcile workspaceId across financial doc queries (25 resolvers, 4 files) — 7fb07d8 |
| 2026-05-09 | Phase 1A    | Multi-tenant isolation test suite (44 cases, 11 resources) — 4fc3fa2                 |
