/**
 * Agenda Apple : l'adresse CalDAV fournie ne vise jamais le réseau interne.
 *
 * connectAppleCalendar transmettait calDavUrl telle quelle au client CalDAV :
 * le serveur envoyait ses requêtes (avec l'identifiant en Basic) vers
 * 127.0.0.1, 169.254.169.254, 10.x… et le message d'erreur renvoyé
 * cartographiait le réseau. Seul iCloud en https est accepté, et le refus
 * a lieu avant toute requête, avec un message qui ne dit rien de l'adresse.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
});

const dav = vi.hoisted(() => ({
  createDAVClient: vi.fn(async () => ({
    fetchCalendars: async () => [{ url: "https://caldav.icloud.com/1/" }],
  })),
}));
vi.mock("tsdav", () => dav);
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  syncConnection: vi.fn(async () => {}),
  pushEventToCalendar: vi.fn(async () => {}),
  disconnectCalendar: vi.fn(async () => {}),
}));
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
  cleanupWebhookForConnection: vi.fn(),
  registerWebhookForConnection: vi.fn(),
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import AppleCalendarProvider, {
  CALDAV_URL_REFUSED,
  isAllowedCalDavUrl,
} from "../../src/services/calendar/providers/AppleCalendarProvider.js";
import calendarConnectionResolvers from "../../src/resolvers/calendarConnection.js";
import CalendarConnection from "../../src/models/CalendarConnection.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

beforeEach(() => {
  dav.createDAVClient.mockClear();
});

const INTERNES = [
  "http://127.0.0.1:2019/",
  "http://localhost:6379/",
  "http://169.254.169.254/latest/meta-data/",
  "http://10.0.0.1/",
  "https://192.168.1.10/caldav/",
  "file:///etc/passwd",
  "http://caldav.icloud.com/",
  "https://caldav.icloud.com:8443/",
  "https://user:pass@caldav.icloud.com/",
  "https://caldav.icloud.com.evil.test/",
  "https://evil.test/caldav.icloud.com",
  "pas une adresse",
];

describe("isAllowedCalDavUrl", () => {
  it.each(INTERNES)("refuse %s", (url) => {
    expect(isAllowedCalDavUrl(url)).toBe(false);
  });

  it.each([
    undefined,
    null,
    "",
    "https://caldav.icloud.com",
    "https://caldav.icloud.com/",
    "https://p42-caldav.icloud.com/123/calendars/",
  ])("accepte %s", (url) => {
    expect(isAllowedCalDavUrl(url)).toBe(true);
  });
});

describe("AppleCalendarProvider", () => {
  it("ne contacte jamais une adresse refusée (connexion et synchronisation)", async () => {
    const provider = new AppleCalendarProvider();

    const validation = await provider.validateCredentials(
      "a@icloud.com",
      "mdp",
      "http://127.0.0.1:2019/",
    );
    expect(validation).toEqual({ valid: false, error: CALDAV_URL_REFUSED });

    await expect(
      provider.connect("a@icloud.com", "mdp", "http://169.254.169.254/"),
    ).rejects.toThrow(CALDAV_URL_REFUSED);
    expect(dav.createDAVClient).not.toHaveBeenCalled();
  });

  it("iCloud par défaut", async () => {
    const provider = new AppleCalendarProvider();

    const validation = await provider.validateCredentials(
      "a@icloud.com",
      "mdp",
    );

    expect(validation.valid).toBe(true);
    expect(dav.createDAVClient).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "https://caldav.icloud.com" }),
    );
  });
});

describe("connectAppleCalendar", () => {
  const owner = buildUserId();
  const workspaceId = buildOrganizationId();

  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });
  beforeEach(async () => {
    await clearMongo();
    invalidateOrgCache();
    await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  });

  const connect = (calDavUrl) =>
    calendarConnectionResolvers.Mutation.connectAppleCalendar(
      null,
      { input: { username: "a@icloud.com", appPassword: "mdp", calDavUrl } },
      buildContext({ userId: owner, organizationId: workspaceId }),
      { fieldName: "connectAppleCalendar" },
    );

  it.each(INTERNES.slice(0, 6))(
    "refuse %s avant toute requête, sans répéter l'adresse",
    async (calDavUrl) => {
      const result = await connect(calDavUrl);

      expect(result).toMatchObject({
        success: false,
        message: CALDAV_URL_REFUSED,
        connection: null,
      });
      expect(dav.createDAVClient).not.toHaveBeenCalled();
      expect(await CalendarConnection.countDocuments({})).toBe(0);
    },
  );

  it("connecte iCloud (adresse par défaut)", async () => {
    const result = await connect(undefined);

    expect(result.success).toBe(true);
    const saved = await CalendarConnection.findOne({ provider: "apple" });
    expect(saved.calDavUrl ?? null).toBeNull();
  });
});
