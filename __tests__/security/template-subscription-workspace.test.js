/**
 * Modèles de devis, bons de commande et factures : le mode lecture seule
 * (abonnement inactif) porte sur l'espace où le modèle est enregistré, pas
 * sur l'espace actif nommé par l'en-tête.
 *
 * Membre de deux espaces, en-tête x-organization-id sur l'espace abonné,
 * enregistrement d'un modèle dans l'espace à l'abonnement échu :
 * SUBSCRIPTION_READ_ONLY et aucun modèle créé. Dans l'espace abonné, le même
 * appel crée le modèle.
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

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
});
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { ERROR_CODES } from "../../src/utils/errors.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import Invoice from "../../src/models/Invoice.js";
import QuoteTemplate from "../../src/models/quoteTemplate.js";
import PurchaseOrderTemplate from "../../src/models/purchaseOrderTemplate.js";
import InvoiceTemplate from "../../src/models/invoiceTemplate.js";
import quoteTemplateResolvers from "../../src/resolvers/quoteTemplate.js";
import purchaseOrderTemplateResolvers from "../../src/resolvers/purchaseOrderTemplate.js";
import invoiceTemplateResolvers from "../../src/resolvers/invoiceTemplate.js";

const userId = buildUserId();
const expiredOrg = buildOrganizationId();
const activeOrg = buildOrganizationId();

// Contexte GraphQL tel que server.js le construit : aucun espace avant le RBAC
const serverContext = (headers = {}) => ({
  req: { headers },
  user: {
    _id: new mongoose.Types.ObjectId(String(userId)),
    id: String(userId),
    email: "test@test.com",
  },
  organizationId: headers["x-organization-id"] || null,
});

const readOnly = { code: ERROR_CODES.SUBSCRIPTION_READ_ONLY };

const baseDocument = (workspaceId) => ({
  workspaceId,
  createdBy: userId,
  status: "PENDING",
  number: "000001",
  prefix: "D-202610",
  issueDate: new Date("2026-10-01T00:00:00.000Z"),
  items: [
    { description: "Prestation", quantity: 1, unitPrice: 100, vatRate: 20 },
  ],
  totalHT: 100,
  totalVAT: 20,
  totalTTC: 120,
  finalTotalHT: 100,
  finalTotalVAT: 20,
  finalTotalTTC: 120,
  discount: 0,
  discountType: "FIXED",
  client: { id: "client-1", name: "Acme", email: "acme@test.fr" },
  createdAt: new Date(),
  updatedAt: new Date(),
});

async function insertSources(workspaceId) {
  const quote = await Quote.collection.insertOne(baseDocument(workspaceId));
  const purchaseOrder = await PurchaseOrder.collection.insertOne({
    ...baseDocument(workspaceId),
    prefix: "BC-202610",
    status: "CONFIRMED",
  });
  const invoice = await Invoice.collection.insertOne({
    ...baseDocument(workspaceId),
    prefix: "F-202610",
    dueDate: new Date("2026-10-31T00:00:00.000Z"),
  });
  return {
    quoteId: String(quote.insertedId),
    purchaseOrderId: String(purchaseOrder.insertedId),
    invoiceId: String(invoice.insertedId),
  };
}

const CASES = [
  {
    label: "saveQuoteAsTemplate",
    call: (workspaceId, ids, ctx) =>
      quoteTemplateResolvers.Mutation.saveQuoteAsTemplate(
        null,
        {
          workspaceId: String(workspaceId),
          input: { quoteId: ids.quoteId, name: "Modèle de devis" },
        },
        ctx,
      ),
    Model: QuoteTemplate,
  },
  {
    label: "savePurchaseOrderAsTemplate",
    call: (workspaceId, ids, ctx) =>
      purchaseOrderTemplateResolvers.Mutation.savePurchaseOrderAsTemplate(
        null,
        {
          workspaceId: String(workspaceId),
          input: {
            purchaseOrderId: ids.purchaseOrderId,
            name: "Modèle de bon de commande",
          },
        },
        ctx,
      ),
    Model: PurchaseOrderTemplate,
  },
  {
    label: "saveInvoiceAsTemplate",
    call: (workspaceId, ids, ctx) =>
      invoiceTemplateResolvers.Mutation.saveInvoiceAsTemplate(
        null,
        {
          workspaceId: String(workspaceId),
          input: { invoiceId: ids.invoiceId, name: "Modèle de facture" },
        },
        ctx,
      ),
    Model: InvoiceTemplate,
  },
];

let expiredIds;
let activeIds;

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  await seedOrgMembership({
    userId,
    organizationId: expiredOrg,
    role: "owner",
    subscriptionStatus: "unpaid",
  });
  await seedOrgMembership({ userId, organizationId: activeOrg, role: "owner" });
  expiredIds = await insertSources(expiredOrg);
  activeIds = await insertSources(activeOrg);
});

describe("modèles : abonnement de l'espace où le modèle est enregistré", () => {
  for (const { label, call, Model } of CASES) {
    it(`${label} dans l'espace échu, en-tête sur l'espace abonné : lecture seule, aucun modèle`, async () => {
      const ctx = serverContext({ "x-organization-id": String(activeOrg) });

      await expect(call(expiredOrg, expiredIds, ctx)).rejects.toMatchObject(
        readOnly,
      );
      expect(await Model.countDocuments({})).toBe(0);
    });

    it(`${label} dans l'espace échu, sans en-tête : lecture seule, aucun modèle`, async () => {
      await expect(
        call(expiredOrg, expiredIds, serverContext()),
      ).rejects.toMatchObject(readOnly);
      expect(await Model.countDocuments({})).toBe(0);
    });

    it(`${label} dans l'espace abonné : modèle créé`, async () => {
      const ctx = serverContext({ "x-organization-id": String(activeOrg) });

      const saved = await call(activeOrg, activeIds, ctx);

      expect(String(saved.workspaceId)).toBe(String(activeOrg));
      expect(await Model.countDocuments({ workspaceId: activeOrg })).toBe(1);
    });
  }
});
