/**
 * Suppression d'un compte (RGPD) et prospection : la boîte d'envoi du
 * membre part avec son compte, dans tous ses espaces (accès révoqué chez
 * Google, sauf si l'adresse est encore connectée ailleurs ; prospections en
 * cours qui en partaient mises en pause) ; avec le dernier membre, toute la
 * prospection de l'espace est effacée (boîtes, prospections, destinataires,
 * adresses prospectées). Google simulé par fetch : aucun appel réel.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { startReplicaSet } from "../helpers/numberingSimulation.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import User from "../../src/models/User.js";
import MailboxConnection from "../../src/models/MailboxConnection.js";
import ProspectingContact from "../../src/models/ProspectingContact.js";
import ProspectingRecipient from "../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../src/models/ProspectingSequence.js";
import { deleteUserAccount } from "../../src/services/rgpd.js";

const leaver = buildUserId();
const colleague = buildUserId();
const org = buildOrganizationId();
const otherOrg = buildOrganizationId();
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

let replSet;
const revokes = [];

async function seedProspecting(userId, workspaceId, email) {
  const mailbox = await MailboxConnection.create({
    workspaceId,
    userId,
    provider: "GOOGLE",
    accountEmail: email,
    accessToken: `acces-${email}`,
    refreshToken: `rafraichissement-${email}`,
    status: "ACTIVE",
  });
  const sequence = await ProspectingSequence.create({
    workspaceId,
    mailboxId: mailbox._id,
    name: "En cours",
    status: "ACTIVE",
  });
  await ProspectingRecipient.create({
    workspaceId,
    sequenceId: sequence._id,
    mailboxId: mailbox._id,
    email: `prospect-${email}`,
    status: "PENDING",
  });
  await ProspectingContact.create({
    workspaceId,
    email: `contact-${email}`,
    lastSentAt: new Date(),
  });
  return { mailbox, sequence };
}

beforeAll(async () => {
  replSet = await startReplicaSet("rgpd_prospection");
  await Promise.allSettled(
    Object.values(mongoose.models).map((Model) => Model.init()),
  );
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  revokes.length = 0;
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubGlobal("fetch", async (url, options = {}) => {
    if (String(url) === REVOKE_URL) {
      revokes.push(new URLSearchParams(options.body).get("token"));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`appel réseau inattendu : ${url}`);
  });
  await User.collection.insertOne({ _id: leaver, email: "leaver@test.fr" });
  await User.collection.insertOne({
    _id: colleague,
    email: "colleague@test.fr",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("suppression du compte (RGPD) et prospection", () => {
  it("dernier membre : boîte révoquée, toute la prospection de l'espace effacée", async () => {
    await seedOrgMembership({ userId: leaver, organizationId: org });
    await seedProspecting(leaver, org, "jean@atelier.fr");

    const summary = await deleteUserAccount(String(leaver), String(org));
    expect(summary.organizationDeleted).toBe(true);

    expect(revokes).toEqual(["rafraichissement-jean@atelier.fr"]);
    expect(await MailboxConnection.countDocuments()).toBe(0);
    for (const Model of [
      ProspectingSequence,
      ProspectingRecipient,
      ProspectingContact,
    ]) {
      expect(await Model.countDocuments({ workspaceId: org })).toBe(0);
    }
  });

  it("espace partagé : la boîte du membre part, ses prospections passent en pause, celles des autres restent", async () => {
    await seedOrgMembership({ userId: colleague, organizationId: org });
    await seedOrgMembership({
      userId: leaver,
      organizationId: org,
      role: "member",
    });
    const mine = await seedProspecting(leaver, org, "jean@atelier.fr");
    const theirs = await seedProspecting(colleague, org, "paul@atelier.fr");

    const summary = await deleteUserAccount(String(leaver), String(org));
    expect(summary.organizationDeleted).toBe(false);

    expect(
      await MailboxConnection.exists({ _id: mine.mailbox._id }),
    ).toBeNull();
    expect(revokes).toEqual(["rafraichissement-jean@atelier.fr"]);
    const paused = await ProspectingSequence.findById(mine.sequence._id).lean();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
    expect(paused.pausedReason).toBe(
      "Boîte d'envoi supprimée avec le compte de son propriétaire.",
    );
    expect(
      (await MailboxConnection.findById(theirs.mailbox._id).lean()).status,
    ).toBe("ACTIVE");
    expect(
      (await ProspectingSequence.findById(theirs.sequence._id).lean()).status,
    ).toBe("ACTIVE");
    // Historique de l'espace gardé (règle des 30 jours, fiches contact)
    expect(
      await ProspectingRecipient.countDocuments({ workspaceId: org }),
    ).toBe(2);
  });

  it("boîtes du membre dans ses autres espaces supprimées aussi ; accès gardé si l'adresse reste connectée ailleurs", async () => {
    await seedOrgMembership({ userId: colleague, organizationId: org });
    await seedOrgMembership({
      userId: leaver,
      organizationId: org,
      role: "member",
    });
    await seedOrgMembership({ userId: colleague, organizationId: otherOrg });
    await seedProspecting(leaver, org, "commun@atelier.fr");
    await seedProspecting(leaver, otherOrg, "jean@ailleurs.fr");
    // Même adresse connectée par un collègue dans un autre espace
    await MailboxConnection.create({
      workspaceId: otherOrg,
      userId: colleague,
      provider: "GOOGLE",
      accountEmail: "commun@atelier.fr",
      refreshToken: "jeton-du-collegue",
      status: "ACTIVE",
    });

    await deleteUserAccount(String(leaver), String(org));

    expect(await MailboxConnection.countDocuments({ userId: leaver })).toBe(0);
    expect(revokes).toEqual(["rafraichissement-jean@ailleurs.fr"]);
    expect(await MailboxConnection.countDocuments({ userId: colleague })).toBe(
      1,
    );
  });
});
