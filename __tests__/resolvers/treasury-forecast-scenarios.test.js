import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";

import ForecastScenario from "../../src/models/ForecastScenario.js";
import DetectedRecurrence from "../../src/models/DetectedRecurrence.js";
import ManualCashflowEntry from "../../src/models/ManualCashflowEntry.js";
import resolvers from "../../src/resolvers/treasuryForecast.js";

// Un scénario est un calque sur Base : rien de ce qui est fait dans un
// scénario ne doit remonter dans Base (ticket « masquer A Way Out dans
// Pessimiste a aussi masqué dans Base »).

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
const { Query, Mutation } = resolvers;

const monthKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const addMonths = (d, n) => {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
};
const horizon = () => {
  const now = new Date();
  return { startMonth: monthKey(now), endMonth: monthKey(addMonths(now, 5)) };
};

const createScenario = (name = "Pessimiste") =>
  Mutation.upsertForecastScenario(
    null,
    { input: { name, incomeMultiplier: 0.8, expenseMultiplier: 1.2 } },
    ctx(),
  );

// Récurrence mensuelle active vue pour la dernière fois le mois dernier :
// projetée sur chacun des mois de l'horizon.
const createRecurrence = (partyName = "A Way Out") =>
  DetectedRecurrence.create({
    workspaceId: wId(),
    source: "TRANSACTION",
    type: "EXPENSE",
    partyKey: partyName.toLowerCase().replace(/\s+/g, "-"),
    partyName,
    category: "SUBSCRIPTIONS",
    averageAmount: 49,
    frequency: "MONTHLY",
    intervalDays: 30,
    occurrenceCount: 4,
    lastSeenDate: addMonths(new Date(), -1),
    lastSeenMonth: monthKey(addMonths(new Date(), -1)),
    consecutiveMonths: 4,
    isActive: true,
    isMuted: false,
  });

const occurrencesOf = async (scenarioId, name) =>
  (
    await Query.forecastOccurrences(null, { ...horizon(), scenarioId }, ctx())
  ).filter((o) => o.name === name);

describe("Scénarios de prévision — masquage d'une récurrence", () => {
  it("masquer dans un scénario ne masque pas dans Base", async () => {
    const scenario = await createScenario();
    const rec = await createRecurrence();

    const result = await Mutation.muteDetectedRecurrence(
      null,
      { id: rec._id.toString(), muted: true, scenarioId: scenario._id },
      ctx(),
    );
    expect(result.isMuted).toBe(true);
    expect(result.isActive).toBe(false);
    expect(result.scenarioOverride).toBe(true);

    // Base intacte en base de données…
    const inDb = await DetectedRecurrence.findById(rec._id).lean();
    expect(inDb.isMuted).toBe(false);
    expect(inDb.isActive).toBe(true);

    // …et dans la liste vue depuis Base vs depuis le scénario.
    const [base] = await Query.detectedRecurrences(null, {}, ctx());
    expect(base.isMuted).toBe(false);
    expect(base.scenarioOverride).toBe(false);
    const [inScenario] = await Query.detectedRecurrences(
      null,
      { scenarioId: scenario._id.toString() },
      ctx(),
    );
    expect(inScenario.isMuted).toBe(true);
    expect(inScenario.scenarioOverride).toBe(true);

    // Projection : toujours là en Base, absente dans le scénario.
    expect(
      (await occurrencesOf(undefined, "A Way Out")).length,
    ).toBeGreaterThan(0);
    expect(await occurrencesOf(scenario._id.toString(), "A Way Out")).toEqual(
      [],
    );
  });

  it("revenir à l'état de Base retire la surcharge", async () => {
    const scenario = await createScenario();
    const rec = await createRecurrence();
    const args = { id: rec._id.toString(), scenarioId: scenario._id };
    await Mutation.muteDetectedRecurrence(
      null,
      { ...args, muted: true },
      ctx(),
    );
    const back = await Mutation.muteDetectedRecurrence(
      null,
      { ...args, muted: false },
      ctx(),
    );
    expect(back.isMuted).toBe(false);
    expect(back.scenarioOverride).toBe(false);
    const s = await ForecastScenario.findById(scenario._id).lean();
    expect(s.recurrenceOverrides).toEqual([]);
  });

  it("un scénario peut réactiver une récurrence masquée en Base", async () => {
    const scenario = await createScenario();
    const rec = await createRecurrence();
    // Masquage en Base (comportement historique) : isActive passe à false.
    await Mutation.muteDetectedRecurrence(
      null,
      { id: rec._id.toString(), muted: true },
      ctx(),
    );
    expect(await occurrencesOf(undefined, "A Way Out")).toEqual([]);

    await Mutation.muteDetectedRecurrence(
      null,
      { id: rec._id.toString(), muted: false, scenarioId: scenario._id },
      ctx(),
    );
    expect(
      (await occurrencesOf(scenario._id.toString(), "A Way Out")).length,
    ).toBeGreaterThan(0);
    // Base reste masquée.
    expect(await occurrencesOf(undefined, "A Way Out")).toEqual([]);
    expect((await DetectedRecurrence.findById(rec._id).lean()).isMuted).toBe(
      true,
    );
  });

  it("masquer en Base (sans scénario) garde le comportement historique", async () => {
    const rec = await createRecurrence();
    const result = await Mutation.muteDetectedRecurrence(
      null,
      { id: rec._id.toString(), muted: true },
      ctx(),
    );
    expect(result.isMuted).toBe(true);
    // Résolveur de champ : undefined → false côté GraphQL.
    expect(result.scenarioOverride).toBeFalsy();
    const inDb = await DetectedRecurrence.findById(rec._id).lean();
    expect(inDb.isMuted).toBe(true);
    expect(inDb.isActive).toBe(false);
  });

  it("supprimer la récurrence nettoie les surcharges des scénarios", async () => {
    const scenario = await createScenario();
    const rec = await createRecurrence();
    await Mutation.muteDetectedRecurrence(
      null,
      { id: rec._id.toString(), muted: true, scenarioId: scenario._id },
      ctx(),
    );
    await Mutation.deleteDetectedRecurrence(
      null,
      { id: rec._id.toString() },
      ctx(),
    );
    const s = await ForecastScenario.findById(scenario._id).lean();
    expect(s.recurrenceOverrides).toEqual([]);
  });
});

describe("Scénarios de prévision — suppression d'une occurrence", () => {
  it("supprimer un mois dans un scénario ne touche pas l'entité (Base)", async () => {
    const scenario = await createScenario();
    const rec = await createRecurrence();
    const month = monthKey(addMonths(new Date(), 1));

    await Mutation.excludeForecastOccurrence(
      null,
      {
        kind: "DETECTED",
        id: rec._id.toString(),
        month,
        scenarioId: scenario._id,
      },
      ctx(),
    );
    // Idempotent : pas de doublon.
    await Mutation.excludeForecastOccurrence(
      null,
      {
        kind: "DETECTED",
        id: rec._id.toString(),
        month,
        scenarioId: scenario._id,
      },
      ctx(),
    );

    const inDb = await DetectedRecurrence.findById(rec._id).lean();
    expect(inDb.excludedMonths).toEqual([]);
    const s = await ForecastScenario.findById(scenario._id).lean();
    expect(s.excludedOccurrences).toHaveLength(1);
    expect(s.excludedOccurrences[0]).toMatchObject({ kind: "DETECTED", month });

    const baseMonths = (await occurrencesOf(undefined, "A Way Out")).map((o) =>
      monthKey(new Date(o.date)),
    );
    const scenarioMonths = (
      await occurrencesOf(scenario._id.toString(), "A Way Out")
    ).map((o) => monthKey(new Date(o.date)));
    expect(baseMonths).toContain(month);
    expect(scenarioMonths).not.toContain(month);
    expect(scenarioMonths.length).toBe(baseMonths.length - 1);
  });
});

describe("Scénarios de prévision — saisies manuelles", () => {
  const entryInput = (name, extra = {}) => ({
    name,
    type: "EXPENSE",
    category: "RENT",
    amount: 1000,
    startDate: addMonths(new Date(), 1).toISOString(),
    endDate: null,
    frequency: "MONTHLY",
    ...extra,
  });

  it("une saisie créée dans un scénario n'existe que dans ce scénario", async () => {
    const scenario = await createScenario();
    await Mutation.upsertManualCashflowEntry(
      null,
      { input: entryInput("Loyer Base") },
      ctx(),
    );
    const own = await Mutation.upsertManualCashflowEntry(
      null,
      {
        input: entryInput("Bureau supplémentaire", {
          scenarioId: scenario._id,
        }),
      },
      ctx(),
    );
    expect(own.scenarioId.toString()).toBe(scenario._id.toString());

    const base = await Query.manualCashflowEntries(null, {}, ctx());
    expect(base.map((e) => e.name)).toEqual(["Loyer Base"]);
    const inScenario = await Query.manualCashflowEntries(
      null,
      { scenarioId: scenario._id.toString() },
      ctx(),
    );
    expect(inScenario.map((e) => e.name).sort()).toEqual([
      "Bureau supplémentaire",
      "Loyer Base",
    ]);

    expect(await occurrencesOf(undefined, "Bureau supplémentaire")).toEqual([]);
    expect(
      (await occurrencesOf(scenario._id.toString(), "Bureau supplémentaire"))
        .length,
    ).toBeGreaterThan(0);
  });

  it("masquer une saisie de Base dans un scénario ne modifie pas la saisie", async () => {
    const scenario = await createScenario();
    const entry = await Mutation.upsertManualCashflowEntry(
      null,
      { input: entryInput("Loyer Base") },
      ctx(),
    );
    const hidden = await Mutation.hideManualCashflowEntryInScenario(
      null,
      { id: entry._id.toString(), scenarioId: scenario._id, hidden: true },
      ctx(),
    );
    expect(hidden.hiddenInScenario).toBe(true);

    const [base] = await Query.manualCashflowEntries(null, {}, ctx());
    expect(base.hiddenInScenario).toBe(false);
    const [inScenario] = await Query.manualCashflowEntries(
      null,
      { scenarioId: scenario._id.toString() },
      ctx(),
    );
    expect(inScenario.hiddenInScenario).toBe(true);

    expect(
      (await occurrencesOf(undefined, "Loyer Base")).length,
    ).toBeGreaterThan(0);
    expect(await occurrencesOf(scenario._id.toString(), "Loyer Base")).toEqual(
      [],
    );

    // Réaffichage.
    await Mutation.hideManualCashflowEntryInScenario(
      null,
      { id: entry._id.toString(), scenarioId: scenario._id, hidden: false },
      ctx(),
    );
    expect(
      (await occurrencesOf(scenario._id.toString(), "Loyer Base")).length,
    ).toBeGreaterThan(0);
  });

  it("refuse de masquer une saisie qui appartient déjà à un scénario", async () => {
    const scenario = await createScenario();
    const own = await Mutation.upsertManualCashflowEntry(
      null,
      { input: entryInput("Propre au scénario", { scenarioId: scenario._id }) },
      ctx(),
    );
    await expect(
      Mutation.hideManualCashflowEntryInScenario(
        null,
        { id: own._id.toString(), scenarioId: scenario._id, hidden: true },
        ctx(),
      ),
    ).rejects.toThrow(/appartient à un scénario/);
  });

  it("supprimer le scénario supprime ses saisies mais pas celles de Base", async () => {
    const scenario = await createScenario();
    await Mutation.upsertManualCashflowEntry(
      null,
      { input: entryInput("Loyer Base") },
      ctx(),
    );
    await Mutation.upsertManualCashflowEntry(
      null,
      { input: entryInput("Propre au scénario", { scenarioId: scenario._id }) },
      ctx(),
    );
    await Mutation.deleteForecastScenario(
      null,
      { id: scenario._id.toString() },
      ctx(),
    );
    const remaining = await ManualCashflowEntry.find({
      workspaceId: wId(),
    }).lean();
    expect(remaining.map((e) => e.name)).toEqual(["Loyer Base"]);
  });

  it("un scénario inconnu est refusé à la création d'une saisie", async () => {
    await expect(
      Mutation.upsertManualCashflowEntry(
        null,
        {
          input: entryInput("X", {
            scenarioId: new mongoose.Types.ObjectId().toString(),
          }),
        },
        ctx(),
      ),
    ).rejects.toThrow(/Scénario non trouvé/);
  });
});
