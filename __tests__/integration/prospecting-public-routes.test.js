/**
 * Prospection, pages publiques /api/prospection :
 *   - désinscription : GET sans effet (page de confirmation), POST et
 *     désabonnement en un clic (RFC 8058) : adresse dans la liste
 *     d'exclusion commune (UNSUBSCRIBED, source, prospection d'origine),
 *     destinataire UNSUBSCRIBED, compteurs à jour, idempotent ; jeton de
 *     test sans effet ; jeton invalide ou de campagne refusé ; limite par IP ;
 *   - coupe-circuit : au moins 30 vrais envois sur les 100 derniers et plus
 *     de 10 % de désinscrits → boîte suspendue, prospections en pause ;
 *   - page « Vos données » : responsable (raison sociale, adresse, SIREN,
 *     contact), finalité, base légale, source, durée, droits, CNIL.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test";
  process.env.CALENDAR_ENCRYPTION_KEY ||= "cle-de-test-boites";
});

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import EmailSuppression from "../../src/models/EmailSuppression.js";
import MailboxConnection from "../../src/models/MailboxConnection.js";
import ProspectingRecipient from "../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../src/models/ProspectingSequence.js";
import prospectingRoutes, {
  RATE_LIMITS,
} from "../../src/routes/prospecting.js";
import { maskEmail } from "../../src/routes/emailCampaigns.js";
import {
  TOKEN_KINDS,
  createCampaignToken,
  prospectingDataUrlFor,
  prospectingUnsubscribeUrlFor,
} from "../../src/services/emailCampaigns/tracking.js";
import { evaluateMailboxReputation } from "../../src/services/prospecting/unsubscribe.js";
import { visibleText } from "../../src/services/emailCampaigns/html.js";

let server;
let baseUrl;
const workspaceId = buildOrganizationId();
const owner = buildUserId();
let mailbox;
let sequence;
let recipient;

const api = (path, options = {}) =>
  fetch(`${baseUrl}/api/prospection${path}`, {
    redirect: "manual",
    ...options,
  });
const token = (kind, id = recipient._id) =>
  createCampaignToken(kind, String(id));
const unsubscribe = (
  body = "",
  t = token(TOKEN_KINDS.prospectingUnsubscribe),
) =>
  api(`/desinscription?t=${t}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    MailboxConnection.init(),
    ProspectingSequence.init(),
    ProspectingRecipient.init(),
    EmailSuppression.init(),
  ]);
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/prospection", prospectingRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  resetMemoryAttempts();
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    organizationName: "Atelier Durand",
  });
  mailbox = await MailboxConnection.create({
    workspaceId,
    userId: owner,
    provider: "GOOGLE",
    accountEmail: "jean@atelier-durand.fr",
    status: "ACTIVE",
  });
  sequence = await ProspectingSequence.create({
    workspaceId,
    mailboxId: mailbox._id,
    name: "Menuisiers",
    status: "ACTIVE",
    snapshot: { companyName: "Atelier <Durand>", senderEmail: "jean@x.fr" },
  });
  recipient = await ProspectingRecipient.create({
    workspaceId,
    sequenceId: sequence._id,
    mailboxId: mailbox._id,
    email: "contact@menuiserie-lemoine.fr",
    name: "Menuiserie Lemoine",
    status: "SENT",
    sentAt: new Date(),
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("désinscription", () => {
  it("adresses des liens : /api/prospection/desinscription et /donnees", () => {
    vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
    expect(prospectingUnsubscribeUrlFor(recipient._id)).toBe(
      `https://api.exemple.test/api/prospection/desinscription?t=${token(TOKEN_KINDS.prospectingUnsubscribe)}`,
    );
    expect(prospectingDataUrlFor(workspaceId)).toBe(
      `https://api.exemple.test/api/prospection/donnees/${token(TOKEN_KINDS.prospectingData, workspaceId)}`,
    );
  });

  it("GET : page de confirmation au nom de l'entreprise, aucun effet", async () => {
    const res = await api(
      `/desinscription?t=${token(TOKEN_KINDS.prospectingUnsubscribe)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain("Atelier &lt;Durand&gt;");
    expect(html).not.toContain("Atelier <Durand>");
    expect(html).toContain(maskEmail("contact@menuiserie-lemoine.fr"));
    expect(html).not.toContain("contact@menuiserie-lemoine.fr");
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="desinscription?t=');
    expect(html).not.toContain("—");
    expect(await EmailSuppression.countDocuments()).toBe(0);
    expect((await ProspectingRecipient.findById(recipient._id)).status).toBe(
      "SENT",
    );
  });

  it("POST en un clic (RFC 8058) : liste d'exclusion commune, UNSUBSCRIBED, idempotent", async () => {
    const res = await unsubscribe("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("C&#39;est noté");
    const suppression = await EmailSuppression.findOne().lean();
    expect(suppression).toMatchObject({
      email: "contact@menuiserie-lemoine.fr",
      reason: "UNSUBSCRIBED",
      source: "prospecting-one-click",
    });
    expect(String(suppression.sequenceId)).toBe(String(sequence._id));
    expect(String(suppression.workspaceId)).toBe(String(workspaceId));
    const after = await ProspectingRecipient.findById(recipient._id).lean();
    expect(after.status).toBe("UNSUBSCRIBED");
    expect(after.unsubscribedAt).not.toBeNull();
    expect(
      (await ProspectingSequence.findById(sequence._id).lean()).stats,
    ).toMatchObject({ recipients: 1, unsubscribed: 1, sent: 0 });

    // Deuxième clic : rien ne change
    const firstDate = after.unsubscribedAt.getTime();
    await unsubscribe("List-Unsubscribe=One-Click");
    expect(await EmailSuppression.countDocuments()).toBe(1);
    expect(
      (
        await ProspectingRecipient.findById(recipient._id)
      ).unsubscribedAt.getTime(),
    ).toBe(firstDate);
    // La page de confirmation le dit
    const page = await (
      await api(
        `/desinscription?t=${token(TOKEN_KINDS.prospectingUnsubscribe)}`,
      )
    ).text();
    expect(page).toContain("Désinscription déjà enregistrée");
  });

  it("POST depuis la page (formulaire) : source « prospecting-link »", async () => {
    await unsubscribe("");
    expect((await EmailSuppression.findOne().lean()).source).toBe(
      "prospecting-link",
    );
  });

  it("jeton d'e-mail de test : page d'explication, aucune désinscription", async () => {
    const t = token(TOKEN_KINDS.prospectingTestUnsubscribe, sequence._id);
    const get = await api(`/desinscription?t=${t}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("E-mail de test");
    const post = await unsubscribe("List-Unsubscribe=One-Click", t);
    expect(post.status).toBe(200);
    expect(await EmailSuppression.countDocuments()).toBe(0);
  });

  it("jeton invalide ou d'une campagne : refusé", async () => {
    expect((await api("/desinscription?t=abc")).status).toBe(400);
    const campaignToken = token(TOKEN_KINDS.unsubscribe);
    expect((await api(`/desinscription?t=${campaignToken}`)).status).toBe(400);
    expect((await unsubscribe("", campaignToken)).status).toBe(400);
    expect(await EmailSuppression.countDocuments()).toBe(0);
  });

  it("limite par adresse IP : 429 au-delà", async () => {
    const t = token(TOKEN_KINDS.prospectingUnsubscribe);
    for (let i = 0; i < RATE_LIMITS.unsubscribe.max; i += 1) {
      await api(`/desinscription?t=${t}`);
    }
    const res = await api(`/desinscription?t=${t}`);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("coupe-circuit de réputation", () => {
  async function seedSends(
    count,
    { unsubscribed = 0, simulated = false } = {},
  ) {
    const docs = Array.from({ length: count }, (_, i) => ({
      workspaceId,
      sequenceId: sequence._id,
      mailboxId: mailbox._id,
      email: `contact${i}@entreprise-${i}${simulated ? "-sim" : ""}.fr`,
      status:
        i < unsubscribed ? "UNSUBSCRIBED" : simulated ? "SIMULATED" : "SENT",
      simulated,
      sentAt: new Date(Date.now() - (i + 1) * 60 * 1000),
      unsubscribedAt: i < unsubscribed ? new Date() : null,
    }));
    await ProspectingRecipient.insertMany(docs);
  }

  it("plus de 10 % de désinscrits sur au moins 30 vrais envois : boîte suspendue, prospections en pause", async () => {
    await seedSends(39, { unsubscribed: 4 });
    // Prospection encore en cours (un destinataire attend son tour)
    await ProspectingRecipient.create({
      workspaceId,
      sequenceId: sequence._id,
      mailboxId: mailbox._id,
      email: "attente@entreprise.fr",
      status: "PENDING",
    });
    // 40 vrais envois avec le destinataire du test ; sa désinscription fait 5
    const res = await unsubscribe("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    const paused = await MailboxConnection.findById(mailbox._id).lean();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "REPUTATION" });
    expect(paused.pausedReason).toMatch(/protéger votre réputation/);
    expect(paused.pausedReason).not.toContain("—");
    expect(
      await ProspectingSequence.findById(sequence._id).lean(),
    ).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
  });

  it("10 % tout juste, ou moins de 30 vrais envois : rien", async () => {
    await seedSends(29, { unsubscribed: 2 });
    // 30 vrais envois, 3 désinscrits = 10 % : pas au-delà
    await unsubscribe("List-Unsubscribe=One-Click");
    expect((await MailboxConnection.findById(mailbox._id)).status).toBe(
      "ACTIVE",
    );

    await ProspectingRecipient.deleteMany({ _id: { $ne: recipient._id } });
    await seedSends(20, { unsubscribed: 10 });
    expect(await evaluateMailboxReputation(mailbox._id)).toBe(false);
  });

  it("envois simulés exclus du calcul", async () => {
    await seedSends(60, { simulated: true });
    await seedSends(10, { unsubscribed: 5 });
    expect(await evaluateMailboxReputation(mailbox._id)).toBe(false);
  });
});

describe("page « Vos données »", () => {
  it("informations RGPD de l'espace (responsable, SIREN, contact, base légale, source, durée, droits, CNIL)", async () => {
    const res = await api(
      `/donnees/${token(TOKEN_KINDS.prospectingData, workspaceId)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    // Texte affiché : balises retirées, espaces insécables comme des espaces
    const seen = visibleText(html).replace(/\u00a0/g, " ");
    for (const expected of [
      "Vos données",
      "Vous avez reçu un message de prospection d'Atelier Durand",
      "Responsable du traitement",
      "Atelier Durand, 1 rue du Test, 75001 Paris.",
      "SIREN : 123456789.",
      "Contact : contact@test.fr",
      "Prospection commerciale auprès des professionnels",
      "L'intérêt légitime d'Atelier Durand",
      "Raison sociale, adresse e-mail professionnelle, activité et adresse",
      "Societeinfo (données publiques des entreprises)",
      "Newbi (édité par Sweily) en qualité de sous-traitant",
      "3 ans après le dernier contact venu de votre part",
      "Votre opposition est conservée au moins 3 ans",
      "l'accès à vos données, leur rectification ou leur effacement",
      "« Se désinscrire »",
      "réclamation à la CNIL : www.cnil.fr",
    ]) {
      expect(seen, expected).toContain(expected);
    }
    expect(html).toContain('href="mailto:contact@test.fr"');
    expect(html).toContain('href="https://www.cnil.fr"');
    expect(html).not.toContain("—");
  });

  it("sans e-mail de l'entreprise : l'adresse de la boîte d'envoi de la dernière prospection sert de contact", async () => {
    await mongoose.connection.db
      .collection("organization")
      .updateOne({ _id: workspaceId }, { $set: { companyEmail: "" } });
    await ProspectingSequence.updateOne(
      { _id: sequence._id },
      {
        $set: {
          startedAt: new Date("2026-11-20T09:00:00Z"),
          "snapshot.senderEmail": "jean@atelier-durand.fr",
        },
      },
    );
    const html = await (
      await api(`/donnees/${token(TOKEN_KINDS.prospectingData, workspaceId)}`)
    ).text();
    expect(html).toContain('href="mailto:jean@atelier-durand.fr"');
    expect(visibleText(html)).toContain(
      "ou par e-mail à jean@atelier-durand.fr",
    );
  });

  it("jeton invalide (ou d'un autre type) : 404", async () => {
    expect((await api("/donnees/abc")).status).toBe(404);
    const wrongKind = token(TOKEN_KINDS.prospectingUnsubscribe, workspaceId);
    expect((await api(`/donnees/${wrongKind}`)).status).toBe(404);
    const unknown = token(TOKEN_KINDS.prospectingData, buildOrganizationId());
    expect((await api(`/donnees/${unknown}`)).status).toBe(404);
  });
});
