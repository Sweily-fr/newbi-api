# Security Audit — Tracking

Last updated: 2026-05-06 (critical finding added)

## Overview

Multi-sprint backend security improvement plan based on internal audit.
Each sprint focuses on a specific category of access control or input validation.

## Sprint Status

| Sprint       | Theme                                                               | Status         | Deployed |
| ------------ | ------------------------------------------------------------------- | -------------- | -------- |
| 9            | Multi-tenant access checks (imported docs, partner, reconciliation) | ✅ Done        | ✅ Prod  |
| 10           | File transfer payment session hardening                             | ✅ Done        | ✅ Prod  |
| 11A          | Webhook signature verification + JWT strict                         | ✅ Done        | ✅ Prod  |
| 11B          | Public board share password hashing + timing-safe comparison        | ✅ Done        | ✅ Prod  |
| 11C          | Workspace scope on remaining resolvers                              | 🟡 In Progress | ❌       |
| 11D          | Replace Math.random with crypto.randomBytes (residual)              | ⏸️ Planned     | ❌       |
| 11E+         | High/Medium findings from Pass 1                                    | ⏸️ Planned     | ❌       |
| Audit Pass 2 | Input validation, data exposure, rate limiting                      | ⏸️ Not started | -        |
| Audit Pass 3 | CORS, uploads, third-party webhooks, env vars                       | ⏸️ Not started | -        |

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

## Sprint 11C — Workspace scope on remaining resolvers (IN PROGRESS)

**Status**: 🟡 In progress

### Targets

| #   | File                         | Issue                                                                              | Status                 |
| --- | ---------------------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| 2   | importedInvoice.js:1413      | findByIdAndDelete without workspace filter (defense in depth)                      | ✅ Committed (53b6ea4) |
| 3   | importedPurchaseOrder.js:590 | Same pattern                                                                       | ✅ Committed (82a1765) |
| 1   | importedQuote.js             | 10 resolvers migrated to requireRead/Write/Delete + helper filtered by workspaceId | ✅ Committed (db5a3c4) |
| 4   | clientAutomation.js          | 1 real defense-in-depth fix + 3 cosmetic hardenings (resolver layer already RBAC)  | ✅ Committed           |

### Notes

- Correctif 1 scope expanded: initially 7 resolvers, but verification revealed that 3 additional list/stats/create resolvers were trusting workspaceId from GraphQL args (controllable by client). Now 10 resolvers in scope.

### Sprint 11C-1 details

**Status**: ✅ Committed, pending merge to develop

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

**Status**: ✅ Committed, pending merge to develop

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

Status: Under analysis, pending decision on Plan A/B/C.

---

## Sprint 11D — Math.random residuals (PLANNED)

**Status**: ⏸️ Planned, not started

### Targets

- chunkUpload.js:122 — file ID
- expense.js:83 — filename
- GoCardlessProvider.js:434 — externalId

### Pattern to apply

Replace `Math.random()...` with `crypto.randomBytes(16).toString("hex")`.

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

## Update log

| Date       | Sprint      | Action                                                                        |
| ---------- | ----------- | ----------------------------------------------------------------------------- |
| 2026-05-06 | Tracking    | Tracking file created                                                         |
| 2026-05-06 | 11C-2       | importedInvoice.js findByIdAndDelete scoped (53b6ea4)                         |
| 2026-05-06 | 11C-3       | importedPurchaseOrder.js findByIdAndDelete scoped (82a1765)                   |
| 2026-05-07 | 11C-1       | importedQuote.js migrated to RBAC (10 resolvers) — db5a3c4                    |
| 2026-05-07 | 11C-4       | clientAutomation defense-in-depth (4 lines)                                   |
| 2026-05-07 | Conventions | docs/SECURITY-CONVENTIONS.md created                                          |
| 2026-05-06 | CRITICAL    | withWorkspace wrapper lacks membership verification — ~120 resolvers affected |
