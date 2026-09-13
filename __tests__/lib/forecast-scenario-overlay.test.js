import { describe, it, expect } from "vitest";
import mongoose from "mongoose";

// Real implementation — must import, not re-implement.
import {
  buildScenarioOverlay,
  projectableRecurrenceFilter,
} from "../../src/utils/forecastScenarioOverlay.js";

const oid = () => new mongoose.Types.ObjectId();

describe("buildScenarioOverlay — Base (aucun scénario)", () => {
  const overlay = buildScenarioOverlay(null);

  it("suit les champs des entités", () => {
    expect(overlay.isScenario).toBe(false);
    expect(overlay.isRecurrenceMuted({ isMuted: true })).toBe(true);
    expect(overlay.isRecurrenceMuted({ isMuted: false })).toBe(false);
    expect(
      overlay.isRecurrenceProjected({ isActive: true, isMuted: false }),
    ).toBe(true);
    expect(
      overlay.isRecurrenceProjected({ isActive: false, isMuted: false }),
    ).toBe(false);
    expect(overlay.hasRecurrenceOverride({ _id: oid() })).toBe(false);
    expect(overlay.isManualEntryHidden({ _id: oid() })).toBe(false);
    expect(overlay.isOccurrenceExcluded("MANUAL", oid(), "2026-10")).toBe(
      false,
    );
  });

  it("ne voit que les saisies de Base", () => {
    expect(overlay.manualEntryFilter()).toEqual({ scenarioId: null });
  });

  it("ne projette que les récurrences actives non masquées", () => {
    const wId = oid();
    expect(projectableRecurrenceFilter(wId, overlay)).toEqual({
      workspaceId: wId,
      isActive: true,
      isMuted: false,
    });
  });
});

describe("buildScenarioOverlay — scénario", () => {
  const mutedHere = { _id: oid(), isActive: true, isMuted: false };
  const mutedInBase = {
    _id: oid(),
    isActive: false,
    isMuted: true,
    consecutiveMonths: 4,
  };
  const staleInBase = {
    _id: oid(),
    isActive: false,
    isMuted: true,
    consecutiveMonths: 1,
  };
  const untouched = { _id: oid(), isActive: true, isMuted: false };
  const hiddenEntry = { _id: oid() };
  const scenario = {
    _id: oid(),
    recurrenceOverrides: [
      { recurrenceId: mutedHere._id, isMuted: true },
      { recurrenceId: mutedInBase._id, isMuted: false },
      { recurrenceId: staleInBase._id, isMuted: false },
    ],
    hiddenManualEntryIds: [hiddenEntry._id],
    excludedOccurrences: [
      { kind: "DETECTED", entityId: untouched._id, month: "2026-11" },
    ],
  };
  const overlay = buildScenarioOverlay(scenario);

  it("masque une récurrence dans le scénario sans toucher Base", () => {
    expect(overlay.isScenario).toBe(true);
    expect(overlay.isRecurrenceMuted(mutedHere)).toBe(true);
    expect(overlay.isRecurrenceProjected(mutedHere)).toBe(false);
    expect(overlay.hasRecurrenceOverride(mutedHere)).toBe(true);
    // L'entité elle-même reste non masquée (Base intacte).
    expect(mutedHere.isMuted).toBe(false);
  });

  it("réactive une récurrence masquée en Base si sa série est valide", () => {
    expect(overlay.isRecurrenceMuted(mutedInBase)).toBe(false);
    expect(overlay.isRecurrenceProjected(mutedInBase)).toBe(true);
    // Série trop courte : réactivée mais pas projetée.
    expect(overlay.isRecurrenceMuted(staleInBase)).toBe(false);
    expect(overlay.isRecurrenceProjected(staleInBase)).toBe(false);
  });

  it("laisse les récurrences non surchargées suivre Base", () => {
    expect(overlay.hasRecurrenceOverride(untouched)).toBe(false);
    expect(overlay.isRecurrenceMuted(untouched)).toBe(false);
    expect(overlay.isRecurrenceProjected(untouched)).toBe(true);
  });

  it("gère les saisies masquées et les occurrences exclues", () => {
    expect(overlay.isManualEntryHidden(hiddenEntry)).toBe(true);
    expect(overlay.isManualEntryHidden({ _id: oid() })).toBe(false);
    expect(
      overlay.isOccurrenceExcluded("DETECTED", untouched._id, "2026-11"),
    ).toBe(true);
    expect(
      overlay.isOccurrenceExcluded("DETECTED", untouched._id, "2026-12"),
    ).toBe(false);
    expect(
      overlay.isOccurrenceExcluded("MANUAL", untouched._id, "2026-11"),
    ).toBe(false);
  });

  it("voit les saisies de Base et celles du scénario", () => {
    expect(overlay.manualEntryFilter()).toEqual({
      $or: [{ scenarioId: null }, { scenarioId: scenario._id }],
    });
  });

  it("inclut les récurrences surchargées dans les candidates à la projection", () => {
    const wId = oid();
    const filter = projectableRecurrenceFilter(wId, overlay);
    expect(filter.workspaceId).toBe(wId);
    expect(filter.$or[0]).toEqual({ isActive: true, isMuted: false });
    expect(filter.$or[1]._id.$in.map(String).sort()).toEqual(
      [mutedHere._id, mutedInBase._id, staleInBase._id].map(String).sort(),
    );
  });
});
