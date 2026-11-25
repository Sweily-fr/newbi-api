/**
 * Prospection, envoi par le cron (Gmail simulé par fetch : aucun appel
 * réel, aucun e-mail réel) : un message par passage et par boîte, plage de
 * Paris (heures, week-end, jours fériés), limite du jour et montée
 * progressive (réels + simulés), espacement de 3 à 8 minutes, verrou de la
 * boîte, tour de rôle entre prospections, re-vérifications avant l'envoi
 * (désinscrit, déjà prospecté depuis moins de 30 jours), mode d'envoi des
 * campagnes (simulation), jeton renouvelé, erreurs classées (jeton refusé :
 * boîte EXPIRED et membre prévenu une fois ; quota : reprise le lendemain ;
 * adresse refusée : FAILED ; erreur passagère : 3 essais), envoi
 * interrompu jamais renvoyé, droits retirés, fin de la prospection.
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
import { decodeHeader, parseMime } from "../../helpers/mime.js";
import { buildOrganizationId, buildUserId } from "../../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../../src/services/organizationRoleService.js";
import EmailSuppression from "../../../src/models/EmailSuppression.js";
import MailboxConnection, {
  decryptToken,
} from "../../../src/models/MailboxConnection.js";
import ProspectingRecipient from "../../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../../src/models/ProspectingSequence.js";
import {
  MAX_ATTEMPTS,
  processMailbox,
  runProspectingTick,
} from "../../../src/services/prospecting/sending.js";
import {
  TOKEN_KINDS,
  verifyCampaignToken,
} from "../../../src/services/emailCampaigns/tracking.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// Mercredi 25 novembre 2026, 10 h à Paris
const WEDNESDAY_10H = new Date("2026-11-25T09:00:00Z");
const MINUTE = 60 * 1000;

const gmail = { sends: [], refreshes: [], send: null, token: null };
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

async function seedMailbox(overrides = {}) {
  return MailboxConnection.create({
    workspaceId,
    userId: owner,
    provider: "GOOGLE",
    accountEmail: "jean@atelier-durand.fr",
    accountName: "Jean Dupont",
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
    workspaceId,
    mailboxId: mailbox._id,
    createdBy: owner,
    name: "Menuisiers de Lyon",
    status: "ACTIVE",
    subject: "Une idée pour {{entreprise}}",
    body: "<p>Bonjour {{prenom|à vous}},</p><p>Votre activité ({{activite}}) nous intéresse.</p>",
    startedAt: WEDNESDAY_10H,
    snapshot: {
      senderEmail: mailbox.accountEmail,
      senderName: "Jean Dupont",
      companyName: "Atelier Durand",
      companyAddress: "12 rue des Lilas, 69001 Lyon",
      dataPageUrl: "https://api.exemple.test/api/prospection/donnees/x",
    },
    ...overrides,
  });
}

let counter = 0;
async function seedRecipients(sequence, count, overrides = {}) {
  const docs = Array.from({ length: count }, () => {
    counter += 1;
    return {
      workspaceId,
      sequenceId: sequence._id,
      mailboxId: sequence.mailboxId,
      email: `contact${counter}@menuiserie-${counter}.fr`,
      name: `Menuiserie ${counter}`,
      company: `Menuiserie ${counter}`,
      vars: {
        prenom: "Marie",
        entreprise: `Menuiserie ${counter}`,
        activite: "Menuiserie",
      },
      isGeneratedProspect: true,
      status: "PENDING",
      ...overrides,
    };
  });
  return ProspectingRecipient.insertMany(docs);
}

const freshMailbox = (id) => MailboxConnection.findById(id).lean();
const recipientOf = (id) => ProspectingRecipient.findById(id).lean();

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    MailboxConnection.init(),
    ProspectingSequence.init(),
    ProspectingRecipient.init(),
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
  clock = new Date(WEDNESDAY_10H);
  mails.sent = [];
  gmail.sends = [];
  gmail.refreshes = [];
  gmail.send = null;
  gmail.token = null;
  vi.stubEnv("CALENDAR_ENCRYPTION_KEY", "cle-de-test-boites");
  vi.stubEnv("JWT_SECRET", "secret-de-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
  vi.stubEnv("FRONTEND_URL", "https://app.exemple.test");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("PROSPECTING_MAX_DAILY_PER_MAILBOX", "");
  // Envoi réel (vers Gmail simulé) sauf mention contraire
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "live");
  vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
  vi.stubGlobal("fetch", async (url, options = {}) => {
    if (String(url) === TOKEN_URL) {
      gmail.refreshes.push(
        Object.fromEntries(new URLSearchParams(options.body)),
      );
      return gmail.token
        ? gmail.token()
        : json(200, {
            access_token: "acces-renouvele",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.send",
          });
    }
    if (String(url) === SEND_URL) {
      const { raw } = JSON.parse(options.body);
      gmail.sends.push({
        authorization: options.headers.Authorization,
        mime: Buffer.from(raw, "base64url").toString("utf8"),
      });
      return gmail.send
        ? gmail.send(gmail.sends.length)
        : json(200, {
            id: `msg-${gmail.sends.length}`,
            threadId: `thread-${gmail.sends.length}`,
          });
    }
    throw new Error(`appel réseau inattendu : ${url}`);
  });
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Atelier Durand",
  });
  await mongoose.connection.db.collection("user").insertOne({
    _id: owner,
    name: "Jean Dupont",
    email: "jean@newbi-membre.fr",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("un envoi", () => {
  it("un message par passage depuis la boîte : SENT, identifiants Gmail, prochain envoi dans 3 à 8 minutes", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [first, second] = await seedRecipients(sequence, 3);

    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "sent",
    );
    expect(gmail.sends).toHaveLength(1);
    expect(gmail.sends[0].authorization).toBe("Bearer acces-valide");

    const message = parseMime(gmail.sends[0].mime);
    expect(message.headers.from).toBe('"Jean Dupont" <jean@atelier-durand.fr>');
    expect(message.headers.to).toBe(first.email);
    expect(decodeHeader(message.headers.subject)).toBe(
      `Une idée pour ${first.company}`,
    );
    const unsubscribe = /^<(.+)>$/.exec(message.headers["list-unsubscribe"])[1];
    expect(unsubscribe).toMatch(
      /^https:\/\/api\.exemple\.test\/api\/prospection\/desinscription\?t=/,
    );
    expect(
      verifyCampaignToken(
        TOKEN_KINDS.prospectingUnsubscribe,
        new URL(unsubscribe).searchParams.get("t"),
      ),
    ).toBe(String(first._id));
    expect(message.headers["list-unsubscribe-post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(message.text).toContain("Bonjour Marie,");
    expect(message.html).toContain("(Menuiserie)");
    expect(message.html).toContain("Societeinfo");

    const sent = await recipientOf(first._id);
    expect(sent).toMatchObject({
      status: "SENT",
      simulated: false,
      providerMessageId: "msg-1",
      threadId: "thread-1",
      attempts: 1,
      lockedAt: null,
      sendStartedAt: null,
    });
    expect(sent.sentAt.getTime()).toBe(clock.getTime());
    const after = await freshMailbox(mailbox._id);
    const delay = after.nextSendAfter.getTime() - clock.getTime();
    expect(delay).toBeGreaterThanOrEqual(3 * MINUTE);
    expect(delay).toBeLessThanOrEqual(8 * MINUTE);
    expect(after.lockedUntil).toBeNull();
    const stats = (await ProspectingSequence.findById(sequence._id).lean())
      .stats;
    expect(stats).toMatchObject({ recipients: 3, pending: 2, sent: 1 });

    // Prochain envoi pas encore dû : rien ne part
    expect(await processMailbox(after, { now: now() })).toBe("busy");
    expect(gmail.sends).toHaveLength(1);
    expect((await recipientOf(second._id)).status).toBe("PENDING");
  });

  it("plus ancien destinataire d'abord ; prospection terminée quand plus rien n'attend", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const recipients = await seedRecipients(sequence, 3);
    for (let i = 0; i < 3; i += 1) {
      await runProspectingTick({ now });
      advance(9 * MINUTE);
    }
    expect(gmail.sends.map((s) => parseMime(s.mime).headers.to)).toEqual(
      recipients.map((r) => r.email),
    );
    const done = await ProspectingSequence.findById(sequence._id).lean();
    expect(done.status).toBe("COMPLETED");
    expect(done.completedAt).not.toBeNull();
    expect(done.stats).toMatchObject({ recipients: 3, pending: 0, sent: 3 });
  });

  it("hors plage : rien avant 9 h, le week-end ni un jour férié", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    await seedRecipients(sequence, 1);
    const at = (iso) =>
      processMailbox(mailbox.toObject(), { now: new Date(iso) });
    expect(await at("2026-11-25T07:30:00Z")).toBe("outsideWindow"); // 8 h 30
    expect(await at("2026-11-25T17:00:00Z")).toBe("outsideWindow"); // 18 h
    expect(await at("2026-11-28T10:00:00Z")).toBe("outsideWindow"); // samedi
    expect(await at("2026-12-25T10:00:00Z")).toBe("outsideWindow"); // Noël
    expect(gmail.sends).toHaveLength(0);
  });

  it("limite du jour avec montée progressive : 10 par jour la première semaine, envois simulés compris", async () => {
    const mailbox = await seedMailbox({
      connectedAt: new Date("2026-11-23T08:00:00Z"),
    });
    const sequence = await seedSequence(mailbox);
    await seedRecipients(sequence, 6, {
      status: "SENT",
      sentAt: new Date("2026-11-25T08:10:00Z"),
    });
    await seedRecipients(sequence, 4, {
      status: "SIMULATED",
      simulated: true,
      sentAt: new Date("2026-11-25T08:20:00Z"),
    });
    await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "dailyLimit",
    );
    // Lendemain : le compteur repart (jour de Paris)
    expect(
      await processMailbox(mailbox.toObject(), {
        now: new Date("2026-11-26T09:00:00Z"),
      }),
    ).toBe("sent");
  });

  it("verrou de la boîte : deux passages simultanés n'envoient qu'un message", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    await seedRecipients(sequence, 2);
    const outcomes = await Promise.all([
      processMailbox(mailbox.toObject(), { now: now() }),
      processMailbox(mailbox.toObject(), { now: now() }),
    ]);
    expect(outcomes.sort()).toEqual(["busy", "sent"]);
    expect(gmail.sends).toHaveLength(1);
  });

  it("tour de rôle entre les prospections d'une même boîte", async () => {
    const mailbox = await seedMailbox();
    const a = await seedSequence(mailbox, { name: "A" });
    const b = await seedSequence(mailbox, { name: "B" });
    const [a1, a2] = await seedRecipients(a, 2);
    const [b1] = await seedRecipients(b, 2);
    for (let i = 0; i < 3; i += 1) {
      await runProspectingTick({ now });
      advance(9 * MINUTE);
    }
    expect(gmail.sends.map((s) => parseMime(s.mime).headers.to)).toEqual([
      a1.email,
      b1.email,
      a2.email,
    ]);
  });
});

describe("re-vérifications avant l'envoi", () => {
  it("désinscrit et déjà prospecté depuis moins de 30 jours : SKIPPED, puis envoi du suivant", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [suppressed, recent, simulatedBefore, ok] = await seedRecipients(
      sequence,
      4,
    );
    await EmailSuppression.create({
      workspaceId,
      email: suppressed.email,
      reason: "UNSUBSCRIBED",
    });
    const older = await seedSequence(mailbox, { status: "COMPLETED" });
    await ProspectingRecipient.create([
      {
        workspaceId,
        sequenceId: older._id,
        mailboxId: mailbox._id,
        email: recent.email,
        status: "SENT",
        sentAt: new Date("2026-11-15T09:00:00Z"),
      },
      // Envoi simulé : rien n'est parti, la règle des 30 jours ne compte pas
      {
        workspaceId,
        sequenceId: older._id,
        mailboxId: mailbox._id,
        email: simulatedBefore.email,
        status: "SIMULATED",
        simulated: true,
        sentAt: new Date("2026-11-20T09:00:00Z"),
      },
    ]);

    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "sent",
    );
    expect(await recipientOf(suppressed._id)).toMatchObject({
      status: "SKIPPED",
      skippedReason: "désinscrit",
    });
    expect(await recipientOf(recent._id)).toMatchObject({
      status: "SKIPPED",
      skippedReason: "déjà prospecté",
    });
    expect((await recipientOf(simulatedBefore._id)).status).toBe("SENT");
    expect((await recipientOf(ok._id)).status).toBe("PENDING");
    expect(gmail.sends).toHaveLength(1);
    const stats = (await ProspectingSequence.findById(sequence._id).lean())
      .stats;
    expect(stats).toMatchObject({ skipped: 2, sent: 1, pending: 1 });
  });

  it("au-delà de 30 jours, l'adresse peut de nouveau être prospectée", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [recipient] = await seedRecipients(sequence, 1);
    const older = await seedSequence(mailbox, { status: "COMPLETED" });
    await ProspectingRecipient.create({
      workspaceId,
      sequenceId: older._id,
      mailboxId: mailbox._id,
      email: recipient.email,
      status: "SENT",
      sentAt: new Date("2026-10-20T09:00:00Z"),
    });
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "sent",
    );
  });
});

describe("mode d'envoi des campagnes", () => {
  it("hors production : seules les adresses autorisées reçoivent, les autres sont simulées", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "@menuiserie-autorisee.fr");
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [other] = await seedRecipients(sequence, 1);
    const [allowed] = await seedRecipients(sequence, 1, {
      email: "contact@menuiserie-autorisee.fr",
    });

    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "simulated",
    );
    expect(gmail.sends).toHaveLength(0);
    expect(await recipientOf(other._id)).toMatchObject({
      status: "SIMULATED",
      simulated: true,
    });
    // Simulé : espacé comme un vrai envoi, compté dans les envois du jour
    const after = await freshMailbox(mailbox._id);
    expect(after.nextSendAfter.getTime()).toBeGreaterThan(clock.getTime());

    advance(9 * MINUTE);
    expect(await processMailbox(after, { now: now() })).toBe("sent");
    expect(gmail.sends).toHaveLength(1);
    expect((await recipientOf(allowed._id)).status).toBe("SENT");
  });
});

describe("jetons", () => {
  it("jeton expiré : renouvelé avant l'envoi et enregistré chiffré", async () => {
    const mailbox = await seedMailbox({
      tokenExpiresAt: new Date(WEDNESDAY_10H.getTime() - MINUTE),
    });
    const sequence = await seedSequence(mailbox);
    await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "sent",
    );
    expect(gmail.refreshes).toHaveLength(1);
    expect(gmail.refreshes[0]).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "rafraichissement",
      client_id: "google-id",
    });
    expect(gmail.sends[0].authorization).toBe("Bearer acces-renouvele");
    const stored = await freshMailbox(mailbox._id);
    expect(stored.accessToken).toMatch(/^encrypted:/);
    expect(decryptToken(stored.accessToken)).toBe("acces-renouvele");
    expect(stored.refreshToken).toMatch(/^encrypted:/);
  });

  it("jeton refusé : boîte EXPIRED, destinataire en attente, membre prévenu une seule fois", async () => {
    gmail.token = () =>
      json(400, { error: "invalid_grant", error_description: "revoked" });
    const mailbox = await seedMailbox({
      tokenExpiresAt: new Date(WEDNESDAY_10H.getTime() - MINUTE),
    });
    const sequence = await seedSequence(mailbox);
    const [recipient] = await seedRecipients(sequence, 1);

    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "expired",
    );
    expect(await freshMailbox(mailbox._id)).toMatchObject({
      status: "EXPIRED",
      lockedUntil: null,
    });
    expect(await recipientOf(recipient._id)).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lockedAt: null,
    });
    expect(
      (await ProspectingSequence.findById(sequence._id).lean()).status,
    ).toBe("ACTIVE");
    expect(mails.sent).toHaveLength(1);
    expect(mails.sent[0].to).toBe("jean@newbi-membre.fr");
    expect(mails.sent[0].subject).toBe(
      "Reconnectez votre boîte d'envoi pour reprendre vos prospections",
    );
    expect(mails.sent[0].html).toContain("jean@atelier-durand.fr");
    expect(mails.sent[0].html).toContain(
      "https://app.exemple.test/dashboard/outils/prospection",
    );
    expect(mails.sent[0].html).not.toContain("—");

    // Boîte expirée : plus servie ; l'e-mail ne repart pas
    advance(9 * MINUTE);
    await runProspectingTick({ now });
    await MailboxConnection.updateOne(
      { _id: mailbox._id },
      { $set: { status: "ACTIVE" } },
    );
    await processMailbox(await freshMailbox(mailbox._id), { now: now() });
    expect(mails.sent).toHaveLength(1);
    expect(gmail.sends).toHaveLength(0);
  });

  it("401 à l'envoi : jeton renouvelé une fois puis nouvel essai", async () => {
    gmail.send = (count) =>
      count === 1
        ? json(401, { error: { message: "Invalid Credentials" } })
        : json(200, { id: "msg-ok", threadId: "thread-ok" });
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [recipient] = await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "sent",
    );
    expect(gmail.refreshes).toHaveLength(1);
    expect(gmail.sends.map((s) => s.authorization)).toEqual([
      "Bearer acces-valide",
      "Bearer acces-renouvele",
    ]);
    expect((await recipientOf(recipient._id)).providerMessageId).toBe("msg-ok");
  });
});

describe("erreurs du fournisseur", () => {
  it("quota atteint : reprise au début de la plage du lendemain, aucun essai consommé", async () => {
    gmail.send = () =>
      json(429, { error: { message: "User-rate limit exceeded" } });
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [recipient] = await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "quota",
    );
    expect(await recipientOf(recipient._id)).toMatchObject({
      status: "PENDING",
      attempts: 0,
      lockedAt: null,
    });
    const after = await freshMailbox(mailbox._id);
    // Jeudi 26 novembre, 9 h à Paris
    expect(after.nextSendAfter.toISOString()).toBe("2026-11-26T08:00:00.000Z");
    expect(after.status).toBe("ACTIVE");
  });

  it("adresse refusée : FAILED avec le message du fournisseur", async () => {
    gmail.send = () => json(400, { error: { message: "Invalid To header" } });
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [recipient] = await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "failed",
    );
    const failed = await recipientOf(recipient._id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toContain("Invalid To header");
    const done = await ProspectingSequence.findById(sequence._id).lean();
    expect(done.stats.failed).toBe(1);
    expect(done.status).toBe("COMPLETED");
  });

  it("erreur passagère : nouvel essai, 3 au plus, puis FAILED", async () => {
    gmail.send = () => json(503, { error: { message: "Backend Error" } });
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const [recipient] = await seedRecipients(sequence, 1);
    expect(MAX_ATTEMPTS).toBe(3);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      expect(
        await processMailbox(await freshMailbox(mailbox._id), { now: now() }),
      ).toBe("retry");
      expect(await recipientOf(recipient._id)).toMatchObject({
        status: "PENDING",
        attempts: attempt,
      });
      advance(6 * MINUTE);
    }
    expect(
      await processMailbox(await freshMailbox(mailbox._id), { now: now() }),
    ).toBe("failed");
    const failed = await recipientOf(recipient._id);
    expect(failed.status).toBe("FAILED");
    expect(failed.error).toMatch(/^Envoi impossible après 3 essais/);
  });
});

describe("garde-fous", () => {
  it("envoi interrompu après l'appel au fournisseur : jamais renvoyé ; réservation sans appel : levée", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    const staleSince = new Date(WEDNESDAY_10H.getTime() - 15 * MINUTE);
    const [started] = await seedRecipients(sequence, 1, {
      lockedAt: staleSince,
      sendStartedAt: staleSince,
    });
    const [reserved] = await seedRecipients(sequence, 1, {
      lockedAt: staleSince,
    });
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "sent",
    );
    const interrupted = await recipientOf(started._id);
    expect(interrupted.status).toBe("FAILED");
    expect(interrupted.error).toMatch(/^Envoi interrompu/);
    expect((await recipientOf(reserved._id)).status).toBe("SENT");
    expect(gmail.sends).toHaveLength(1);
  });

  it("le propriétaire n'a plus le droit d'envoyer : prospections en pause, rien ne part", async () => {
    await mongoose.connection.db
      .collection("member")
      .updateOne({ userId: owner }, { $set: { role: "viewer" } });
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "noRights",
    );
    expect(gmail.sends).toHaveLength(0);
    expect(
      await ProspectingSequence.findById(sequence._id).lean(),
    ).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
  });

  it("autre adresse que celle du lancement : rien ne part, prospection en pause", async () => {
    const mailbox = await seedMailbox();
    const sequence = await seedSequence(mailbox);
    await ProspectingSequence.updateOne(
      { _id: sequence._id },
      { $set: { "snapshot.senderEmail": "ancienne@atelier-durand.fr" } },
    );
    await seedRecipients(sequence, 1);
    expect(await processMailbox(mailbox.toObject(), { now: now() })).toBe(
      "paused",
    );
    expect(gmail.sends).toHaveLength(0);
    const paused = await ProspectingSequence.findById(sequence._id).lean();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
    expect(paused.pausedReason).toMatch(/autre adresse/);
  });

  it("passage du cron : seules les boîtes actives dont l'envoi est dû", async () => {
    const [paul, luc] = [buildUserId(), buildUserId()];
    for (const userId of [paul, luc]) {
      await seedOrgMembership({
        userId,
        organizationId: workspaceId,
        role: "admin",
      });
    }
    const due = await seedMailbox();
    const later = await seedMailbox({
      userId: paul,
      accountEmail: "paul@atelier-durand.fr",
      nextSendAfter: new Date(WEDNESDAY_10H.getTime() + 5 * MINUTE),
    });
    const expired = await seedMailbox({
      userId: luc,
      accountEmail: "luc@atelier-durand.fr",
      status: "EXPIRED",
    });
    for (const mailbox of [due, later, expired]) {
      const sequence = await seedSequence(mailbox);
      await seedRecipients(sequence, 1);
    }
    const draft = await seedSequence(due, { status: "DRAFT" });
    await seedRecipients(draft, 1);
    expect(await runProspectingTick({ now })).toEqual({ sent: 1 });
    expect(gmail.sends).toHaveLength(1);
    expect(parseMime(gmail.sends[0].mime).headers.from).toContain(
      "jean@atelier-durand.fr",
    );
  });
});
