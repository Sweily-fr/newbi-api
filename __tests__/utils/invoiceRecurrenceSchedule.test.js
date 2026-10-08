import { describe, it, expect } from "vitest";
import {
  addMonths,
  isDayString,
  nextOccurrenceFrom,
  occurrenceDate,
  parisDay,
  paymentDelayDays,
  refreshPrefixDate,
} from "../../src/utils/invoiceRecurrenceSchedule.js";

describe("calendrier des factures récurrentes", () => {
  it("valide les jours AAAA-MM-JJ", () => {
    expect(isDayString("2026-10-08")).toBe(true);
    expect(isDayString("2026-02-30")).toBe(false);
    expect(isDayString("08/10/2026")).toBe(false);
    expect(isDayString(null)).toBe(false);
  });

  it("donne le jour calendaire de Paris, pas celui du serveur", () => {
    // 23h30 UTC le 8 = 1h30 à Paris le 9 (heure d'été)
    expect(parisDay(new Date("2026-10-08T23:30:00Z"))).toBe("2026-10-09");
    expect(parisDay(new Date("2026-10-08T12:00:00Z"))).toBe("2026-10-08");
  });

  it("garde le jour d'ancrage des mensualités sans dériver après un mois court", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    const rec = { startDate: "2026-01-31", frequency: "MONTHLY", interval: 1 };
    expect(occurrenceDate(rec, 1)).toBe("2026-02-28");
    expect(occurrenceDate(rec, 2)).toBe("2026-03-31");
    expect(occurrenceDate(rec, 12)).toBe("2027-01-31");
  });

  it("calcule les échéances quotidiennes, hebdomadaires et à intervalle", () => {
    expect(
      occurrenceDate({ startDate: "2026-12-30", frequency: "DAILY" }, 3),
    ).toBe("2027-01-02");
    expect(
      occurrenceDate({ startDate: "2026-10-08", frequency: "WEEKLY" }, 2),
    ).toBe("2026-10-22");
    expect(
      occurrenceDate(
        { startDate: "2026-10-08", frequency: "MONTHLY", interval: 3 },
        1,
      ),
    ).toBe("2027-01-08");
  });

  it("trouve la prochaine échéance à partir d'un jour donné", () => {
    const rec = { startDate: "2026-01-15", frequency: "MONTHLY", interval: 1 };
    expect(nextOccurrenceFrom(rec, "2026-01-01")).toBe("2026-01-15");
    expect(nextOccurrenceFrom(rec, "2026-01-15")).toBe("2026-01-15");
    expect(nextOccurrenceFrom(rec, "2026-01-15", { strict: true })).toBe(
      "2026-02-15",
    );
    expect(nextOccurrenceFrom(rec, "2026-10-16")).toBe("2026-11-15");
    // Longue période : l'estimation ne doit jamais sauter une échéance
    expect(nextOccurrenceFrom(rec, "2036-01-15")).toBe("2036-01-15");
    expect(nextOccurrenceFrom(rec, "2036-01-16")).toBe("2036-02-15");
  });

  it("ne trouve plus d'échéance après la date de fin", () => {
    const rec = {
      startDate: "2026-10-08",
      frequency: "WEEKLY",
      interval: 1,
      endDate: "2026-10-20",
    };
    expect(nextOccurrenceFrom(rec, "2026-10-09")).toBe("2026-10-15");
    expect(nextOccurrenceFrom(rec, "2026-10-15", { strict: true })).toBeNull();
  });

  it("recale le préfixe sur le mois de l'échéance comme l'éditeur", () => {
    expect(refreshPrefixDate("F-092026", "2026-11-03")).toBe("F-112026");
    expect(refreshPrefixDate("F-2026-09", "2027-01-03")).toBe("F-2027-01");
    expect(refreshPrefixDate("FAC2026", "2027-01-03")).toBe("FAC2027");
    expect(refreshPrefixDate("FACT", "2027-01-03")).toBe("FACT");
  });

  it("conserve le délai de paiement du modèle", () => {
    expect(
      paymentDelayDays(new Date("2026-10-01"), new Date("2026-10-31")),
    ).toBe(30);
    expect(
      paymentDelayDays(new Date("2026-10-01"), new Date("2026-10-01")),
    ).toBe(0);
    expect(paymentDelayDays(new Date("2026-10-01"), null)).toBe(30);
  });
});
