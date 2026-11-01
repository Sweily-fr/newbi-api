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
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

// Mock fire-and-forget automations
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

// Événement de calendrier créé avec l'avoir (CREDIT_NOTE_CREATED) : simulé,
// le test vérifie seulement qu'aucun n'est créé à la modification
vi.mock("../../src/models/Event.js", () => ({
  default: {
    create: vi.fn().mockResolvedValue({}),
    deleteMany: vi.fn().mockResolvedValue({}),
  },
}));

// Archivage R2 (Puppeteer côté NewbiV2) : on vérifie seulement l'appel
vi.mock("../../src/services/creditNoteFacturXArchiveService.js", () => ({
  triggerCreditNoteFacturXArchive: vi.fn(),
}));

// Routage e-invoicing simulé : le test décide de la réponse de la plateforme
vi.mock("../../src/utils/eInvoiceRoutingHelper.js", () => ({
  evaluateAndRouteCreditNote: vi.fn(),
}));

import CreditNote from "../../src/models/CreditNote.js";
import DocumentCounter from "../../src/models/DocumentCounter.js";
import { evaluateAndRouteCreditNote } from "../../src/utils/eInvoiceRoutingHelper.js";
import Event from "../../src/models/Event.js";
import Invoice from "../../src/models/Invoice.js";
import creditNoteResolvers from "../../src/resolvers/creditNote.js";
import { triggerCreditNoteFacturXArchive } from "../../src/services/creditNoteFacturXArchiveService.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userId = buildUserId();
const organizationId = buildOrganizationId();

async function insertInvoice(overrides = {}) {
  const _id = new mongoose.Types.ObjectId();
  const doc = {
    _id,
    workspaceId: organizationId,
    createdBy: userId,
    number: `INV-${_id.toString().slice(-6)}`,
    prefix: "F-202605",
    status: "COMPLETED",
    items: [
      { description: "Service", quantity: 1, unitPrice: 1000, vatRate: 20 },
    ],
    totalHT: 1000,
    totalVAT: 200,
    totalTTC: 1200,
    finalTotalHT: 1000,
    finalTotalVAT: 200,
    finalTotalTTC: 1200,
    issueDate: new Date(),
    createdAt: new Date(),
    isReverseCharge: false,
    ...overrides,
  };
  await Invoice.collection.insertOne(doc);
  return doc;
}

// Adresse exigée par le modèle dès que le port est facturé
const SHIPPING_ADDRESS = {
  fullName: "Client Test",
  street: "1 rue",
  city: "Paris",
  postalCode: "75001",
  country: "France",
};

function buildCreditNoteInput(invoiceId, overrides = {}) {
  return {
    originalInvoiceId: invoiceId.toString(),
    creditType: "CORRECTION",
    items: [
      { description: "Retour", quantity: 1, unitPrice: 500, vatRate: 20 },
    ],
    client: {
      name: "Client Test",
      email: "client@test.fr",
      address: {
        street: "1 rue",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  // requireCompanyInfo validates capitalSocial + rcs for SASU
  const db = mongoose.connection.db;
  await db.collection("organization").updateOne(
    { _id: organizationId },
    {
      $set: {
        capitalSocial: "10000",
        rcs: "Paris B 123 456 789",
        vatNumber: "FR12345678901",
      },
    },
  );
});

const ctx = () => buildContext({ userId, organizationId });

// ---------------------------------------------------------------------------
// Avoir d'une facture transmise en facturation électronique (UNTDID 381)
// ---------------------------------------------------------------------------

const create = (input) =>
  creditNoteResolvers.Mutation.createCreditNote(null, { input }, ctx());

describe("createCreditNote : routage e-invoicing avant l'enregistrement", () => {
  beforeEach(() => {
    evaluateAndRouteCreditNote.mockReset();
  });

  it("avoir déposé sur la plateforme : enregistré avec son identifiant SuperPDP", async () => {
    evaluateAndRouteCreditNote.mockImplementation(async (creditNote) => {
      creditNote.eInvoiceFlowType = "E_INVOICING";
      creditNote.superPdpInvoiceId = "spdp-381-1";
      creditNote.eInvoiceStatus = "PENDING_VALIDATION";
      return { flowType: "E_INVOICING", reason: "B2B" };
    });
    const inv = await insertInvoice({ superPdpInvoiceId: "spdp-380-1" });

    const result = await create(buildCreditNoteInput(inv._id));

    const saved = await CreditNote.findById(result._id || result.id).lean();
    expect(saved.superPdpInvoiceId).toBe("spdp-381-1");
    expect(saved.eInvoiceStatus).toBe("PENDING_VALIDATION");
    // Numéro attribué AVANT le dépôt : la plateforme reçoit le vrai numéro
    const sent = evaluateAndRouteCreditNote.mock.calls[0][0];
    expect(sent.number).toMatch(/^\d{4}$/);
  });

  it("dépôt refusé : rien n'est enregistré, le numéro est rendu, le motif est donné", async () => {
    evaluateAndRouteCreditNote.mockImplementationOnce(async (creditNote) => {
      creditNote.eInvoiceStatus = "ERROR";
      return {
        flowType: "E_INVOICING",
        sendFailed: true,
        error: "Compte SuperPDP non connecté",
      };
    });
    const inv = await insertInvoice({ superPdpInvoiceId: "spdp-380-2" });

    await expect(create(buildCreditNoteInput(inv._id))).rejects.toThrow(
      /facturation électronique.*n'a pas été créé.*Compte SuperPDP non connecté/,
    );
    expect(await CreditNote.countDocuments({})).toBe(0);

    // L'avoir suivant reprend le même numéro : aucun trou dans la séquence
    evaluateAndRouteCreditNote.mockResolvedValue(null);
    const next = await create(buildCreditNoteInput(inv._id));
    expect(next.number).toBe("0001");
  });

  it("dépôt en échec (exception) : même refus, aucun avoir", async () => {
    evaluateAndRouteCreditNote.mockRejectedValueOnce(new Error("réseau"));
    const inv = await insertInvoice({ superPdpInvoiceId: "spdp-380-3" });

    await expect(create(buildCreditNoteInput(inv._id))).rejects.toThrow(
      /n'a pas été créé.*réseau/,
    );
    expect(await CreditNote.countDocuments({})).toBe(0);
  });

  it("e-invoicing non activé : avoir enregistré comme avant", async () => {
    evaluateAndRouteCreditNote.mockResolvedValue(null);
    const inv = await insertInvoice();

    const result = await create(buildCreditNoteInput(inv._id));
    expect(result.number).toBe("0001");
    expect(await CreditNote.countDocuments({})).toBe(1);
  });

  it("le numéro n'est rendu que si personne ne l'a suivi", async () => {
    await DocumentCounter.create({
      documentType: "creditNote",
      prefix: "AV-T",
      workspaceId: organizationId.toString(),
      lastNumber: 5,
    });
    expect(
      await DocumentCounter.releaseNumber("creditNote", "AV-T", organizationId, "0004"),
    ).toBe(false);
    expect(
      await DocumentCounter.releaseNumber("creditNote", "AV-T", organizationId, "0005"),
    ).toBe(true);
    const counter = await DocumentCounter.findOne({ prefix: "AV-T" }).lean();
    expect(counter.lastNumber).toBe(4);
  });
});
