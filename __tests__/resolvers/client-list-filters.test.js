/**
 * Filtres faits en base pour les pages des contacts :
 *   - clients(blocked: true) : tous les contacts bloqués de l'espace (la page
 *     « Contacts bloqués » ne filtre plus les 500 premiers contacts) ;
 *   - quotes / purchaseOrders (clientId) : documents d'un contact, quel que
 *     soit leur rang parmi ceux de l'espace (onglets de la fiche).
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
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
  default: {},
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Client from "../../src/models/Client.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import clientResolvers from "../../src/resolvers/client.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";

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

describe("clients(blocked)", () => {
  beforeEach(async () => {
    const docs = Array.from({ length: 12 }, (_, i) =>
      buildClientDoc({
        workspaceId: organizationId,
        createdBy: userId,
        name: `Contact ${String(i).padStart(2, "0")}`,
        email: `contact${i}@exemple.test`,
        isBlocked: i === 11,
      }),
    );
    await Client.insertMany(docs);
  });

  const list = (args) =>
    clientResolvers.Query.clients(null, { page: 1, limit: 5, ...args }, ctx());

  it("blocked: true renvoie le contact bloqué, même au-delà de la première page", async () => {
    const res = await list({ blocked: true });
    expect(res.items.map((c) => c.name)).toEqual(["Contact 11"]);
    expect(res.totalItems).toBe(1);
  });

  it("blocked: false exclut les contacts bloqués", async () => {
    const res = await list({ blocked: false, limit: 50 });
    expect(res.totalItems).toBe(11);
    expect(res.items.some((c) => c.isBlocked)).toBe(false);
  });

  it("sans filtre : tous les contacts", async () => {
    const res = await list({ limit: 50 });
    expect(res.totalItems).toBe(12);
  });
});

describe("quotes et purchaseOrders (clientId)", () => {
  const clientX = new mongoose.Types.ObjectId().toString();

  async function seed(Model, prefix) {
    const docs = Array.from({ length: 60 }, (_, i) => ({
      _id: new mongoose.Types.ObjectId(),
      workspaceId: organizationId,
      createdBy: userId,
      number: String(1000 + i),
      prefix,
      status: "PENDING",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      // Le plus ancien seulement pour le contact X
      client:
        i === 0
          ? { id: clientX, name: "Contact X", email: "x@exemple.test" }
          : { id: "autre", name: "Autre", email: "autre@exemple.test" },
      issueDate: new Date(2026, 0, 1 + i),
      createdAt: new Date(2026, 0, 1 + i),
      finalTotalTTC: 120,
    }));
    await Model.collection.insertMany(docs);
  }

  it("quotes(clientId) trouve le devis le plus ancien du contact", async () => {
    await seed(Quote, "D-TEST");
    const res = await quoteResolvers.Query.quotes(
      null,
      {
        workspaceId: organizationId.toString(),
        page: 1,
        limit: 50,
        clientId: clientX,
      },
      ctx(),
    );
    expect(res.quotes).toHaveLength(1);
    expect(res.quotes[0].number).toBe("1000");
  });

  it("purchaseOrders(clientId) trouve le bon de commande le plus ancien du contact", async () => {
    await seed(PurchaseOrder, "BC-TEST");
    const res = await purchaseOrderResolvers.Query.purchaseOrders(
      null,
      {
        workspaceId: organizationId.toString(),
        page: 1,
        limit: 50,
        clientId: clientX,
      },
      ctx(),
    );
    expect(res.purchaseOrders).toHaveLength(1);
    expect(res.purchaseOrders[0].number).toBe("1000");
  });
});
