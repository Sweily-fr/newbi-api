/**
 * Achat d'imports OCR supplémentaires : le nombre crédité doit correspondre
 * au paiement Stripe (achat d'imports, de cet espace, pour cette quantité,
 * au prix de l'offre). Un paiement d'autre chose, d'un autre espace, ou d'un
 * montant trop faible ne crédite rien ; un même paiement ne sert qu'une fois.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

const payments = vi.hoisted(() => new Map());
vi.mock("../../src/utils/stripe.js", () => {
  const retrieve = async (id) => {
    if (!payments.has(id)) throw new Error("No such payment");
    return payments.get(id);
  };
  return {
    default: {
      checkout: { sessions: { retrieve } },
      paymentIntents: { retrieve },
    },
  };
});
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: vi.fn().mockResolvedValue(true) },
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import UserOcrQuota from "../../src/models/UserOcrQuota.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";

const owner = buildUserId();
const org = buildOrganizationId();
const otherOrg = buildOrganizationId();
const ws = String(org);
const ctx = () => buildContext({ userId: owner, organizationId: org });

// Offre TPE (« pme ») : 0,20 € l'import supplémentaire.
const session = (id, { quantity, amount, workspaceId = ws, purpose } = {}) =>
  payments.set(id, {
    id,
    payment_status: "paid",
    amount_total: amount,
    currency: "eur",
    metadata: {
      purpose: purpose ?? "extra_ocr_imports",
      workspaceId,
      quantity: String(quantity),
    },
  });

const buy = (quantity, paymentId) =>
  importedInvoiceResolvers.Mutation.purchaseExtraOcrImports(
    null,
    { workspaceId: ws, quantity, paymentId },
    ctx(),
  );

const extraPurchased = async () =>
  (await UserOcrQuota.find({}).lean()).reduce(
    (sum, q) => sum + (q.extraImportsPurchased || 0),
    0,
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  payments.clear();
  await seedOrgMembership({ userId: owner, organizationId: org });
});

describe("purchaseExtraOcrImports", () => {
  it("paiement de 10 imports au bon prix : 10 imports crédités", async () => {
    session("cs_test_ok", { quantity: 10, amount: 200 });
    const result = await buy(10, "cs_test_ok");
    expect(result.success).toBe(true);
    expect(await extraPurchased()).toBe(10);
  });

  it("paiement d'un import puis demande de 1 000 : refus, rien crédité", async () => {
    session("cs_test_un", { quantity: 1, amount: 20 });
    await expect(buy(1000, "cs_test_un")).rejects.toThrow(
      "Ce paiement ne correspond pas à cet achat d'imports.",
    );
    expect(await extraPurchased()).toBe(0);
  });

  it("montant payé inférieur au prix de la quantité : refus", async () => {
    session("cs_test_peu", { quantity: 1000, amount: 20 });
    await expect(buy(1000, "cs_test_peu")).rejects.toThrow(
      "Ce paiement ne correspond pas à cet achat d'imports.",
    );
    expect(await extraPurchased()).toBe(0);
  });

  it("paiement d'un transfert de fichiers : refus", async () => {
    payments.set("pi_transfert", {
      id: "pi_transfert",
      status: "succeeded",
      amount_received: 5000,
      currency: "eur",
      metadata: { type: "file_transfer", transferId: "abc" },
    });
    await expect(buy(10, "pi_transfert")).rejects.toThrow(
      "Ce paiement ne correspond pas à cet achat d'imports.",
    );
    expect(await extraPurchased()).toBe(0);
  });

  it("paiement d'imports d'un autre espace : refus", async () => {
    session("cs_test_autre", {
      quantity: 10,
      amount: 200,
      workspaceId: String(otherOrg),
    });
    await expect(buy(10, "cs_test_autre")).rejects.toThrow(
      "Ce paiement ne correspond pas à cet achat d'imports.",
    );
    expect(await extraPurchased()).toBe(0);
  });

  it("paiement non abouti : refus", async () => {
    payments.set("cs_test_ouvert", {
      id: "cs_test_ouvert",
      payment_status: "unpaid",
      amount_total: 200,
      currency: "eur",
      metadata: {
        purpose: "extra_ocr_imports",
        workspaceId: ws,
        quantity: "10",
      },
    });
    await expect(buy(10, "cs_test_ouvert")).rejects.toThrow(
      "Paiement non confirmé.",
    );
  });

  it("même paiement deux fois : le second est refusé", async () => {
    session("cs_test_double", { quantity: 5, amount: 100 });
    await buy(5, "cs_test_double");
    await expect(buy(5, "cs_test_double")).rejects.toThrow(
      "Ce paiement a déjà été utilisé.",
    );
    expect(await extraPurchased()).toBe(5);
  });
});
