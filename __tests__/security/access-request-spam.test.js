/**
 * Demandes d'accès à une page (requestModuleAccess) : pas de rafale.
 *
 * Un membre qui clique 20 fois sur « Demander l'accès » à la même page dans
 * les 10 minutes ne doit envoyer qu'un e-mail et qu'une notification au
 * super admin, y compris quand les clics arrivent en même temps. Page ou
 * action inconnue : refus avec un message. Nom du demandeur échappé dans
 * l'e-mail.
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

const sent = vi.hoisted(() => ({ mails: [] }));
vi.mock("nodemailer", () => {
  const transport = {
    sendMail: async (options) => {
      sent.mails.push(options);
      return { messageId: "test" };
    },
    verify: async () => true,
  };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

vi.mock("../../src/services/pushNotificationService.js", () => ({
  sendPushToUser: vi.fn(async () => {}),
}));

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  requestModuleAccess,
  invalidateOrganizationRoles,
} from "../../src/services/organizationRoleService.js";

const organizationId = buildOrganizationId();
const ownerId = buildUserId();
const memberId = buildUserId();

const db = () => mongoose.connection.db;

const requester = (name = "Membre Test") => ({
  _id: memberId,
  id: String(memberId),
  email: "membre@exemple.fr",
  name,
});

const ask = (args = { module: "invoices", action: "view" }, name) =>
  requestModuleAccess(
    {
      organizationId: String(organizationId),
      organizationName: "Espace Test",
      user: requester(name),
      userRole: "viewer",
    },
    args,
  );

const accessNotifications = () =>
  db().collection("notifications").countDocuments({ type: "ACCESS_REQUESTED" });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrganizationRoles();
  sent.mails.length = 0;
  await seedOrgMembership({ userId: ownerId, organizationId, role: "owner" });
  await seedOrgMembership({ userId: memberId, organizationId, role: "viewer" });
  await db()
    .collection("user")
    .insertMany([
      { _id: ownerId, email: "owner@exemple.fr", name: "Super Admin" },
      { _id: memberId, email: "membre@exemple.fr", name: "Membre Test" },
    ]);
});

describe("requestModuleAccess : rafales", () => {
  it("20 demandes successives sur la même page en 10 minutes : un e-mail, une notification", async () => {
    for (let i = 0; i < 20; i += 1) {
      await ask();
    }
    expect(sent.mails).toHaveLength(1);
    expect(await accessNotifications()).toBe(1);
  });

  it("20 demandes simultanées sur la même page : un e-mail, une notification", async () => {
    await Promise.allSettled(Array.from({ length: 20 }, () => ask()));
    expect(
      sent.mails.length,
      "des demandes simultanées (double-clic, onglets) ne doivent envoyer qu'un seul e-mail au super admin",
    ).toBe(1);
    expect(
      await accessNotifications(),
      "des demandes simultanées ne doivent créer qu'une seule notification",
    ).toBe(1);
  });

  it("une page différente reste une nouvelle demande", async () => {
    await ask({ module: "invoices", action: "view" });
    await ask({ module: "quotes", action: "view" });
    expect(sent.mails).toHaveLength(2);
    expect(await accessNotifications()).toBe(2);
  });
});

describe("requestModuleAccess : refus", () => {
  it("page inconnue : refusée avec un message, rien n'est envoyé", async () => {
    await expect(
      ask({ module: "inconnue", action: "view" }),
    ).rejects.toMatchObject({
      message: "Page inconnue",
      code: "INVALID_INPUT",
    });
    expect(sent.mails).toHaveLength(0);
    expect(await accessNotifications()).toBe(0);
  });

  it("action inconnue : refusée avec un message, rien n'est envoyé", async () => {
    await expect(
      ask({ module: "invoices", action: "delete" }),
    ).rejects.toMatchObject({
      message: "Action inconnue",
      code: "INVALID_INPUT",
    });
    expect(sent.mails).toHaveLength(0);
    expect(await accessNotifications()).toBe(0);
  });
});

describe("requestModuleAccess : e-mail", () => {
  it("nom du demandeur avec du HTML : échappé dans le corps de l'e-mail", async () => {
    const name = `<img src=x onerror="alert(1)"><a href="https://exemple.test">Clique</a>`;
    await ask({ module: "invoices", action: "view" }, name);
    expect(sent.mails).toHaveLength(1);
    const { html } = sent.mails[0];
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('<a href="https://exemple.test"');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
