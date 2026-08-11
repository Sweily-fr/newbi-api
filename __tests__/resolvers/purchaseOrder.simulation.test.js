/**
 * Banc de simulation de la numérotation des bons de commande.
 *
 * Contrairement aux autres fichiers de test, celui-ci démarre un replica set
 * en mémoire : les transitions DRAFT → CONFIRMED de `changePurchaseOrderStatus`
 * utilisent une transaction MongoDB, impossible à exécuter sur un mongod
 * standalone. Cela permet de rejouer les enchaînements réels de l'application
 * (créer, repasser en brouillon, créer, valider un brouillon, convertir un
 * devis…) et de vérifier après CHAQUE étape que la numérotation reste saine.
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
} from "../helpers/numberingSimulation.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));

import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import Quote from "../../src/models/Quote.js";
import purchaseOrderResolvers from "../../src/resolvers/purchaseOrder.js";

const create = purchaseOrderResolvers.Mutation.createPurchaseOrder;
const update = purchaseOrderResolvers.Mutation.updatePurchaseOrder;
const changeStatus = purchaseOrderResolvers.Mutation.changePurchaseOrderStatus;
const convertQuote =
  purchaseOrderResolvers.Mutation.convertQuoteToPurchaseOrder;
const nextNumber = purchaseOrderResolvers.Query.nextPurchaseOrderNumber;

const userId = buildUserId();
const organizationId = buildOrganizationId();
const PREFIX = "BC-SIM";

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("sim_po");
  // Sans ça, l'index unique (prefix + number + workspaceId + issueYear) est
  // construit de façon asynchrone et les premières simulations tournent sans
  // contrainte d'unicité : le banc ne prouverait plus rien.
  await ensureIndexes(
    PurchaseOrder,
    "po_prefix_number_workspaceId_year_unique",
  );
  await Quote.init();
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  invalidateOrgCache();
  await resetWorkspace({ userId, organizationId });
});

const ctx = () => buildContext({ userId, organizationId });

function buildPOInput(overrides = {}) {
  return {
    items: [
      { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
    ],
    client: {
      name: "Fournisseur Test",
      email: "fournisseur@test.fr",
      address: {
        street: "10 avenue Fournisseur",
        city: "Lyon",
        postalCode: "69001",
        country: "France",
      },
    },
    issueDate: new Date().toISOString(),
    ...overrides,
  };
}

const NUMBER_VALIDATOR = /^[A-Za-z0-9-]{1,20}$/;

/**
 * Invariants attendus à tout moment, quel que soit l'enchaînement :
 *  1. aucun doublon de numéro parmi les documents finalisés d'un même préfixe
 *  2. la séquence finalisée est continue (1, 2, 3… sans trou)
 *  3. tout numéro persisté respecte le validateur du modèle (≤ 20 caractères)
 *  4. un brouillon ne porte jamais un numéro définitif encore libre dans la
 *     séquence sans être renommé (vérifié indirectement par 1 et 2)
 */
async function assertInvariants(label) {
  const all = await PurchaseOrder.find({ workspaceId: organizationId }).lean();

  for (const po of all) {
    expect(
      NUMBER_VALIDATOR.test(po.number),
      `${label}: numéro invalide "${po.number}" (${po.status})`,
    ).toBe(true);
  }

  const finalized = all.filter((po) => po.status !== "DRAFT");
  const byPrefix = new Map();
  for (const po of finalized) {
    const key = `${po.prefix}|${po.issueYear}`;
    if (!byPrefix.has(key)) byPrefix.set(key, []);
    byPrefix.get(key).push(po.number);
  }

  for (const [key, numbers] of byPrefix) {
    const unique = new Set(numbers);
    expect(
      unique.size,
      `${label}: doublon de numéro finalisé sur ${key} (${numbers.join(", ")})`,
    ).toBe(numbers.length);

    const numeric = numbers
      .filter((n) => /^\d+$/.test(n))
      .map((n) => parseInt(n, 10))
      .sort((a, b) => a - b);
    if (numeric.length > 0) {
      const expectedSequence = Array.from(
        { length: numeric.length },
        (_, i) => i + 1,
      );
      expect(numeric, `${label}: trou dans la séquence de ${key}`).toEqual(
        expectedSequence,
      );
    }
  }

  return all;
}

/**
 * Version relâchée pour le fuzz : on n'exige PAS la continuité de la séquence,
 * parce que repasser en brouillon un BC qui n'est pas le dernier laisse un trou
 * par construction (son numéro sort des finalisés). Restent les invariants durs :
 * unicité des numéros finalisés et respect du validateur du modèle.
 */
async function assertInvariantsLoose(label, journal = []) {
  const all = await PurchaseOrder.find({ workspaceId: organizationId }).lean();
  const context = journal.length ? `\nJournal :\n${journal.join("\n")}` : "";

  for (const po of all) {
    expect(
      NUMBER_VALIDATOR.test(po.number),
      `${label}: numéro invalide "${po.number}" (${po.status})${context}`,
    ).toBe(true);
  }

  const finalized = all
    .filter((po) => po.status !== "DRAFT")
    .map((po) => `${po.prefix}|${po.issueYear}|${po.number}`);
  expect(
    new Set(finalized).size,
    `${label}: doublon parmi les numéros finalisés${context}`,
  ).toBe(finalized.length);

  return all;
}

// Ce que fait l'éditeur : il demande le prochain numéro puis l'envoie tel quel.
const proposedNumber = () =>
  nextNumber(null, { prefix: PREFIX, autoNumbering: false }, ctx());

const createConfirmed = async (number, overrides = {}) =>
  create(
    null,
    {
      input: buildPOInput({
        prefix: PREFIX,
        number,
        status: "CONFIRMED",
        ...overrides,
      }),
    },
    ctx(),
  );

const createDraft = async (overrides = {}) =>
  create(
    null,
    { input: buildPOInput({ prefix: PREFIX, ...overrides }) },
    ctx(),
  );

describe("Simulation numérotation BC — enchaînements réels", () => {
  // Documente un comportement PRÉEXISTANT, indépendant du renommage des
  // brouillons : repasser en brouillon un BC qui n'est pas le dernier sort son
  // numéro de la séquence finalisée et y laisse un trou définitif, puisque le
  // prochain numéro proposé reste max+1. Test de constat, pas de validation.
  it("constat : repasser en brouillon un BC intermédiaire laisse un trou dans la séquence", async () => {
    const po1 = await createConfirmed("0001");
    const po2 = await createConfirmed("0002");
    await createConfirmed("0003");

    await changeStatus(
      null,
      { id: po2._id.toString(), status: "DRAFT" },
      ctx(),
    );

    const finalized = await PurchaseOrder.find({
      workspaceId: organizationId,
      status: { $ne: "DRAFT" },
    })
      .sort({ number: 1 })
      .lean();
    expect(finalized.map((p) => p.number)).toEqual(["0001", "0003"]);

    // Le numéro proposé reste max+1 : 0002 ne sera pas réattribué
    expect(await proposedNumber()).toBe("0004");

    // Et en revalidant l'ancien 0002, il prend 0004, pas son numéro d'origine
    const revalidated = await changeStatus(
      null,
      { id: po2._id.toString(), status: "CONFIRMED" },
      ctx(),
    );
    expect(revalidated.number).toBe("0004");
    expect(po1.number).toBe("0001");
  });

  it("scénario utilisateur : créer, repasser en brouillon, recréer, puis valider le brouillon", async () => {
    // 1. Création d'un BC finalisé avec le numéro proposé par l'éditeur
    const first = await createConfirmed(await proposedNumber());
    expect(first.number).toBe("0001");
    await assertInvariants("après création 0001");

    // 2. L'utilisateur le repasse en brouillon (le numéro reste sur le brouillon)
    const reverted = await changeStatus(
      null,
      { id: first._id.toString(), status: "DRAFT" },
      ctx(),
    );
    expect(reverted.status).toBe("DRAFT");
    await assertInvariants("après retour en brouillon");

    // 3. Nouveau BC : l'éditeur propose 0001, qui est squatté par le brouillon
    expect(await proposedNumber()).toBe("0001");
    const second = await createConfirmed("0001");
    expect(second.number).toBe("0001");
    await assertInvariants("après recréation sur 0001");

    // Le brouillon a été renommé et reste éditable
    const renamed = await PurchaseOrder.findById(first._id);
    expect(renamed.status).toBe("DRAFT");
    expect(renamed.number).not.toBe("0001");
    renamed.headerNotes = "toujours éditable";
    await expect(renamed.save()).resolves.toBeDefined();

    // 4. L'utilisateur valide finalement l'ancien brouillon → numéro suivant
    const revalidated = await changeStatus(
      null,
      { id: first._id.toString(), status: "CONFIRMED" },
      ctx(),
    );
    expect(revalidated.status).toBe("CONFIRMED");
    expect(revalidated.number).toBe("0002");
    await assertInvariants("après validation du brouillon");
  });

  it("valide un brouillon PENDANT qu'un autre brouillon squatte le numéro", async () => {
    const confirmed = await createConfirmed(await proposedNumber());
    await changeStatus(
      null,
      { id: confirmed._id.toString(), status: "DRAFT" },
      ctx(),
    );

    // Un second brouillon, créé normalement (numéro provisoire DRAFT-xxx)
    const draft = await createDraft();
    expect(draft.number).toMatch(/^DRAFT-/);

    // On valide ce second brouillon : il doit prendre 0001 (libre dans la
    // séquence) et déloger le brouillon squatteur, sans laisser de trou.
    const validated = await changeStatus(
      null,
      { id: draft._id.toString(), status: "CONFIRMED" },
      ctx(),
    );
    expect(validated.number).toBe("0001");
    await assertInvariants("après validation avec squatteur");

    // Puis on valide le squatteur à son tour
    const second = await changeStatus(
      null,
      { id: confirmed._id.toString(), status: "CONFIRMED" },
      ctx(),
    );
    expect(second.number).toBe("0002");
    await assertInvariants("après validation du squatteur");
  });

  it("finalise depuis l'éditeur (updatePurchaseOrder) avec et sans numéro fourni", async () => {
    const confirmed = await createConfirmed(await proposedNumber());
    await changeStatus(
      null,
      { id: confirmed._id.toString(), status: "DRAFT" },
      ctx(),
    );

    // Finalisation SANS numéro (branche auto de updatePurchaseOrder)
    const draftA = await createDraft();
    const finalizedA = await update(
      null,
      { id: draftA._id.toString(), input: { status: "CONFIRMED" } },
      ctx(),
    );
    expect(finalizedA.number).toBe("0001");
    await assertInvariants("après finalisation auto");

    // Finalisation AVEC le numéro proposé par l'éditeur
    const draftB = await createDraft();
    const proposed = await proposedNumber();
    expect(proposed).toBe("0002");
    const finalizedB = await update(
      null,
      {
        id: draftB._id.toString(),
        input: { status: "CONFIRMED", number: proposed, prefix: PREFIX },
      },
      ctx(),
    );
    expect(finalizedB.number).toBe("0002");
    await assertInvariants("après finalisation avec numéro");
  });

  it("enchaîne 12 cycles création / retour brouillon / revalidation sans casser la séquence", async () => {
    const parkedDrafts = [];

    for (let i = 0; i < 12; i++) {
      const po = await createConfirmed(await proposedNumber());

      // Un cycle sur trois : on repasse le BC en brouillon (il garde son numéro)
      if (i % 3 === 0) {
        await changeStatus(
          null,
          { id: po._id.toString(), status: "DRAFT" },
          ctx(),
        );
        parkedDrafts.push(po._id);
      }
      await assertInvariants(`cycle ${i}`);
    }

    // On revalide tous les brouillons mis de côté
    for (const id of parkedDrafts) {
      const revalidated = await changeStatus(
        null,
        { id: id.toString(), status: "CONFIRMED" },
        ctx(),
      );
      expect(revalidated.status).toBe("CONFIRMED");
      await assertInvariants(`revalidation ${id}`);
    }

    const finalized = await PurchaseOrder.find({
      workspaceId: organizationId,
      status: { $ne: "DRAFT" },
    }).lean();
    expect(finalized).toHaveLength(12);
  });

  it("deux créations concurrentes sur le même numéro : une seule passe, pas de doublon", async () => {
    await createConfirmed(await proposedNumber());
    const proposed = await proposedNumber();
    expect(proposed).toBe("0002");

    const results = await Promise.allSettled([
      createConfirmed(proposed),
      createConfirmed(proposed),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    // Erreur applicative lisible, pas une MongoServerError brute
    expect(rejected.reason.message).toMatch(/déjà utilisé|séquence|numéro/i);
    await assertInvariants("après création concurrente");
  });

  it("conversion d'un devis en BC pendant qu'un brouillon squatte le numéro", async () => {
    const now = new Date();
    const convertPrefix = `BC-${now.getFullYear()}${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}`;

    // Un BC finalisé sur le préfixe de conversion, repassé en brouillon
    const confirmed = await create(
      null,
      {
        input: buildPOInput({
          prefix: convertPrefix,
          number: "0001",
          status: "CONFIRMED",
        }),
      },
      ctx(),
    );
    await changeStatus(
      null,
      { id: confirmed._id.toString(), status: "DRAFT" },
      ctx(),
    );

    const quoteId = new mongoose.Types.ObjectId();
    await Quote.collection.insertOne({
      _id: quoteId,
      workspaceId: organizationId,
      createdBy: userId,
      number: "0100",
      prefix: "D-SIM",
      status: "COMPLETED",
      items: [
        { description: "Widget", quantity: 2, unitPrice: 500, vatRate: 20 },
      ],
      client: {
        name: "Client Test",
        email: "c@test.fr",
        address: {
          street: "1 rue Test",
          city: "Paris",
          postalCode: "75001",
          country: "France",
        },
      },
      issueDate: new Date(),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdAt: new Date(),
      finalTotalTTC: 1200,
    });

    const converted = await convertQuote(null, { quoteId }, ctx());
    expect(converted.status).toBe("CONFIRMED");
    expect(converted.number).toBe("0001");
    await assertInvariants("après conversion devis");
  });

  it("préfixes différents : les séquences restent indépendantes", async () => {
    const other = "BC-AUTRE";

    const a1 = await createConfirmed("0001");
    const b1 = await create(
      null,
      {
        input: buildPOInput({
          prefix: other,
          number: "0001",
          status: "CONFIRMED",
        }),
      },
      ctx(),
    );
    expect(a1.number).toBe("0001");
    expect(b1.number).toBe("0001");

    // Retour en brouillon du BC de l'autre préfixe
    await changeStatus(null, { id: b1._id.toString(), status: "DRAFT" }, ctx());

    // Créer sur le premier préfixe ne doit pas toucher au brouillon de l'autre
    const a2 = await createConfirmed("0002");
    expect(a2.number).toBe("0002");

    const untouched = await PurchaseOrder.findById(b1._id);
    expect(untouched.number).toBe("0001");
    await assertInvariants("après préfixes croisés");
  });

  it("trois BC repassés en brouillon d'affilée : les trois numéros sont réattribués", async () => {
    // 0001, 0002, 0003 finalisés puis tous repassés en brouillon : chacun
    // squatte son numéro, invisible pour la séquence qui redémarre à 0001.
    const parked = [];
    for (const n of ["0001", "0002", "0003"]) {
      const po = await createConfirmed(n);
      await changeStatus(
        null,
        { id: po._id.toString(), status: "DRAFT" },
        ctx(),
      );
      parked.push(po._id);
    }
    expect(await proposedNumber()).toBe("0001");

    // Trois nouvelles créations consécutives doivent déloger les trois squatteurs
    for (const expected of ["0001", "0002", "0003"]) {
      expect(await proposedNumber()).toBe(expected);
      const created = await createConfirmed(expected);
      expect(created.number).toBe(expected);
      await assertInvariants(`après recréation ${expected}`);
    }

    const renamed = await PurchaseOrder.find({ _id: { $in: parked } }).lean();
    expect(renamed).toHaveLength(3);
    const renamedNumbers = renamed.map((d) => d.number);
    expect(new Set(renamedNumbers).size).toBe(3);
    for (const n of renamedNumbers) {
      expect(n).toMatch(/^\d{4}-\d+$/);
      expect(n.length).toBeLessThanOrEqual(20);
    }

    // Les trois brouillons renommés restent revalidables
    for (const id of parked) {
      await changeStatus(
        null,
        { id: id.toString(), status: "CONFIRMED" },
        ctx(),
      );
      await assertInvariants(`revalidation ${id}`);
    }
    const finalized = await PurchaseOrder.countDocuments({
      workspaceId: organizationId,
      status: { $ne: "DRAFT" },
    });
    expect(finalized).toBe(6);
  });

  it("séquence continue (autoNumbering) : le retour en brouillon ne bloque aucun préfixe", async () => {
    await mongoose.connection.db
      .collection("organization")
      .updateOne(
        { _id: organizationId },
        { $set: { purchaseOrderAutoNumbering: true } },
      );
    invalidateOrgCache();

    const nextGlobal = () =>
      nextNumber(null, { prefix: PREFIX, autoNumbering: true }, ctx());
    const createOn = (prefix, number) =>
      create(
        null,
        { input: buildPOInput({ prefix, number, status: "CONFIRMED" }) },
        ctx(),
      );

    const a1 = await createOn(PREFIX, await nextGlobal());
    expect(a1.number).toBe("0001");

    // La séquence est globale : le préfixe suivant continue à 0002
    const b1 = await createOn("BC-AUTRE", await nextGlobal());
    expect(b1.number).toBe("0002");

    // Retour en brouillon du 0001, puis recréation sur le même préfixe
    await changeStatus(null, { id: a1._id.toString(), status: "DRAFT" }, ctx());
    expect(await nextGlobal()).toBe("0003");
    const a2 = await createOn(PREFIX, "0003");
    expect(a2.number).toBe("0003");

    // Le brouillon garé n'a pas été renommé : son numéro n'entrait en conflit
    // avec personne (0001 ≠ 0003)
    const parked = await PurchaseOrder.findById(a1._id);
    expect(parked.number).toBe("0001");

    // Et sa revalidation prend bien le prochain numéro global
    const revalidated = await changeStatus(
      null,
      { id: a1._id.toString(), status: "CONFIRMED" },
      ctx(),
    );
    expect(revalidated.number).toBe("0004");
    await assertInvariantsLoose("après séquence continue");
  });

  it("un brouillon renommé peut être revalidé et prend le numéro suivant", async () => {
    const first = await createConfirmed("0001");
    await changeStatus(
      null,
      { id: first._id.toString(), status: "DRAFT" },
      ctx(),
    );
    await createConfirmed("0001");

    const revalidated = await changeStatus(
      null,
      { id: first._id.toString(), status: "CONFIRMED" },
      ctx(),
    );
    expect(revalidated.number).toBe("0002");

    // Et on peut encore créer derrière, sans collision
    expect(await proposedNumber()).toBe("0003");
    const third = await createConfirmed("0003");
    expect(third.number).toBe("0003");
    await assertInvariants("après revalidation puis création");
  });
});

// ---------------------------------------------------------------------------
// Fuzz : 100 enchaînements aléatoires de 25 opérations, invariants vérifiés
// après chaque étape (2 500 opérations au total).
// ---------------------------------------------------------------------------

const adapter = {
  label: "bon de commande",
  model: PurchaseOrder,
  numberValidator: /^[A-Za-z0-9-]{1,20}$/,
  draftStatus: "DRAFT",
  finalizedStatus: "CONFIRMED",
  nextNumber: (context) =>
    nextNumber(null, { prefix: PREFIX, autoNumbering: false }, context),
  createFinalized: (number, context) =>
    create(
      null,
      {
        input: buildPOInput({ prefix: PREFIX, number, status: "CONFIRMED" }),
      },
      context,
    ),
  createDraft: (context) =>
    create(null, { input: buildPOInput({ prefix: PREFIX }) }, context),
  finalizeViaStatus: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "CONFIRMED" }, context),
  finalizeViaUpdate: (id, number, context) =>
    update(
      null,
      {
        id: id.toString(),
        input: number
          ? { status: "CONFIRMED", number, prefix: PREFIX }
          : { status: "CONFIRMED" },
      },
      context,
    ),
  revertToDraft: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "DRAFT" }, context),
  cancel: (id, context) =>
    changeStatus(null, { id: id.toString(), status: "CANCELED" }, context),
};

const SEEDS = Array.from({ length: 100 }, (_, i) => 1000 + i * 7919);

describe("Simulation numérotation BC — fuzz", () => {
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
      // Le tirage doit réellement exercer les résolveurs, pas enchaîner des skips
      const executed = journal.filter((l) => !l.includes("skip")).length;
      expect(executed).toBeGreaterThanOrEqual(20);
    },
  );
});
