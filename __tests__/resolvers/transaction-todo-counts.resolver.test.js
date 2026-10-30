import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Transaction from "../../src/models/Transaction.js";
import bankingResolvers from "../../src/resolvers/banking.js";

// Compteurs « Justificatifs manquants » et « Transactions à catégoriser » de
// l'accueil : écrits en dur à 0 côté site faute de requête.

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ws = () => organizationId.toString();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

let n = 0;
const tx = (amount, extra = {}) => {
  n += 1;
  return {
    externalId: `tx-todo-${n}`,
    provider: "bridge",
    type: amount > 0 ? "credit" : "debit",
    status: "completed",
    amount,
    workspaceId: ws(),
    date: new Date(),
    deletedAt: null,
    linkedInvoiceIds: [],
    linkedPurchaseInvoiceIds: [],
    linkedImportedInvoiceIds: [],
    receiptFiles: [],
    category: null,
    expenseCategory: null,
    ...extra,
  };
};

const counts = (workspaceId = ws()) =>
  bankingResolvers.Query.transactionTodoCounts(
    null,
    { workspaceId },
    buildContext({ userId, organizationId }),
  );

describe("transactionTodoCounts", () => {
  it("justificatifs manquants : dépenses bancaires sans pièce ni facture liée", async () => {
    await Transaction.collection.insertMany([
      tx(-35.5),
      tx(-89.99, { expenseCategory: "SOFTWARE" }),
      // Justifiées : pièce jointe ou facture d'achat liée
      tx(-12, { receiptFiles: [{ url: "https://r2.test/ticket.pdf" }] }),
      tx(-480, { linkedPurchaseInvoiceIds: [organizationId] }),
      // Ni entrée d'argent, ni espèces, ni transaction supprimée
      tx(450),
      tx(-20, { provider: "manual" }),
      tx(-999, { deletedAt: new Date() }),
    ]);
    expect((await counts()).missingReceipt).toBe(2);
  });

  it("à catégoriser : transactions bancaires sans aucune catégorie", async () => {
    await Transaction.collection.insertMany([
      tx(-35.5),
      tx(450),
      tx(-89.99, { expenseCategory: "SOFTWARE" }),
      tx(-64.8, { category: "carburant" }),
      tx(50, { provider: "manual" }),
      tx(-999, { deletedAt: new Date() }),
    ]);
    expect((await counts()).uncategorized).toBe(2);
  });

  it("ne compte que les transactions de l'espace", async () => {
    const other = buildOrganizationId().toString();
    await Transaction.collection.insertMany([
      tx(-35.5, { workspaceId: other }),
    ]);
    expect(await counts()).toEqual({ missingReceipt: 0, uncategorized: 0 });
  });
});
