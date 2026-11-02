/**
 * Automatisations des documents partagés sur les devis et les bons de
 * commande : chaque changement de statut déclenche l'automatisation qui lui
 * correspond, avec le bon document.
 *
 *   Devis : finalisation (QUOTE_SENT), acceptation (QUOTE_ACCEPTED), refus
 *   (QUOTE_CANCELED) ; le retour en brouillon ne déclenche rien.
 *   Bons de commande : confirmation, en cours, livré, annulé
 *   (PURCHASE_ORDER_*) ; la validation ne déclenche rien.
 *   Bons de livraison : aucun déclencheur (choix documenté).
 *
 * processAutomationDocument avec un type de document différent du
 * déclencheur est refusé : couvert par
 * __tests__/security/automation-document-cached-pdf.test.js.
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

const executeAutomations = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncPurchaseOrderIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/qontoSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/abbySyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/esignatureService.js", () => ({
  default: { deleteSignature: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/esignaturePubsub.js", () => ({
  publishSignatureStatus: vi.fn(),
  signatureChannel: () => "signature",
}));

import mongoose from "mongoose";
import { buildContext } from "../helpers/auth.js";
import {
  resetWorkspace,
  startReplicaSet,
} from "../helpers/numberingSimulation.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Quote from "../../src/models/Quote.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DocumentAutomation from "../../src/models/DocumentAutomation.js";
import quoteResolvers from "../../src/resolvers/quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

const baseDocument = (fields) => ({
  workspaceId: organizationId,
  createdBy: userId,
  issueDate: new Date(),
  validUntil: new Date(Date.now() + 30 * 86_400_000),
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
  client: {
    id: "client-1",
    name: "Acme",
    email: "acme@test.fr",
    type: "COMPANY",
    address: {
      street: "1 rue Test",
      city: "Paris",
      postalCode: "75001",
      country: "France",
    },
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...fields,
});

async function insertQuote(status, number) {
  const { insertedId } = await Quote.collection.insertOne(
    baseDocument({ status, number, prefix: "D-202610" }),
  );
  return String(insertedId);
}

async function insertPurchaseOrder(status, number) {
  const { insertedId } = await PurchaseOrder.collection.insertOne(
    baseDocument({ status, number, prefix: "BC-202610" }),
  );
  return String(insertedId);
}

const changeQuoteStatus = (id, status) =>
  quoteResolvers.Mutation.changeQuoteStatus(
    null,
    { id, workspaceId: String(organizationId), status },
    ctx(),
  );

const changePurchaseOrderStatus = (id, status) =>
  purchaseOrderResolvers.Mutation.changePurchaseOrderStatus(
    null,
    { id, workspaceId: String(organizationId), status },
    ctx(),
  );

/** Déclencheurs passés à executeAutomations, avec le document concerné. */
const triggers = () =>
  executeAutomations.mock.calls.map(([trigger, workspaceId, document]) => ({
    trigger,
    workspaceId: String(workspaceId),
    documentId: document?.documentId,
    documentType: document?.documentType,
  }));

// Replica set : la finalisation d'un brouillon passe par une transaction
let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("automation_triggers");
}, 180000);
afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});
beforeEach(async () => {
  invalidateOrgCache();
  executeAutomations.mockClear();
  await resetWorkspace({ userId, organizationId });
});

describe("devis : automatisation de chaque changement de statut", () => {
  const CASES = [
    [
      "finalisation du brouillon",
      "DRAFT",
      "DRAFT-000001",
      "PENDING",
      "QUOTE_SENT",
    ],
    ["acceptation", "PENDING", "000001", "COMPLETED", "QUOTE_ACCEPTED"],
    ["refus", "PENDING", "000002", "CANCELED", "QUOTE_CANCELED"],
  ];

  for (const [label, from, number, to, trigger] of CASES) {
    it(`${label} : ${trigger}`, async () => {
      const id = await insertQuote(from, number);

      await changeQuoteStatus(id, to);

      expect(triggers()).toEqual([
        {
          trigger,
          workspaceId: String(organizationId),
          documentId: id,
          documentType: "quote",
        },
      ]);
    });
  }

  it("retour en brouillon : aucune automatisation", async () => {
    const id = await insertQuote("PENDING", "000003");

    await changeQuoteStatus(id, "DRAFT");

    expect(triggers()).toEqual([]);
  });
});

describe("bons de commande : automatisation de chaque changement de statut", () => {
  const CASES = [
    [
      "confirmation du brouillon",
      "DRAFT",
      "DRAFT-000001",
      "CONFIRMED",
      "PURCHASE_ORDER_CONFIRMED",
    ],
    [
      "mise en cours",
      "VALIDATED",
      "000001",
      "IN_PROGRESS",
      "PURCHASE_ORDER_IN_PROGRESS",
    ],
    [
      "livraison",
      "IN_PROGRESS",
      "000002",
      "DELIVERED",
      "PURCHASE_ORDER_DELIVERED",
    ],
    [
      "annulation",
      "CONFIRMED",
      "000003",
      "CANCELED",
      "PURCHASE_ORDER_CANCELED",
    ],
  ];

  for (const [label, from, number, to, trigger] of CASES) {
    it(`${label} : ${trigger}`, async () => {
      const id = await insertPurchaseOrder(from, number);

      await changePurchaseOrderStatus(id, to);

      expect(triggers()).toEqual([
        {
          trigger,
          workspaceId: String(organizationId),
          documentId: id,
          documentType: "purchaseOrder",
        },
      ]);
    });
  }

  it("validation : aucune automatisation", async () => {
    const id = await insertPurchaseOrder("CONFIRMED", "000004");

    await changePurchaseOrderStatus(id, "VALIDATED");

    expect(triggers()).toEqual([]);
  });
});

describe("bons de livraison : aucun déclencheur d'automatisation", () => {
  it("les déclencheurs couvrent devis et bons de commande, aucun bon de livraison", () => {
    const enumValues = DocumentAutomation.schema.path("triggerType").enumValues;

    for (const trigger of [
      "QUOTE_SENT",
      "QUOTE_ACCEPTED",
      "QUOTE_CANCELED",
      "PURCHASE_ORDER_CONFIRMED",
      "PURCHASE_ORDER_IN_PROGRESS",
      "PURCHASE_ORDER_DELIVERED",
      "PURCHASE_ORDER_CANCELED",
    ]) {
      expect(enumValues).toContain(trigger);
    }
    expect(enumValues.filter((t) => /DELIVERY/.test(t))).toEqual([]);
  });
});
