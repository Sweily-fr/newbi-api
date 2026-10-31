import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

import ForecastScenario from "../../src/models/ForecastScenario.js";
import TreasuryForecast from "../../src/models/TreasuryForecast.js";
import ManualCashflowEntry from "../../src/models/ManualCashflowEntry.js";
import resolvers from "../../src/resolvers/treasuryForecast.js";

// Les bornes des modèles (multiplicateurs de 0 à 5, montants positifs,
// longueur des noms, mois réel) valent aussi pour les modifications :
// findOneAndUpdate ne les applique qu'avec runValidators.

const userId = buildUserId();
const organizationId = buildOrganizationId();
const wId = () => new mongoose.Types.ObjectId(organizationId);

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

const ctx = () => buildContext({ userId, organizationId });
const { Mutation } = resolvers;

const upsertScenario = (input) =>
  Mutation.upsertForecastScenario(
    null,
    { input: { workspaceId: organizationId.toString(), ...input } },
    ctx(),
  );

describe("Prévision : scénarios hors bornes refusés", () => {
  it.each([
    [
      "multiplicateur des entrées de 50",
      { name: "Multiplicateur 50", incomeMultiplier: 50, expenseMultiplier: 1 },
    ],
    [
      "multiplicateur des sorties négatif",
      { name: "Négatif", incomeMultiplier: 1, expenseMultiplier: -2 },
    ],
    [
      "nom fait d'espaces",
      { name: "   ", incomeMultiplier: 1, expenseMultiplier: 1 },
    ],
    [
      "nom de 200 caractères",
      { name: "S".repeat(200), incomeMultiplier: 1, expenseMultiplier: 1 },
    ],
  ])("%s", async (_cas, input) => {
    await expect(upsertScenario(input)).rejects.toThrow();
    expect(await ForecastScenario.countDocuments({ workspaceId: wId() })).toBe(
      0,
    );
  });

  it("multiplicateur de 6 (+500 %) refusé à la modification aussi", async () => {
    const scenario = await upsertScenario({
      name: "Prudent",
      incomeMultiplier: 1.1,
      expenseMultiplier: 0.95,
    });
    await expect(
      upsertScenario({
        id: scenario._id.toString(),
        name: "Prudent",
        incomeMultiplier: 6,
        expenseMultiplier: 1,
      }),
    ).rejects.toThrow();
    const doc = await ForecastScenario.findById(scenario._id).lean();
    expect(doc.incomeMultiplier).toBe(1.1);
  });

  it("scénario dans les bornes : enregistré", async () => {
    const scenario = await upsertScenario({
      name: "Scénario prudent 2027",
      incomeMultiplier: 1.1,
      expenseMultiplier: 0.95,
    });
    expect(scenario.incomeMultiplier).toBe(1.1);
    expect(scenario.expenseMultiplier).toBe(0.95);
  });
});

describe("Prévision mensuelle : mois et montant", () => {
  const upsertForecast = (input) =>
    Mutation.upsertTreasuryForecast(
      null,
      {
        input: {
          workspaceId: organizationId.toString(),
          category: "TRAINING",
          type: "EXPENSE",
          ...input,
        },
      },
      ctx(),
    );

  it("mois « 2026-13 » refusé", async () => {
    await expect(
      upsertForecast({ month: "2026-13", forecastAmount: 100 }),
    ).rejects.toThrow(/AAAA-MM/);
    expect(await TreasuryForecast.countDocuments({ workspaceId: wId() })).toBe(
      0,
    );
  });

  it("montant négatif refusé", async () => {
    await expect(
      upsertForecast({ month: "2031-01", forecastAmount: -300 }),
    ).rejects.toThrow();
    expect(await TreasuryForecast.countDocuments({ workspaceId: wId() })).toBe(
      0,
    );
  });

  it("mois et montant valides : enregistrés", async () => {
    const result = await upsertForecast({
      month: "2031-01",
      forecastAmount: 300,
    });
    expect(result.forecastAmount).toBe(300);
  });
});

describe("Saisie de prévision modifiée : mêmes bornes qu'à la création", () => {
  const createEntry = () =>
    ManualCashflowEntry.create({
      workspaceId: wId(),
      name: "Prévision aux bornes",
      type: "EXPENSE",
      category: "OTHER_EXPENSE",
      amount: 120,
      startDate: new Date(),
      frequency: "MONTHLY",
      createdBy: userId,
    });

  const editEntry = (entry, changes) =>
    Mutation.upsertManualCashflowEntry(
      null,
      {
        input: {
          id: entry._id.toString(),
          workspaceId: organizationId.toString(),
          name: entry.name,
          type: entry.type,
          category: entry.category,
          amount: entry.amount,
          startDate: new Date().toISOString(),
          frequency: entry.frequency,
          ...changes,
        },
      },
      ctx(),
    );

  it.each([
    ["montant de -500 €", { amount: -500 }],
    ["nom de 300 caractères", { name: "P".repeat(300) }],
  ])("%s : refusée", async (_cas, changes) => {
    const entry = await createEntry();
    await expect(editEntry(entry, changes)).rejects.toThrow();
    const doc = await ManualCashflowEntry.findById(entry._id).lean();
    expect(doc.amount).toBe(120);
    expect(doc.name).toBe("Prévision aux bornes");
  });

  it("modification dans les bornes : enregistrée", async () => {
    const entry = await createEntry();
    const updated = await editEntry(entry, {
      amount: 150,
      name: "Loyer bureau",
    });
    expect(updated.amount).toBe(150);
    expect(updated.name).toBe("Loyer bureau");
  });
});
