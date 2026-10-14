import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

vi.mock("../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendMock = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    constructor() {
      this.emails = { send: (...args) => sendMock(...args) };
    }
  },
}));

import {
  LOG_COLLECTION,
  OPTOUT_COLLECTION,
  SETTINGS_COLLECTION,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  runTrialNudges,
  sendTrialEndNudgeIfInactive,
  listTrialNudgeSchedule,
  recordTrialNudgeEmailEvent,
  updateTrialNudgeSettings,
  unsubscribeFromTrialNudges,
  TrialNudgeError,
} from "../../src/services/trialNudgeService.js";
import { buildTrialNudgeEmail } from "../../src/utils/trialNudgeEmails.js";

const DAY = 86_400_000;
const NOW = new Date("2026-10-14T08:00:00.000Z");
const ago = (days) => new Date(NOW.getTime() - days * DAY);

let db;

beforeAll(async () => {
  process.env.ENABLE_APP_TRIAL = "true";
  process.env.RESEND_API_KEY = "re_test";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-pour-les-relances";
  process.env.BACKEND_URL = "https://api.example.test";
  await startMongo();
  db = mongoose.connection.db;
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  sendMock.mockReset();
  sendMock.mockResolvedValue({ data: { id: "resend-1" }, error: null });
});

async function setMode(mode, inactivityDays = 3) {
  await db
    .collection(SETTINGS_COLLECTION)
    .updateOne(
      { _id: "global" },
      { $set: { mode, inactivityDays } },
      { upsert: true },
    );
}

/**
 * Crée un espace en essai démarré il y a `startedDaysAgo` jours, avec son
 * propriétaire. `lastSeenDaysAgo` ajoute une activité récente.
 */
async function seedTrialOrg({
  startedDaysAgo,
  email = "client@exemple.fr",
  emailVerified = true,
  lastSeenDaysAgo = null,
  trialDays = 30,
} = {}) {
  const orgId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const start = ago(startedDaysAgo);
  await db.collection("organization").insertOne({
    _id: orgId,
    name: "Atelier Test",
    isTrialActive: true,
    trialStartDate: start.toISOString(),
    trialEndDate: new Date(start.getTime() + trialDays * DAY).toISOString(),
  });
  await db
    .collection("user")
    .insertOne({ _id: userId, email, name: "Camille Martin", emailVerified });
  await db
    .collection("member")
    .insertOne({ organizationId: orgId, userId, role: "owner" });
  if (lastSeenDaysAgo !== null) {
    await db.collection("user_device_log").insertOne({
      userId: String(userId),
      deviceKey: "web",
      lastSeenAt: ago(lastSeenDaysAgo),
    });
  }
  return { orgId, userId };
}

const logs = () => db.collection(LOG_COLLECTION).find().toArray();

describe("runTrialNudges", () => {
  it("n'envoie rien tant que le mode est sur off (défaut)", async () => {
    await seedTrialOrg({ startedDaysAgo: 7.1 });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary).toMatchObject({ skipped: true, reason: "mode-off" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("relance J+7 un espace inactif, une seule fois", async () => {
    await setMode("live");
    const { orgId } = await seedTrialOrg({ startedDaysAgo: 7.1 });

    const summary = await runTrialNudges({ now: NOW });
    expect(summary.sent).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toEqual(["client@exemple.fr"]);
    expect(payload.replyTo).toBe("contact@newbi.fr");
    expect(payload.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    expect(payload.html).toContain("Bonjour Camille,");

    const [entry] = await logs();
    expect(entry).toMatchObject({
      step: "inactive_d7",
      status: "sent",
      simulated: false,
      resendId: "resend-1",
    });
    expect(String(entry.orgId)).toBe(String(orgId));

    // Le lendemain, toujours dans la fenêtre : pas de second envoi
    await runTrialNudges({ now: new Date(NOW.getTime() + 0.5 * DAY) });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("souhaite la bienvenue au début de l'essai, une seule fois", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 0.01, lastSeenDaysAgo: 0 });

    const summary = await runTrialNudges({ now: NOW, steps: ["welcome"] });
    expect(summary.sent).toBe(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject).toBe("Bienvenue sur Newbi, votre espace est prêt");
    expect(payload.html).toContain("mailto:contact@newbi.fr");
    // Fin d'essai = début + 30 jours (13 novembre 2026)
    expect(payload.html).toContain("13 novembre 2026");
    expect(payload.html).toContain("vous avez créé un compte Newbi");
    expect((await logs())[0]).toMatchObject({
      step: "welcome",
      status: "sent",
    });

    // Passage suivant (10 min plus tard) puis passage quotidien : rien de plus
    await runTrialNudges({
      now: new Date(NOW.getTime() + 10 * 60 * 1000),
      steps: ["welcome"],
    });
    await runTrialNudges({ now: NOW });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("le passage de bienvenue n'envoie pas les autres relances", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 7.1 });
    const summary = await runTrialNudges({ now: NOW, steps: ["welcome"] });
    expect(summary.due).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("ne relance pas à J+7 un espace actif récemment", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 7.1, lastSeenDaysAgo: 1 });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary.sent).toBe(0);
    expect(summary.excluded).toEqual({ active: 1 });
  });

  it("respecte le seuil d'inactivité réglé", async () => {
    await setMode("live", 5);
    await seedTrialOrg({ startedDaysAgo: 7.1, lastSeenDaysAgo: 4 });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary.excluded).toEqual({ active: 1 });
  });

  it("envoie la demande de suggestions J+14 même à un espace actif", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 14.2, lastSeenDaysAgo: 0.1 });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary.sent).toBe(1);
    expect(sendMock.mock.calls[0][0].subject).toBe(
      "Qu'est-ce qui vous manque sur Newbi\u00a0?",
    );
  });

  it("n'envoie rien aux essais plus anciens que la fenêtre de rattrapage", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 10 });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary.due).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("exclut les comptes internes, non vérifiés, abonnés, gérés et désinscrits", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 7.1, email: "dev@sweily.fr" });
    await seedTrialOrg({ startedDaysAgo: 7.1, emailVerified: false });
    const paid = await seedTrialOrg({ startedDaysAgo: 7.1, email: "a@a.fr" });
    await db
      .collection("subscription")
      .insertOne({ referenceId: String(paid.orgId), status: "active" });
    const managed = await seedTrialOrg({
      startedDaysAgo: 7.1,
      email: "b@b.fr",
    });
    await db
      .collection("managedclients")
      .insertOne({ organizationId: managed.orgId, status: "active" });
    const optout = await seedTrialOrg({ startedDaysAgo: 7.1, email: "c@c.fr" });
    await unsubscribeFromTrialNudges(String(optout.userId));

    const summary = await runTrialNudges({ now: NOW });
    expect(summary.sent).toBe(0);
    expect(summary.excluded).toEqual({
      internal: 1,
      unverified: 1,
      subscribed: 1,
      managed: 1,
      optout: 1,
    });
  });

  it("en simulation, journalise sans envoyer ni bloquer l'envoi réel", async () => {
    await setMode("simulation");
    await seedTrialOrg({ startedDaysAgo: 7.1 });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary.simulated).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
    expect((await logs())[0]).toMatchObject({
      status: "simulated",
      simulated: true,
    });

    await setMode("live");
    const live = await runTrialNudges({ now: NOW });
    expect(live.sent).toBe(1);
  });

  it("note l'échec d'envoi sans retenter", async () => {
    await setMode("live");
    await seedTrialOrg({ startedDaysAgo: 7.1 });
    sendMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const summary = await runTrialNudges({ now: NOW });
    expect(summary.failed).toBe(1);
    expect((await logs())[0]).toMatchObject({ status: "failed" });

    sendMock.mockResolvedValue({ data: { id: "x" }, error: null });
    await runTrialNudges({ now: NOW });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendTrialEndNudgeIfInactive", () => {
  async function expiredOrg({ lastSeenDaysAgo = null } = {}) {
    const { orgId } = await seedTrialOrg({
      startedDaysAgo: 30.2,
      lastSeenDaysAgo,
    });
    return db.collection("organization").findOne({ _id: orgId });
  }

  it("remplace l'e-mail de fin d'essai pour un espace inactif", async () => {
    await setMode("live");
    const org = await expiredOrg();
    expect(await sendTrialEndNudgeIfInactive({ org, now: NOW })).toBe(true);
    expect((await logs())[0]).toMatchObject({
      step: "inactive_d30",
      status: "sent",
    });
  });

  it("laisse partir l'e-mail standard pour un espace actif", async () => {
    await setMode("live");
    const org = await expiredOrg({ lastSeenDaysAgo: 1 });
    expect(await sendTrialEndNudgeIfInactive({ org, now: NOW })).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("laisse partir l'e-mail standard en simulation (et journalise)", async () => {
    await setMode("simulation");
    const org = await expiredOrg();
    expect(await sendTrialEndNudgeIfInactive({ org, now: NOW })).toBe(false);
    expect((await logs())[0]).toMatchObject({ status: "simulated" });
  });

  it("ne fait rien quand le mode est sur off", async () => {
    const org = await expiredOrg();
    expect(await sendTrialEndNudgeIfInactive({ org, now: NOW })).toBe(false);
    expect(await logs()).toHaveLength(0);
  });
});

describe("listTrialNudgeSchedule", () => {
  it("liste les relances dues et à venir avec leur état", async () => {
    await setMode("simulation");
    await seedTrialOrg({ startedDaysAgo: 7.1 });
    await seedTrialOrg({
      startedDaysAgo: 5,
      email: "actif@exemple.fr",
      lastSeenDaysAgo: 0.5,
    });
    const { items, settings } = await listTrialNudgeSchedule({ now: NOW });
    expect(settings.mode).toBe("simulation");
    // A : J+7 dû (inactif), J+14 dans 6,9 jours ; B : J+7 dans 2 jours, mais
    // actif en ce moment (réévalué le jour J)
    expect(items.map((i) => [i.step, i.status, i.reason])).toEqual([
      ["inactive_d7", "due", null],
      ["inactive_d7", "upcoming", "active"],
      ["feedback_d14", "upcoming", null],
    ]);
  });
});

describe("réglages", () => {
  it("valide le mode et le seuil", async () => {
    await expect(
      updateTrialNudgeSettings({ mode: "turbo" }, "admin@newbi.fr"),
    ).rejects.toBeInstanceOf(TrialNudgeError);
    await expect(
      updateTrialNudgeSettings({ inactivityDays: 30 }, "admin@newbi.fr"),
    ).rejects.toBeInstanceOf(TrialNudgeError);
    const settings = await updateTrialNudgeSettings(
      { mode: "live", inactivityDays: "4" },
      "admin@newbi.fr",
    );
    expect(settings).toMatchObject({
      mode: "live",
      inactivityDays: 4,
      updatedBy: "admin@newbi.fr",
    });
  });
});

describe("désinscription et suivi", () => {
  it("vérifie le jeton signé", () => {
    const userId = new mongoose.Types.ObjectId().toString();
    const token = createUnsubscribeToken(userId);
    expect(verifyUnsubscribeToken(token)).toBe(userId);
    expect(verifyUnsubscribeToken(`${userId}.deadbeef`)).toBeNull();
    expect(verifyUnsubscribeToken("apercu")).toBeNull();
  });

  it("note l'ouverture et désinscrit sur signalement indésirable", async () => {
    await setMode("live");
    const { userId } = await seedTrialOrg({ startedDaysAgo: 7.1 });
    await runTrialNudges({ now: NOW });

    expect(await recordTrialNudgeEmailEvent("email.opened", "resend-1")).toBe(
      true,
    );
    expect((await logs())[0].openedAt).toBeInstanceOf(Date);

    await recordTrialNudgeEmailEvent("email.complained", "resend-1");
    const optout = await db
      .collection(OPTOUT_COLLECTION)
      .findOne({ userId: String(userId) });
    expect(optout).toMatchObject({ source: "complaint" });

    expect(await recordTrialNudgeEmailEvent("email.opened", "inconnu")).toBe(
      false,
    );
  });
});

describe("gabarits", () => {
  it.each(["welcome", "inactive_d7", "feedback_d14", "inactive_d30"])(
    "%s : lien de désinscription, pas de tiret cadratin",
    (step) => {
      const { subject, html } = buildTrialNudgeEmail(step, {
        orgName: "<Atelier>",
        unsubscribeUrl: "https://api.example.test/u?t=a&b",
      });
      expect(subject).not.toContain("—");
      expect(html).not.toContain("—");
      expect(html).toContain("Ne plus recevoir ces e-mails");
      expect(html).toContain("&lt;Atelier&gt;");
      expect(html).toContain("Bonjour,");
    },
  );

  it("refuse une étape inconnue", () => {
    expect(() => buildTrialNudgeEmail("inconnue")).toThrow();
  });
});

describe("routes de désinscription", () => {
  let server;
  let base;

  beforeAll(async () => {
    const express = (await import("express")).default;
    const router = (await import("../../src/routes/trialNudges.js")).default;
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use("/api/trial-nudges", router);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}/api/trial-nudges`;
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it("GET affiche une confirmation sans désinscrire", async () => {
    const { userId } = await seedTrialOrg({ startedDaysAgo: 3 });
    const token = createUnsubscribeToken(String(userId));
    const response = await fetch(`${base}/unsubscribe?t=${token}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Confirmer la désinscription");
    expect(await db.collection(OPTOUT_COLLECTION).countDocuments()).toBe(0);
  });

  it("POST désinscrit (désabonnement en un clic compris)", async () => {
    const { userId } = await seedTrialOrg({ startedDaysAgo: 3 });
    const token = createUnsubscribeToken(String(userId));
    const response = await fetch(`${base}/unsubscribe?t=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(response.status).toBe(200);
    expect(
      await db
        .collection(OPTOUT_COLLECTION)
        .findOne({ userId: String(userId) }),
    ).toMatchObject({ email: "client@exemple.fr", source: "one-click" });
  });

  it("refuse un jeton invalide", async () => {
    const response = await fetch(`${base}/unsubscribe?t=apercu`, {
      method: "POST",
    });
    expect(response.status).toBe(400);
    expect(await db.collection(OPTOUT_COLLECTION).countDocuments()).toBe(0);
  });
});
