/**
 * Règles de saisie de la prise de rendez-vous : adresses, plages horaires,
 * exceptions, lieux.
 */
import { describe, it, expect } from "vitest";
import {
  AppointmentInputError,
  locationLabel,
  normalizeAvailability,
  normalizeDateOverrides,
  normalizeIntervals,
  normalizeLocation,
  normalizeSlug,
  phoneRequired,
  slugify,
} from "../../src/utils/appointmentValidation.js";

describe("normalizeSlug", () => {
  it("accepte 3 à 40 caractères en minuscules, chiffres et tirets", () => {
    expect(normalizeSlug("jean-dupont")).toBe("jean-dupont");
    expect(normalizeSlug(" Cabinet-42 ")).toBe("cabinet-42");
    expect(normalizeSlug("abc")).toBe("abc");
  });

  it("refuse les formes invalides", () => {
    for (const slug of [
      "ab",
      "-abc",
      "abc-",
      "jean dupont",
      "élise",
      "a".repeat(41),
    ]) {
      expect(() => normalizeSlug(slug)).toThrow(AppointmentInputError);
    }
  });

  it("refuse les adresses réservées (pages) mais pas pour un type", () => {
    expect(() => normalizeSlug("gerer")).toThrow(/réservée/);
    expect(() => normalizeSlug("admin")).toThrow(/réservée/);
    expect(normalizeSlug("support", { checkReserved: false })).toBe("support");
  });

  it("slugify propose une adresse valide", () => {
    expect(slugify("Rendez-vous de 30 min")).toBe("rendez-vous-de-30-min");
    expect(slugify("Élodie Béranger")).toBe("elodie-beranger");
    expect(slugify("!!")).toBe("rendez-vous");
  });
});

describe("normalizeIntervals", () => {
  it("trie les plages et accepte deux plages qui se touchent", () => {
    expect(
      normalizeIntervals([
        { start: "14:00", end: "18:00" },
        { start: "09:00", end: "14:00" },
      ]),
    ).toEqual([
      { start: "09:00", end: "14:00" },
      { start: "14:00", end: "18:00" },
    ]);
  });

  it("refuse un chevauchement, une fin avant le début et un mauvais format", () => {
    expect(() =>
      normalizeIntervals([
        { start: "09:00", end: "12:00" },
        { start: "11:00", end: "13:00" },
      ]),
    ).toThrow(/chevaucher/);
    expect(() =>
      normalizeIntervals([{ start: "12:00", end: "09:00" }]),
    ).toThrow(/après son début/);
    expect(() => normalizeIntervals([{ start: "9h", end: "10:00" }])).toThrow(
      /HH:mm/,
    );
    expect(() =>
      normalizeIntervals([{ start: "24:00", end: "24:00" }]),
    ).toThrow();
  });

  it("accepte 24:00 en fin de plage seulement", () => {
    expect(normalizeIntervals([{ start: "20:00", end: "24:00" }])).toHaveLength(
      1,
    );
  });
});

describe("normalizeAvailability et normalizeDateOverrides", () => {
  it("refuse un jour en double ou hors 1-7", () => {
    expect(() =>
      normalizeAvailability([
        { dayOfWeek: 1, intervals: [] },
        { dayOfWeek: 1, intervals: [] },
      ]),
    ).toThrow(/qu'une fois/);
    expect(() =>
      normalizeAvailability([{ dayOfWeek: 0, intervals: [] }]),
    ).toThrow();
  });

  it("valide les dates des exceptions et accepte un jour fermé", () => {
    expect(
      normalizeDateOverrides([{ date: "2026-12-25", intervals: [] }]),
    ).toEqual([{ date: "2026-12-25", intervals: [] }]);
    expect(() =>
      normalizeDateOverrides([{ date: "2026-02-30", intervals: [] }]),
    ).toThrow(/invalide/);
    expect(() =>
      normalizeDateOverrides([
        { date: "2026-12-25", intervals: [] },
        { date: "2026-12-25", intervals: [] },
      ]),
    ).toThrow(/Une seule/);
  });
});

describe("normalizeLocation", () => {
  it("exige un agenda Google pour Meet et Microsoft pour Teams", () => {
    expect(() => normalizeLocation({ kind: "GOOGLE_MEET" }, {})).toThrow(
      /Google/,
    );
    expect(() =>
      normalizeLocation({ kind: "TEAMS" }, { google: true }),
    ).toThrow(/Microsoft/);
    expect(
      normalizeLocation({ kind: "GOOGLE_MEET", value: "x" }, { google: true }),
    ).toEqual({
      kind: "GOOGLE_MEET",
      value: null,
    });
  });

  it("exige une adresse https pour un lien et une adresse pour un rendez-vous en personne", () => {
    expect(() => normalizeLocation({ kind: "CUSTOM_LINK" })).toThrow(/https/);
    expect(() =>
      normalizeLocation({ kind: "CUSTOM_LINK", value: "http://zoom.us/j/1" }),
    ).toThrow(/https/);
    expect(
      normalizeLocation({ kind: "CUSTOM_LINK", value: "https://zoom.us/j/1" })
        .value,
    ).toBe("https://zoom.us/j/1");
    expect(() => normalizeLocation({ kind: "IN_PERSON", value: "  " })).toThrow(
      /adresse/,
    );
  });

  it("libellés et téléphone obligatoire", () => {
    expect(locationLabel({ kind: "TEAMS" })).toBe("Microsoft Teams");
    expect(locationLabel({ kind: "IN_PERSON", value: "1 rue de Paris" })).toBe(
      "1 rue de Paris",
    );
    expect(phoneRequired({ location: { kind: "PHONE" } })).toBe(true);
    expect(
      phoneRequired({ requirePhone: true, location: { kind: "TEAMS" } }),
    ).toBe(true);
    expect(phoneRequired({ location: { kind: "TEAMS" } })).toBe(false);
  });
});
