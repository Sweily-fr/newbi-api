/**
 * Données d'une page reprises par une autre : chacune suit « Voir » de sa
 * page d'origine, et les lectures partagées acceptent les pages qui les
 * affichent.
 *
 *   - Calendrier : les échéances de factures et les avoirs créés (client et
 *     montant dans le titre) n'apparaissent qu'avec leur page.
 *   - Prévision : le détail d'un mois ne liste que les documents des pages
 *     visibles (les totaux restent complets).
 *   - « Retirer des membres » n'est pas confondu avec « Supprimer ».
 *   - Résumé bancaire, réglages e-mail, signatures : lisibles depuis les
 *     pages qui les affichent (plus de refus sur une page permise).
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

// Requise au chargement du modèle CalendarConnection (importé par event.js)
vi.hoisted(() => {
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "cle-de-test-agenda";
});
vi.mock("../../src/services/calendar/CalendarWebhookService.js", () => ({
  publishCalendarEventsChanged: vi.fn(),
}));
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
import {
  invalidateOrgCache,
  requireAction,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Event from "../../src/models/Event.js";
import Invoice from "../../src/models/Invoice.js";
import eventResolvers from "../../src/resolvers/event.js";
import treasuryForecastResolvers from "../../src/resolvers/treasuryForecast.js";
import dashboardAggregationResolvers from "../../src/resolvers/dashboardAggregation.js";
import esignatureResolvers from "../../src/resolvers/esignatureResolvers.js";
import emailSettingsResolvers from "../../src/resolvers/emailSettings.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const member = buildUserId();
const ROLE = "role_lecteur_croise";

const ws = () => String(workspaceId);
const ctx = (userId = member) => buildContext({ userId, organizationId: ws() });

// Grille du rôle de `member`
async function grantActions(actions) {
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne(
      { organizationId: workspaceId, role: ROLE },
      { $set: { actions } },
    );
  invalidateOrganizationRoles();
  invalidateOrgCache();
}

const now = new Date();
const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
const midMonth = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 10),
);

async function seedEvent(type, title) {
  const _id = new mongoose.Types.ObjectId();
  await Event.collection.insertOne({
    _id,
    title,
    type,
    start: midMonth,
    end: midMonth,
    workspaceId,
    userId: owner,
    visibility: "workspace",
    source: "newbi",
  });
  return String(_id);
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: member,
    organizationId: workspaceId,
    role: ROLE,
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE,
    name: "Lecteur croisé",
    permission: "{}",
    actions: {},
    createdAt: new Date(),
  });
  invalidateOrganizationRoles();
  invalidateOrgCache();
});

describe("calendrier et documents", () => {
  it("masque échéances de factures et avoirs sans leur page", async () => {
    await seedEvent("MANUAL", "Rendez-vous");
    const dueId = await seedEvent(
      "INVOICE_DUE",
      "Échéance facture F-001 - Client - 1 200 €",
    );
    await seedEvent("CREDIT_NOTE_CREATED", "Avoir créé: AV-001");
    const titles = async () =>
      (await eventResolvers.Query.getEvents(null, {}, ctx())).events.map(
        (e) => e.title,
      );

    await grantActions({ calendar: ["view", "edit"] });
    expect(await titles()).toEqual(["Rendez-vous"]);
    const hidden = await eventResolvers.Query.getEvent(
      null,
      { id: dueId },
      ctx(),
    );
    expect(hidden.event).toBeNull();
    await expect(
      eventResolvers.Mutation.syncInvoiceEvents(null, {}, ctx()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await grantActions({ calendar: ["view"], invoices: ["view"] });
    expect(await titles()).toHaveLength(2);
    expect(await titles()).not.toContain("Avoir créé: AV-001");
  });
});

describe("prévision : détail d'un mois", () => {
  it("ne liste que les documents des pages visibles", async () => {
    await Invoice.collection.insertOne({
      workspaceId,
      status: "PENDING",
      number: "F-001",
      issueDate: midMonth,
      finalTotalTTC: 120,
      client: { name: "Client" },
    });
    const details = () =>
      treasuryForecastResolvers.Query.forecastMonthDetails(
        null,
        { workspaceId: ws(), month: thisMonth },
        ctx(),
      );

    await grantActions({ forecast: ["view"] });
    const hidden = await details();
    expect(hidden.invoices).toEqual([]);
    expect(hidden.purchaseInvoices).toEqual([]);
    expect(hidden.signedQuotes).toEqual([]);
    expect(hidden.bankTransactions).toEqual([]);

    await grantActions({ forecast: ["view"], invoices: ["view"] });
    expect((await details()).invoices).toHaveLength(1);
  });
});

describe("lectures partagées", () => {
  it("« Retirer des membres » n'est pas pris pour « Supprimer »", async () => {
    await expect(
      requireAction("team", "remove")(async () => "ok")(null, {}, ctx(owner)),
    ).resolves.toBe("ok");
  });

  it("résumé bancaire lisible depuis la Vue d'ensemble", async () => {
    await grantActions({ overview: ["view"] });
    await expect(
      dashboardAggregationResolvers.Query.dashboardSummary(
        null,
        { workspaceId: ws() },
        ctx(),
      ),
    ).resolves.toBeDefined();
  });

  it("signatures et réglages e-mail lisibles avec les devis seuls", async () => {
    await grantActions({ quotes: ["view", "send", "sign"] });
    const docId = String(new mongoose.Types.ObjectId());
    await expect(
      esignatureResolvers.Query.getDocumentSignatureStatus(
        null,
        { documentType: "quote", documentId: docId },
        ctx(),
      ),
    ).resolves.toBeNull();
    await expect(
      esignatureResolvers.Query.getDocumentSignatureStatus(
        null,
        { documentType: "invoice", documentId: docId },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      esignatureResolvers.Query.getSignatureRequests(
        null,
        { documentType: "invoice" },
        ctx(),
      ),
    ).resolves.toEqual([]);
    await expect(
      emailSettingsResolvers.Query.getEmailSettings(null, {}, ctx()),
    ).resolves.toBeDefined();
  });
});
