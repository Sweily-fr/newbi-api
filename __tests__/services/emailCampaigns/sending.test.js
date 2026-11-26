/**
 * Campagnes e-mail, lancement et envoi par lots (Resend simulé, aucun
 * envoi réel) : destinataires figés, quota, lots de 100 espacés, en-têtes
 * de désinscription, erreurs partielles, clé d'idempotence stable d'une
 * reprise à l'autre, erreurs temporaires (3 essais), définitives et de
 * configuration, modes simulation et restreint, plafond par minute, pause,
 * reprise, annulation, envoi programmé, e-mails de test, adresse d'envoi
 * (domaine connecté validé ou non, domaine Newbi non validé chez Resend),
 * suivi des ouvertures et des clics (coupé par défaut, attestation exigée et
 * tracée quand il est actif, mention dans le pied).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

const resendMock = vi.hoisted(() => ({
  calls: [],
  responder: null,
  // Domaines du compte Resend (statut du domaine d'envoi Newbi)
  domains: [],
  listCalls: 0,
}));
const alerts = vi.hoisted(() => ({ notifyError: vi.fn(async () => true) }));
vi.mock("../../../src/services/errorAlertService.js", () => ({
  notifyError: alerts.notifyError,
}));
vi.mock("resend", () => ({
  Resend: class {
    constructor(key) {
      this.key = key;
      this.batch = {
        send: async (payloads, options) => {
          resendMock.calls.push({ payloads, options });
          if (resendMock.responder) {
            return resendMock.responder(payloads, resendMock.calls.length);
          }
          return {
            data: {
              data: payloads.map((_, i) => ({
                id: `re_${resendMock.calls.length}_${i}`,
              })),
            },
            error: null,
          };
        },
      };
      this.emails = {
        send: async () => {
          throw new Error("envoi unitaire inattendu");
        },
      };
      this.domains = {
        list: async () => {
          resendMock.listCalls += 1;
          return {
            data: { object: "list", has_more: false, data: resendMock.domains },
            error: null,
          };
        },
      };
    }
  },
}));
vi.mock("../../../src/services/signatureAssets.js", () => ({
  ensureIcons: vi.fn(async () => {}),
  ensureRoundPhoto: vi.fn(async () => null),
  roundPhotoUrl: vi.fn(() => null),
}));
const dnsRecords = vi.hoisted(() => new Map());
vi.mock("node:dns", () => {
  const resolveTxt = async (name) => {
    const value = dnsRecords.get(name);
    if (!value) throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
    return value.map((record) => [record]);
  };
  return { default: { promises: { resolveTxt } }, promises: { resolveTxt } };
});

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
import Client from "../../../src/models/Client.js";
import EmailCampaign from "../../../src/models/EmailCampaign.js";
import EmailCampaignRecipient from "../../../src/models/EmailCampaignRecipient.js";
import EmailSendingDomain from "../../../src/models/EmailSendingDomain.js";
import EmailSignatureV2 from "../../../src/models/EmailSignatureV2.js";
import EmailSuppression from "../../../src/models/EmailSuppression.js";
import EmailTrackingConsent from "../../../src/models/EmailTrackingConsent.js";
import {
  MAX_ATTEMPTS,
  cancelCampaign,
  pauseCampaign,
  processSendingCampaigns,
  requestSend,
  resumeCampaign,
  runEmailCampaignTick,
  sendCampaignTest,
} from "../../../src/services/emailCampaigns/campaignService.js";
import {
  SENDING_UNAVAILABLE_MESSAGE,
  resetDnsCache,
} from "../../../src/services/emailCampaigns/deliverability.js";
import { resetResendClient } from "../../../src/services/emailCampaigns/sender.js";
import { resetNewbiDomainCache } from "../../../src/services/emailCampaigns/sendingDomains.js";
import {
  TOKEN_KINDS,
  verifyCampaignToken,
} from "../../../src/services/emailCampaigns/tracking.js";

const workspaceId = buildOrganizationId();
const userId = buildUserId();
// Adresse Newbi de l'espace : nom de l'entreprise sur le domaine d'envoi
const SENDER = "atelier-durand@envoi.newbi.fr";

let clock;
const now = () => new Date(clock);
const sleeps = [];
const sleep = async (ms) => {
  sleeps.push(ms);
};
const tick = (options = {}) =>
  processSendingCampaigns({ now, sleep, ...options });

async function seedClients(count, prefix = "client") {
  const docs = Array.from({ length: count }, (_, i) =>
    buildClientDoc({
      workspaceId,
      createdBy: userId,
      type: "INDIVIDUAL",
      firstName: "Marie",
      lastName: "Durand",
      name: "Marie Durand",
      email: `${prefix}${i}@exemple.fr`,
    }),
  );
  await Client.insertMany(docs);
}

const DESIGN = {
  version: 1,
  blocks: [
    {
      type: "text",
      html: `<p>Bonjour {{prenom|à vous}},</p><p>${"Voici les nouvelles de notre atelier, avec nos créations du mois et nos conseils. ".repeat(4)}</p>`,
    },
    {
      type: "button",
      label: "Découvrir",
      url: "https://atelier.fr/nouveautes",
    },
  ],
};

async function createCampaign(overrides = {}) {
  return EmailCampaign.create({
    workspaceId,
    name: "Nouveautés de novembre",
    subject: "Les nouveautés de l'atelier, {{prenom|à vous}}",
    preheader: "Nos créations du mois",
    fromName: "Atelier Durand",
    replyTo: "contact@atelier.fr",
    design: DESIGN,
    audience: { mode: "ALL", listIds: [], excludeListIds: [] },
    createdBy: userId,
    ...overrides,
  });
}

const recipientsOf = (campaignId, filter = {}) =>
  EmailCampaignRecipient.find({ campaignId, ...filter })
    .sort({ _id: 1 })
    .lean();

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Client.init(),
    EmailCampaign.init(),
    EmailCampaignRecipient.init(),
    EmailSuppression.init(),
    EmailSendingDomain.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  resetDnsCache();
  resetResendClient();
  resetNewbiDomainCache();
  resendMock.calls = [];
  resendMock.responder = null;
  resendMock.domains = [
    { id: "dom_envoi", name: "envoi.newbi.fr", status: "verified" },
  ];
  resendMock.listCalls = 0;
  alerts.notifyError.mockClear();
  sleeps.length = 0;
  clock = Date.parse("2026-11-16T10:00:00Z");
  vi.stubEnv("JWT_SECRET", "secret-de-test");
  vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
  vi.stubEnv("RESEND_API_KEY", "re_test_aucun_envoi");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_DOMAIN", "envoi.newbi.fr");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_EMAIL", "");
  vi.stubEnv("EMAIL_CAMPAIGN_RESEND_API_KEY", "");
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "live");
  vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
  vi.stubEnv("EMAIL_CAMPAIGN_MAX_PER_MINUTE", "");
  vi.stubEnv("EMAIL_CAMPAIGN_MONTHLY_QUOTAS", "");
  dnsRecords.clear();
  dnsRecords.set("resend._domainkey.envoi.newbi.fr", ["p=abc"]);
  dnsRecords.set("send.envoi.newbi.fr", ["v=spf1 include:amazonses.com ~all"]);
  dnsRecords.set("_dmarc.newbi.fr", ["v=DMARC1; p=none"]);
  await seedOrgMembership({
    userId,
    organizationId: workspaceId,
    organizationName: "Atelier Durand",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lancement", () => {
  it("fige les destinataires, les liens et l'expéditeur", async () => {
    await seedClients(3);
    await EmailSuppression.create({
      workspaceId,
      email: "client1@exemple.fr",
      reason: "UNSUBSCRIBED",
    });
    const campaign = await createCampaign();
    const launched = await requestSend(campaign, {
      userId,
      now: now(),
    });
    expect(launched.status).toBe("SENDING");
    expect(launched.links).toEqual(["https://atelier.fr/nouveautes"]);
    expect(launched.snapshot).toMatchObject({
      senderEmail: SENDER,
      fromName: "Atelier Durand",
      replyTo: "contact@atelier.fr",
      companyName: "Atelier Durand",
      companyAddress: "1 rue du Test, 75001 Paris",
    });
    expect(launched.stats.recipients).toBe(2);
    const saved = await EmailCampaign.findById(campaign._id).lean();
    expect(saved.consentBy).toEqual(userId);
    const recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => r.email)).toEqual([
      "client0@exemple.fr",
      "client2@exemple.fr",
    ]);
    expect(recipients[0]).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("arrêt pendant le lancement : liens et expéditeur déjà figés", async () => {
    await seedClients(2);
    const campaign = await createCampaign();
    const insertMany = vi
      .spyOn(EmailCampaignRecipient, "insertMany")
      .mockImplementationOnce(async () => {
        const saved = await EmailCampaign.findById(campaign._id).lean();
        expect(saved.status).toBe("SENDING");
        expect(saved.links).toEqual(["https://atelier.fr/nouveautes"]);
        expect(saved.snapshot.companyName).toBe("Atelier Durand");
        throw new Error("arrêt simulé");
      });
    await expect(requestSend(campaign, { userId, now: now() })).rejects.toThrow(
      "arrêt simulé",
    );
    insertMany.mockRestore();
    // Échec franc : la campagne revient en brouillon, sans destinataire
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("DRAFT");
    expect(await EmailCampaignRecipient.countDocuments()).toBe(0);
  });

  it("refuse au-delà du quota mensuel, sans rien créer", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_MONTHLY_QUOTAS", '{"pme":2}');
    await seedClients(3);
    const campaign = await createCampaign();
    await expect(requestSend(campaign, { userId, now: now() })).rejects.toThrow(
      /^Votre quota mensuel est atteint : 2 e-mails restants pour 3 destinataires$/,
    );
    expect(await EmailCampaignRecipient.countDocuments()).toBe(0);
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("DRAFT");
  });

  it("refuse une campagne dont la vérification a une erreur (premier titre)", async () => {
    await seedClients(1);
    const campaign = await createCampaign({ subject: "" });
    await expect(requestSend(campaign, { userId })).rejects.toThrow(
      "Ajoutez un objet avant d'envoyer",
    );
  });
});

/** Accord de suivi donné par ces adresses (saisi par l'espace). */
const grantTracking = (...emails) =>
  EmailTrackingConsent.insertMany(
    emails.map((email) => ({
      workspaceId,
      email,
      status: "GRANTED",
      source: "SENDER",
      decidedAt: now(),
    })),
  );

describe("suivi des ouvertures et des clics", () => {
  it("coupé par défaut : ni pixel, ni lien suivi, ni mention, ni préférences", async () => {
    await seedClients(1);
    await grantTracking("client0@exemple.fr");
    const campaign = await createCampaign();
    expect(campaign.trackOpens).toBe(false);
    expect(campaign.trackClicks).toBe(false);
    await requestSend(campaign, { userId, now: now() });
    const saved = await EmailCampaign.findById(campaign._id).lean();
    expect(saved.consentBy).toEqual(userId);
    expect(saved.trackedCount).toBe(0);
    expect((await recipientsOf(campaign._id))[0].trackingAllowed).toBe(false);
    await tick();
    const payload = resendMock.calls[0].payloads[0];
    expect(payload.html).toContain('href="https://atelier.fr/nouveautes"');
    expect(payload.html).not.toContain("/api/email-campaigns/c/");
    expect(payload.html).not.toContain("/api/email-campaigns/o/");
    expect(payload.text).not.toContain("mesure");
    expect(payload.text).not.toContain("Gérer mes préférences");
  });

  it("actif : seules les adresses qui ont accepté sont suivies, sans attestation globale", async () => {
    await seedClients(3);
    await grantTracking("client1@exemple.fr");
    await EmailTrackingConsent.create({
      workspaceId,
      email: "client2@exemple.fr",
      status: "REFUSED",
      source: "CONTACT",
      decidedAt: now(),
    });
    const campaign = await createCampaign({
      trackOpens: true,
      trackClicks: true,
      privacyPolicyUrl: "https://atelier.fr/confidentialite",
    });
    const launched = await requestSend(campaign, { userId, now: now() });
    expect(launched.status).toBe("SENDING");
    expect(launched.trackedCount).toBe(1);
    const recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => [r.email, r.trackingAllowed])).toEqual([
      ["client0@exemple.fr", false],
      ["client1@exemple.fr", true],
      ["client2@exemple.fr", false],
    ]);
    await tick();
    const byEmail = new Map(
      resendMock.calls[0].payloads.map((p) => [p.to[0], p]),
    );
    // Accord donné : pixel, liens suivis, phrase, préférences
    const tracked = byEmail.get("client1@exemple.fr");
    expect(tracked.html).toContain("/api/email-campaigns/o/");
    expect(tracked.html).toContain("/api/email-campaigns/c/");
    expect(tracked.text).toContain(
      "Atelier Durand mesure l'ouverture de cet e-mail et les clics sur ses liens, avec votre accord.\nPolitique de confidentialité : https://atelier.fr/confidentialite\nGérer mes préférences : https://api.exemple.test/api/email-campaigns/preferences?t=",
    );
    const prefToken = tracked.text.split("preferences?t=")[1].split("\n")[0];
    expect(verifyCampaignToken(TOKEN_KINDS.preferences, prefToken)).toBe(
      String(recipients[1]._id),
    );
    // Aucun choix ou refus : même e-mail sans suivi, préférences quand même
    for (const email of ["client0@exemple.fr", "client2@exemple.fr"]) {
      const untracked = byEmail.get(email);
      expect(untracked.html, email).toContain(
        'href="https://atelier.fr/nouveautes"',
      );
      expect(untracked.html, email).not.toContain("/api/email-campaigns/o/");
      expect(untracked.html, email).not.toContain("/api/email-campaigns/c/");
      expect(untracked.text, email).not.toContain("mesure");
      expect(untracked.text, email).toContain("Gérer mes préférences : ");
    }
  });

  it("refus pendant l'envoi : les e-mails encore à partir partent sans suivi", async () => {
    await seedClients(1);
    await grantTracking("client0@exemple.fr");
    const campaign = await createCampaign({ trackOpens: true });
    await requestSend(campaign, { userId, now: now() });
    await EmailCampaignRecipient.updateOne(
      { campaignId: campaign._id },
      { $set: { trackingAllowed: false, trackingExpired: true } },
    );
    await tick();
    const payload = resendMock.calls[0].payloads[0];
    expect(payload.html).not.toContain("/api/email-campaigns/o/");
    expect(payload.text).not.toContain("mesure");
  });

  it("clics seulement : liens suivis sans pixel, seuls les clics annoncés", async () => {
    await seedClients(1);
    await grantTracking("client0@exemple.fr");
    const campaign = await createCampaign({ trackClicks: true });
    await requestSend(campaign, { userId, now: now() });
    await tick();
    const payload = resendMock.calls[0].payloads[0];
    expect(payload.html).toContain("/api/email-campaigns/c/");
    expect(payload.html).not.toContain("/api/email-campaigns/o/");
    expect(payload.text).toContain(
      "Atelier Durand mesure les clics sur les liens de cet e-mail, avec votre accord.",
    );
    expect(payload.text).not.toContain("Politique de confidentialité");
  });
});

describe("envoi par lots", () => {
  it("lots de 100, espacés, en-têtes de désinscription, puis SENT", async () => {
    await seedClients(250);
    await grantTracking("client0@exemple.fr");
    const campaign = await createCampaign({
      trackOpens: true,
      trackClicks: true,
      privacyPolicyUrl: "https://atelier.fr/confidentialite",
    });
    await requestSend(campaign, { userId, now: now() });
    const totals = await tick();
    expect(totals).toMatchObject({ batches: 3, sent: 250, failed: 0 });
    expect(resendMock.calls.map((c) => c.payloads.length)).toEqual([
      100, 100, 50,
    ]);
    expect(sleeps).toEqual([1200, 1200, 1200]);
    const [first] = resendMock.calls;
    expect(first.options).toMatchObject({ batchValidation: "permissive" });
    expect(first.options.idempotencyKey).toMatch(
      new RegExp(`^campagne-${campaign._id}-[0-9a-f]{32}-0$`),
    );
    const payload = first.payloads[0];
    expect(payload).toMatchObject({
      from: `Atelier Durand <${SENDER}>`,
      to: ["client0@exemple.fr"],
      replyTo: "contact@atelier.fr",
      subject: "Les nouveautés de l'atelier, Marie",
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [
        { name: "category", value: "email_campaign" },
        { name: "campaign_id", value: String(campaign._id) },
      ],
    });
    const recipient = (await recipientsOf(campaign._id))[0];
    const unsubscribe = payload.headers["List-Unsubscribe"];
    expect(unsubscribe).toMatch(
      /^<https:\/\/api\.exemple\.test\/api\/email-campaigns\/unsubscribe\?t=/,
    );
    const token = unsubscribe.split("t=")[1].replace(">", "");
    expect(verifyCampaignToken(TOKEN_KINDS.unsubscribe, token)).toBe(
      String(recipient._id),
    );
    // Lien du bouton suivi, pixel, texte brut
    expect(payload.html).toContain("/api/email-campaigns/c/");
    expect(payload.html).not.toContain('href="https://atelier.fr/nouveautes"');
    expect(payload.html).toContain("/api/email-campaigns/o/");
    expect(payload.text).toContain("Bonjour Marie,");
    // Suivi annoncé dans le pied, avec la politique de confidentialité
    expect(payload.text).toContain(
      "Atelier Durand mesure l'ouverture de cet e-mail et les clics sur ses liens, avec votre accord.",
    );
    expect(payload.text).toContain(
      "Politique de confidentialité : https://atelier.fr/confidentialite",
    );
    expect(payload.html).toContain('href="https://atelier.fr/confidentialite"');

    const done = await EmailCampaign.findById(campaign._id).lean();
    expect(done.status).toBe("SENT");
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.stats).toMatchObject({ recipients: 250, sent: 250 });
    expect(recipient).toMatchObject({ status: "SENT", resendId: "re_1_0" });
    expect(recipient.sentAt).toBeInstanceOf(Date);
  });

  it("erreurs partielles : seules les adresses refusées échouent", async () => {
    await seedClients(3);
    resendMock.responder = () => ({
      data: {
        data: [{ id: "re_a" }, { id: "re_c" }],
        errors: [{ index: 1, message: "Adresse invalide" }],
      },
      error: null,
    });
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await tick();
    const recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => [r.status, r.resendId ?? null])).toEqual([
      ["SENT", "re_a"],
      ["FAILED", null],
      ["SENT", "re_c"],
    ]);
    expect(recipients[1].error).toBe("Adresse invalide");
    const done = await EmailCampaign.findById(campaign._id).lean();
    expect(done.stats).toMatchObject({ sent: 2, failed: 1 });
    expect(done.status).toBe("SENT");
  });

  it("reprise après un arrêt en plein envoi : même lot, même clé d'idempotence", async () => {
    await seedClients(3);
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await tick();
    const key = resendMock.calls[0].options.idempotencyKey;
    // Arrêt brutal avant l'enregistrement du résultat : destinataires
    // restés réservés, campagne encore en cours
    await EmailCampaignRecipient.updateMany(
      { campaignId: campaign._id },
      {
        $set: {
          status: "PENDING",
          attempts: 0,
          lockedAt: new Date(clock - 11 * 60 * 1000),
          batchKey: "lot-interrompu",
        },
        $unset: { resendId: 1, sentAt: 1 },
      },
    );
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { status: "SENDING", completedAt: null } },
    );
    await tick();
    expect(resendMock.calls).toHaveLength(2);
    expect(resendMock.calls[1].options.idempotencyKey).toBe(key);
    expect(
      await EmailCampaignRecipient.countDocuments({ status: "SENT" }),
    ).toBe(3);
  });

  it("verrou récent : le lot en cours n'est pas repris", async () => {
    await seedClients(2);
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await EmailCampaignRecipient.updateMany(
      { campaignId: campaign._id },
      { $set: { lockedAt: new Date(clock - 60 * 1000), batchKey: "en-cours" } },
    );
    const totals = await tick();
    expect(totals.batches).toBe(0);
    expect(resendMock.calls).toHaveLength(0);
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("SENDING");
  });

  it("erreur temporaire : nouvel essai plus tard, 3 au plus, puis pause", async () => {
    await seedClients(2);
    resendMock.responder = () => ({
      data: null,
      error: {
        name: "internal_server_error",
        statusCode: 500,
        message: "Panne",
      },
    });
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });

    await tick();
    let recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => [r.status, r.attempts])).toEqual([
      ["PENDING", 1],
      ["PENDING", 1],
    ]);
    const keys = [resendMock.calls[0].options.idempotencyKey];
    // Attente imposée : rien au passage suivant immédiat
    await tick();
    expect(resendMock.calls).toHaveLength(1);

    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      clock += 10 * 60 * 1000;
      await tick();
      keys.push(resendMock.calls.at(-1).options.idempotencyKey);
    }
    expect(resendMock.calls).toHaveLength(MAX_ATTEMPTS);
    // Chaque essai a sa propre clé (une erreur n'est pas rejouée)
    expect(new Set(keys).size).toBe(MAX_ATTEMPTS);
    recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => r.status)).toEqual(["FAILED", "FAILED"]);
    expect(recipients[0].error).toMatch(/après 3 essais/);
    const paused = await EmailCampaign.findById(campaign._id).lean();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "SERVICE" });
    expect(paused.stats.failed).toBe(2);
  });

  it("erreur définitive du lot : destinataires FAILED", async () => {
    await seedClients(2);
    resendMock.responder = () => ({
      data: null,
      error: {
        name: "validation_error",
        statusCode: 422,
        message: "Contenu refusé",
      },
    });
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await tick();
    const recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => [r.status, r.error])).toEqual([
      ["FAILED", "Contenu refusé"],
      ["FAILED", "Contenu refusé"],
    ]);
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("SENT");
  });

  it("configuration refusée : pause, destinataires gardés", async () => {
    await seedClients(2);
    resendMock.responder = () => ({
      data: null,
      error: { name: "invalid_api_key", statusCode: 403, message: "Clé" },
    });
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await tick();
    const paused = await EmailCampaign.findById(campaign._id).lean();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "SERVICE" });
    // L'équipe est prévenue (domaine ou clé refusés par Resend)
    expect(alerts.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "campagnes",
        context: expect.objectContaining({ Expéditeur: SENDER }),
      }),
    );
    const recipients = await recipientsOf(campaign._id);
    expect(recipients.map((r) => [r.status, r.attempts, r.lockedAt])).toEqual([
      ["PENDING", 0, null],
      ["PENDING", 0, null],
    ]);
    // Reprise possible une fois la configuration réparée
    resendMock.responder = null;
    await resumeCampaign(paused);
    await tick();
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("SENT");
  });

  it("mode simulation : aucun appel, statuts et compteurs avancent", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "simulation");
    await seedClients(3);
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    const totals = await tick();
    expect(resendMock.calls).toHaveLength(0);
    expect(totals).toMatchObject({ simulated: 3, sent: 0 });
    expect(sleeps).toEqual([]);
    const done = await EmailCampaign.findById(campaign._id).lean();
    expect(done).toMatchObject({ status: "SENT", sendMode: "SIMULATION" });
    expect(done.stats).toMatchObject({ simulated: 3, sent: 0 });
    const recipient = (await recipientsOf(campaign._id))[0];
    expect(recipient.status).toBe("SIMULATED");
    expect(recipient.sentAt).toBeInstanceOf(Date);
  });

  it("mode restreint (hors production) : envoi réel aux seules adresses autorisées", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv(
      "EMAIL_CAMPAIGN_DEV_RECIPIENTS",
      "client1@exemple.fr,@sweily.fr",
    );
    await seedClients(3);
    await Client.create(
      buildClientDoc({
        workspaceId,
        createdBy: userId,
        email: "equipe@sweily.fr",
      }),
    );
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await tick();
    expect(resendMock.calls).toHaveLength(1);
    expect(resendMock.calls[0].payloads.map((p) => p.to[0]).sort()).toEqual([
      "client1@exemple.fr",
      "equipe@sweily.fr",
    ]);
    const done = await EmailCampaign.findById(campaign._id).lean();
    expect(done.stats).toMatchObject({ sent: 2, simulated: 2 });
  });

  it("plafond par minute : le reste part au passage suivant", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_MAX_PER_MINUTE", "150");
    await seedClients(250);
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    const first = await tick();
    expect(resendMock.calls.map((c) => c.payloads.length)).toEqual([100, 50]);
    expect(first.sent).toBe(150);
    clock += 60 * 1000;
    await tick();
    expect(resendMock.calls.map((c) => c.payloads.length)).toEqual([
      100, 50, 100,
    ]);
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("SENT");
  });

  it("campagnes servies à tour de rôle", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_MAX_PER_MINUTE", "300");
    await seedClients(200);
    const a = await createCampaign({ name: "A" });
    await requestSend(a, { userId, now: now() });
    const b = await createCampaign({ name: "B" });
    await requestSend(b, { userId, now: now() });
    await tick();
    const order = resendMock.calls.map((c) => c.payloads[0].tags[1].value);
    expect(order.slice(0, 2).sort()).toEqual(
      [String(a._id), String(b._id)].sort(),
    );
    expect(order[0]).not.toBe(order[1]);
  });

  it("pause, reprise et annulation", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_MAX_PER_MINUTE", "100");
    await seedClients(250);
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await tick();
    expect(resendMock.calls).toHaveLength(1);

    const paused = await pauseCampaign(
      await EmailCampaign.findById(campaign._id),
    );
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "MANUAL" });
    clock += 60 * 1000;
    await tick();
    expect(resendMock.calls).toHaveLength(1);

    await resumeCampaign(paused);
    clock += 60 * 1000;
    await tick();
    expect(resendMock.calls).toHaveLength(2);

    const canceled = await cancelCampaign(
      await EmailCampaign.findById(campaign._id),
      { now: now() },
    );
    expect(canceled.status).toBe("CANCELED");
    expect(canceled.completedAt).toBeInstanceOf(Date);
    expect(
      await EmailCampaignRecipient.countDocuments({ status: "SKIPPED" }),
    ).toBe(50);
    clock += 60 * 1000;
    await tick();
    expect(resendMock.calls).toHaveLength(2);
  });

  it("pause de réputation : reprise refusée", async () => {
    await seedClients(1);
    const campaign = await createCampaign();
    await requestSend(campaign, { userId, now: now() });
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      {
        $set: {
          status: "PAUSED",
          pauseKind: "REPUTATION",
          pausedReason: "Envoi suspendu",
        },
      },
    );
    await expect(
      resumeCampaign(await EmailCampaign.findById(campaign._id)),
    ).rejects.toThrow(/ne peut pas reprendre/);
  });
});

describe("envoi programmé", () => {
  it("part à l'heure dite", async () => {
    await seedClients(2);
    const campaign = await createCampaign();
    const scheduledAt = new Date(clock + 3600 * 1000);
    const scheduled = await requestSend(campaign, {
      userId,
      scheduledAt,
      now: now(),
    });
    expect(scheduled.status).toBe("SCHEDULED");
    await runEmailCampaignTick({ now, sleep });
    expect(resendMock.calls).toHaveLength(0);
    clock = scheduledAt.getTime() + 1000;
    const result = await runEmailCampaignTick({ now, sleep });
    expect(result).toMatchObject({ launched: 1, sent: 2 });
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("SENT");
  });

  it("quota atteint à l'heure dite : retour au brouillon avec la raison", async () => {
    await seedClients(3);
    const campaign = await createCampaign();
    const scheduledAt = new Date(clock + 3600 * 1000);
    await requestSend(campaign, { userId, scheduledAt, now: now() });
    vi.stubEnv("EMAIL_CAMPAIGN_MONTHLY_QUOTAS", '{"pme":1}');
    clock = scheduledAt.getTime() + 1000;
    const result = await runEmailCampaignTick({ now, sleep });
    expect(result.launched).toBe(0);
    const draft = await EmailCampaign.findById(campaign._id).lean();
    expect(draft.status).toBe("DRAFT");
    expect(draft.pausedReason).toMatch(
      /^L'envoi programmé n'a pas pu partir : Votre quota mensuel est atteint/,
    );
    expect(await EmailCampaignRecipient.countDocuments()).toBe(0);
  });
});

describe("adresse d'envoi", () => {
  const verifiedRecords = [
    {
      record: "DKIM",
      type: "TXT",
      name: "resend._domainkey",
      value: "p=abc",
      status: "VERIFIED",
    },
    {
      record: "SPF",
      type: "MX",
      name: "send",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
      status: "VERIFIED",
    },
    {
      record: "SPF",
      type: "TXT",
      name: "send",
      value: "v=spf1 include:amazonses.com ~all",
      status: "VERIFIED",
    },
  ];
  const connectDomain = (status) =>
    EmailSendingDomain.create({
      workspaceId,
      domain: "atelier.fr",
      fromEmail: "contact@atelier.fr",
      resendDomainId: "dom_atelier",
      status,
      zone: "atelier.fr",
      records: verifiedRecords,
    });

  it("domaine connecté validé : campagne et e-mail de test partent de son adresse", async () => {
    await connectDomain("VERIFIED");
    dnsRecords.set("_dmarc.atelier.fr", ["v=DMARC1; p=none"]);
    await seedClients(2);
    const campaign = await createCampaign();
    const launched = await requestSend(campaign, { userId, now: now() });
    expect(launched.snapshot.senderEmail).toBe("contact@atelier.fr");
    // Domaine du client : le domaine Newbi n'est pas consulté
    expect(resendMock.listCalls).toBe(0);
    await tick();
    expect(resendMock.calls[0].payloads[0]).toMatchObject({
      from: "Atelier Durand <contact@atelier.fr>",
      replyTo: "contact@atelier.fr",
    });
    const draft = await createCampaign();
    await sendCampaignTest(draft, ["moi@atelier.fr"], {});
    expect(resendMock.calls.at(-1).payloads[0].from).toBe(
      "Atelier Durand <contact@atelier.fr>",
    );
  });

  it("domaine pas encore validé : adresse Newbi", async () => {
    await connectDomain("PENDING");
    await seedClients(1);
    const campaign = await createCampaign();
    const launched = await requestSend(campaign, { userId, now: now() });
    expect(launched.snapshot.senderEmail).toBe(SENDER);
  });

  it("domaine Newbi non validé chez Resend : lancement et test refusés au message générique, équipe prévenue", async () => {
    resendMock.domains = [
      { id: "dom_envoi", name: "envoi.newbi.fr", status: "pending" },
    ];
    await seedClients(1);
    const campaign = await createCampaign();
    await expect(requestSend(campaign, { userId, now: now() })).rejects.toThrow(
      SENDING_UNAVAILABLE_MESSAGE,
    );
    expect((await EmailCampaign.findById(campaign._id)).status).toBe("DRAFT");
    await expect(
      sendCampaignTest(campaign, ["moi@atelier.fr"], {}),
    ).rejects.toThrow(SENDING_UNAVAILABLE_MESSAGE);
    expect(resendMock.calls).toHaveLength(0);
    expect(alerts.notifyError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "campagnes",
        context: expect.objectContaining({
          Domaine: "envoi.newbi.fr",
          Statut: "PENDING",
        }),
      }),
    );
  });

  it("aucun envoi réel possible (simulation, mode restreint sans adresse autorisée) : domaine Newbi non consulté", async () => {
    resendMock.domains = [];
    await seedClients(1);
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "simulation");
    const simulated = await requestSend(await createCampaign(), {
      userId,
      now: now(),
    });
    expect(simulated.status).toBe("SENDING");
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "restricted");
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
    const restricted = await requestSend(await createCampaign(), {
      userId,
      now: now(),
    });
    expect(restricted.status).toBe("SENDING");
    expect(resendMock.listCalls).toBe(0);
    // Une adresse autorisée : envoi réel possible, domaine Newbi exigé
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "@exemple.fr");
    await expect(
      requestSend(await createCampaign(), { userId, now: now() }),
    ).rejects.toThrow(SENDING_UNAVAILABLE_MESSAGE);
    expect(resendMock.listCalls).toBe(1);
  });
});

describe("bloc Signature", () => {
  async function campaignWithSignature(overrides = {}) {
    const signature = await EmailSignatureV2.create({
      name: "Ma signature",
      workspaceId,
      createdBy: userId,
      identity: { firstName: "Jean", lastName: "Dupont" },
      contact: { website: "https://atelier.fr/contact" },
    });
    const campaign = await createCampaign({
      design: {
        ...DESIGN,
        blocks: [
          ...DESIGN.blocks,
          { type: "signature", signatureId: String(signature._id) },
        ],
      },
      ...overrides,
    });
    return { signature, campaign };
  }

  it("figée au lancement : modifiée pendant l'envoi, les destinataires reçoivent la même", async () => {
    await seedClients(2);
    await grantTracking("client0@exemple.fr");
    const { signature, campaign } = await campaignWithSignature({
      trackClicks: true,
    });
    const launched = await requestSend(campaign, { userId, now: now() });
    expect(launched.links).toEqual([
      "https://atelier.fr/nouveautes",
      "https://atelier.fr/contact",
    ]);
    const frozen = launched.snapshot.signatures[String(signature._id)];
    expect(frozen.html).toContain("Dupont");
    expect(frozen.text).toContain("Jean Dupont");

    await EmailSignatureV2.updateOne(
      { _id: signature._id },
      {
        $set: {
          "identity.lastName": "Martin",
          "contact.website": "https://ailleurs.fr",
        },
      },
    );
    await tick();
    const payloads = resendMock.calls.flatMap((call) => call.payloads);
    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.html).toContain("Dupont");
      expect(payload.html).not.toContain("Martin");
      expect(payload.html).not.toContain("ailleurs.fr");
      expect(payload.text).toContain("Jean Dupont");
    }
    // Destinataire suivi : lien de la signature suivi comme celui du bouton
    const tracked = payloads.find((p) => p.to[0] === "client0@exemple.fr");
    expect(tracked.html).not.toContain('href="https://atelier.fr/contact"');
    const untracked = payloads.find((p) => p.to[0] === "client1@exemple.fr");
    expect(untracked.html).toContain('href="https://atelier.fr/contact"');
  });

  it("e-mail de test : signature du moment ; supprimée, l'e-mail part sans elle", async () => {
    const { signature, campaign } = await campaignWithSignature();
    await sendCampaignTest(campaign, ["moi@atelier.fr"], {});
    expect(resendMock.calls[0].payloads[0].html).toContain("Dupont");
    await EmailSignatureV2.deleteOne({ _id: signature._id });
    await sendCampaignTest(campaign, ["moi@atelier.fr"], {});
    const html = resendMock.calls[1].payloads[0].html;
    expect(html).not.toContain("Dupont");
    expect(html).not.toContain("nb-signature");
  });
});

describe("e-mails de test", () => {
  it("suivi actif : rien n'est suivi, mais le pied l'annonce comme aux destinataires", async () => {
    const campaign = await createCampaign({
      trackOpens: true,
      trackClicks: true,
      privacyPolicyUrl: "https://atelier.fr/confidentialite",
    });
    await sendCampaignTest(campaign, ["moi@atelier.fr"], {});
    const payload = resendMock.calls[0].payloads[0];
    expect(payload.html).toContain('href="https://atelier.fr/nouveautes"');
    expect(payload.html).not.toContain("/api/email-campaigns/c/");
    expect(payload.html).not.toContain("/api/email-campaigns/o/");
    expect(payload.text).toContain(
      "Atelier Durand mesure l'ouverture de cet e-mail et les clics sur ses liens, avec votre accord.",
    );
    expect(payload.text).toContain(
      "Politique de confidentialité : https://atelier.fr/confidentialite",
    );
    // Lien de préférences d'un e-mail de test : sans effet
    const prefToken = payload.text
      .split("Gérer mes préférences : ")[1]
      .split("\n")[0]
      .split("preferences?t=")[1];
    expect(verifyCampaignToken(TOKEN_KINDS.testUnsubscribe, prefToken)).toBe(
      String(campaign._id),
    );
  });

  it("objet préfixé, liens non suivis, désinscription sans effet", async () => {
    const campaign = await createCampaign();
    const result = await sendCampaignTest(
      campaign,
      ["moi@atelier.fr", "associe@atelier.fr"],
      { vars: { prenom: "Paul" } },
    );
    expect(result).toEqual({
      success: true,
      sentTo: ["moi@atelier.fr", "associe@atelier.fr"],
      simulated: false,
    });
    const [call] = resendMock.calls;
    expect(call.payloads.map((p) => p.to[0])).toEqual([
      "moi@atelier.fr",
      "associe@atelier.fr",
    ]);
    const payload = call.payloads[0];
    expect(payload.subject).toBe("[Test] Les nouveautés de l'atelier, Paul");
    expect(payload.html).toContain('href="https://atelier.fr/nouveautes"');
    expect(payload.html).not.toContain("/api/email-campaigns/o/");
    const token = payload.headers["List-Unsubscribe"]
      .split("t=")[1]
      .replace(">", "");
    expect(verifyCampaignToken(TOKEN_KINDS.testUnsubscribe, token)).toBe(
      String(campaign._id),
    );
    // Les tests ne comptent pas dans le quota
    expect(await EmailCampaignRecipient.countDocuments()).toBe(0);
  });

  it("mode restreint : adresse non autorisée simulée, sans appel", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
    vi.stubEnv("NODE_ENV", "test");
    const campaign = await createCampaign();
    const result = await sendCampaignTest(campaign, ["moi@atelier.fr"], {});
    expect(result).toEqual({
      success: true,
      sentTo: ["moi@atelier.fr"],
      simulated: true,
    });
    expect(resendMock.calls).toHaveLength(0);
  });
});

describe("mongoose", () => {
  it("aucune connexion à une autre base que celle des tests", () => {
    expect(mongoose.connection.name).toMatch(/^test_/);
  });
});
