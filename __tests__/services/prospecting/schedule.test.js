/**
 * Prospection, rythme d'envoi en heure de Paris : plage (jours, heures,
 * jours fériés français), limite effective avec montée progressive (10 les
 * 7 premiers jours, 20 du 8e au 14e), bornes de la limite, début de la
 * plage suivante (quota du fournisseur), espacement de 3 à 8 minutes,
 * estimation de fin.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  MAX_SPACING_MS,
  MIN_SPACING_MS,
  effectiveDailyLimit,
  estimateSchedule,
  isFrenchHoliday,
  isValidSendWindow,
  isWithinSendWindow,
  nextWindowStart,
  parisInstant,
  parisParts,
  randomSpacingMs,
  rampUpCap,
  weekdayOf,
} from "../../../src/services/prospecting/schedule.js";
import {
  availableProviders,
  clampDailyLimit,
  defaultDailyLimit,
  maxDailyLimit,
} from "../../../src/services/prospecting/config.js";

const WEEKDAYS = { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 };
// Mercredi 25 novembre 2026 (heure d'hiver : Paris = UTC + 1)
const at = (iso) => new Date(iso);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("heure de Paris", () => {
  it("jour, jour de la semaine et heure à Paris, quel que soit l'UTC", () => {
    expect(parisParts(at("2026-11-25T23:30:00Z"))).toMatchObject({
      day: "2026-11-26",
      weekday: 4,
      hour: 0,
      minute: 30,
    });
    // Heure d'été : UTC + 2
    expect(parisParts(at("2026-07-01T07:15:00Z"))).toMatchObject({
      day: "2026-07-01",
      hour: 9,
    });
  });

  it("instant d'une heure de Paris (hiver et été)", () => {
    expect(parisInstant("2026-11-26", 9).toISOString()).toBe(
      "2026-11-26T08:00:00.000Z",
    );
    expect(parisInstant("2026-07-02", 9).toISOString()).toBe(
      "2026-07-02T07:00:00.000Z",
    );
    // Lendemain du passage à l'heure d'été (29 mars 2026)
    expect(parisInstant("2026-03-30", 9).toISOString()).toBe(
      "2026-03-30T07:00:00.000Z",
    );
  });

  it("jours de la semaine (1 = lundi, 7 = dimanche)", () => {
    expect(weekdayOf("2026-11-23")).toBe(1);
    expect(weekdayOf("2026-11-29")).toBe(7);
  });
});

describe("plage d'envoi", () => {
  it("dans la plage : jour ouvré, de 9 h à 18 h (fin exclue)", () => {
    expect(isWithinSendWindow(WEEKDAYS, at("2026-11-25T08:00:00Z"))).toBe(true); // 9 h
    expect(isWithinSendWindow(WEEKDAYS, at("2026-11-25T07:59:00Z"))).toBe(
      false,
    ); // 8 h 59
    expect(isWithinSendWindow(WEEKDAYS, at("2026-11-25T16:59:00Z"))).toBe(true); // 17 h 59
    expect(isWithinSendWindow(WEEKDAYS, at("2026-11-25T17:00:00Z"))).toBe(
      false,
    ); // 18 h
  });

  it("jamais le week-end hors des jours choisis", () => {
    // Samedi 28 novembre 2026, 10 h
    expect(isWithinSendWindow(WEEKDAYS, at("2026-11-28T09:00:00Z"))).toBe(
      false,
    );
    expect(
      isWithinSendWindow(
        { ...WEEKDAYS, days: [6] },
        at("2026-11-28T09:00:00Z"),
      ),
    ).toBe(true);
  });

  it("jamais un jour férié français", () => {
    expect(isFrenchHoliday("2026-12-25")).toBe(true);
    expect(isFrenchHoliday("2026-11-11")).toBe(true);
    expect(isFrenchHoliday("2026-05-25")).toBe(true); // lundi de Pentecôte
    expect(isFrenchHoliday("2026-11-25")).toBe(false);
    // Vendredi 25 décembre 2026, 10 h
    expect(isWithinSendWindow(WEEKDAYS, at("2026-12-25T09:00:00Z"))).toBe(
      false,
    );
  });

  it("plage invalide : aucun jour, fin avant le début", () => {
    expect(isValidSendWindow(WEEKDAYS)).toBe(true);
    expect(isValidSendWindow({ ...WEEKDAYS, days: [] })).toBe(false);
    expect(isValidSendWindow({ ...WEEKDAYS, startHour: 18, endHour: 9 })).toBe(
      false,
    );
    expect(isWithinSendWindow({ days: [] }, at("2026-11-25T09:00:00Z"))).toBe(
      false,
    );
  });

  it("début de la plage du prochain jour d'envoi (week-end et fériés sautés)", () => {
    // Vendredi 20 novembre 2026, 15 h → lundi 23 à 9 h
    expect(
      nextWindowStart(WEEKDAYS, at("2026-11-20T14:00:00Z")).toISOString(),
    ).toBe("2026-11-23T08:00:00.000Z");
    // Jeudi 24 décembre 2026 → lundi 28 (25 décembre férié, puis week-end)
    expect(
      nextWindowStart(WEEKDAYS, at("2026-12-24T10:00:00Z")).toISOString(),
    ).toBe("2026-12-28T08:00:00.000Z");
  });
});

describe("limite du jour", () => {
  const mailbox = (connectedAt, dailyLimit = 30) => ({
    dailyLimit,
    connectedAt: new Date(connectedAt),
  });
  const now = at("2026-11-25T10:00:00Z");

  it("montée progressive : 10 les 7 premiers jours, 20 du 8e au 14e, puis la limite", () => {
    expect(rampUpCap(at("2026-11-25T09:00:00Z"), now)).toBe(10); // jour 1
    expect(rampUpCap(at("2026-11-19T10:00:00Z"), now)).toBe(10); // jour 7
    expect(rampUpCap(at("2026-11-18T10:00:00Z"), now)).toBe(20); // jour 8
    expect(rampUpCap(at("2026-11-12T10:00:00Z"), now)).toBe(20); // jour 14
    expect(rampUpCap(at("2026-11-11T10:00:00Z"), now)).toBe(Infinity); // jour 15
    expect(effectiveDailyLimit(mailbox("2026-11-25T09:00:00Z"), now)).toBe(10);
    expect(effectiveDailyLimit(mailbox("2026-11-15T09:00:00Z"), now)).toBe(20);
    expect(effectiveDailyLimit(mailbox("2026-10-01T09:00:00Z"), now)).toBe(30);
    expect(effectiveDailyLimit(mailbox("2026-11-15T09:00:00Z", 15), now)).toBe(
      15,
    );
  });

  it("limite bornée de 5 au plafond (50 par défaut, PROSPECTING_MAX_DAILY_PER_MAILBOX)", () => {
    expect(maxDailyLimit()).toBe(50);
    expect(defaultDailyLimit()).toBe(30);
    expect(clampDailyLimit(2)).toBe(5);
    expect(clampDailyLimit(500)).toBe(50);
    vi.stubEnv("PROSPECTING_MAX_DAILY_PER_MAILBOX", "20");
    expect(maxDailyLimit()).toBe(20);
    expect(defaultDailyLimit()).toBe(20);
    expect(effectiveDailyLimit(mailbox("2026-10-01T09:00:00Z", 30), now)).toBe(
      20,
    );
  });

  it("espacement de 3 à 8 minutes", () => {
    for (let i = 0; i < 200; i += 1) {
      const delay = randomSpacingMs();
      expect(delay).toBeGreaterThanOrEqual(MIN_SPACING_MS);
      expect(delay).toBeLessThanOrEqual(MAX_SPACING_MS);
    }
    expect(MIN_SPACING_MS).toBe(3 * 60 * 1000);
    expect(MAX_SPACING_MS).toBe(8 * 60 * 1000);
  });
});

describe("estimation de fin", () => {
  const settled = {
    dailyLimit: 30,
    connectedAt: at("2026-09-01T08:00:00Z"),
    sendWindow: WEEKDAYS,
  };

  it("jours ouvrés d'envoi au rythme de la boîte (week-end exclu)", () => {
    // Mercredi 25 à 7 h (avant la plage) : 30 par jour, 100 e-mails
    expect(
      estimateSchedule({
        mailbox: settled,
        count: 100,
        now: at("2026-11-25T06:00:00Z"),
      }),
    ).toEqual({ days: 4, endDate: "2026-11-30" });
  });

  it("montée progressive comprise, envois du jour déduits", () => {
    // Boîte connectée ce matin : 10 par jour, dont 5 déjà partis aujourd'hui
    const fresh = { ...settled, connectedAt: at("2026-11-25T08:00:00Z") };
    expect(
      estimateSchedule({
        mailbox: fresh,
        count: 25,
        sentToday: 5,
        now: at("2026-11-25T09:00:00Z"),
      }),
    ).toEqual({ days: 3, endDate: "2026-11-27" });
    expect(
      estimateSchedule({
        mailbox: fresh,
        count: 26,
        sentToday: 5,
        now: at("2026-11-25T09:00:00Z"),
      }),
    ).toEqual({ days: 4, endDate: "2026-11-30" });
  });

  it("rien à envoyer ou plage invalide : pas d'estimation", () => {
    expect(estimateSchedule({ mailbox: settled, count: 0 })).toBeNull();
    expect(
      estimateSchedule({
        mailbox: { ...settled, sendWindow: { days: [] } },
        count: 5,
      }),
    ).toBeNull();
  });
});

describe("fournisseurs configurés", () => {
  it("Google : identifiants dédiés seulement, jamais ceux du calendrier", () => {
    const env = {
      GOOGLE_CALENDAR_CLIENT_ID: "cal",
      GOOGLE_CALENDAR_CLIENT_SECRET: "cal-secret",
    };
    expect(availableProviders(env).google).toBe(false);
    expect(
      availableProviders({
        ...env,
        PROSPECTING_GOOGLE_CLIENT_ID: "id",
        PROSPECTING_GOOGLE_CLIENT_SECRET: "secret",
      }).google,
    ).toBe(true);
  });

  it("Microsoft : identifiants dédiés, repli sur ceux du calendrier", () => {
    expect(availableProviders({}).microsoft).toBe(false);
    expect(
      availableProviders({
        MICROSOFT_CALENDAR_CLIENT_ID: "cal",
        MICROSOFT_CALENDAR_CLIENT_SECRET: "cal-secret",
      }).microsoft,
    ).toBe(true);
    expect(
      availableProviders({
        PROSPECTING_MICROSOFT_CLIENT_ID: "id",
        PROSPECTING_MICROSOFT_CLIENT_SECRET: "",
      }).microsoft,
    ).toBe(false);
  });
});
