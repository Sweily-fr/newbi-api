/**
 * Recalage des dates d'un brouillon à sa finalisation (fonction pure).
 * « Aujourd'hui » est le jour de Paris, y compris entre minuit et 1 h (2 h
 * l'été), quand le jour UTC du serveur est encore la veille.
 */
import { describe, it, expect } from "vitest";
import { startOfTodayInParis } from "../../src/utils/parisDay.js";
import { refreshDraftDates } from "../../src/utils/draftDates.js";

/** Date « jour » telle que l'API la stocke (minuit UTC). */
const jour = (aaaammjj) => new Date(`${aaaammjj}T00:00:00.000Z`);
const iso = (date) => date.toISOString().slice(0, 10);

describe("startOfTodayInParis", () => {
  it.each([
    [
      "nuit d'hiver : Paris a déjà changé de jour",
      "2026-11-23T23:15:00Z",
      "2026-11-24",
    ],
    ["une minute avant minuit à Paris", "2026-11-23T22:59:00Z", "2026-11-23"],
    ["en journée : même jour qu'en UTC", "2026-11-24T10:00:00Z", "2026-11-24"],
    ["nuit d'été (UTC+2)", "2026-07-01T22:30:00Z", "2026-07-02"],
    ["passage à l'année suivante", "2026-12-31T23:30:00Z", "2027-01-01"],
  ])("%s", (_, maintenant, attendu) => {
    const debut = startOfTodayInParis(new Date(maintenant));
    expect(debut.toISOString()).toBe(`${attendu}T00:00:00.000Z`);
  });
});

describe("refreshDraftDates", () => {
  it("à 0 h 15 à Paris, recale un brouillon de la veille sur le jour de Paris", () => {
    // 24/11 à 0 h 15 à Paris, encore le 23/11 en UTC : le site affiche le 24/11.
    const r = refreshDraftDates(
      jour("2026-11-23"),
      jour("2026-12-23"),
      new Date("2026-11-23T23:15:00Z"),
    );
    expect(r.changed).toBe(true);
    expect(iso(r.issueDate)).toBe("2026-11-24");
    expect(iso(r.secondDate)).toBe("2026-12-24");
  });

  it("à 0 h 15 à Paris, garde un brouillon déjà daté du jour de Paris", () => {
    const r = refreshDraftDates(
      jour("2026-11-24"),
      jour("2026-12-24"),
      new Date("2026-11-23T23:15:00Z"),
    );
    expect(r.changed).toBe(false);
    expect(iso(r.issueDate)).toBe("2026-11-24");
  });

  it("en journée, ramène une émission passée au jour même et garde le délai", () => {
    const r = refreshDraftDates(
      jour("2026-11-10"),
      jour("2026-11-25"),
      new Date("2026-11-24T10:00:00Z"),
    );
    expect(r.changed).toBe(true);
    expect(r.issueDate.toISOString()).toBe("2026-11-24T00:00:00.000Z");
    expect(iso(r.secondDate)).toBe("2026-12-09"); // 15 jours conservés
  });

  it("seconde date antérieure à l'émission : délai de 30 jours", () => {
    const r = refreshDraftDates(
      jour("2026-11-10"),
      jour("2026-11-01"),
      new Date("2026-11-24T10:00:00Z"),
    );
    expect(iso(r.secondDate)).toBe("2026-12-24");
  });

  it("n'invente pas de seconde date absente", () => {
    const r = refreshDraftDates(
      jour("2026-11-10"),
      null,
      new Date("2026-11-24T10:00:00Z"),
    );
    expect(r.changed).toBe(true);
    expect(r.secondDate).toBeNull();
  });

  it("laisse une émission future telle quelle", () => {
    const r = refreshDraftDates(
      jour("2026-11-30"),
      jour("2026-12-30"),
      new Date("2026-11-24T10:00:00Z"),
    );
    expect(r.changed).toBe(false);
    expect(iso(r.issueDate)).toBe("2026-11-30");
  });

  it("accepte une chaîne « AAAA-MM-JJ » et ignore une date invalide", () => {
    const maintenant = new Date("2026-11-24T10:00:00Z");
    expect(
      iso(refreshDraftDates("2026-11-20", "2026-12-20", maintenant).issueDate),
    ).toBe("2026-11-24");
    expect(refreshDraftDates("pas une date", null, maintenant)).toEqual({
      issueDate: null,
      secondDate: null,
      changed: false,
    });
  });
});
