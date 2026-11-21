/**
 * Rappel des échéances fiscales du jour dans les notifications : créé à la
 * lecture, une seule fois par utilisateur, espace et échéance, pour qui voit
 * le calendrier.
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

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import notificationResolvers from "../../src/resolvers/notification.js";
import {
  ensureFiscalDeadlineNotifications,
  fiscalNotificationText,
  resetFiscalNotificationCache,
} from "../../src/services/calendar/fiscalNotifications.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const other = buildUserId();

// Jeudi 19 novembre 2026, 10 h à Paris : CA3 d'octobre d'une SAS
const DUE_DAY = new Date("2026-11-19T09:00:00Z");
const DAY_BEFORE = new Date("2026-11-18T09:00:00Z");

const SAS = {
  legalForm: "SAS",
  isVatSubject: true,
  vatRegime: "reel-normal",
  vatFrequency: "mensuel",
  vatMode: "debits",
  fiscalYearStartDate: "2026-01-01",
  fiscalYearEndDate: "2026-12-31",
};

const notifications = (userId = owner) =>
  mongoose.connection.db
    .collection("notifications")
    .find({ userId, workspaceId, type: "FISCAL_DEADLINE" })
    .toArray();

const run = (userId = owner, now = DUE_DAY) =>
  ensureFiscalDeadlineNotifications({
    userId: String(userId),
    workspaceId: String(workspaceId),
    now,
  });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  resetFiscalNotificationCache();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await mongoose.connection.db
    .collection("organization")
    .updateOne({ _id: workspaceId }, { $set: SAS });
});

describe("rappel des échéances fiscales du jour", () => {
  it("le jour de la déclaration de TVA : une notification qui ouvre l'échéance", async () => {
    const created = await run();
    expect(created).toHaveLength(1);
    const [notification] = await notifications();
    expect(notification).toMatchObject({
      type: "FISCAL_DEADLINE",
      title: "Déclaration de TVA (CA3) : à faire aujourd'hui",
      read: false,
    });
    expect(notification.message).toContain("Octobre 2026");
    expect(notification.message).toContain("date indicative");
    expect(notification.data.url).toBe(
      "/dashboard/calendar?jour=2026-11-19&echeance=FISCAL%3AVAT_RETURN_MONTHLY%3A2026-11-19",
    );
  });

  it("la veille : rien", async () => {
    expect(await run(owner, DAY_BEFORE)).toEqual([]);
    expect(await notifications()).toHaveLength(0);
  });

  it("une seule fois, même supprimée puis relue le même jour", async () => {
    await run();
    resetFiscalNotificationCache();
    await run();
    expect(await notifications()).toHaveLength(1);

    await mongoose.connection.db
      .collection("notifications")
      .deleteMany({ type: "FISCAL_DEADLINE" });
    resetFiscalNotificationCache();
    await run();
    expect(await notifications()).toHaveLength(0);
  });

  it("deux lectures en même temps : pas de doublon", async () => {
    await Promise.all([run(), run()]);
    resetFiscalNotificationCache();
    await Promise.all([run(), run()]);
    expect(await notifications()).toHaveLength(1);
  });

  it("chaque membre reçoit son rappel", async () => {
    await seedOrgMembership({
      userId: other,
      organizationId: workspaceId,
      role: "viewer",
    });
    await run(owner);
    await run(other);
    expect(await notifications(owner)).toHaveLength(1);
    expect(await notifications(other)).toHaveLength(1);
  });

  it("pas membre de l'espace : rien", async () => {
    expect(await run(other)).toEqual([]);
    expect(await notifications(other)).toHaveLength(0);
  });

  it("rôle sans le calendrier : rien", async () => {
    const ROLE = "role_sans_calendrier";
    await mongoose.connection.db.collection("organizationRole").insertOne({
      organizationId: workspaceId,
      role: ROLE,
      name: "Sans calendrier",
      permission: "{}",
      actions: { invoices: ["view"] },
      createdAt: new Date(),
    });
    await seedOrgMembership({
      userId: other,
      organizationId: workspaceId,
      role: ROLE,
    });
    invalidateOrganizationRoles();
    expect(await run(other)).toEqual([]);
  });

  it("déclaration déjà confirmée dans Newbi : rien", async () => {
    await mongoose.connection.db.collection("vat_declarations").insertOne({
      workspaceId,
      periodKey: "2026-10",
      form: "CA3",
      periodStart: "2026-10-01",
      periodEnd: "2026-10-31",
    });
    expect(await run()).toEqual([]);
  });

  it("informations légales incomplètes : rien, sans erreur", async () => {
    await mongoose.connection.db
      .collection("organization")
      .updateOne({ _id: workspaceId }, { $unset: { legalForm: "" } });
    expect(await run()).toEqual([]);
  });

  it("à la connexion : le compteur et la liste de la cloche l'incluent", async () => {
    vi.useFakeTimers({ now: DUE_DAY, toFake: ["Date"] });
    try {
      const context = buildContext({
        userId: owner,
        organizationId: workspaceId,
      });
      const count =
        await notificationResolvers.Query.getUnreadNotificationsCount(
          null,
          { workspaceId: String(workspaceId) },
          context,
        );
      expect(count).toBe(1);
      const list = await notificationResolvers.Query.getNotifications(
        null,
        { workspaceId: String(workspaceId) },
        context,
      );
      expect(list.notifications.map((n) => n.type)).toEqual([
        "FISCAL_DEADLINE",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un paiement est « à payer », une échéance conditionnelle le dit", () => {
    expect(
      fiscalNotificationText({
        title: "Acompte d'impôt sur les sociétés",
        reference: "1er acompte",
        counterparty: "Service des impôts des entreprises",
        documentStatus: "PAYMENT",
        isIndicative: false,
        isConditional: true,
      }),
    ).toEqual({
      title: "Acompte d'impôt sur les sociétés : à payer aujourd'hui",
      message:
        "1er acompte · Service des impôts des entreprises · selon votre situation",
    });
  });
});
