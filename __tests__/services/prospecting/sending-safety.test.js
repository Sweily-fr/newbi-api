/**
 * Prospection, garde-fous de l'envoi (constats de la relecture du
 * 25/11/2026 ; Gmail simulé par fetch, aucun appel réel) :
 *   - deux boîtes du même espace ne peuvent jamais écrire à la même
 *     adresse (réservation atomique `prospecting_contacts`) ;
 *   - une adresse en attente dans une autre prospection en cours est
 *     écartée du décompte (« déjà prospectés ») ;
 *   - refus propre au compte, ou trois échecs de suite : boîte en pause,
 *     sans faire échouer les destinataires un par un ;
 *   - panne ou refus du renouvellement de jeton : erreur de la boîte, le
 *     destinataire ne consomme aucun essai ;
 *   - même adresse connectée deux fois : limite du jour et espacement
 *     comptés par adresse, accès non révoqué tant qu'une autre connexion
 *     s'en sert ;
 *   - fiche supprimée, bloquée ou passée en particulier : écartée ;
 *   - envoi incertain ou interrompu : jamais renvoyé, compté comme envoyé ;
 *   - propriétaire parti de l'espace : boîte déconnectée ;
 *   - abonnement inactif, fonctionnalité fermée : rien ne part.
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

vi.mock("../../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const mails = vi.hoisted(() => ({ sent: [] }));
vi.mock("../../../src/utils/trialEmails.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sendRenderedEmail: async (message) => {
    mails.sent.push(message);
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { seedOrgMembership } from "../../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../../src/services/organizationRoleService.js";
import Client from "../../../src/models/Client.js";
import EmailSuppression from "../../../src/models/EmailSuppression.js";
import MailboxConnection from "../../../src/models/MailboxConnection.js";
import ProspectingContact from "../../../src/models/ProspectingContact.js";
import ProspectingRecipient from "../../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../../src/models/ProspectingSequence.js";
import {
  INTERRUPTED_MESSAGE,
  UNCERTAIN_MESSAGE,
  processMailbox,
  resetOrphanSweep,
  runProspectingTick,
} from "../../../src/services/prospecting/sending.js";
import {
  countSentToday,
  disconnectMailbox,
} from "../../../src/services/prospecting/mailboxes.js";
import { resolveProspectingAudience } from "../../../src/services/prospecting/audience.js";

const workspaceId = buildOrganizationId();
const owner1 = buildUserId();
const owner2 = buildUserId();
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const WEDNESDAY_10H = new Date("2026-11-25T09:00:00Z");
const MINUTE = 60 * 1000;

const gmail = {
  sends: [],
  tokenCalls: 0,
  revokes: [],
  send: null,
  token: null,
};
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

let clock;
const now = () => new Date(clock);
const advance = (ms) => {
  clock = new Date(clock.getTime() + ms);
};

async function seedMailbox(userId, email, overrides = {}) {
  return MailboxConnection.create({
    workspaceId,
    userId,
    provider: "GOOGLE",
    accountEmail: email,
    accountName: "Membre",
    accessToken: "acces-valide",
    refreshToken: "rafraichissement",
    tokenExpiresAt: new Date(WEDNESDAY_10H.getTime() + 60 * MINUTE),
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    status: "ACTIVE",
    dailyLimit: 30,
    connectedAt: new Date("2026-09-01T08:00:00Z"),
    ...overrides,
  });
}

async function seedSequence(mailbox, overrides = {}) {
  return ProspectingSequence.create({
    workspaceId: mailbox.workspaceId,
    mailboxId: mailbox._id,
    createdBy: mailbox.userId,
    name: "Prospection",
    status: "ACTIVE",
    subject: "Bonjour",
    body: "<p>Bonjour</p>",
    startedAt: WEDNESDAY_10H,
    snapshot: {
      senderEmail: mailbox.accountEmail,
      senderName: "Membre",
      companyName: "Atelier Durand",
      companyAddress: "12 rue des Lilas, 69001 Lyon",
      dataPageUrl: "https://api.exemple.test/api/prospection/donnees/x",
    },
    ...overrides,
  });
}

const recipient = (sequence, email, overrides = {}) => ({
  workspaceId: sequence.workspaceId,
  sequenceId: sequence._id,
  mailboxId: sequence.mailboxId,
  email,
  name: email,
  company: email,
  vars: { prenom: "Marie" },
  status: "PENDING",
  ...overrides,
});

const fresh = (id) => MailboxConnection.findById(id).lean();
const recipientOf = (id) => ProspectingRecipient.findById(id).lean();
const sendsTo = (email) => gmail.sends.filter((to) => to === email).length;

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Client.init(),
    MailboxConnection.init(),
    ProspectingSequence.init(),
    ProspectingRecipient.init(),
    ProspectingContact.init(),
    EmailSuppression.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  resetOrphanSweep();
  clock = new Date(WEDNESDAY_10H);
  mails.sent = [];
  Object.assign(gmail, {
    sends: [],
    tokenCalls: 0,
    revokes: [],
    send: null,
    token: null,
  });
  vi.stubEnv("CALENDAR_ENCRYPTION_KEY", "cle-de-test-boites");
  vi.stubEnv("JWT_SECRET", "secret-de-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
  vi.stubEnv("FRONTEND_URL", "https://app.exemple.test");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("PROSPECTING_MAX_DAILY_PER_MAILBOX", "");
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "live");
  vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
  vi.stubGlobal("fetch", async (url, options = {}) => {
    if (String(url) === TOKEN_URL) {
      gmail.tokenCalls += 1;
      return gmail.token
        ? gmail.token()
        : json(200, { access_token: "acces-renouvele", expires_in: 3600 });
    }
    if (String(url) === REVOKE_URL) {
      gmail.revokes.push(new URLSearchParams(options.body).get("token"));
      return json(200, {});
    }
    if (String(url) === SEND_URL) {
      const { raw } = JSON.parse(options.body);
      const mime = Buffer.from(raw, "base64url").toString("utf8");
      gmail.sends.push(/^To: (.*)$/m.exec(mime)?.[1]?.trim());
      // Latence d'un vrai appel : les boîtes sont servies en parallèle
      await new Promise((resolve) => {
        setTimeout(resolve, 30);
      });
      return gmail.send
        ? gmail.send(gmail.sends.length)
        : json(200, { id: `m${gmail.sends.length}`, threadId: "t" });
    }
    throw new Error(`appel réseau inattendu : ${url}`);
  });
  await seedOrgMembership({
    userId: owner1,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Atelier Durand",
  });
  await seedOrgMembership({
    userId: owner2,
    organizationId: workspaceId,
    role: "admin",
    organizationName: "Atelier Durand",
  });
  await mongoose.connection.db.collection("user").insertMany([
    { _id: owner1, name: "Jean Dupont", email: "jean@newbi-membre.fr" },
    { _id: owner2, name: "Paul Martin", email: "paul@newbi-membre.fr" },
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("même adresse dans deux prospections de l'espace", () => {
  it("deux boîtes servies en parallèle : un seul message, l'autre écarté", async () => {
    const box1 = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const box2 = await seedMailbox(owner2, "paul@atelier-durand.fr");
    const seq1 = await seedSequence(box1);
    const seq2 = await seedSequence(box2);
    const [r1, r2] = await ProspectingRecipient.insertMany([
      recipient(seq1, "commun@menuiserie.fr"),
      recipient(seq2, "commun@menuiserie.fr"),
    ]);
    await runProspectingTick({ now });
    expect(sendsTo("commun@menuiserie.fr")).toBe(1);
    const statuses = [
      (await recipientOf(r1._id)).status,
      (await recipientOf(r2._id)).status,
    ].sort();
    expect(statuses).toEqual(["SENT", "SKIPPED"]);
    const skipped = await ProspectingRecipient.findOne({
      status: "SKIPPED",
    }).lean();
    expect(skipped.skippedReason).toBe("déjà prospecté");
    const contact = await ProspectingContact.findOne({
      workspaceId,
      email: "commun@menuiserie.fr",
    }).lean();
    expect(contact.lastSentAt.getTime()).toBe(clock.getTime());
  });

  it("décompte : adresse encore en attente dans une autre prospection en cours ou en pause", async () => {
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const running = await seedSequence(box);
    const paused = await seedSequence(box, { status: "PAUSED" });
    const done = await seedSequence(box, { status: "COMPLETED" });
    await ProspectingRecipient.insertMany([
      recipient(running, "attente@menuiserie.fr"),
      recipient(paused, "pause@menuiserie.fr"),
      recipient(done, "fini@menuiserie.fr", { status: "SKIPPED" }),
    ]);
    await Client.insertMany(
      ["attente", "pause", "fini", "libre"].map((name) =>
        buildClientDoc({
          workspaceId,
          createdBy: owner1,
          type: "COMPANY",
          name: `Menuiserie ${name}`,
          email: `${name}@menuiserie.fr`,
        }),
      ),
    );
    const { counts } = await resolveProspectingAudience(
      workspaceId,
      { mode: "ALL" },
      { now: now() },
    );
    expect(counts).toMatchObject({
      total: 4,
      sendable: 2,
      recentlyContacted: 2,
    });
  });
});

describe("erreurs de la boîte, jamais du destinataire", () => {
  it("refus propre au compte (Precondition check failed) : boîte en pause, destinataires intacts", async () => {
    gmail.send = () =>
      json(400, {
        error: {
          code: 400,
          message: "Precondition check failed.",
          errors: [{ reason: "failedPrecondition" }],
          status: "FAILED_PRECONDITION",
        },
      });
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    const docs = await ProspectingRecipient.insertMany([
      recipient(seq, "a@ent.fr"),
      recipient(seq, "b@ent.fr"),
    ]);
    expect(await processMailbox(box.toObject(), { now: now() })).toBe(
      "accountError",
    );
    const paused = await fresh(box._id);
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "ACCOUNT" });
    expect(paused.pausedReason).toMatch(/^Votre messagerie refuse les envois/);
    expect(paused.lastError).toContain("Precondition check failed");
    for (const doc of docs) {
      expect(await recipientOf(doc._id)).toMatchObject({
        status: "PENDING",
        attempts: 0,
        lockedAt: null,
      });
    }
    expect(await ProspectingSequence.findById(seq._id).lean()).toMatchObject({
      status: "PAUSED",
      pauseKind: "MAILBOX",
    });
    // L'adresse n'est pas restée réservée
    expect(await ProspectingContact.countDocuments()).toBe(0);
    advance(10 * MINUTE);
    await runProspectingTick({ now });
    expect(gmail.sends).toHaveLength(1);
  });

  it("trois échecs de suite : boîte en pause avec une raison", async () => {
    gmail.send = () => json(400, { error: { message: "Invalid To header" } });
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    await ProspectingRecipient.insertMany(
      ["a", "b", "c", "d"].map((x) => recipient(seq, `${x}@ent.fr`)),
    );
    const outcomes = [];
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(await processMailbox(await fresh(box._id), { now: now() }));
      advance(9 * MINUTE);
    }
    expect(outcomes).toEqual(["failed", "failed", "failuresPaused", "busy"]);
    const paused = await fresh(box._id);
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "ACCOUNT" });
    expect(paused.pausedReason).toBe(
      "Trois envois de suite ont échoué : vérifiez votre boîte d'envoi et vos destinataires, puis reprenez la prospection.",
    );
    expect(
      await ProspectingRecipient.countDocuments({ status: "PENDING" }),
    ).toBe(1);
  });

  it("un envoi réussi remet le compteur d'échecs à zéro", async () => {
    gmail.send = (count) =>
      count === 2
        ? json(200, { id: "ok", threadId: "t" })
        : json(400, { error: { message: "Invalid To header" } });
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    await ProspectingRecipient.insertMany(
      ["a", "b", "c", "d"].map((x) => recipient(seq, `${x}@ent.fr`)),
    );
    for (let i = 0; i < 4; i += 1) {
      await processMailbox(await fresh(box._id), { now: now() });
      advance(9 * MINUTE);
    }
    expect((await fresh(box._id)).status).toBe("ACTIVE");
  });

  it("panne du point de jeton (503) : le destinataire ne consomme aucun essai", async () => {
    gmail.token = () => json(503, { error: "backendError" });
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      tokenExpiresAt: new Date(WEDNESDAY_10H.getTime() - MINUTE),
    });
    const seq = await seedSequence(box);
    const [first] = await ProspectingRecipient.insertMany([
      recipient(seq, "a@ent.fr"),
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect(await processMailbox(await fresh(box._id), { now: now() })).toBe(
        "tokenRetry",
      );
      const after = await fresh(box._id);
      expect(after.status).toBe("ACTIVE");
      expect(after.nextSendAfter.getTime()).toBe(clock.getTime() + 10 * MINUTE);
      advance(11 * MINUTE);
    }
    expect(await recipientOf(first._id)).toMatchObject({
      status: "PENDING",
      attempts: 0,
    });
    expect(gmail.sends).toHaveLength(0);
    expect(await ProspectingContact.countDocuments()).toBe(0);
  });

  it("appli refusée au renouvellement (invalid_client) : boîte EXPIRED, un seul e-mail", async () => {
    gmail.token = () =>
      json(401, { error: "invalid_client", error_description: "Unauthorized" });
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      tokenExpiresAt: new Date(WEDNESDAY_10H.getTime() - MINUTE),
    });
    const seq = await seedSequence(box);
    await ProspectingRecipient.insertMany([recipient(seq, "a@ent.fr")]);
    expect(await processMailbox(box.toObject(), { now: now() })).toBe(
      "expired",
    );
    expect((await fresh(box._id)).status).toBe("EXPIRED");
    expect(mails.sent).toHaveLength(1);
  });
});

describe("même adresse connectée par deux membres ou espaces", () => {
  it("limite du jour et espacement comptés par adresse", async () => {
    const otherWorkspace = buildOrganizationId();
    await seedOrgMembership({
      userId: owner1,
      organizationId: otherWorkspace,
      role: "owner",
    });
    const here = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      dailyLimit: 5,
    });
    const there = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      workspaceId: otherWorkspace,
      dailyLimit: 5,
    });
    const seqHere = await seedSequence(here);
    const seqThere = await seedSequence(there);
    // 5 envois aujourd'hui depuis l'autre espace, même adresse
    await ProspectingRecipient.insertMany(
      Array.from({ length: 5 }, (_, i) =>
        recipient(seqThere, `deja${i}@ent.fr`, {
          status: "SENT",
          sentAt: new Date(WEDNESDAY_10H.getTime() - (i + 1) * MINUTE),
        }),
      ),
    );
    await ProspectingRecipient.insertMany([recipient(seqHere, "a@ent.fr")]);
    expect(await countSentToday(here.toObject(), now())).toBe(5);
    expect(await processMailbox(here.toObject(), { now: now() })).toBe(
      "dailyLimit",
    );

    // Espacement : un envoi d'une connexion retarde l'autre
    await MailboxConnection.updateMany({}, { $set: { dailyLimit: 30 } });
    await ProspectingRecipient.insertMany([recipient(seqThere, "b@ent.fr")]);
    expect(await processMailbox(await fresh(here._id), { now: now() })).toBe(
      "sent",
    );
    const delayed = await fresh(there._id);
    expect(delayed.nextSendAfter.getTime()).toBeGreaterThan(clock.getTime());
    expect(await processMailbox(delayed, { now: now() })).toBe("busy");
  });

  it("une seule adresse servie par passage du cron", async () => {
    const otherWorkspace = buildOrganizationId();
    await seedOrgMembership({
      userId: owner1,
      organizationId: otherWorkspace,
      role: "owner",
    });
    const here = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const there = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      workspaceId: otherWorkspace,
    });
    await ProspectingRecipient.insertMany([
      recipient(await seedSequence(here), "a@ent.fr"),
      recipient(await seedSequence(there), "b@ent.fr"),
    ]);
    await runProspectingTick({ now });
    expect(gmail.sends).toHaveLength(1);
  });

  it("déconnexion : accès gardé chez Google tant qu'une autre connexion s'en sert", async () => {
    const otherWorkspace = buildOrganizationId();
    const here = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const there = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      workspaceId: otherWorkspace,
    });
    await disconnectMailbox(here.toObject());
    expect(gmail.revokes).toEqual([]);
    expect(await fresh(here._id)).toMatchObject({
      status: "DISCONNECTED",
      accessToken: null,
      refreshToken: null,
    });
    // Dernière connexion de l'adresse : révoquée
    await disconnectMailbox(there.toObject());
    expect(gmail.revokes).toEqual(["rafraichissement"]);
  });
});

describe("fiche du contact relue avant l'envoi", () => {
  it("supprimée, bloquée ou passée en particulier : écartée avec son motif", async () => {
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    const make = (name, extra = {}) =>
      Client.create(
        buildClientDoc({
          workspaceId,
          createdBy: owner1,
          type: "COMPANY",
          name,
          email: `${name.toLowerCase().replace(/\s/g, "")}@ent.fr`,
          ...extra,
        }),
      );
    const deleted = await make("Supprimee");
    const blocked = await make("Bloquee", { isBlocked: true });
    const individual = await make("Particulier");
    const ok = await make("Valable");
    await Client.collection.updateOne(
      { _id: individual._id },
      { $set: { type: "INDIVIDUAL" } },
    );
    const docs = await ProspectingRecipient.insertMany(
      [deleted, blocked, individual, ok].map((client) =>
        recipient(seq, client.email, { clientId: client._id }),
      ),
    );
    await Client.deleteOne({ _id: deleted._id });
    expect(await processMailbox(box.toObject(), { now: now() })).toBe("sent");
    const reasons = await Promise.all(
      docs.map(async (doc) => {
        const r = await recipientOf(doc._id);
        return [r.status, r.skippedReason];
      }),
    );
    expect(reasons).toEqual([
      ["SKIPPED", "contact supprimé"],
      ["SKIPPED", "contact bloqué"],
      ["SKIPPED", "particulier"],
      ["SENT", null],
    ]);
  });
});

describe("message peut-être parti : jamais renvoyé", () => {
  it("coupure en plein envoi : FAILED « envoi incertain », compté comme envoyé, adresse gardée", async () => {
    gmail.send = (count) => {
      if (count === 1) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: { code: "ECONNRESET" },
        });
      }
      return json(200, { id: "m", threadId: "t" });
    };
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      dailyLimit: 5,
      connectedAt: new Date("2026-09-01T08:00:00Z"),
    });
    const seq = await seedSequence(box);
    const [uncertain] = await ProspectingRecipient.insertMany([
      recipient(seq, "a@ent.fr"),
      recipient(seq, "b@ent.fr"),
    ]);
    expect(await processMailbox(box.toObject(), { now: now() })).toBe(
      "uncertain",
    );
    const failed = await recipientOf(uncertain._id);
    expect(failed).toMatchObject({
      status: "FAILED",
      error: UNCERTAIN_MESSAGE,
      attempts: 1,
    });
    expect(failed.sentAt.getTime()).toBe(clock.getTime());
    expect(await countSentToday(box.toObject(), now())).toBe(1);
    expect(
      await ProspectingContact.exists({ workspaceId, email: "a@ent.fr" }),
    ).not.toBeNull();
    // Passage suivant : l'adresse suivante, jamais un renvoi
    advance(9 * MINUTE);
    expect(await processMailbox(await fresh(box._id), { now: now() })).toBe(
      "sent",
    );
    expect(gmail.sends).toEqual(["a@ent.fr", "b@ent.fr"]);
  });

  it("envoi interrompu par un arrêt : FAILED, compté pour la limite et la règle des 30 jours", async () => {
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr", {
      dailyLimit: 5,
    });
    const seq = await seedSequence(box);
    const startedAt = new Date(WEDNESDAY_10H.getTime() - 15 * MINUTE);
    const [interrupted] = await ProspectingRecipient.insertMany([
      recipient(seq, "a@ent.fr", {
        lockedAt: startedAt,
        sendStartedAt: startedAt,
      }),
    ]);
    const other = await seedSequence(box);
    const [again] = await ProspectingRecipient.insertMany([
      recipient(other, "a@ent.fr"),
    ]);
    await processMailbox(box.toObject(), { now: now() });
    const failed = await recipientOf(interrupted._id);
    expect(failed).toMatchObject({
      status: "FAILED",
      error: INTERRUPTED_MESSAGE,
    });
    expect(failed.sentAt.getTime()).toBe(startedAt.getTime());
    expect(await countSentToday(box.toObject(), now())).toBe(1);
    expect(await recipientOf(again._id)).toMatchObject({
      status: "SKIPPED",
      skippedReason: "déjà prospecté",
    });
    expect(gmail.sends).toHaveLength(0);
  });
});

describe("propriétaire, abonnement, accès anticipé", () => {
  it("propriétaire parti de l'espace : boîte déconnectée, même sans prospection en cours", async () => {
    const idle = await seedMailbox(owner2, "paul@atelier-durand.fr");
    const busy = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(busy);
    await ProspectingRecipient.insertMany([recipient(seq, "a@ent.fr")]);
    await mongoose.connection.db.collection("member").deleteMany({});
    const totals = await runProspectingTick({ now, sweepOrphans: true });
    expect(totals.ownerLeft).toBe(2);
    for (const id of [idle._id, busy._id]) {
      expect(await fresh(id)).toMatchObject({
        status: "DISCONNECTED",
        accessToken: null,
        refreshToken: null,
      });
    }
    const paused = await ProspectingSequence.findById(seq._id).lean();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
    expect(paused.pausedReason).toMatch(/ne fait plus partie de l'espace/);
    expect(gmail.sends).toHaveLength(0);
  });

  it("propriétaire retiré entre deux recherches : déconnecté au moment d'envoyer", async () => {
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    await ProspectingRecipient.insertMany([recipient(seq, "a@ent.fr")]);
    await mongoose.connection.db
      .collection("member")
      .deleteOne({ userId: owner1 });
    expect(await processMailbox(box.toObject(), { now: now() })).toBe(
      "ownerLeft",
    );
    expect((await fresh(box._id)).status).toBe("DISCONNECTED");
  });

  it("abonnement inactif : rien ne part, nouvel essai dans une heure", async () => {
    await mongoose.connection.db
      .collection("subscription")
      .updateMany({}, { $set: { status: "canceled", periodEnd: null } });
    invalidateSubCache();
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    await ProspectingRecipient.insertMany([recipient(seq, "a@ent.fr")]);
    expect(await processMailbox(box.toObject(), { now: now() })).toBe(
      "subscription",
    );
    expect((await fresh(box._id)).nextSendAfter.getTime()).toBe(
      clock.getTime() + 60 * MINUTE,
    );
    expect(gmail.sends).toHaveLength(0);
  });

  it("fonctionnalité fermée à l'espace : rien ne part", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "prospecting");
    vi.stubEnv("BETA_WORKSPACE_IDS", String(buildOrganizationId()));
    const box = await seedMailbox(owner1, "jean@atelier-durand.fr");
    const seq = await seedSequence(box);
    await ProspectingRecipient.insertMany([recipient(seq, "a@ent.fr")]);
    expect(await processMailbox(box.toObject(), { now: now() })).toBe(
      "featureClosed",
    );
    expect(gmail.sends).toHaveLength(0);
  });
});
