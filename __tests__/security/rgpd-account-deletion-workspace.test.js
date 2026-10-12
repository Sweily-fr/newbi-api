/**
 * Suppression de compte (RGPD) : les données d'un espace ne partent qu'avec
 * son dernier membre.
 *
 * deleteUserAccount vidait l'espace actif quel que soit le membre : réglages
 * SMTP, e-mail et documents, kanban, transactions, factures d'achat,
 * fournisseurs, comptes bancaires connectés... Un membre en lecture seule (ou
 * un comptable invité) qui supprimait son compte effaçait l'espace des
 * autres. La demande différée, exécutée 30 jours plus tard, ne relisait pas
 * l'appartenance et supprimait même l'organisation quittée entre-temps s'il
 * n'y restait qu'un membre.
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

// Clés exigées au chargement des modèles (SmtpSettings, connexions)
vi.hoisted(() => {
  process.env.SMTP_ENCRYPTION_KEY =
    process.env.SMTP_ENCRYPTION_KEY || "a".repeat(64);
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
});

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    signatureBucketName: "signatures-test",
    client: {
      send: vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false }),
    },
  },
}));

import mongoose from "mongoose";
import { clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { startReplicaSet } from "../helpers/numberingSimulation.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import User from "../../src/models/User.js";
import Invoice from "../../src/models/Invoice.js";
import Client from "../../src/models/Client.js";
import Product from "../../src/models/Product.js";
import SmtpSettings from "../../src/models/SmtpSettings.js";
import EmailSettings from "../../src/models/EmailSettings.js";
import DocumentSettings from "../../src/models/DocumentSettings.js";
import Notification from "../../src/models/Notification.js";
import DeletionRequest from "../../src/models/DeletionRequest.js";
import rgpdResolvers from "../../src/resolvers/rgpd.js";
import { processAccountDeletions } from "../../src/jobs/processAccountDeletions.js";

const leaver = buildUserId();
const colleague = buildUserId();
const org = buildOrganizationId();

const db = () => mongoose.connection.db;

// Collections de l'espace effacées par la suppression (filtre workspaceId)
const WORKSPACE_COLLECTIONS = [
  "kanbanprojects",
  "kanbantasks",
  "transactions",
  "purchaseinvoices",
  "suppliers",
  "documentcounters",
  "installedapps",
];
const SETTINGS_MODELS = [SmtpSettings, EmailSettings, DocumentSettings];

async function seedUser(_id, email) {
  await User.collection.insertOne({ _id, email, createdAt: new Date() });
}

async function seedWorkspaceData() {
  for (const name of WORKSPACE_COLLECTIONS) {
    await db().collection(name).insertOne({ workspaceId: org, label: name });
  }
  for (const Model of SETTINGS_MODELS) {
    await Model.collection.insertOne({ workspaceId: org });
  }
  // QontoAccount est indexé par organizationId (string)
  await db()
    .collection("qontoaccounts")
    .insertOne({ organizationId: String(org), label: "Qonto" });
  await db()
    .collection("invitation")
    .insertOne({ organizationId: org, email: "invite@test.fr" });

  // Pièces et fiches créées par le membre qui part
  await Invoice.collection.insertOne({
    workspaceId: org,
    createdBy: leaver,
    number: "F-0001",
    companyInfo: { name: "Entreprise SAS", email: "contact@entreprise.fr" },
  });
  await Client.collection.insertOne({
    workspaceId: org,
    createdBy: leaver,
    name: "Client partagé",
  });
  await Product.collection.insertOne({
    workspaceId: org,
    createdBy: leaver,
    name: "Produit partagé",
  });

  // Données personnelles du membre qui part
  await Notification.collection.insertOne({
    userId: leaver,
    workspaceId: org,
    title: "Notification",
  });
  await db().collection("session").insertOne({ userId: leaver, token: "t" });
}

async function workspaceState() {
  const counts = {};
  for (const name of WORKSPACE_COLLECTIONS) {
    counts[name] = await db()
      .collection(name)
      .countDocuments({ workspaceId: org });
  }
  for (const Model of SETTINGS_MODELS) {
    counts[Model.modelName] = await Model.collection.countDocuments({
      workspaceId: org,
    });
  }
  counts.qontoaccounts = await db()
    .collection("qontoaccounts")
    .countDocuments({ organizationId: String(org) });
  counts.invitation = await db()
    .collection("invitation")
    .countDocuments({ organizationId: org });
  counts.organization = await db()
    .collection("organization")
    .countDocuments({ _id: org });
  counts.clients = await Client.collection.countDocuments({ workspaceId: org });
  counts.products = await Product.collection.countDocuments({
    workspaceId: org,
  });
  return counts;
}

async function expectWorkspaceKept() {
  const counts = await workspaceState();
  for (const [name, count] of Object.entries(counts)) {
    expect(count, `${name} doit rester à l'espace`).toBe(1);
  }
  const invoice = await Invoice.collection.findOne({ workspaceId: org });
  expect(invoice.companyInfo.name).toBe("Entreprise SAS");
}

async function expectAccountDeleted() {
  expect(await User.collection.countDocuments({ _id: leaver })).toBe(0);
  expect(await Notification.collection.countDocuments({ userId: leaver })).toBe(
    0,
  );
  expect(
    await db().collection("session").countDocuments({ userId: leaver }),
  ).toBe(0);
  expect(
    await db()
      .collection("member")
      .countDocuments({ userId: leaver, organizationId: org }),
  ).toBe(0);
}

const confirm = () =>
  rgpdResolvers.Mutation.confirmAccountDeletion(
    null,
    {},
    buildContext({ userId: leaver, organizationId: org }),
  );

async function schedulePastRequest() {
  await DeletionRequest.create({
    userId: leaver,
    organizationId: org,
    userEmail: "leaver@test.fr",
    scheduledAt: new Date(Date.now() - 60 * 1000),
  });
}

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("rgpd_deletion");
  // Collections et index créés avant les transactions
  await Promise.all(
    [
      User,
      Invoice,
      Client,
      Product,
      Notification,
      DeletionRequest,
      ...SETTINGS_MODELS,
    ].map((Model) => Model.init()),
  );
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedUser(leaver, "leaver@test.fr");
  await seedUser(colleague, "colleague@test.fr");
});

describe("confirmAccountDeletion", () => {
  it("un membre en lecture seule ne vide pas l'espace des autres", async () => {
    await seedOrgMembership({ userId: colleague, organizationId: org });
    await seedOrgMembership({
      userId: leaver,
      organizationId: org,
      role: "viewer",
    });
    await seedWorkspaceData();

    const result = await confirm();

    expect(result.success).toBe(true);
    expect(result.summary.organizationDeleted).toBe(false);
    await expectWorkspaceKept();
    await expectAccountDeleted();
    expect(
      await db()
        .collection("member")
        .countDocuments({ userId: colleague, organizationId: org }),
    ).toBe(1);
  });

  it("un comptable invité laisse pièces, clients et produits à l'espace", async () => {
    await seedOrgMembership({ userId: colleague, organizationId: org });
    await seedOrgMembership({
      userId: leaver,
      organizationId: org,
      role: "accountant",
    });
    await seedWorkspaceData();

    const result = await confirm();

    expect(result.summary).toMatchObject({
      invoicesAnonymized: 0,
      clientsDeleted: 0,
      productsDeleted: 0,
      kanbanProjectsDeleted: 0,
    });
    await expectWorkspaceKept();
  });

  it("le dernier membre emporte l'espace, comme avant", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await seedWorkspaceData();

    const result = await confirm();

    expect(result.summary.organizationDeleted).toBe(true);
    expect(result.summary.invoicesAnonymized).toBe(1);
    const counts = await workspaceState();
    for (const [name, count] of Object.entries(counts)) {
      expect(count, `${name} doit être supprimé`).toBe(0);
    }
    const invoice = await Invoice.collection.findOne({ workspaceId: org });
    expect(invoice.companyInfo.name).toBe("Utilisateur supprimé");
    await expectAccountDeleted();
  });
});

describe("processAccountDeletions (demande différée)", () => {
  it("ne touche pas un espace quitté depuis la demande", async () => {
    // L'utilisateur a quitté l'espace ; il n'y reste qu'un membre
    await seedOrgMembership({ userId: colleague, organizationId: org });
    await seedWorkspaceData();
    await schedulePastRequest();

    const result = await processAccountDeletions();

    expect(result).toEqual({ processed: 1, failed: 0 });
    await expectWorkspaceKept();
    await expectAccountDeleted();
    const request = await DeletionRequest.findOne({ userId: leaver }).lean();
    expect(request.status).toBe("completed");
    expect(request.deletionSummary.organizationDeleted).toBe(false);
  });

  it("garde l'espace rejoint par un autre membre depuis la demande", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await seedOrgMembership({
      userId: colleague,
      organizationId: org,
      role: "admin",
    });
    await seedWorkspaceData();
    await schedulePastRequest();

    await processAccountDeletions();

    await expectWorkspaceKept();
    await expectAccountDeleted();
  });

  it("vide l'espace dont l'utilisateur est toujours le seul membre", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await seedWorkspaceData();
    await schedulePastRequest();

    await processAccountDeletions();

    const counts = await workspaceState();
    for (const [name, count] of Object.entries(counts)) {
      expect(count, `${name} doit être supprimé`).toBe(0);
    }
    await expectAccountDeleted();
  });
});
