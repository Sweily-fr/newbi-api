/**
 * Listes de factures et d'avoirs : 1 000 éléments au plus par page, page à
 * partir de 1 (invoices(limit: 100000) ou page 0 ne font plus lire toute la
 * collection ni échouer la requête). Le site relit les listes complètes par
 * pages de 1 000.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { boundedPage, MAX_PAGE_SIZE } from "../../src/utils/pagination.js";
import Invoice from "../../src/models/Invoice.js";
import CreditNote from "../../src/models/CreditNote.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";
import creditNoteResolvers from "../../src/resolvers/creditNote.js";

describe("boundedPage", () => {
  it("borne la taille à 1 000 et la page à 1", () => {
    expect(MAX_PAGE_SIZE).toBe(1000);
    expect(boundedPage(1, 100000)).toEqual({ page: 1, limit: 1000 });
    expect(boundedPage(0, 20)).toEqual({ page: 1, limit: 20 });
    expect(boundedPage(-3, -5)).toEqual({ page: 1, limit: 1 });
    expect(boundedPage("x", "y")).toEqual({ page: 1, limit: 10 });
  });
});

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

const N = 1005;

describe("invoices et creditNotes", () => {
  it("invoices(limit: 100000) : 1 000 factures, page suivante annoncée", async () => {
    await Invoice.collection.insertMany(
      Array.from({ length: N }, (_, i) => ({
        workspaceId: organizationId,
        createdBy: userId,
        number: String(i + 1).padStart(4, "0"),
        prefix: "F-T",
        status: "PENDING",
        createdAt: new Date(Date.now() - i * 1000),
        client: { name: "Client" },
        items: [],
      })),
    );
    const r = await invoiceResolvers.Query.invoices(
      null,
      { workspaceId: String(organizationId), limit: 100000, page: 0 },
      ctx(),
    );
    expect(r.invoices).toHaveLength(1000);
    expect(r.totalCount).toBe(N);
    expect(r.hasNextPage).toBe(true);
  });

  it("creditNotes(limit: 100000) : 1 000 avoirs au plus", async () => {
    await CreditNote.collection.insertMany(
      Array.from({ length: N }, (_, i) => ({
        workspaceId: new mongoose.Types.ObjectId(organizationId),
        createdBy: userId,
        number: String(i + 1).padStart(4, "0"),
        prefix: "AV-T",
        status: "CREATED",
        createdAt: new Date(Date.now() - i * 1000),
        client: { name: "Client" },
        items: [],
      })),
    );
    const r = await creditNoteResolvers.Query.creditNotes(
      null,
      { limit: 100000, page: -1 },
      ctx(),
    );
    expect(r.creditNotes).toHaveLength(1000);
    expect(r.totalCount).toBe(N);
  });
});
