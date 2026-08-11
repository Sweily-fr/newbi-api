/**
 * Banc de simulation de la numérotation des devis.
 *
 * Même harnais que les bons de commande (replica set en mémoire pour les
 * transactions de finalisation, invariants vérifiés après chaque étape) :
 * les trois documents partagent la même mécanique de numérotation, donc les
 * mêmes pièges. Voir __tests__/helpers/numberingSimulation.js.
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
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
    sendQuoteCreatedNotification: vi.fn().mockResolvedValue(undefined),
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncQuoteIfNeeded: vi.fn().mockResolvedValue(undefined),
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import Quote from "../../src/models/Quote.js";
import quoteResolvers from "../../src/resolvers/quote.js";

const create = quoteResolvers.Mutation.createQuote;
const update = quoteResolvers.Mutation.updateQuote;
const changeStatus = quoteResolvers.Mutation.changeQuoteStatus;
const nextNumber = quoteResolvers.Query.nextQuoteNumber;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const clientId = new mongoose.Types.ObjectId();
const PREFIX = "D-SIM";

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("sim_quote");
  await ensureIndexes(Quote, "prefix_number_workspaceId_year_unique");
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  invalidateOrgCache();
  await resetWorkspace({ userId, organizationId });
  // Client existant : sans id, createQuote refuse un second document portant
  // la même adresse email ("un client avec cet email existe déjà").
  await mongoose.connection.db.collection("clients").insertOne({
    _id: clientId,
    workspaceId: organizationId,
    createdBy: userId,
    type: "COMPANY",
    ...buildClient(),
    createdAt: new Date(),
  });
});

const ctx = () => buildContext({ userId, organizationId });

function buildQuoteInput(overrides = {}) {
  return {
    items: [
      { description: "Prestation", quantity: 2, unitPrice: 500, vatRate: 20 },
    ],
    client: { id: clientId.toString(), type: "COMPANY", ...buildClient() },
    issueDate: new Date().toISOString(),
    ...overrides,
  };
}

const adapter = {
  label: "devis",
  model: Quote,
  numberValidator: /^[A-Za-z0-9-]{1,20}$/,
  draftStatus: "DRAFT",
  finalizedStatus: "PENDING",
  nextNumber: (context) =>
    nextNumber(null, { prefix: PREFIX, autoNumbering: false }, context),
  createFinalized: (number, context) =>
    create(
      null,
      { input: buildQuoteInput({ prefix: PREFIX, number, status: "PENDING" }) },
      context,
    ),
  // `status` est explicite, comme le fait le schéma GraphQL
  // (CreateQuoteInput.status = DRAFT) : on appelle ici le résolveur en direct,
  // sans la couche qui applique ce défaut.
  createDraft: (context) =>
    create(
      null,
      { input: buildQuoteInput({ prefix: PREFIX, status: "DRAFT" }) },
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
  revertToDraft: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "DRAFT" }, context),
  cancel: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "CANCELED" }, context),
};

const proposedNumber = () => adapter.nextNumber(ctx());
const createFinalized = (number) => adapter.createFinalized(number, ctx());
const createDraft = () => adapter.createDraft(ctx());
const invariants = (label) =>
  assertNumberingInvariants({ adapter, organizationId, label });

describe("Simulation numérotation devis — enchaînements réels", () => {
  it("scénario utilisateur : créer, repasser en brouillon, recréer, puis valider le brouillon", async () => {
    const first = await createFinalized(await proposedNumber());
    expect(first.number).toBe("0001");

    const reverted = await changeStatus(
      null,
      { id: first._id.toString(), status: "DRAFT" },
      ctx(),
    );
    expect(reverted.status).toBe("DRAFT");

    // Le numéro proposé repasse à 0001, squatté par le brouillon
    expect(await proposedNumber()).toBe("0001");
    const second = await createFinalized("0001");
    expect(second.number).toBe("0001");
    await invariants("après recréation sur 0001");

    const renamed = await Quote.findById(first._id);
    expect(renamed.status).toBe("DRAFT");
    expect(renamed.number).not.toBe("0001");
    renamed.headerNotes = "toujours éditable";
    await expect(renamed.save()).resolves.toBeDefined();

    const revalidated = await changeStatus(
      null,
      { id: first._id.toString(), status: "PENDING" },
      ctx(),
    );
    expect(revalidated.number).toBe("0002");
    await invariants("après revalidation");

    // Le devis qui portait 0001 doit être resté finalisé : l'ancien code le
    // rétrogradait silencieusement en brouillon pour lui reprendre son numéro.
    const stillFinalized = await Quote.findById(second._id);
    expect(stillFinalized.status).toBe("PENDING");
    expect(stillFinalized.number).toBe("0001");
  });

  it("ne rétrograde jamais un devis finalisé pour lui reprendre son numéro", async () => {
    // Cas atteignable : l'index unique porte sur préfixe + numéro + ANNÉE,
    // alors que la recherche de doublon de la numérotation ignore l'année. Un
    // brouillon de l'an dernier portant 0001 coexiste donc légalement avec un
    // devis finalisé 0001 de cette année. En le validant, l'ancien code
    // rétrogradait le devis finalisé en brouillon pour lui prendre son numéro.
    const lastYear = new Date().getFullYear() - 1;
    const current = await createFinalized("0001");
    expect(current.number).toBe("0001");

    // Brouillon de l'an dernier inséré tel quel : c'est l'état d'un devis
    // repassé en brouillon l'an dernier, resté de côté pendant que la séquence
    // de cette année avançait.
    const { insertedId: oldDraftId } = await Quote.collection.insertOne({
      workspaceId: organizationId,
      createdBy: userId,
      number: "0001",
      prefix: PREFIX,
      status: "DRAFT",
      items: [{ description: "X", quantity: 1, unitPrice: 100, vatRate: 20 }],
      client: { id: clientId, type: "COMPANY", ...buildClient() },
      issueDate: new Date(`${lastYear}-06-15T10:00:00.000Z`),
      validUntil: new Date(`${lastYear}-07-15T10:00:00.000Z`),
      issueYear: lastYear,
      createdAt: new Date(`${lastYear}-06-15T10:00:00.000Z`),
    });

    const revalidated = await changeStatus(
      null,
      { id: oldDraftId.toString(), status: "PENDING" },
      ctx(),
    );

    // Le brouillon de l'an dernier prend le numéro suivant…
    expect(revalidated.number).toBe("0002");
    // …et le devis finalisé n'a pas bougé
    const untouched = await Quote.findById(current._id);
    expect(untouched.status).toBe("PENDING");
    expect(untouched.number).toBe("0001");
    await invariants("après validation d'un brouillon de l'an dernier");
  });

  it("conserve le préfixe du brouillon à la validation", async () => {
    // Aucun devis finalisé : l'ancien code retombait sur D-<mois><année> et
    // faisait perdre le préfixe personnalisé du brouillon.
    const draft = await createDraft();
    expect(draft.prefix).toBe(PREFIX);

    const validated = await changeStatus(
      null,
      { id: draft._id.toString(), status: "PENDING" },
      ctx(),
    );
    expect(validated.prefix).toBe(PREFIX);
    expect(validated.number).toBe("0001");

    // Même exigence sur la finalisation depuis l'éditeur, branche sans numéro
    const draftB = await createDraft();
    const finalizedB = await update(
      null,
      { id: draftB._id.toString(), input: { status: "PENDING" } },
      ctx(),
    );
    expect(finalizedB.prefix).toBe(PREFIX);
    expect(finalizedB.number).toBe("0002");
    await invariants("après validations avec préfixe personnalisé");
  });

  // Non-régression de deux correctifs :
  //  - le préfixe du brouillon est conservé à la validation (il était
  //    reconstruit depuis le dernier devis finalisé et retombait sur
  //    D-<mois><année> quand il n'y en avait aucun) ;
  //  - un devis DÉJÀ FINALISÉ n'est plus rétrogradé en brouillon pour lui
  //    prendre son numéro ; le brouillon validé prend le numéro suivant.
  it("valide un brouillon pendant qu'un autre brouillon squatte le numéro", async () => {
    const finalized = await createFinalized(await proposedNumber());
    await changeStatus(
      null,
      { id: finalized._id.toString(), status: "DRAFT" },
      ctx(),
    );

    const draft = await createDraft();
    expect(draft.number).toMatch(/^DRAFT-/);

    const validated = await changeStatus(
      null,
      { id: draft._id.toString(), status: "PENDING" },
      ctx(),
    );
    expect(validated.number).toBe("0001");
    await invariants("après validation avec squatteur");

    const second = await changeStatus(
      null,
      { id: finalized._id.toString(), status: "PENDING" },
      ctx(),
    );
    expect(second.number).toBe("0002");
    await invariants("après validation du squatteur");
  });

  it("finalise depuis l'éditeur avec et sans numéro fourni", async () => {
    const finalized = await createFinalized(await proposedNumber());
    await changeStatus(
      null,
      { id: finalized._id.toString(), status: "DRAFT" },
      ctx(),
    );

    const draftA = await createDraft();
    const a = await update(
      null,
      { id: draftA._id.toString(), input: { status: "PENDING" } },
      ctx(),
    );
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

  it("enchaîne 10 cycles création / retour brouillon / revalidation", async () => {
    const parked = [];
    for (let i = 0; i < 10; i++) {
      const q = await createFinalized(await proposedNumber());
      if (i % 3 === 0) {
        await changeStatus(
          null,
          { id: q._id.toString(), status: "DRAFT" },
          ctx(),
        );
        parked.push(q._id);
      }
      await invariants(`cycle ${i}`);
    }

    for (const id of parked) {
      const revalidated = await changeStatus(
        null,
        { id: id.toString(), status: "PENDING" },
        ctx(),
      );
      expect(revalidated.status).toBe("PENDING");
      await invariants(`revalidation ${id}`);
    }

    const finalized = await Quote.countDocuments({
      workspaceId: organizationId,
      status: { $ne: "DRAFT" },
    });
    expect(finalized).toBe(10);
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

const SEEDS = Array.from({ length: 100 }, (_, i) => 2000 + i * 6841);

const runFuzz = (seed) =>
  runNumberingFuzz({ adapter, seed, steps: 25, organizationId, ctx: ctx() });

describe("Simulation numérotation devis — fuzz", () => {
  it.each(SEEDS)(
    "graine %i : 25 opérations aléatoires sans casse de numérotation",
    async (seed) => {
      const journal = await runFuzz(seed);
      const executed = journal.filter((l) => !l.includes("skip")).length;
      expect(executed).toBeGreaterThanOrEqual(20);
    },
  );
});
