/**
 * Prévision de trésorerie : calculs de dates et de montants, et lectures
 * qui doivent rester cohérentes avec l'accueil.
 *   - échéances du 29 au 31 (saisies et récurrences détectées) : une
 *     occurrence par mois, au dernier jour des mois plus courts, sans dérive ;
 *   - saisies anciennes (hebdomadaire de 2014, mensuelle de 1970) toujours
 *     projetées ;
 *   - « Prévision à 3 mois » : le 3e mois calendaire, même un 30 ou un 31 ;
 *   - montants démesurés refusés, et une saisie démesurée déjà en base ne
 *     casse plus la prévision (Infinity) ;
 *   - filtre de compte : solde et mouvements du seul compte choisi ; sans
 *     filtre, espèces comprises dans le solde comme sur l'accueil ;
 *   - détail d'un mois sans les transactions supprimées ;
 *   - nom de scénario déjà pris refusé ; mois d'exclusion réel.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

import ForecastScenario from "../../src/models/ForecastScenario.js";
import DetectedRecurrence from "../../src/models/DetectedRecurrence.js";
import ManualCashflowEntry from "../../src/models/ManualCashflowEntry.js";
import Transaction from "../../src/models/Transaction.js";
import AccountBanking from "../../src/models/AccountBanking.js";
// Modèles lus par la prévision via mongoose.model()
import "../../src/models/Invoice.js";
import "../../src/models/PurchaseInvoice.js";
import "../../src/models/Quote.js";
import resolvers, {
  expandManualEntry,
  addMonthsClamped,
  monthKeyAfter,
  projectForecastOccurrences,
} from "../../src/resolvers/treasuryForecast.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const wId = () => new mongoose.Types.ObjectId(organizationId);
const ctx = () => buildContext({ userId, organizationId });
const { Query, Mutation } = resolvers;

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

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

describe("Échéances du 29 au 31", () => {
  it("saisie mensuelle du 31 janvier : une occurrence chaque mois, au dernier jour des mois courts", () => {
    const occ = expandManualEntry(
      { frequency: "MONTHLY", amount: 1500, startDate: new Date(2027, 0, 31) },
      new Date(2027, 0, 1),
      new Date(2027, 6, 1),
    );
    expect(occ.map((o) => ymd(o.date))).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
      "2027-05-31",
      "2027-06-30",
    ]);
  });

  it("saisie mensuelle du 30 : février au 29 une année bissextile", () => {
    const occ = expandManualEntry(
      { frequency: "MONTHLY", amount: 2000, startDate: new Date(2028, 0, 30) },
      new Date(2028, 0, 1),
      new Date(2028, 3, 1),
    );
    expect(occ.map((o) => ymd(o.date))).toEqual([
      "2028-01-30",
      "2028-02-29",
      "2028-03-30",
    ]);
  });

  it("saisie trimestrielle du 31 : 31/01, 30/04, 31/07, 31/10", () => {
    const occ = expandManualEntry(
      { frequency: "QUARTERLY", amount: 900, startDate: new Date(2027, 0, 31) },
      new Date(2027, 0, 1),
      new Date(2028, 0, 1),
    );
    expect(occ.map((o) => ymd(o.date))).toEqual([
      "2027-01-31",
      "2027-04-30",
      "2027-07-31",
      "2027-10-31",
    ]);
  });

  it("addMonthsClamped ramène au dernier jour du mois", () => {
    expect(ymd(addMonthsClamped(new Date(2027, 0, 31), 1))).toBe("2027-02-28");
    expect(ymd(addMonthsClamped(new Date(2028, 1, 29), 12))).toBe("2029-02-28");
    expect(ymd(addMonthsClamped(new Date(2027, 7, 31), 3))).toBe("2027-11-30");
  });

  it("récurrence détectée vue pour la dernière fois un 31 : une occurrence chaque mois suivant", async () => {
    await DetectedRecurrence.create({
      workspaceId: wId(),
      source: "TRANSACTION",
      type: "EXPENSE",
      partyKey: "loyer-sci",
      partyName: "Loyer SCI",
      category: "RENT",
      averageAmount: 1500,
      frequency: "MONTHLY",
      intervalDays: 30,
      occurrenceCount: 4,
      lastSeenDate: new Date(2030, 0, 31, 12),
      lastSeenMonth: "2030-01",
      consecutiveMonths: 4,
      isActive: true,
      isMuted: false,
    });
    const occ = await projectForecastOccurrences(
      organizationId,
      new Date(2030, 1, 1),
      new Date(2030, 6, 1),
      { includePast: true },
    );
    expect(occ.map((o) => ymd(o.date))).toEqual([
      "2030-02-28",
      "2030-03-31",
      "2030-04-30",
      "2030-05-31",
      "2030-06-30",
    ]);
  });
});

describe("Saisies anciennes", () => {
  it("hebdomadaire démarrée le 06/01/2014 sans fin : projetée chaque semaine de l'horizon", () => {
    const occ = expandManualEntry(
      { frequency: "WEEKLY", amount: 50, startDate: new Date(2014, 0, 6) },
      new Date(2026, 9, 1),
      new Date(2027, 9, 1),
    );
    expect(occ.length).toBeGreaterThanOrEqual(52);
    // Toujours un lundi (jour de la date de début)
    expect(occ.every((o) => o.date.getDay() === 1)).toBe(true);
  });

  it("mensuelle démarrée en 1970 : projetée sur l'horizon, progression ancrée sur le début", () => {
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 100,
        amountDelta: 1,
        amountDeltaType: "AMOUNT",
        startDate: new Date(1970, 0, 15),
      },
      new Date(2026, 0, 1),
      new Date(2026, 3, 1),
    );
    expect(occ.map((o) => ymd(o.date))).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
    ]);
    // 56 ans × 12 mois d'occurrences avant janvier 2026
    expect(occ[0].amount).toBe(100 + 56 * 12);
  });
});

describe("Prévision à 3 mois", () => {
  it("vise le 3e mois calendaire, même en fin de mois", () => {
    expect(monthKeyAfter(new Date(2026, 10, 30), 3)).toBe("2027-02");
    expect(monthKeyAfter(new Date(2027, 2, 31), 3)).toBe("2027-06");
    expect(monthKeyAfter(new Date(2027, 7, 31), 3)).toBe("2027-11");
    expect(monthKeyAfter(new Date(2026, 9, 15), 3)).toBe("2027-01");
  });

  it("le KPI vaut le solde de clôture du 3e mois suivant", async () => {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 5, 1);
    const data = await Query.treasuryForecastData(
      null,
      { startDate: `${monthKey(now)}-01`, endDate: `${monthKey(end)}-01` },
      ctx(),
    );
    const target = data.months.find((m) => m.month === monthKeyAfter(now, 3));
    expect(target).toBeTruthy();
    expect(data.kpi.projectedBalance3Months).toBe(target.closingBalance);
  });
});

describe("Montants démesurés", () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const upsert = (input) =>
    Mutation.upsertManualCashflowEntry(
      null,
      {
        input: {
          name: "Saisie démesurée",
          type: "EXPENSE",
          category: "OTHER_EXPENSE",
          amount: 100,
          startDate: today(),
          frequency: "MONTHLY",
          ...input,
        },
      },
      ctx(),
    );

  for (const [label, input, message] of [
    ["montant de 1e308", { amount: 1e308 }, /1 000 000 000/],
    [
      "progression de +100 000 % par semaine",
      { frequency: "WEEKLY", amountDelta: 100000, amountDeltaType: "PERCENT" },
      /progression/i,
    ],
    [
      "fin antérieure au début",
      { startDate: "2027-06-01", endDate: "2027-01-01" },
      /date de fin/i,
    ],
  ]) {
    it(`refuse une saisie avec ${label}, rien en base`, async () => {
      await expect(upsert(input)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: expect.stringMatching(message),
      });
      expect(await ManualCashflowEntry.countDocuments()).toBe(0);
    });
  }

  it("refuse aussi la modification d'une saisie existante avec un montant démesuré", async () => {
    const created = await upsert({});
    await expect(
      upsert({ id: String(created._id), amount: 1e12 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await ManualCashflowEntry.findById(created._id)).amount).toBe(100);
  });

  it("une saisie démesurée déjà en base ne casse plus la prévision", async () => {
    const now = new Date();
    for (const [amount, delta] of [
      [1e308, 0],
      [100, 100000],
    ]) {
      await ManualCashflowEntry.collection.insertOne({
        workspaceId: wId(),
        scenarioId: null,
        name: `Ancienne saisie ${amount}`,
        type: "EXPENSE",
        category: "OTHER_EXPENSE",
        amount,
        amountDelta: delta,
        amountDeltaType: "PERCENT",
        startDate: new Date(now.getFullYear() - 1, 0, 1),
        endDate: null,
        frequency: "WEEKLY",
        excludedMonths: [],
        createdBy: new mongoose.Types.ObjectId(userId),
      });
    }
    const end = new Date(now.getFullYear(), now.getMonth() + 11, 1);
    const data = await Query.treasuryForecastData(
      null,
      { startDate: `${monthKey(now)}-01`, endDate: `${monthKey(end)}-01` },
      ctx(),
    );
    for (const m of data.months) {
      for (const field of [
        "forecastExpense",
        "openingBalance",
        "closingBalance",
      ]) {
        expect(Number.isFinite(m[field]), `${m.month} ${field}`).toBe(true);
      }
    }
    expect(Number.isFinite(data.kpi.projectedBalance3Months)).toBe(true);
  });
});

describe("Compte choisi et espèces", () => {
  const now = new Date();
  const thisMonth = () => monthKey(now);
  const seedAccounts = async () => {
    const [a, b] = await AccountBanking.insertMany([
      {
        externalId: "ext-compte-a",
        provider: "bridge",
        name: "Compte A",
        status: "active",
        balance: 10000,
        workspaceId: organizationId.toString(),
      },
      {
        externalId: "ext-compte-b",
        provider: "bridge",
        name: "Compte B",
        status: "active",
        balance: 5000,
        workspaceId: organizationId.toString(),
      },
    ]);
    const tx = (fromAccount, amount, extra = {}) => ({
      workspaceId: organizationId.toString(),
      externalId: `tx-${Math.random()}`,
      provider: "bridge",
      type: amount > 0 ? "credit" : "debit",
      status: "completed",
      amount,
      currency: "EUR",
      description: "Mouvement",
      fromAccount,
      date: new Date(now.getFullYear(), now.getMonth(), 1, 12),
      deletedAt: null,
      ...extra,
    });
    await Transaction.collection.insertMany([
      tx("ext-compte-b", 3000),
      tx("ext-compte-a", -200, { expenseCategory: "SOFTWARE" }),
    ]);
    return { a, b, tx };
  };
  const forecast = (args = {}) =>
    Query.treasuryForecastData(
      null,
      {
        startDate: `${thisMonth()}-01`,
        endDate: `${thisMonth()}-01`,
        ...args,
      },
      ctx(),
    );

  it("compte A choisi : son solde et ses seuls mouvements", async () => {
    const { a } = await seedAccounts();
    const data = await forecast({ accountId: String(a._id) });
    const [month] = data.months;
    expect(data.kpi.currentBalance).toBe(10000);
    expect(month.actualIncome).toBe(0);
    expect(month.actualExpense).toBe(200);
    expect(month.openingBalance).toBe(10200);
    expect(month.closingBalance).toBe(10000);
  });

  it("sans compte choisi : tous les comptes et les espèces, ouverture non minorée", async () => {
    const { tx } = await seedAccounts();
    await Transaction.collection.insertOne(
      tx(null, 50, { provider: "manual", description: "Dépôt d'espèces" }),
    );
    const data = await forecast();
    const [month] = data.months;
    // 10 000 + 5 000 + 50 € d'espèces, comme le solde de l'accueil
    expect(data.kpi.currentBalance).toBe(15050);
    expect(month.actualIncome).toBe(3050);
    expect(month.openingBalance).toBe(15050 - 3050 + 200);
  });

  it("refuse un identifiant de compte mal formé avec un message clair", async () => {
    await expect(
      forecast({ accountId: "pas-un-compte" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Compte bancaire invalide",
    });
  });
});

describe("Détail d'un mois", () => {
  it("n'affiche pas les transactions supprimées", async () => {
    const now = new Date();
    const base = {
      workspaceId: organizationId.toString(),
      provider: "bridge",
      status: "completed",
      currency: "EUR",
      date: new Date(now.getFullYear(), now.getMonth(), 1, 12),
    };
    await Transaction.collection.insertMany([
      {
        ...base,
        externalId: "visible",
        amount: -40,
        description: "CB GARDEE",
        deletedAt: null,
      },
      {
        ...base,
        externalId: "supprimee",
        amount: -999,
        description: "CB SUPPRIMEE",
        deletedAt: new Date(),
      },
    ]);
    const details = await Query.forecastMonthDetails(
      null,
      { month: monthKey(now) },
      ctx(),
    );
    expect(details.bankTransactions.map((t) => t.description)).toEqual([
      "CB GARDEE",
    ]);
  });
});

describe("Scénarios : nom déjà pris", () => {
  const upsertScenario = (input) =>
    Mutation.upsertForecastScenario(null, { input }, ctx());

  it("« Nouveau scénario » au nom d'un scénario existant : refusé, l'existant inchangé", async () => {
    await upsertScenario({
      name: "Optimiste",
      incomeMultiplier: 1.2,
      expenseMultiplier: 0.9,
    });
    await expect(
      upsertScenario({
        name: "Optimiste",
        incomeMultiplier: 1.5,
        expenseMultiplier: 1,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Un scénario porte déjà ce nom",
    });
    const scenarios = await ForecastScenario.find({
      workspaceId: wId(),
    }).lean();
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]).toMatchObject({
      incomeMultiplier: 1.2,
      expenseMultiplier: 0.9,
    });
  });

  it("renommer avec le nom d'un autre scénario : même message, sans erreur technique", async () => {
    await upsertScenario({
      name: "Optimiste",
      incomeMultiplier: 1.2,
      expenseMultiplier: 0.9,
    });
    const autre = await upsertScenario({
      name: "Prudent",
      incomeMultiplier: 1,
      expenseMultiplier: 1,
    });
    await expect(
      upsertScenario({
        id: String(autre._id),
        name: "Optimiste",
        incomeMultiplier: 1,
        expenseMultiplier: 1,
      }),
    ).rejects.toMatchObject({ message: "Un scénario porte déjà ce nom" });
    expect((await ForecastScenario.findById(autre._id)).name).toBe("Prudent");
  });

  it("garder son propre nom en modifiant ses pourcentages reste permis", async () => {
    const s = await upsertScenario({
      name: "Optimiste",
      incomeMultiplier: 1.2,
      expenseMultiplier: 0.9,
    });
    const updated = await upsertScenario({
      id: String(s._id),
      name: "Optimiste",
      incomeMultiplier: 1.3,
      expenseMultiplier: 0.9,
    });
    expect(updated.incomeMultiplier).toBe(1.3);
  });
});

describe("Retirer un mois d'une prévision", () => {
  it("refuse un mois inexistant", async () => {
    const entry = await ManualCashflowEntry.create({
      workspaceId: wId(),
      name: "Loyer",
      type: "EXPENSE",
      category: "RENT",
      amount: 1200,
      startDate: new Date(),
      frequency: "MONTHLY",
      createdBy: new mongoose.Types.ObjectId(userId),
    });
    for (const month of ["2026-13", "0000-00"]) {
      await expect(
        Mutation.excludeForecastOccurrence(
          null,
          { kind: "MANUAL", id: String(entry._id), month },
          ctx(),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(
      (await ManualCashflowEntry.findById(entry._id)).excludedMonths,
    ).toEqual([]);
  });
});
