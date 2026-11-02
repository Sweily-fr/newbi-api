/**
 * Analyse des récurrences relancée plusieurs fois : une récurrence dont la
 * série est momentanément irrégulière perd un mois au plus une fois par mois
 * calendaire. « Analyser » cliqué trois fois le même jour ne la désactive
 * pas ; le passage du mois suivant la vieillit normalement.
 */
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
import DetectedRecurrence from "../../src/models/DetectedRecurrence.js";
import "../../src/models/Transaction.js";
import { runRecurringInvoiceDetectionForWorkspace } from "../../src/cron/recurringInvoiceDetectionCron.js";

const workspaceId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2026-03-15T10:00:00Z"),
  });
});
afterEach(() => {
  vi.useRealTimers();
});

// Récurrence sans aucune opération dans la fenêtre d'analyse : son groupe a
// disparu, elle vieillit d'un mois à chaque analyse « mensuelle ».
const insertRecurrence = (lastDetectedAt) =>
  DetectedRecurrence.collection.insertOne({
    workspaceId,
    source: "TRANSACTION",
    type: "EXPENSE",
    partyKey: "abonnement-irregulier",
    partyName: "Abonnement irrégulier",
    category: "OTHER",
    averageAmount: 30,
    lastSeenMonth: "2026-02",
    consecutiveMonths: 3,
    isActive: true,
    isMuted: false,
    excludedMonths: [],
    lastDetectedAt,
  });

const state = async () =>
  DetectedRecurrence.findOne({ workspaceId })
    .select("consecutiveMonths isActive")
    .lean();

describe("détection des récurrences relancée", () => {
  it("trois analyses le même jour : un seul mois de moins, toujours active", async () => {
    await insertRecurrence(new Date("2026-02-01T02:15:00Z"));
    for (let i = 0; i < 3; i++) {
      await runRecurringInvoiceDetectionForWorkspace(workspaceId);
    }
    expect(await state()).toMatchObject({
      consecutiveMonths: 2,
      isActive: true,
    });
  });

  it("déjà analysée ce mois-ci : rien ne change", async () => {
    await insertRecurrence(new Date("2026-03-02T09:00:00Z"));
    await runRecurringInvoiceDetectionForWorkspace(workspaceId);
    expect(await state()).toMatchObject({
      consecutiveMonths: 3,
      isActive: true,
    });
  });

  it("un mois plus tard : elle vieillit de nouveau", async () => {
    await insertRecurrence(new Date("2026-02-01T02:15:00Z"));
    await runRecurringInvoiceDetectionForWorkspace(workspaceId);
    vi.setSystemTime(new Date("2026-04-01T02:15:00Z"));
    await runRecurringInvoiceDetectionForWorkspace(workspaceId);
    expect(await state()).toMatchObject({
      consecutiveMonths: 1,
      isActive: true,
    });
  });
});
