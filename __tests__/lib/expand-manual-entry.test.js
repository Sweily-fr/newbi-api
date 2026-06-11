import { describe, it, expect } from "vitest";

// Real implementation — must import, not re-implement.
import { expandManualEntry } from "../../src/resolvers/treasuryForecast.js";

const range = (startIso, endIso) => [new Date(startIso), new Date(endIso)];

describe("expandManualEntry", () => {
  it("expands a monthly entry with a constant amount when no delta", () => {
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 100,
        startDate: "2026-01-10T00:00:00.000Z",
        endDate: null,
      },
      ...range("2026-01-01", "2026-05-01"),
    );
    expect(occ).toHaveLength(4);
    expect(occ.map((o) => o.amount)).toEqual([100, 100, 100, 100]);
  });

  it("applies a fixed EUR delta on each occurrence (Augmenter de)", () => {
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 100,
        amountDelta: 50,
        amountDeltaType: "AMOUNT",
        startDate: "2026-01-10T00:00:00.000Z",
        endDate: null,
      },
      ...range("2026-01-01", "2026-05-01"),
    );
    expect(occ.map((o) => o.amount)).toEqual([100, 150, 200, 250]);
  });

  it("applies a negative EUR delta without going below zero (Diminuer de)", () => {
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 100,
        amountDelta: -60,
        amountDeltaType: "AMOUNT",
        startDate: "2026-01-10T00:00:00.000Z",
        endDate: null,
      },
      ...range("2026-01-01", "2026-05-01"),
    );
    expect(occ.map((o) => o.amount)).toEqual([100, 40, 0, 0]);
  });

  it("applies a compounding percent delta", () => {
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 1000,
        amountDelta: 10,
        amountDeltaType: "PERCENT",
        startDate: "2026-01-10T00:00:00.000Z",
        endDate: null,
      },
      ...range("2026-01-01", "2026-04-01"),
    );
    expect(occ.map((o) => o.amount)).toEqual([1000, 1100, 1210]);
  });

  it("keeps the progression anchored on startDate when the range starts later", () => {
    // 3 occurrences avant la fenêtre : la 4e (avril) doit valoir 100 + 3×50.
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 100,
        amountDelta: 50,
        amountDeltaType: "AMOUNT",
        startDate: "2026-01-10T00:00:00.000Z",
        endDate: null,
      },
      ...range("2026-04-01", "2026-06-01"),
    );
    expect(occ.map((o) => o.amount)).toEqual([250, 300]);
  });

  it("stops at endDate (Répéter jusqu'en)", () => {
    const occ = expandManualEntry(
      {
        frequency: "MONTHLY",
        amount: 100,
        startDate: "2026-01-10T00:00:00.000Z",
        endDate: "2026-03-15T00:00:00.000Z",
      },
      ...range("2026-01-01", "2026-12-01"),
    );
    expect(occ).toHaveLength(3); // janv, févr, mars
  });

  it("returns a single occurrence for ONCE regardless of delta", () => {
    const occ = expandManualEntry(
      {
        frequency: "ONCE",
        amount: 100,
        amountDelta: 50,
        startDate: "2026-02-10T00:00:00.000Z",
        endDate: null,
      },
      ...range("2026-01-01", "2026-12-01"),
    );
    expect(occ).toHaveLength(1);
    expect(occ[0].amount).toBe(100);
  });
});
