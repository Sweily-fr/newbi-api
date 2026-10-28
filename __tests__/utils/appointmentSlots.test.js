/**
 * Moteur de créneaux de la prise de rendez-vous (fonction pure) :
 * changements d'heure, exceptions, marges, préavis, horizon, plafond
 * quotidien, alignement, fuseau de page autre que Paris.
 */
import { describe, it, expect } from "vitest";
import {
  computeAvailableSlots,
  localDayOf,
  addDays,
  dayBounds,
} from "../../src/utils/appointmentSlots.js";
import { DEFAULT_AVAILABILITY } from "../../src/utils/appointmentValidation.js";

const iso = (slots) => slots.map((s) => s.start.toISOString());

const basePage = (overrides = {}) => ({
  timezone: "Europe/Paris",
  availability: DEFAULT_AVAILABILITY,
  dateOverrides: [],
  ...overrides,
});

const baseType = (overrides = {}) => ({
  _id: "type-a",
  durationMinutes: 30,
  slotIntervalMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
  maxDaysAhead: 365,
  maxPerDay: null,
  ...overrides,
});

// Dimanche ouvert la nuit (plage qui contient le changement d'heure) et le matin
const sundayNight = basePage({
  availability: [
    ...DEFAULT_AVAILABILITY,
    {
      dayOfWeek: 7,
      intervals: [
        { start: "01:00", end: "04:00" },
        { start: "09:00", end: "10:00" },
      ],
    },
  ],
});

const slotsOn = (day, { page = basePage(), type = baseType(), ...rest } = {}) =>
  computeAvailableSlots({
    page,
    type,
    // 1er janvier de l'année du jour testé : dans l'horizon d'un an
    now: new Date(`${day.slice(0, 4)}-01-01T00:00:00Z`),
    from: day,
    to: day,
    ...rest,
  });

describe("computeAvailableSlots : journée ordinaire", () => {
  it("découpe les plages du lundi en créneaux de 30 minutes (heure d'hiver)", () => {
    const slots = slotsOn("2026-11-02");
    expect(slots).toHaveLength(14);
    expect(slots[0].start.toISOString()).toBe("2026-11-02T08:00:00.000Z");
    expect(slots[0].end.toISOString()).toBe("2026-11-02T08:30:00.000Z");
    expect(slots[5].start.toISOString()).toBe("2026-11-02T10:30:00.000Z");
    expect(slots[6].start.toISOString()).toBe("2026-11-02T13:00:00.000Z");
    expect(slots.at(-1).start.toISOString()).toBe("2026-11-02T16:30:00.000Z");
  });

  it("ne propose rien le samedi (jour sans plage)", () => {
    expect(slotsOn("2026-10-31")).toEqual([]);
  });

  it("accepte 24:00 comme fin de journée", () => {
    const page = basePage({
      availability: [
        { dayOfWeek: 1, intervals: [{ start: "23:00", end: "24:00" }] },
      ],
    });
    expect(iso(slotsOn("2026-11-02", { page }))).toEqual([
      "2026-11-02T22:00:00.000Z",
      "2026-11-02T22:30:00.000Z",
    ]);
  });
});

describe("computeAvailableSlots : changements d'heure", () => {
  it("29/03/2026 (heure d'été) : 9 h vaut 8 h UTC le vendredi, 7 h UTC le lundi", () => {
    expect(slotsOn("2026-03-27")[0].start.toISOString()).toBe(
      "2026-03-27T08:00:00.000Z",
    );
    expect(slotsOn("2026-03-30")[0].start.toISOString()).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });

  it("29/03/2026 : la plage 01:00-04:00 ne dure que 2 h, sans 02:00 ni 02:30", () => {
    const slots = slotsOn("2026-03-29", { page: sundayNight });
    expect(iso(slots)).toEqual([
      "2026-03-29T00:00:00.000Z", // 01:00 CET
      "2026-03-29T00:30:00.000Z", // 01:30 CET
      "2026-03-29T01:00:00.000Z", // 03:00 CEST
      "2026-03-29T01:30:00.000Z", // 03:30 CEST
      "2026-03-29T07:00:00.000Z", // 09:00 CEST
      "2026-03-29T07:30:00.000Z",
    ]);
  });

  it("29/03/2026 : une heure de rendez-vous à cheval sur le changement dure 60 vraies minutes", () => {
    const page = basePage({
      availability: [
        { dayOfWeek: 7, intervals: [{ start: "01:30", end: "03:30" }] },
      ],
    });
    const slots = slotsOn("2026-03-29", {
      page,
      type: baseType({ durationMinutes: 60 }),
    });
    expect(slots).toHaveLength(1);
    expect(slots[0].start.toISOString()).toBe("2026-03-29T00:30:00.000Z");
    expect(slots[0].end.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("25/10/2026 (heure d'hiver) : 02:00 et 02:30 apparaissent deux fois", () => {
    const slots = slotsOn("2026-10-25", { page: sundayNight });
    expect(iso(slots)).toEqual([
      "2026-10-24T23:00:00.000Z", // 01:00 CEST
      "2026-10-24T23:30:00.000Z", // 01:30 CEST
      "2026-10-25T00:00:00.000Z", // 02:00 CEST
      "2026-10-25T00:30:00.000Z", // 02:30 CEST
      "2026-10-25T01:00:00.000Z", // 02:00 CET
      "2026-10-25T01:30:00.000Z", // 02:30 CET
      "2026-10-25T02:00:00.000Z", // 03:00 CET
      "2026-10-25T02:30:00.000Z", // 03:30 CET
      "2026-10-25T08:00:00.000Z", // 09:00 CET
      "2026-10-25T08:30:00.000Z",
    ]);
  });

  it("25/10/2026 : 9 h vaut 7 h UTC le vendredi, 8 h UTC le lundi", () => {
    expect(slotsOn("2026-10-23")[0].start.toISOString()).toBe(
      "2026-10-23T07:00:00.000Z",
    );
    expect(slotsOn("2026-10-26")[0].start.toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });

  it("28/03/2027 : passage à l'heure d'été", () => {
    expect(slotsOn("2027-03-26")[0].start.toISOString()).toBe(
      "2027-03-26T08:00:00.000Z",
    );
    expect(slotsOn("2027-03-29")[0].start.toISOString()).toBe(
      "2027-03-29T07:00:00.000Z",
    );
    const night = slotsOn("2027-03-28", { page: sundayNight });
    expect(
      night.filter((s) => s.start < new Date("2027-03-28T05:00:00Z")),
    ).toHaveLength(4);
  });

  it("31/10/2027 : retour à l'heure d'hiver", () => {
    expect(slotsOn("2027-10-29")[0].start.toISOString()).toBe(
      "2027-10-29T07:00:00.000Z",
    );
    expect(slotsOn("2027-11-01")[0].start.toISOString()).toBe(
      "2027-11-01T08:00:00.000Z",
    );
    const night = slotsOn("2027-10-31", { page: sundayNight });
    expect(
      night.filter((s) => s.start < new Date("2027-10-31T05:00:00Z")),
    ).toHaveLength(8);
  });

  it("une plage de plusieurs jours enjambe le changement d'heure sans décalage", () => {
    const slots = computeAvailableSlots({
      page: basePage(),
      type: baseType(),
      now: new Date("2026-01-01T00:00:00Z"),
      from: "2026-10-23",
      to: "2026-10-26",
    });
    const firstOfDay = (day) => slots.find((s) => localDayOf(s.start) === day);
    expect(firstOfDay("2026-10-23").start.toISOString()).toBe(
      "2026-10-23T07:00:00.000Z",
    );
    expect(firstOfDay("2026-10-26").start.toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
    expect(
      slots.filter((s) => localDayOf(s.start) === "2026-10-24"),
    ).toHaveLength(0);
  });
});

describe("computeAvailableSlots : exceptions par date", () => {
  it("un jour fermé (liste vide) ne propose rien", () => {
    const page = basePage({
      dateOverrides: [{ date: "2026-11-02", intervals: [] }],
    });
    expect(slotsOn("2026-11-02", { page })).toEqual([]);
    // Le lendemain garde la semaine type
    expect(slotsOn("2026-11-03", { page })).toHaveLength(14);
  });

  it("des horaires spéciaux remplacent la semaine type, même un samedi", () => {
    const page = basePage({
      dateOverrides: [
        { date: "2026-11-02", intervals: [{ start: "10:00", end: "11:00" }] },
        { date: "2026-10-31", intervals: [{ start: "09:00", end: "09:30" }] },
      ],
    });
    expect(iso(slotsOn("2026-11-02", { page }))).toEqual([
      "2026-11-02T09:00:00.000Z",
      "2026-11-02T09:30:00.000Z",
    ]);
    expect(iso(slotsOn("2026-10-31", { page }))).toEqual([
      "2026-10-31T08:00:00.000Z",
    ]);
  });
});

describe("computeAvailableSlots : occupation et marges", () => {
  const page = basePage({
    availability: [
      { dayOfWeek: 1, intervals: [{ start: "09:00", end: "12:00" }] },
    ],
  });
  // 10:00-10:30 heure de Paris le lundi 2 novembre 2026
  const busy = [
    {
      start: new Date("2026-11-02T09:00:00Z"),
      end: new Date("2026-11-02T09:30:00Z"),
    },
  ];

  it("retire les créneaux qui chevauchent un intervalle occupé", () => {
    expect(iso(slotsOn("2026-11-02", { page, busy }))).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T08:30:00.000Z",
      "2026-11-02T09:30:00.000Z",
      "2026-11-02T10:00:00.000Z",
      "2026-11-02T10:30:00.000Z",
    ]);
  });

  it("élargit chaque créneau de ses marges avant et après", () => {
    const type = baseType({ bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
    expect(iso(slotsOn("2026-11-02", { page, type, busy }))).toEqual([
      "2026-11-02T08:00:00.000Z", // 09:00 (fenêtre 08:45-09:45)
      "2026-11-02T10:00:00.000Z", // 11:00 (fenêtre 10:45-11:45)
      "2026-11-02T10:30:00.000Z",
    ]);
  });

  it("élargit une réservation existante de ses propres marges", () => {
    const bookings = [
      {
        startAt: new Date("2026-11-02T09:00:00Z"),
        endAt: new Date("2026-11-02T09:30:00Z"),
        status: "CONFIRMED",
        appointmentTypeId: "type-b",
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 30,
      },
    ];
    expect(iso(slotsOn("2026-11-02", { page, bookings }))).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T08:30:00.000Z",
      "2026-11-02T10:00:00.000Z", // 11:00 : la marge de 30 min court jusqu'à 11:00
      "2026-11-02T10:30:00.000Z",
    ]);
  });

  it("reprend les marges du type courant quand celles de la réservation sont inconnues", () => {
    const type = baseType({ bufferBeforeMinutes: 0, bufferAfterMinutes: 30 });
    const bookings = [
      {
        startAt: new Date("2026-11-02T09:00:00Z"),
        endAt: new Date("2026-11-02T09:30:00Z"),
        status: "CONFIRMED",
      },
    ];
    // Réservation 10:00-10:30 élargie à 11:00 ; créneau 09:30 élargi à 10:30
    expect(iso(slotsOn("2026-11-02", { page, type, bookings }))).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T10:00:00.000Z",
      "2026-11-02T10:30:00.000Z",
    ]);
  });

  it("ignore les réservations annulées", () => {
    const bookings = [
      {
        startAt: new Date("2026-11-02T09:00:00Z"),
        endAt: new Date("2026-11-02T09:30:00Z"),
        status: "CANCELLED",
      },
    ];
    expect(slotsOn("2026-11-02", { page, bookings })).toHaveLength(6);
  });
});

describe("computeAvailableSlots : préavis et horizon", () => {
  it("respecte le préavis minimal", () => {
    // Lundi 2 novembre 2026, 09:40 à Paris ; préavis 60 min → 11:00 au plus tôt
    const slots = computeAvailableSlots({
      page: basePage(),
      type: baseType({ minNoticeMinutes: 60 }),
      now: new Date("2026-11-02T08:40:00Z"),
      from: "2026-11-02",
      to: "2026-11-02",
    });
    expect(slots[0].start.toISOString()).toBe("2026-11-02T10:00:00.000Z");
  });

  it("ne remonte jamais avant aujourd'hui", () => {
    const slots = computeAvailableSlots({
      page: basePage(),
      type: baseType(),
      now: new Date("2026-11-03T12:00:00Z"),
      from: "2026-11-02",
      to: "2026-11-03",
    });
    expect(slots.every((s) => localDayOf(s.start) === "2026-11-03")).toBe(true);
    expect(slots[0].start.toISOString()).toBe("2026-11-03T13:00:00.000Z");
  });

  it("s'arrête à l'horizon (aujourd'hui + maxDaysAhead, jour de la page)", () => {
    const slots = computeAvailableSlots({
      page: basePage(),
      type: baseType({ maxDaysAhead: 1 }),
      // Lundi 2 novembre, 23:30 à Paris (22:30 UTC) : aujourd'hui = lundi
      now: new Date("2026-11-02T22:30:00Z"),
      from: "2026-11-02",
      to: "2026-11-06",
    });
    const days = [...new Set(slots.map((s) => localDayOf(s.start)))];
    expect(days).toEqual(["2026-11-03"]);
  });
});

describe("computeAvailableSlots : plafond quotidien", () => {
  const confirmedOn = (startIso, typeId = "type-a", status = "CONFIRMED") => ({
    startAt: new Date(startIso),
    endAt: new Date(new Date(startIso).getTime() + 30 * 60 * 1000),
    appointmentTypeId: typeId,
    status,
  });

  it("ferme la journée quand le plafond de ce type est atteint", () => {
    const type = baseType({ maxPerDay: 2 });
    const bookings = [
      confirmedOn("2026-11-02T08:00:00Z"),
      confirmedOn("2026-11-02T13:00:00Z"),
    ];
    expect(slotsOn("2026-11-02", { type, bookings })).toEqual([]);
    expect(slotsOn("2026-11-03", { type, bookings })).toHaveLength(14);
  });

  it("ne compte ni les annulations ni les autres types", () => {
    const type = baseType({ maxPerDay: 2 });
    const bookings = [
      confirmedOn("2026-11-02T08:00:00Z"),
      confirmedOn("2026-11-02T13:00:00Z", "type-a", "CANCELLED"),
      confirmedOn("2026-11-02T14:00:00Z", "type-b"),
    ];
    expect(slotsOn("2026-11-02", { type, bookings }).length).toBeGreaterThan(0);
  });

  it("compte par jour de la page, pas par jour UTC", () => {
    const type = baseType({ maxPerDay: 1 });
    // 00:30 le 3 novembre à Paris = 23:30 UTC le 2 novembre
    const bookings = [confirmedOn("2026-11-02T23:30:00Z")];
    expect(slotsOn("2026-11-02", { type, bookings })).toHaveLength(14);
    expect(slotsOn("2026-11-03", { type, bookings })).toEqual([]);
  });
});

describe("computeAvailableSlots : alignement et durée", () => {
  it("part du début de la plage, au pas du type", () => {
    const page = basePage({
      availability: [
        { dayOfWeek: 1, intervals: [{ start: "09:15", end: "11:00" }] },
      ],
    });
    expect(iso(slotsOn("2026-11-02", { page }))).toEqual([
      "2026-11-02T08:15:00.000Z",
      "2026-11-02T08:45:00.000Z",
      "2026-11-02T09:15:00.000Z",
    ]);
  });

  it("un pas plus court que la durée fait se recouvrir les créneaux", () => {
    const page = basePage({
      availability: [
        { dayOfWeek: 1, intervals: [{ start: "09:00", end: "10:30" }] },
      ],
    });
    const type = baseType({ durationMinutes: 60, slotIntervalMinutes: 15 });
    expect(iso(slotsOn("2026-11-02", { page, type }))).toEqual([
      "2026-11-02T08:00:00.000Z",
      "2026-11-02T08:15:00.000Z",
      "2026-11-02T08:30:00.000Z",
    ]);
  });

  it("ne propose rien dans une plage plus courte que le rendez-vous", () => {
    const page = basePage({
      availability: [
        { dayOfWeek: 1, intervals: [{ start: "09:00", end: "09:20" }] },
      ],
    });
    expect(slotsOn("2026-11-02", { page })).toEqual([]);
  });
});

describe("computeAvailableSlots : fuseau de page autre que Paris", () => {
  const newYork = basePage({ timezone: "America/New_York" });

  it("calcule les heures dans le fuseau de la page (New York)", () => {
    // Heure d'été américaine jusqu'au 1er novembre 2026
    expect(
      slotsOn("2026-10-30", { page: newYork })[0].start.toISOString(),
    ).toBe("2026-10-30T13:00:00.000Z");
    expect(
      slotsOn("2026-11-02", { page: newYork })[0].start.toISOString(),
    ).toBe("2026-11-02T14:00:00.000Z");
  });

  it("le jour de la page décide du préavis et de l'horizon", () => {
    // 21:00 le 2 novembre à New York = 02:00 UTC le 3 novembre
    const slots = computeAvailableSlots({
      page: newYork,
      type: baseType({ maxDaysAhead: 0 }),
      now: new Date("2026-11-03T02:00:00Z"),
      from: "2026-11-02",
      to: "2026-11-05",
    });
    expect(slots).toEqual([]); // plus aucune plage le 2 novembre après 21:00
  });

  it("Tokyo (sans heure d'été)", () => {
    const tokyo = basePage({ timezone: "Asia/Tokyo" });
    expect(slotsOn("2026-11-02", { page: tokyo })[0].start.toISOString()).toBe(
      "2026-11-02T00:00:00.000Z",
    );
  });

  it("un fuseau invalide retombe sur Paris", () => {
    const page = basePage({ timezone: "Pas/Un_Fuseau" });
    expect(slotsOn("2026-11-02", { page })[0].start.toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    );
  });
});

describe("outils de dates", () => {
  it("addDays et dayBounds suivent le calendrier local", () => {
    expect(addDays("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    const { start, end } = dayBounds("2026-03-29", "Europe/Paris");
    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    // Journée de 23 heures
    expect(end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
  });

  it("des dates invalides ne donnent aucun créneau", () => {
    expect(
      computeAvailableSlots({
        page: basePage(),
        type: baseType(),
        from: "2026-02-31",
        to: "2026-03-02",
      }),
    ).toEqual([]);
  });
});
