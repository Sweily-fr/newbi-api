/**
 * Automatisations des documents partagés : un statut déclenche son
 * automatisation quel que soit le chemin qui l'a posé, pas seulement les
 * boutons de changement de statut.
 *
 * Signalé le 13/11/2026 : « les automatisations ne sont pas automatiques, il
 * faut les relancer manuellement ». Une facture payée par rapprochement
 * bancaire, une facture d'achat créée depuis un justificatif ou reçue de
 * SuperPDP, une facture importée validée après vérification ne déclenchaient
 * rien. Une erreur d'automatisation ne doit jamais faire échouer l'action
 * d'origine.
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

const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, betterAuthJWTMiddleware: async () => auth.user };
});
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    deleteImage: vi.fn().mockResolvedValue(true),
    importedInvoicesBucketName: "imported",
  },
}));
const automations = vi.hoisted(() => ({
  executeAutomations: vi.fn().mockResolvedValue(undefined),
  executeAutomationsForExpense: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: automations,
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Transaction from "../../src/models/Transaction.js";
import Invoice from "../../src/models/Invoice.js";
import ImportedInvoice from "../../src/models/ImportedInvoice.js";
import reconciliationResolvers from "../../src/resolvers/reconciliationResolvers.js";
import importedInvoiceResolvers from "../../src/resolvers/importedInvoice.js";
import reconciliationRoutes from "../../src/routes/reconciliation.js";
import {
  statusTrigger,
  triggerPurchaseInvoiceAutomations,
} from "../../src/utils/documentAutomationTriggers.js";

const { ObjectId } = mongoose.Types;
const owner = buildUserId();
const organizationId = buildOrganizationId();
const ws = String(organizationId);

let server;
let baseUrl;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/reconciliation", reconciliationRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId: owner, organizationId, role: "owner" });
  auth.user = { _id: owner, id: String(owner), email: "owner@test.fr" };
  automations.executeAutomations.mockReset().mockResolvedValue(undefined);
  automations.executeAutomationsForExpense
    .mockReset()
    .mockResolvedValue(undefined);
});

const ctx = () => buildContext({ userId: owner, organizationId });
// Les automatisations partent sans attendre : laisser passer la file
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let n = 0;
async function credit() {
  n += 1;
  const _id = new ObjectId();
  await Transaction.collection.insertOne({
    _id,
    externalId: `tx-auto-${n}`,
    provider: "bridge",
    type: "credit",
    status: "completed",
    amount: 1000,
    currency: "EUR",
    description: "VIR CLIENT",
    workspaceId: ws,
    date: new Date("2026-10-01T00:00:00.000Z"),
    reconciliationStatus: "unmatched",
    linkedInvoiceIds: [],
    linkedPurchaseInvoiceIds: [],
    linkedImportedInvoiceIds: [],
    reconciliationLinks: [],
    deletedAt: null,
  });
  return _id;
}

async function salesInvoice(fields = {}) {
  const _id = new ObjectId();
  await Invoice.collection.insertOne({
    _id,
    workspaceId: organizationId,
    number: "000042",
    prefix: "F-2026-",
    status: "PENDING",
    client: { name: "Acme" },
    linkedTransactionIds: [],
    finalTotalTTC: 1000,
    ...fields,
  });
  return _id;
}

const paidCalls = () =>
  automations.executeAutomations.mock.calls.map(
    ([trigger, workspaceId, context, userId]) => ({
      trigger,
      workspaceId,
      documentId: context.documentId,
      documentType: context.documentType,
      userId,
    }),
  );

describe("rapprochement bancaire : « Facture payée »", () => {
  it("rapprochement depuis l'écran (GraphQL) : automatisation de la facture", async () => {
    const tx = await credit();
    const invoiceId = await salesInvoice();

    const result =
      await reconciliationResolvers.Mutation.linkTransactionToInvoice(
        null,
        { input: { transactionId: String(tx), invoiceId: String(invoiceId) } },
        ctx(),
      );
    await settle();

    expect(result.success).toBe(true);
    expect(paidCalls()).toEqual([
      {
        trigger: "INVOICE_PAID",
        workspaceId: ws,
        documentId: String(invoiceId),
        documentType: "invoice",
        userId: String(owner),
      },
    ]);
  });

  it("rapprochement par l'API REST : même automatisation", async () => {
    const tx = await credit();
    const invoiceId = await salesInvoice();

    const res = await fetch(`${baseUrl}/reconciliation/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-workspace-id": ws },
      body: JSON.stringify({
        transactionId: String(tx),
        invoiceId: String(invoiceId),
      }),
    });
    await settle();

    expect(res.status).toBe(200);
    expect(paidCalls()).toEqual([
      expect.objectContaining({
        trigger: "INVOICE_PAID",
        documentId: String(invoiceId),
      }),
    ]);
  });

  it("facture déjà payée (second paiement) : rien de relancé", async () => {
    const tx = await credit();
    const invoiceId = await salesInvoice({ status: "COMPLETED" });

    await reconciliationResolvers.Mutation.linkTransactionToInvoice(
      null,
      { input: { transactionId: String(tx), invoiceId: String(invoiceId) } },
      ctx(),
    );
    await settle();

    expect(paidCalls()).toEqual([]);
  });

  it("automatisation en erreur : le rapprochement réussit quand même", async () => {
    automations.executeAutomations.mockImplementation(() => {
      throw new Error("panne R2");
    });
    const tx = await credit();
    const invoiceId = await salesInvoice();

    const result =
      await reconciliationResolvers.Mutation.linkTransactionToInvoice(
        null,
        { input: { transactionId: String(tx), invoiceId: String(invoiceId) } },
        ctx(),
      );
    await settle();

    expect(result.success).toBe(true);
    expect((await Invoice.collection.findOne({ _id: invoiceId })).status).toBe(
      "COMPLETED",
    );
  });
});

describe("factures d'achat créées ou payées hors écran", () => {
  it("chaque statut déclenche son automatisation", () => {
    expect(statusTrigger("purchaseInvoice", "TO_PROCESS")).toBe(
      "PURCHASE_INVOICE_TO_PROCESS",
    );
    expect(statusTrigger("purchaseInvoice", "PAID")).toBe(
      "PURCHASE_INVOICE_PAID",
    );
    expect(statusTrigger("invoice", "PENDING")).toBe("INVOICE_SENT");
    expect(statusTrigger("quote", "PENDING")).toBe("QUOTE_SENT");
    expect(statusTrigger("purchaseOrder", "CONFIRMED")).toBe(
      "PURCHASE_ORDER_CONFIRMED",
    );
    expect(statusTrigger("invoice", "INCONNU")).toBeNull();
  });

  it("facture payée (justificatif, SuperPDP, Qonto) : « Facture d'achat payée »", async () => {
    const invoice = {
      _id: new ObjectId(),
      status: "PAID",
      invoiceNumber: "CANVA-1",
      supplierName: "Canva",
    };

    triggerPurchaseInvoiceAutomations(invoice, organizationId);
    await settle();

    expect(automations.executeAutomationsForExpense).toHaveBeenCalledWith(
      "PURCHASE_INVOICE_PAID",
      ws,
      expect.objectContaining({
        documentId: String(invoice._id),
        documentType: "purchaseInvoice",
        documentNumber: "CANVA-1",
      }),
      null,
    );
  });

  it("erreur immédiate du service : rien ne remonte à l'appelant", async () => {
    automations.executeAutomationsForExpense.mockImplementation(() => {
      throw new Error("panne");
    });

    expect(() =>
      triggerPurchaseInvoiceAutomations(
        { _id: new ObjectId(), status: "TO_PAY" },
        organizationId,
      ),
    ).not.toThrow();
    await settle();
  });
});

describe("facture importée validée après vérification", () => {
  async function imported(status) {
    const { insertedId } = await ImportedInvoice.collection.insertOne({
      workspaceId: organizationId,
      importedBy: owner,
      status,
      source: "GMAIL",
      originalInvoiceNumber: "GM-1",
      vendor: { name: "Fournisseur Gmail" },
      file: {
        url: "https://r2.invalid/gm-1.pdf",
        cloudflareKey: `${ws}/gm-1.pdf`,
        originalFileName: "gm-1.pdf",
        mimeType: "application/pdf",
      },
      createdAt: new Date(),
    });
    return insertedId;
  }
  const validate = (id) =>
    importedInvoiceResolvers.Mutation.validateImportedInvoice(
      null,
      { id: String(id) },
      ctx(),
    );

  it("à vérifier puis validée : « Facture importée »", async () => {
    const id = await imported("PENDING_REVIEW");

    await validate(id);
    await settle();

    expect(automations.executeAutomationsForExpense).toHaveBeenCalledWith(
      "INVOICE_IMPORTED",
      ws,
      expect.objectContaining({
        documentId: String(id),
        documentType: "importedInvoice",
      }),
      String(owner),
    );
  });

  it("déjà validée : rien de relancé", async () => {
    const id = await imported("VALIDATED");

    await validate(id);
    await settle();

    expect(automations.executeAutomationsForExpense).not.toHaveBeenCalled();
  });
});
