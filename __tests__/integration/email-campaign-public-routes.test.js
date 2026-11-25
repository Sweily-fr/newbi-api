/**
 * Campagnes e-mail, routes publiques /api/email-campaigns :
 *   - désinscription : GET sans effet (page de confirmation), POST et
 *     désabonnement en un clic (RFC 8058), idempotente ; jeton de test sans
 *     effet ; jeton invalide refusé ;
 *   - pixel d'ouverture jamais mis en cache ;
 *   - clic : redirection vers le lien figé au lancement seulement, jamais
 *     de redirection ouverte (jeton, numéro ou lien invalides = page) ;
 *   - suivi effacé (durée de conservation dépassée) : image et redirection
 *     servies, plus rien d'enregistré.
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
  process.env.JWT_SECRET = process.env.JWT_SECRET || "secret-de-test";
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
import { buildOrganizationId } from "../factories/index.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import EmailCampaign from "../../src/models/EmailCampaign.js";
import EmailCampaignClick from "../../src/models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../src/models/EmailCampaignRecipient.js";
import EmailSuppression from "../../src/models/EmailSuppression.js";
import emailCampaignRoutes, {
  RATE_LIMITS,
  maskEmail,
} from "../../src/routes/emailCampaigns.js";
import {
  TOKEN_KINDS,
  createCampaignToken,
} from "../../src/services/emailCampaigns/tracking.js";

let server;
let baseUrl;
const workspaceId = buildOrganizationId();
let campaign;
let recipient;

const api = (path, options = {}) =>
  fetch(`${baseUrl}/api/email-campaigns${path}`, {
    redirect: "manual",
    ...options,
  });

const token = (kind, id = recipient._id) =>
  createCampaignToken(kind, String(id));

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EmailCampaign.init(),
    EmailCampaignRecipient.init(),
    EmailSuppression.init(),
  ]);
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/email-campaigns", emailCampaignRoutes);
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
  campaign = await EmailCampaign.create({
    workspaceId,
    name: "Nouveautés",
    status: "SENDING",
    links: ["https://atelier.fr/nouveautes", "https://atelier.fr/contact"],
    snapshot: { companyName: "Atelier <Durand>", senderEmail: "x@y.fr" },
  });
  recipient = await EmailCampaignRecipient.create({
    workspaceId,
    campaignId: campaign._id,
    email: "marie.durand@exemple.fr",
    name: "Marie Durand",
    status: "DELIVERED",
    sentAt: new Date(),
  });
});

const statsOf = async () => (await EmailCampaign.findById(campaign._id)).stats;

describe("désinscription", () => {
  it("GET : page de confirmation au nom de l'entreprise, aucun effet", async () => {
    const res = await api(`/unsubscribe?t=${token(TOKEN_KINDS.unsubscribe)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const html = await res.text();
    expect(html).toContain("Atelier &lt;Durand&gt;");
    expect(html).not.toContain("Atelier <Durand>");
    expect(html).toContain(maskEmail("marie.durand@exemple.fr"));
    expect(html).not.toContain("marie.durand@exemple.fr");
    expect(html).toContain('method="POST"');
    expect(html).toContain("Ne plus recevoir ces e-mails");
    expect(html).toContain("envoyés par Atelier &lt;Durand&gt;");
    expect(html).not.toContain("—");
    expect(await EmailSuppression.countDocuments()).toBe(0);
    expect(
      (await EmailCampaignRecipient.findById(recipient._id)).unsubscribedAt,
    ).toBeNull();
  });

  it("POST en un clic (RFC 8058) : désinscrit, idempotent", async () => {
    const post = () =>
      api(`/unsubscribe?t=${token(TOKEN_KINDS.unsubscribe)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("C&#39;est noté");
    const suppression = await EmailSuppression.findOne().lean();
    expect(suppression).toMatchObject({
      email: "marie.durand@exemple.fr",
      reason: "UNSUBSCRIBED",
      source: "one-click",
    });
    expect(String(suppression.workspaceId)).toBe(String(workspaceId));
    expect(
      (await EmailCampaignRecipient.findById(recipient._id)).unsubscribedAt,
    ).toBeInstanceOf(Date);
    expect((await statsOf()).unsubscribed).toBe(1);

    expect((await post()).status).toBe(200);
    expect(await EmailSuppression.countDocuments()).toBe(1);
    expect((await statsOf()).unsubscribed).toBe(1);

    const again = await api(`/unsubscribe?t=${token(TOKEN_KINDS.unsubscribe)}`);
    expect(await again.text()).toContain("Désinscription déjà enregistrée");
  });

  it("une adresse ajoutée à la main devient une désinscription", async () => {
    await EmailSuppression.create({
      workspaceId,
      email: "marie.durand@exemple.fr",
      reason: "MANUAL",
    });
    await api(`/unsubscribe?t=${token(TOKEN_KINDS.unsubscribe)}`, {
      method: "POST",
    });
    expect((await EmailSuppression.findOne().lean()).reason).toBe(
      "UNSUBSCRIBED",
    );
  });

  it("jeton invalide, d'un autre type ou altéré : refusé sans effet", async () => {
    for (const bad of [
      "abc",
      token(TOKEN_KINDS.open),
      `${String(new mongoose.Types.ObjectId())}.${token(TOKEN_KINDS.unsubscribe).split(".")[1]}`,
    ]) {
      const res = await api(`/unsubscribe?t=${encodeURIComponent(bad)}`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Lien invalide");
    }
    expect(await EmailSuppression.countDocuments()).toBe(0);
  });

  it("e-mail de test : page d'explication, rien n'est enregistré", async () => {
    const res = await api(
      `/unsubscribe?t=${token(TOKEN_KINDS.testUnsubscribe, campaign._id)}`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("E-mail de test");
    expect(await EmailSuppression.countDocuments()).toBe(0);
  });

  it("limite par adresse IP", async () => {
    const url = `/unsubscribe?t=${token(TOKEN_KINDS.unsubscribe)}`;
    for (let i = 0; i < RATE_LIMITS.unsubscribe.max; i += 1) {
      expect((await api(url)).status).toBe(200);
    }
    const res = await api(url);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
  });
});

describe("pixel d'ouverture", () => {
  it("image transparente jamais mise en cache, ouvertures comptées", async () => {
    const res = await api(`/o/${token(TOKEN_KINDS.open)}.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await res.arrayBuffer()).length).toBe(42);
    await api(`/o/${token(TOKEN_KINDS.open)}.gif`);
    const saved = await EmailCampaignRecipient.findById(recipient._id).lean();
    expect(saved.openCount).toBe(2);
    expect(saved.openedAt).toBeInstanceOf(Date);
    expect(await statsOf()).toMatchObject({ opened: 1, opens: 2 });
  });

  it("jeton invalide : l'image quand même, rien d'enregistré", async () => {
    const res = await api(`/o/${token(TOKEN_KINDS.click)}.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect((await statsOf()).opens).toBe(0);
  });

  it("suivi effacé (conservation dépassée) : l'image, rien d'enregistré", async () => {
    await EmailCampaignRecipient.updateOne(
      { _id: recipient._id },
      { $set: { trackingExpired: true } },
    );
    const res = await api(`/o/${token(TOKEN_KINDS.open)}.gif`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const saved = await EmailCampaignRecipient.findById(recipient._id).lean();
    expect(saved).toMatchObject({ openedAt: null, openCount: 0 });
    expect(await statsOf()).toMatchObject({ opened: 0, opens: 0 });
  });
});

describe("clic suivi", () => {
  it("redirige vers le lien figé, compte le clic et l'ouverture", async () => {
    const res = await api(
      `/c/${token(TOKEN_KINDS.click)}/1?url=https://pirate.example`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://atelier.fr/contact");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    await api(`/c/${token(TOKEN_KINDS.click)}/1`);
    const saved = await EmailCampaignRecipient.findById(recipient._id).lean();
    expect(saved).toMatchObject({ clickCount: 2, openCount: 1 });
    expect(await statsOf()).toMatchObject({
      clicked: 1,
      clicks: 2,
      opened: 1,
      opens: 1,
    });
    const clicks = await EmailCampaignClick.find().lean();
    expect(clicks.map((c) => c.linkIndex)).toEqual([1, 1]);
  });

  it("suivi effacé (conservation dépassée) : redirection, rien d'enregistré", async () => {
    await EmailCampaignRecipient.updateOne(
      { _id: recipient._id },
      { $set: { trackingExpired: true } },
    );
    const res = await api(`/c/${token(TOKEN_KINDS.click)}/0`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://atelier.fr/nouveautes");
    const saved = await EmailCampaignRecipient.findById(recipient._id).lean();
    expect(saved).toMatchObject({ clickCount: 0, openCount: 0 });
    expect(await EmailCampaignClick.countDocuments()).toBe(0);
    expect(await statsOf()).toMatchObject({ clicks: 0, opens: 0 });
  });

  it("jamais de redirection ouverte", async () => {
    const cases = [
      `/c/${token(TOKEN_KINDS.click)}/2`,
      `/c/${token(TOKEN_KINDS.click)}/-1`,
      `/c/${token(TOKEN_KINDS.click)}/abc`,
      `/c/${token(TOKEN_KINDS.unsubscribe)}/0`,
      `/c/${String(new mongoose.Types.ObjectId())}.faux/0`,
      `/c/${encodeURIComponent("https://pirate.example")}/0`,
    ];
    for (const path of cases) {
      const res = await api(path);
      expect(res.status, path).toBe(400);
      expect(res.headers.get("location"), path).toBeNull();
      expect(await res.text()).toContain("Lien invalide");
    }
    // Lien enregistré illisible (donnée abîmée) : pas de redirection
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { links: ["javascript:alert(1)"] } },
    );
    const res = await api(`/c/${token(TOKEN_KINDS.click)}/0`);
    expect(res.status).toBe(400);
    expect((await statsOf()).clicks).toBe(0);
  });
});
