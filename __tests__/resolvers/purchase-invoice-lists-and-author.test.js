/**
 * Factures d'achat : pagination des listes bornée (page négative, taille
 * démesurée) sans erreur, et auteur d'une facture (createdBy) réduit à son
 * identité pour les autres membres de l'espace.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Supplier from "../../src/models/Supplier.js";
import "../../src/models/User.js";
import purchaseInvoiceResolvers from "../../src/resolvers/purchaseInvoice.js";
import bankingResolvers from "../../src/resolvers/banking.js";

const owner = buildUserId();
const viewer = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);
const Q = purchaseInvoiceResolvers.Query;
const ctx = (userId = owner) => buildContext({ userId, organizationId });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
  await seedOrgMembership({ userId: viewer, organizationId, role: "viewer" });
  await PurchaseInvoice.collection.insertMany(
    Array.from({ length: 3 }, (_, i) => ({
      workspaceId: organizationId,
      createdBy: owner,
      supplierName: `Fournisseur ${i}`,
      issueDate: new Date(`2026-10-0${i + 1}`),
      amountTTC: 10 + i,
      status: "TO_PAY",
      files: [],
      linkedTransactionIds: [],
    })),
  );
  await Supplier.collection.insertMany(
    Array.from({ length: 3 }, (_, i) => ({
      workspaceId: organizationId,
      name: `Fiche ${i}`,
      createdBy: owner,
    })),
  );
});

describe("Listes : pagination bornée", () => {
  it("purchaseInvoices page -1 et taille 100 000 : première page, 1 000 au plus", async () => {
    const res = await Q.purchaseInvoices(
      null,
      { workspaceId: ws, page: -1, limit: 100000 },
      ctx(),
    );
    expect(res.items).toHaveLength(3);
    expect(res.currentPage).toBe(1);
    expect(res.totalPages).toBe(1);
  });

  it("purchaseInvoices taille 0 : au moins un élément par page", async () => {
    const res = await Q.purchaseInvoices(
      null,
      { workspaceId: ws, page: 1, limit: 0 },
      ctx(),
    );
    expect(res.items).toHaveLength(1);
    expect(res.totalPages).toBe(3);
  });

  it("suppliers page -5 et taille 100 000 : sans erreur", async () => {
    const res = await Q.suppliers(
      null,
      { workspaceId: ws, page: -5, limit: 100000 },
      ctx(),
    );
    expect(res.items).toHaveLength(3);
    expect(res.currentPage).toBe(1);
  });

  it("transactions décalage négatif : sans erreur", async () => {
    const res = await bankingResolvers.Query.transactions(
      null,
      { workspaceId: ws, limit: -10, offset: -20 },
      ctx(),
    );
    expect(Array.isArray(res)).toBe(true);
  });
});

describe("Auteur d'une facture d'achat (createdBy)", () => {
  it("identité seulement : ni abonnement, ni parrainage, ni entreprise", async () => {
    await mongoose.connection.db.collection("user").insertOne({
      _id: owner,
      email: "auteur@test.fr",
      emailVerified: true,
      referralCode: "PARRAIN-42",
      subscription: {
        licence: true,
        trial: false,
        stripeCustomerId: "cus_secret",
      },
      company: {
        name: "Cabinet",
        bankDetails: { iban: "FR7630006000011234567890189" },
      },
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
    });
    const facture = await PurchaseInvoice.collection.findOne({});
    const auteur =
      await purchaseInvoiceResolvers.PurchaseInvoice.createdBy(facture);
    expect(auteur).toMatchObject({
      id: String(owner),
      email: "auteur@test.fr",
      isEmailVerified: true,
    });
    expect(JSON.stringify(auteur)).not.toMatch(
      /cus_secret|PARRAIN-42|FR7630006000011234567890189/,
    );
    expect(auteur.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
