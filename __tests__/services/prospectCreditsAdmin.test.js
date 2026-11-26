import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId } from "../factories/index.js";

vi.mock(
  "../../src/services/prospects/societeinfoClient.js",
  async (importOriginal) => ({
    ...(await importOriginal()),
    isSocieteinfoConfigured: vi.fn(() => true),
    getKeyInfo: vi.fn(),
  }),
);

vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { sendEmail: vi.fn(async () => ({ id: "test" })) },
}));

import {
  getKeyInfo,
  isSocieteinfoConfigured,
} from "../../src/services/prospects/societeinfoClient.js";
import {
  adjustProspectCredits,
  listProspectCredits,
  splitAdjustment,
  MAX_ADJUSTMENT_INCREASE,
} from "../../src/services/prospects/prospectCreditsAdmin.js";
import {
  getProspectBalance,
  insufficientCreditsError,
  spendSource,
} from "../../src/services/prospects/prospectQuota.js";
import {
  getPurchasedCreditsOwed,
  processProspectOrders,
} from "../../src/services/prospects/prospectOrders.js";
import ProspectCreditAdjustment from "../../src/models/ProspectCreditAdjustment.js";
import ProspectCreditPurchase from "../../src/models/ProspectCreditPurchase.js";
import ProspectCreditUsage from "../../src/models/ProspectCreditUsage.js";

/**
 * Ajustements de crédits de prospection depuis le back-office : l'admin
 * saisit le nouveau solde, on enregistre la différence (jamais d'écrasement),
 * tracée ; le solde ne devient jamais négatif ; le cron des commandes compte
 * les crédits ajoutés comme dus aux clients.
 */

const ADMIN = "admin@newbi.fr";
const MOTIF = "Geste commercial après un souci de génération";
let workspaceId;
let numero = 0;

const db = () => mongoose.connection.db;

async function organisation(id = workspaceId, name = "Menuiserie Dupont") {
  await db()
    .collection("organization")
    .insertOne({ _id: new mongoose.Types.ObjectId(id), name });
}

async function abonnement(plan, status = "active", id = workspaceId) {
  await db()
    .collection("subscription")
    .updateOne(
      { referenceId: id },
      {
        $set: {
          referenceId: id,
          plan,
          status,
          periodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
        },
      },
      { upsert: true },
    );
}

const depense = (credits, source = "plan", extra = {}) =>
  ProspectCreditUsage.create({
    workspaceId,
    kind: "search",
    credits,
    source,
    ...extra,
  });

const achat = (credits, status = "paid", id = workspaceId) => {
  numero += 1;
  return ProspectCreditPurchase.create({
    workspaceId: id,
    credits,
    amountTotal: credits * 30,
    status,
    stripeCheckoutSessionId: `cs_test_admin_${numero}`,
  });
};

const ajuster = (balance, extra = {}) =>
  adjustProspectCredits(
    workspaceId,
    { balance, reason: MOTIF, ...extra },
    ADMIN,
  );

// Le mois suivant, heure de Paris : les crédits du mois repartent
const moisSuivant = () => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + 1, 15);
  return date;
};

beforeAll(async () => {
  await startMongo();
  await ProspectCreditAdjustment.init();
  await ProspectCreditPurchase.init();
  await ProspectCreditUsage.init();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  isSocieteinfoConfigured.mockReturnValue(true);
  process.env.PROSPECT_MONTHLY_CREDIT_CAP = "100";
  workspaceId = buildOrganizationId().toString();
  await organisation();
});

afterEach(() => {
  delete process.env.PROSPECT_MONTHLY_CREDIT_CAP;
  delete process.env.PROSPECTS_ENABLED;
  delete process.env.PROSPECTS_WORKSPACE_IDS;
});

describe("répartition d'un ajustement", () => {
  const solde = (monthly, purchased, extra = {}) => ({
    available: monthly + purchased,
    monthlyRemaining: monthly,
    purchasedRemaining: purchased,
    purchasedTotal: purchased,
    purchasedUsed: 0,
    ...extra,
  });

  it("un ajout va toujours aux crédits sans expiration", () => {
    expect(splitAdjustment(solde(20, 5), 50)).toEqual({
      credits: 25,
      purchasedCredits: 25,
      planCredits: 0,
    });
  });

  it("un retrait prend d'abord les crédits sans expiration, puis ceux du mois", () => {
    expect(splitAdjustment(solde(20, 5), 22)).toEqual({
      credits: -3,
      purchasedCredits: -3,
      planCredits: 0,
    });
    expect(splitAdjustment(solde(20, 5), 10)).toEqual({
      credits: -15,
      purchasedCredits: -5,
      planCredits: -10,
    });
    expect(splitAdjustment(solde(20, 5), 0)).toEqual({
      credits: -25,
      purchasedCredits: -5,
      planCredits: -20,
    });
  });

  it("un solde dépassé est effacé pour arriver exactement au nouveau solde", () => {
    // 2 crédits achetés dépensés de trop (deux dépenses simultanées)
    const depasse = solde(0, 0, { purchasedTotal: 10, purchasedUsed: 12 });
    expect(splitAdjustment(depasse, 5)).toEqual({
      credits: 5,
      purchasedCredits: 7,
      planCredits: 0,
    });
  });
});

describe("ajustement du solde d'un espace", () => {
  it("geste commercial : la différence est enregistrée et tracée, le solde suit", async () => {
    await abonnement("pme");
    await depense(10);
    expect((await getProspectBalance(workspaceId)).available).toBe(20);

    const { adjustment, balance } = await ajuster(50, { expectedBalance: 20 });

    expect(adjustment).toMatchObject({
      workspaceId,
      credits: 30,
      purchasedCredits: 30,
      planCredits: 0,
      balanceBefore: 20,
      balanceAfter: 50,
      reason: MOTIF,
      adminEmail: ADMIN,
    });
    expect(adjustment.createdAt).toBeInstanceOf(Date);
    expect(balance).toMatchObject({
      monthlyCredits: 30,
      monthlyUsed: 10,
      monthlyRemaining: 20,
      purchasedRemaining: 30,
      available: 50,
    });

    // Rien d'autre n'est écrit : ni achat, ni dépense
    expect(await ProspectCreditPurchase.countDocuments()).toBe(0);
    expect(await ProspectCreditUsage.countDocuments()).toBe(1);
    // Journal d'audit du back-office
    const audit = await db()
      .collection("backoffice_audit_log")
      .findOne({ action: "prospect_credits.adjust" });
    expect(audit).toMatchObject({
      adminEmail: ADMIN,
      credits: 30,
      balanceBefore: 20,
      balanceAfter: 50,
      reason: MOTIF,
    });
  });

  it("les crédits ajoutés n'expirent pas et passent après ceux du mois", async () => {
    await abonnement("pme");
    await ajuster(40);

    const balance = await getProspectBalance(workspaceId);
    expect(spendSource(balance)).toBe("plan");
    await depense(30);
    expect(spendSource(await getProspectBalance(workspaceId))).toBe(
      "purchased",
    );

    // Le mois suivant : 30 crédits neufs, les 10 ajoutés sont toujours là
    expect(await getProspectBalance(workspaceId, moisSuivant())).toMatchObject({
      monthlyRemaining: 30,
      purchasedRemaining: 10,
      available: 40,
    });
  });

  it("annuler un geste revient exactement à l'avant, ce mois-ci et les suivants", async () => {
    await abonnement("pme");
    await depense(10);
    await ajuster(70);
    const { adjustment } = await ajuster(20);

    expect(adjustment).toMatchObject({
      credits: -50,
      purchasedCredits: -50,
      planCredits: 0,
    });
    expect((await getProspectBalance(workspaceId)).available).toBe(20);
    expect(await getProspectBalance(workspaceId, moisSuivant())).toMatchObject({
      monthlyRemaining: 30,
      purchasedRemaining: 0,
      available: 30,
    });
  });

  it("un retrait plus grand que les crédits sans expiration prend les crédits du mois, ce mois-ci seulement", async () => {
    await abonnement("entreprise");
    await achat(25);
    await depense(40);
    // 60 du mois + 25 achetés = 85 ; on descend à 30
    const { adjustment, balance } = await ajuster(30);

    expect(adjustment).toMatchObject({
      credits: -55,
      purchasedCredits: -25,
      planCredits: -30,
    });
    expect(balance).toMatchObject({
      monthlyCredits: 70,
      monthlyAdjustment: -30,
      monthlyUsed: 40,
      monthlyRemaining: 30,
      purchasedRemaining: 0,
      available: 30,
    });
    // Le mois suivant, l'offre redonne ses 100 crédits ; les achetés restent retirés
    expect(await getProspectBalance(workspaceId, moisSuivant())).toMatchObject({
      monthlyCredits: 100,
      purchasedRemaining: 0,
      available: 100,
    });
  });

  it("un retrait des crédits du mois borne aussi les dépenses simultanées", async () => {
    await abonnement("pme");
    await depense(10);
    await ajuster(5);
    await depense(5);
    expect(await getProspectBalance(workspaceId)).toMatchObject({
      monthlyRemaining: 0,
      available: 0,
      overdrawn: { plan: false, purchased: false },
    });
    // Un crédit pris en même temps qu'un autre : le solde du mois est dépassé
    await depense(1);
    expect((await getProspectBalance(workspaceId)).overdrawn.plan).toBe(true);
  });

  it("crédits du mois retirés : le client n'est pas renvoyé vers une offre qu'il a déjà", async () => {
    await abonnement("pme");
    await ajuster(0);
    const balance = await getProspectBalance(workspaceId);
    expect(balance).toMatchObject({ planCredits: 30, monthlyCredits: 0 });
    const error = insufficientCreditsError(balance, 1);
    expect(error.details.reason).toBe("QUOTA_EXCEEDED");
    expect(error.message).not.toMatch(/incluse à partir/);
  });

  it("solde à 0 permis, jamais en dessous", async () => {
    await abonnement("pme");
    await expect(ajuster(-1)).rejects.toMatchObject({
      status: 400,
      message: "Le nouveau solde ne peut pas être négatif.",
    });
    await ajuster(0);
    expect((await getProspectBalance(workspaceId)).available).toBe(0);
    expect(await ProspectCreditAdjustment.countDocuments()).toBe(1);
  });

  it("un solde dépassé est remis au nombre demandé", async () => {
    await abonnement("entreprise");
    await depense(100);
    await achat(10);
    // Deux dépenses simultanées ont pris 2 crédits achetés de trop
    await depense(12, "purchased");
    expect((await getProspectBalance(workspaceId)).available).toBe(0);

    await ajuster(5);
    expect((await getProspectBalance(workspaceId)).available).toBe(5);
  });

  it("refuse un nombre non entier, un motif absent ou trop long", async () => {
    await abonnement("pme");
    for (const balance of ["", "abc", 2.5, null, undefined, true]) {
      await expect(ajuster(balance)).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      adjustProspectCredits(workspaceId, { balance: 10 }, ADMIN),
    ).rejects.toMatchObject({ status: 400, message: /motif est obligatoire/ });
    await expect(
      adjustProspectCredits(workspaceId, { balance: 10, reason: "  " }, ADMIN),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      ajuster(10, { reason: "x".repeat(501) }),
    ).rejects.toMatchObject({ status: 400, message: /trop long/ });
    expect(await ProspectCreditAdjustment.countDocuments()).toBe(0);
  });

  it("accepte le nouveau solde saisi en texte", async () => {
    await abonnement("pme");
    const { balance } = await ajuster(" 45 ");
    expect(balance.available).toBe(45);
  });

  it("refuse un solde inchangé et un ajout trop grand (faute de frappe)", async () => {
    await abonnement("pme");
    await expect(ajuster(30)).rejects.toMatchObject({
      status: 400,
      message: /égal au solde actuel/,
    });
    await expect(
      ajuster(30 + MAX_ADJUSTMENT_INCREASE + 1),
    ).rejects.toMatchObject({ status: 400, message: /au plus/ });
    await ajuster(30 + MAX_ADJUSTMENT_INCREASE);
    expect((await getProspectBalance(workspaceId)).available).toBe(1030);
  });

  it("refuse une organisation inconnue", async () => {
    await expect(
      adjustProspectCredits("pas-un-id", { balance: 1, reason: MOTIF }, ADMIN),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      adjustProspectCredits(
        buildOrganizationId().toString(),
        { balance: 1, reason: MOTIF },
        ADMIN,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("solde changé depuis l'affichage (dépense, double envoi) : rien n'est fait", async () => {
    await abonnement("pme");
    await ajuster(50, { expectedBalance: 30 });
    // Même formulaire envoyé une seconde fois
    await expect(ajuster(50, { expectedBalance: 30 })).rejects.toMatchObject({
      status: 409,
      message: /50 crédits/,
    });
    await depense(1);
    await expect(ajuster(60, { expectedBalance: 50 })).rejects.toMatchObject({
      status: 409,
    });
    expect(await ProspectCreditAdjustment.countDocuments()).toBe(1);
    expect((await getProspectBalance(workspaceId)).available).toBe(49);
  });

  it("deux ajustements simultanés ne s'appliquent pas tous les deux au même solde", async () => {
    await abonnement("pme");
    const results = await Promise.allSettled([ajuster(50), ajuster(50)]);
    const passed = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");

    // Soit le second voit le premier (solde déjà à 50), soit il prend le
    // même numéro : jamais 70
    expect(passed).toHaveLength(1);
    expect(refused[0].reason.status).toBeGreaterThanOrEqual(400);
    expect((await getProspectBalance(workspaceId)).available).toBe(50);
    expect(
      (await ProspectCreditAdjustment.find().lean()).map((a) => a.sequence),
    ).toEqual([1]);
  });

  it("numérote les ajustements de chaque espace", async () => {
    await abonnement("pme");
    await ajuster(40);
    await ajuster(35);
    const other = buildOrganizationId().toString();
    await organisation(other, "Autre");
    await adjustProspectCredits(other, { balance: 5, reason: MOTIF }, ADMIN);

    const rows = await ProspectCreditAdjustment.find()
      .sort({ createdAt: 1 })
      .lean();
    expect(rows.map((r) => [String(r.workspaceId), r.sequence])).toEqual([
      [workspaceId, 1],
      [workspaceId, 2],
      [other, 1],
    ]);
  });
});

describe("commandes et crédits ajoutés", () => {
  it("les crédits ajoutés sont dus aux clients : le stock les garde avant d'activer une commande", async () => {
    await abonnement("entreprise");
    await ajuster(130);
    expect(await getPurchasedCreditsOwed()).toBe(30);

    // Stock 150 : 100 gardés pour les abonnements, 30 dus, reste 20 < 25
    getKeyInfo.mockResolvedValue({ totalAvailableCredits: 150 });
    const order = await achat(25, "pending");
    const notifyTeam = vi.fn(async () => true);
    const notifyCustomer = vi.fn(async () => true);
    const result = await processProspectOrders({ notifyTeam, notifyCustomer });
    expect(result.activated).toEqual([]);
    expect(
      (await ProspectCreditPurchase.findById(order._id).lean()).status,
    ).toBe("pending");
    expect(notifyTeam.mock.calls[0][0]).toMatchObject({
      owed: 30,
      missing: 5,
    });

    // Un retrait libère le stock gardé
    await ajuster(100);
    expect(await getPurchasedCreditsOwed()).toBe(0);
    const again = await processProspectOrders({ notifyTeam, notifyCustomer });
    expect(again.activated).toHaveLength(1);
  });
});

describe("liste de la page Crédits de prospection", () => {
  it("organisations abonnées ou ayant des crédits, solde, commandes et stock", async () => {
    process.env.PROSPECTS_ENABLED = "true";
    process.env.PROSPECTS_WORKSPACE_IDS = workspaceId;
    getKeyInfo.mockResolvedValue({ totalAvailableCredits: 300 });

    // Entreprise avec une commande en attente et un achat activé
    await abonnement("entreprise");
    await depense(12);
    await achat(40);
    await achat(25, "pending");

    // Essai Premium
    const essai = buildOrganizationId().toString();
    await organisation(essai, "En essai");
    await abonnement("pme", "trialing", essai);

    // Sans abonnement mais avec un ajustement
    const sansAbonnement = buildOrganizationId().toString();
    await organisation(sansAbonnement, "Geste");
    await adjustProspectCredits(
      sansAbonnement,
      { balance: 15, reason: MOTIF },
      ADMIN,
    );

    // Trace d'un abonnement remplacé : ignorée
    const remplace = buildOrganizationId().toString();
    await db().collection("subscription").insertOne({
      referenceId: remplace,
      plan: "pme",
      status: "active",
      replacedOrganizationId: "autre",
    });

    const list = await listProspectCredits();
    const byId = new Map(list.workspaces.map((w) => [w.workspaceId, w]));

    expect([...byId.keys()].sort()).toEqual(
      [workspaceId, essai, sansAbonnement].sort(),
    );
    expect(byId.get(workspaceId)).toMatchObject({
      subscription: { plan: "entreprise", status: "active" },
      generationOpen: true,
      balance: {
        plan: "entreprise",
        monthlyCredits: 100,
        monthlyUsed: 12,
        monthlyRemaining: 88,
        purchasedRemaining: 40,
        purchasedPending: 25,
        available: 128,
      },
    });
    expect(byId.get(workspaceId).pendingOrders).toEqual([
      expect.objectContaining({ credits: 25, amountTotal: 750 }),
    ]);
    expect(byId.get(essai)).toMatchObject({
      subscription: { plan: "pme", status: "trialing" },
      generationOpen: false,
      balance: { plan: null, available: 0 },
      pendingOrders: [],
    });
    expect(byId.get(sansAbonnement)).toMatchObject({
      subscription: null,
      balance: { purchasedRemaining: 15, available: 15 },
    });

    // Stock 300 : 100 gardés (cap) - 12 dépensés = 88, dus 40 + 15 = 55
    expect(list.provider).toMatchObject({
      configured: true,
      stock: 300,
      owed: 55,
      reserve: 88,
      pendingCredits: 25,
      missing: 0,
    });
    expect(list.limits).toMatchObject({
      maxIncrease: MAX_ADJUSTMENT_INCREASE,
      monthlyCreditsByPlan: { freelance: 0, pme: 30, entreprise: 100 },
    });
  });

  it("stock illisible : affiché comme tel, pas de crédits à racheter inventés", async () => {
    await abonnement("entreprise");
    await achat(25, "pending");
    getKeyInfo.mockRejectedValue(new Error("Délai dépassé"));
    const list = await listProspectCredits();
    expect(list.provider).toMatchObject({
      stock: null,
      missing: null,
      pendingCredits: 25,
    });
  });
});
