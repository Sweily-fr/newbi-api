/**
 * Banc de simulation de la numérotation des factures.
 *
 * Même harnais que les bons de commande et les devis (replica set en mémoire,
 * invariants vérifiés après chaque étape). Particularité facture : le retour
 * arrière PENDING → DRAFT est interdit, l'opération correspondante est donc
 * absente de l'adaptateur.
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

import { buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  startReplicaSet,
  ensureIndexes,
  resetWorkspace,
  runNumberingFuzz,
  assertNumberingInvariants,
  buildClient,
} from "../helpers/numberingSimulation.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

// Effets de bord hors sujet pour la numérotation
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { sendInvoice: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { getSettings: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../../src/utils/eInvoiceRoutingHelper.js", () => ({
  evaluateAndRouteInvoice: vi.fn().mockResolvedValue(undefined),
  reportPaymentIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  autoPushEventToConnections: vi.fn().mockResolvedValue(undefined),
  updateEventInExternalCalendars: vi.fn().mockResolvedValue(undefined),
  deleteEventFromExternalCalendars: vi.fn().mockResolvedValue(undefined),
  pushEventToCalendar: vi.fn().mockResolvedValue(undefined),
  syncConnection: vi.fn().mockResolvedValue(undefined),
  syncAllForUser: vi.fn().mockResolvedValue(undefined),
  disconnectCalendar: vi.fn().mockResolvedValue(undefined),
}));

import Invoice from "../../src/models/Invoice.js";
import invoiceResolvers from "../../src/resolvers/invoice.js";

const create = invoiceResolvers.Mutation.createInvoice;
const update = invoiceResolvers.Mutation.updateInvoice;
const changeStatus = invoiceResolvers.Mutation.changeInvoiceStatus;
const nextNumber = invoiceResolvers.Query.nextInvoiceNumber;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const clientId = new mongoose.Types.ObjectId();
const PREFIX = "F-SIM";

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("sim_invoice");
  await ensureIndexes(Invoice, "prefix_number_workspaceId_year_unique");
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  invalidateOrgCache();
  await resetWorkspace({ userId, organizationId });
  // Client existant : sans id, createInvoice refuse un second document portant
  // la même adresse email.
  await mongoose.connection.db.collection("clients").insertOne({
    _id: clientId,
    workspaceId: organizationId,
    createdBy: userId,
    type: "COMPANY",
    ...buildClient(),
    createdAt: new Date(),
  });
  // L'utilisateur est lu pour ses préférences de préfixe (settings)
  await mongoose.connection.db
    .collection("users")
    .updateOne(
      { _id: userId },
      { $setOnInsert: { _id: userId, email: "test@test.com" } },
      { upsert: true },
    );
});

const ctx = () => buildContext({ userId, organizationId });

function buildInvoiceInput(overrides = {}) {
  const now = new Date();
  return {
    items: [
      { description: "Prestation", quantity: 2, unitPrice: 500, vatRate: 20 },
    ],
    client: { id: clientId.toString(), type: "COMPANY", ...buildClient() },
    issueDate: now.toISOString(),
    dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const adapter = {
  label: "facture",
  model: Invoice,
  // Le modèle facture tolère 50 caractères (contre 20 pour BC et devis)
  numberValidator: /^[A-Za-z0-9-]{1,50}$/,
  draftStatus: "DRAFT",
  finalizedStatus: "PENDING",
  nextNumber: (context) =>
    nextNumber(
      null,
      { prefix: PREFIX, isDraft: false, autoNumbering: false },
      context,
    ),
  createFinalized: (number, context) =>
    create(
      null,
      {
        input: buildInvoiceInput({ prefix: PREFIX, number, status: "PENDING" }),
      },
      context,
    ),
  createDraft: (context) =>
    create(
      null,
      { input: buildInvoiceInput({ prefix: PREFIX, status: "DRAFT" }) },
      context,
    ),
  finalizeViaStatus: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "PENDING" }, context),
  finalizeViaUpdate: (id, number, context) =>
    update(
      null,
      {
        id: id.toString(),
        input: number
          ? { status: "PENDING", number, prefix: PREFIX }
          : { status: "PENDING" },
      },
      context,
    ),
  // La facture réserve son numéro dès la création du brouillon
  // (`DRAFT-0002` → `0002`) : à la finalisation, le numéro envoyé par
  // l'éditeur est ignoré au profit du numéro réservé. Voir le scénario
  // « réserve son numéro dès le brouillon » plus bas.
  finalizeKeepsReservedNumber: true,
  // Pas de revertToDraft : la facture interdit PENDING → DRAFT
  cancel: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "CANCELED" }, context),
};

const proposedNumber = () => adapter.nextNumber(ctx());
const createFinalized = (number) => adapter.createFinalized(number, ctx());
const createDraft = () => adapter.createDraft(ctx());
const invariants = (label) =>
  assertNumberingInvariants({ adapter, organizationId, label });

describe("Simulation numérotation factures — enchaînements réels", () => {
  it("le retour arrière PENDING → DRAFT reste interdit", async () => {
    const invoice = await createFinalized(await proposedNumber());
    await expect(
      changeStatus(
        null,
        { id: invoice._id.toString(), status: "DRAFT" },
        ctx(),
      ),
    ).rejects.toThrow();
    await invariants("après tentative de rétrogradation");
  });

  it("crée une facture finalisée sur un numéro occupé par un brouillon legacy", async () => {
    // Brouillon portant un numéro définitif (données legacy) : invisible pour
    // la numérotation mais présent dans l'index unique.
    const { insertedId } = await Invoice.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: PREFIX,
      status: "DRAFT",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { id: clientId, type: "COMPANY", ...buildClient() },
      issueDate: new Date(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      issueYear: new Date().getFullYear(),
      createdAt: new Date(),
    });

    expect(await proposedNumber()).toBe("0001");
    const created = await createFinalized("0001");
    expect(created.number).toBe("0001");

    const renamed = await Invoice.findById(insertedId);
    expect(renamed.status).toBe("DRAFT");
    expect(renamed.number).not.toBe("0001");
    await invariants("après création sur numéro squatté");
  });

  it("finalise depuis l'éditeur avec et sans numéro fourni", async () => {
    const draftA = await createDraft();
    const a = await update(
      null,
      { id: draftA._id.toString(), input: { status: "PENDING" } },
      ctx(),
    );
    expect(a.status).toBe("PENDING");
    expect(a.number).toBe("0001");
    await invariants("après finalisation auto");

    const draftB = await createDraft();
    const proposed = await proposedNumber();
    expect(proposed).toBe("0002");
    const b = await update(
      null,
      {
        id: draftB._id.toString(),
        input: { status: "PENDING", number: proposed, prefix: PREFIX },
      },
      ctx(),
    );
    expect(b.number).toBe("0002");
    await invariants("après finalisation avec numéro");
  });

  it("valide des brouillons en série sans trou ni doublon", async () => {
    const drafts = [];
    for (let i = 0; i < 5; i++) drafts.push(await createDraft());

    const numbers = [];
    for (const draft of drafts) {
      const validated = await changeStatus(
        null,
        { id: draft._id.toString(), status: "PENDING" },
        ctx(),
      );
      numbers.push(validated.number);
      await invariants(`validation ${validated.number}`);
    }

    expect(numbers).toEqual(["0001", "0002", "0003", "0004", "0005"]);
  });

  // Constat : contrairement au devis et au bon de commande (numéro provisoire
  // DRAFT-<timestamp>, hors séquence), la facture RÉSERVE un numéro
  // séquentiel dès la création du brouillon (DRAFT-0001, DRAFT-0002…). Deux
  // conséquences visibles ici :
  //  - le numéro envoyé par l'éditeur à la finalisation est ignoré au profit
  //    du numéro réservé ;
  //  - `nextInvoiceNumber` (hors brouillon) annonce max+1 parmi les factures
  //    finalisées, donc pas forcément le numéro qui sera réellement attribué.
  // Un brouillon abandonné ou supprimé laisse alors un trou définitif dans la
  // séquence, ce que l'article 242 nonies A du CGI n'admet pas.
  it("constat : la facture réserve son numéro dès le brouillon", async () => {
    const draftA = await createDraft();
    const draftB = await createDraft();
    expect(draftA.number).toBe("DRAFT-0001");
    expect(draftB.number).toBe("DRAFT-0002");

    // L'éditeur propose 0001 (aucune facture finalisée)
    expect(await proposedNumber()).toBe("0001");

    // Mais finaliser le SECOND brouillon donne 0002, pas 0001
    const finalized = await update(
      null,
      {
        id: draftB._id.toString(),
        input: { status: "PENDING", number: "0001", prefix: PREFIX },
      },
      ctx(),
    );
    expect(finalized.number).toBe("0002");

    // La séquence finalisée démarre donc à 0002 : 0001 reste réservé au
    // brouillon A et sera perdu si celui-ci est supprimé.
    const numbers = await Invoice.find({
      workspaceId: organizationId,
      status: { $ne: "DRAFT" },
    }).lean();
    expect(numbers.map((i) => i.number)).toEqual(["0002"]);
    await invariants("après finalisation du second brouillon");
  });

  it("deux créations concurrentes sur le même numéro : une seule passe", async () => {
    await createFinalized(await proposedNumber());
    const proposed = await proposedNumber();

    const results = await Promise.allSettled([
      createFinalized(proposed),
      createFinalized(proposed),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await invariants("après création concurrente");
  });
});

// ---------------------------------------------------------------------------
// Fuzz : 100 enchaînements aléatoires de 25 opérations
// ---------------------------------------------------------------------------

const SEEDS = Array.from({ length: 100 }, (_, i) => 3000 + i * 5779);

describe("Simulation numérotation factures — fuzz", () => {
  it.each(SEEDS)(
    "graine %i : 25 opérations aléatoires sans casse de numérotation",
    async (seed) => {
      const journal = await runNumberingFuzz({
        adapter,
        seed,
        steps: 25,
        organizationId,
        ctx: ctx(),
      });
      const executed = journal.filter((l) => !l.includes("skip")).length;
      expect(executed).toBeGreaterThanOrEqual(20);
    },
  );
});
