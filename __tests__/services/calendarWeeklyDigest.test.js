/**
 * Récap du lundi par e-mail : semaine du lundi au dimanche de chaque espace
 * dont l'utilisateur voit le calendrier, sur préférence (désactivée par
 * défaut), sans doublon par utilisateur × espace × semaine.
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

vi.hoisted(() => {
  process.env.FRONTEND_URL = "https://www.newbi.fr";
  delete process.env.CALENDAR_WEEKLY_DIGEST_MODE;
});

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import Event from "../../src/models/Event.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import {
  DIGEST_LOG_COLLECTION,
  digestMode,
  resetDigestIndexesForTests,
  runWeeklyDigest,
  weekOf,
} from "../../src/services/calendar/weeklyDigestService.js";
import {
  buildWeeklyDigestEmail,
  dayHeading,
  weekRangeLabel,
} from "../../src/utils/calendarDigestEmail.js";
import { startCalendarWeeklyDigestCron } from "../../src/cron/calendarWeeklyDigestCron.js";

// Lundi 2 novembre 2026, 8 h à Paris
const NOW = new Date("2026-11-02T07:00:00Z");
const owner = buildUserId();
const colleague = buildUserId();
const workspaceId = buildOrganizationId();
const otherWorkspaceId = buildOrganizationId();

const plain = (text) => String(text).replace(/\s/g, " ");
// Texte visible de l'e-mail : balises retirées, entités et espaces ramenées
const visibleText = (html) =>
  plain(
    String(html)
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  ).replace(/ +/g, " ");

let send;
const run = (options = {}) =>
  runWeeklyDigest({
    now: NOW,
    mode: "live",
    send,
    pauseMs: 0,
    ...options,
  });

async function seedUser(userId, { digest = true, ...fields } = {}) {
  await mongoose.connection.db.collection("user").insertOne({
    _id: userId,
    email: `${userId}@test.fr`,
    name: "Léa Martin",
    emailVerified: true,
    notificationPreferences: {
      invoice_overdue: { email: true, push: true },
      ...(digest
        ? { calendar_weekly_digest: { email: true, push: false } }
        : {}),
    },
    ...fields,
  });
}

async function setCustomRole(userId, organizationId, role, actions) {
  const db = mongoose.connection.db;
  await db
    .collection("organizationRole")
    .updateOne(
      { organizationId, role },
      { $set: { actions, name: role, permission: "{}" } },
      { upsert: true },
    );
  await db
    .collection("member")
    .updateOne({ userId, organizationId }, { $set: { role } });
  invalidateOrganizationRoles();
  invalidateOrgCache();
}

const parisNoon = (day) => new Date(`${day}T11:00:00Z`);

async function seedWeek(organizationId = workspaceId) {
  await Invoice.collection.insertMany([
    {
      workspaceId: organizationId,
      prefix: "F-202611",
      number: "0001",
      status: "PENDING",
      finalTotalTTC: 1200,
      client: { name: "Atelier Lumière", type: "COMPANY" },
      dueDate: parisNoon("2026-11-04"),
    },
    {
      workspaceId: organizationId,
      prefix: "F-202611",
      number: "0002",
      status: "COMPLETED",
      finalTotalTTC: 300,
      client: { name: "Client Déjà Payé", type: "COMPANY" },
      dueDate: parisNoon("2026-11-05"),
    },
    {
      workspaceId: organizationId,
      prefix: "F-202611",
      number: "0003",
      status: "PENDING",
      finalTotalTTC: 999,
      client: { name: "Semaine Suivante", type: "COMPANY" },
      dueDate: parisNoon("2026-11-10"),
    },
  ]);
  await PurchaseInvoice.collection.insertOne({
    workspaceId: organizationId,
    supplierName: "OVH",
    invoiceNumber: "FR-77",
    status: "TO_PAY",
    amountTTC: 59.99,
    currency: "EUR",
    dueDate: parisNoon("2026-11-06"),
  });
  await Quote.collection.insertOne({
    workspaceId: organizationId,
    prefix: "D-202611",
    number: "0004",
    status: "PENDING",
    finalTotalTTC: 3400,
    client: { name: "Studio Sud", type: "COMPANY" },
    validUntil: parisNoon("2026-11-03"),
  });
  const { insertedId: boardId } = await Board.collection.insertOne({
    workspaceId: organizationId,
    userId: owner,
    title: "Site vitrine",
    members: [],
  });
  const { insertedId: columnId } = await Column.collection.insertOne({
    workspaceId: organizationId,
    boardId,
    title: "En cours",
  });
  await Task.collection.insertOne({
    workspaceId: organizationId,
    boardId,
    columnId: String(columnId),
    title: "Maquettes",
    status: "todo",
    dueDate: parisNoon("2026-11-07"),
  });
  await Event.collection.insertMany([
    {
      workspaceId: organizationId,
      userId: owner,
      title: "Réunion client",
      // 9 h 30 à Paris (UTC+1 en novembre)
      start: new Date("2026-11-03T08:30:00Z"),
      end: new Date("2026-11-03T09:30:00Z"),
      allDay: false,
      type: "MANUAL",
      source: "newbi",
      visibility: "workspace",
    },
    {
      workspaceId: organizationId,
      userId: owner,
      title: "Rendez-vous Google",
      start: new Date("2026-11-04T08:30:00Z"),
      end: new Date("2026-11-04T09:30:00Z"),
      allDay: false,
      type: "EXTERNAL",
      source: "google",
      visibility: "private",
    },
  ]);
}

const logs = () =>
  mongoose.connection.db.collection(DIGEST_LOG_COLLECTION).find().toArray();

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  resetDigestIndexesForTests();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  send = vi.fn(async () => "resend-id");
  await seedUser(owner);
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Studio Nord",
  });
});

afterEach(() => {
  delete process.env.CALENDAR_WEEKLY_DIGEST_MODE;
});

describe("mode d'envoi", () => {
  it("éteint par défaut : rien n'est calculé ni envoyé", async () => {
    await seedWeek();

    expect(digestMode()).toBe("off");
    expect(await runWeeklyDigest({ now: NOW, send })).toEqual({
      skipped: true,
      reason: "mode-off",
    });
    expect(send).not.toHaveBeenCalled();
    expect(startCalendarWeeklyDigestCron()).toBeNull();
  });

  it("simulation : journal rempli, aucun envoi, l'envoi réel reste à faire", async () => {
    await seedWeek();

    const simulated = await run({ mode: "simulation" });
    expect(simulated.simulated).toBe(1);
    expect(send).not.toHaveBeenCalled();

    const live = await run();
    expect(live.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cron planifié seulement en simulation ou en envoi réel", () => {
    process.env.CALENDAR_WEEKLY_DIGEST_MODE = "live";
    const task = startCalendarWeeklyDigestCron();
    expect(task).not.toBeNull();
    task.stop();

    process.env.CALENDAR_WEEKLY_DIGEST_MODE = "n'importe quoi";
    expect(digestMode()).toBe("off");
  });
});

describe("contenu du récap", () => {
  it("totaux en tête puis la semaine jour par jour", async () => {
    await seedWeek();

    const summary = await run();

    expect(summary).toMatchObject({
      sent: 1,
      failed: 0,
      weekStart: "2026-11-02",
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [{ to, subject, html }] = send.mock.calls[0];
    expect(to).toBe(`${owner}@test.fr`);
    expect(subject).toBe("Votre semaine du 2 au 8 novembre - Studio Nord");

    const text = visibleText(html);
    expect(text).toContain("Bonjour Léa,");
    expect(text).toContain("À encaisser : 1 facture, 1 200 €");
    expect(text).toContain("À payer : 1 facture, 59,99 €");
    expect(text).toContain("Devis à relancer : 1 devis, 3 400 €");
    expect(text).toContain("Tâches : 1 échéance");
    expect(text).toContain("Événements : 1 événement");
    // Les totaux précèdent la liste par jour
    expect(text.indexOf("À encaisser")).toBeLessThan(
      text.indexOf("Mardi 3 novembre"),
    );
    expect(text).toMatch(
      /Mardi 3 novembre Devis à relancer · Studio Sud · 3 400 € 09:30 Réunion client/,
    );
    expect(text).toContain(
      "Mercredi 4 novembre Facture à encaisser · Atelier Lumière · 1 200 €",
    );
    expect(text).toContain(
      "Vendredi 6 novembre Facture à payer · OVH · 59,99 €",
    );
    expect(text).toContain(
      "Samedi 7 novembre Tâche · Maquettes · Site vitrine",
    );
    expect(html).toContain('href="https://www.newbi.fr/dashboard/calendar"');
  });

  it("n'y met ni ce qui est réglé, ni les autres semaines, ni les agendas externes", async () => {
    await seedWeek();

    await run();

    const text = visibleText(send.mock.calls[0][0].html);
    expect(text).not.toContain("Client Déjà Payé");
    expect(text).not.toContain("Semaine Suivante");
    expect(text).not.toContain("Rendez-vous Google");
    expect(text).not.toContain("Lundi 2 novembre");
  });

  it("semaine vide : pas d'e-mail", async () => {
    const summary = await run();

    expect(summary.empty).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect((await logs()).map((l) => l.status)).toEqual(["empty"]);
  });

  it("sans icône ni tiret cadratin, mots finaux liés", async () => {
    await seedWeek();
    await run();

    const { html, subject } = send.mock.calls[0][0];
    expect(`${subject}${html}`).not.toContain("—");
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).toContain("white-space: nowrap");
  });

  it("au-delà de 40 éléments, renvoie au calendrier", () => {
    const items = Array.from({ length: 45 }, (_, i) => ({
      id: `TASK:${i}`,
      kind: "TASK",
      day: "2026-11-04",
      state: "UPCOMING",
      title: `Tâche ${i}`,
    }));

    const email = buildWeeklyDigestEmail({
      workspaceName: "Studio Nord",
      weekStart: "2026-11-02",
      weekEnd: "2026-11-08",
      items,
    });

    expect(visibleText(email.html)).toContain(
      "Et 5 autres éléments à retrouver dans le calendrier.",
    );
    expect(visibleText(email.html)).toContain("Tâches : 45 échéances");
  });
});

describe("destinataires et droits", () => {
  it("seulement les comptes qui l'ont activé, à l'adresse vérifiée", async () => {
    const notOptedIn = buildUserId();
    const unverified = buildUserId();
    const banned = buildUserId();
    await seedUser(notOptedIn, { digest: false });
    await seedUser(unverified, { emailVerified: false });
    await seedUser(banned, { banned: true });
    for (const userId of [notOptedIn, unverified, banned]) {
      await seedOrgMembership({
        userId,
        organizationId: workspaceId,
        role: "admin",
      });
    }
    await seedWeek();

    const summary = await run();

    expect(send.mock.calls.map(([call]) => call.to)).toEqual([
      `${owner}@test.fr`,
    ]);
    expect(summary.excluded).toEqual({ unverified: 1, banned: 1 });
  });

  it("un e-mail par espace dont le calendrier est visible", async () => {
    const hidden = buildOrganizationId();
    await seedOrgMembership({
      userId: owner,
      organizationId: otherWorkspaceId,
      role: "viewer",
      organizationName: "Atelier Sud",
    });
    await seedOrgMembership({
      userId: owner,
      organizationId: hidden,
      role: "viewer",
      organizationName: "Sans agenda",
    });
    await setCustomRole(owner, hidden, "role_sans_agenda", {
      invoices: ["view"],
    });
    await seedWeek(workspaceId);
    await seedWeek(otherWorkspaceId);
    await seedWeek(hidden);

    const summary = await run();

    expect(send.mock.calls.map(([call]) => call.subject).sort()).toEqual([
      "Votre semaine du 2 au 8 novembre - Atelier Sud",
      "Votre semaine du 2 au 8 novembre - Studio Nord",
    ]);
    expect(summary.excluded).toEqual({ no_calendar_access: 1 });
  });

  it("chaque source suit le droit « Voir » de sa page", async () => {
    await seedOrgMembership({
      userId: colleague,
      organizationId: workspaceId,
      role: "viewer",
    });
    await seedUser(colleague);
    await setCustomRole(colleague, workspaceId, "role_agenda", {
      calendar: ["view"],
    });
    await seedWeek();

    await run();

    const colleagueMail = send.mock.calls.find(
      ([call]) => call.to === `${colleague}@test.fr`,
    )[0];
    const text = visibleText(colleagueMail.html);
    expect(text).toContain("Réunion client");
    expect(text).not.toContain("Atelier Lumière");
    expect(text).not.toContain("OVH");
    expect(text).not.toContain("Maquettes");
  });

  it("membre retiré de l'espace : plus de récap", async () => {
    await seedWeek();
    await mongoose.connection.db
      .collection("member")
      .deleteOne({ userId: owner, organizationId: workspaceId });

    await run();

    expect(send).not.toHaveBeenCalled();
  });
});

describe("anti-doublon", () => {
  it("un seul e-mail par utilisateur, espace et semaine, même après un redémarrage", async () => {
    await seedWeek();

    await run();
    const second = await run({ now: new Date("2026-11-02T09:00:00Z") });
    // Redémarrage : état en mémoire perdu, le journal en base fait foi
    resetDigestIndexesForTests();
    const third = await run({ now: new Date("2026-11-02T10:00:00Z") });

    expect(send).toHaveBeenCalledTimes(1);
    expect(second.alreadyDone).toBe(1);
    expect(third.alreadyDone).toBe(1);
    expect((await logs()).map((l) => [l.weekStart, l.status])).toEqual([
      ["2026-11-02", "sent"],
    ]);
  });

  it("deux passages simultanés n'envoient qu'une fois", async () => {
    await seedWeek();

    await Promise.all([run(), run()]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("la semaine suivante, un nouveau récap part", async () => {
    await seedWeek();

    await run();
    await run({ now: new Date("2026-11-09T07:00:00Z") });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].subject).toBe(
      "Votre semaine du 9 au 15 novembre - Studio Nord",
    );
  });

  it("envoi en échec : noté, jamais renvoyé automatiquement", async () => {
    await seedWeek();
    send.mockRejectedValueOnce(new Error("Resend indisponible"));

    const first = await run();
    const second = await run();

    expect(first.failed).toBe(1);
    expect(second.alreadyDone).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const [log] = await logs();
    expect(log).toMatchObject({ status: "failed" });
    expect(log.error).toContain("Resend indisponible");
  });
});

describe("dates", () => {
  it("semaine du lundi au dimanche, à l'heure de Paris", () => {
    expect(weekOf(NOW)).toEqual({
      weekStart: "2026-11-02",
      weekEnd: "2026-11-08",
    });
    // Dimanche 23 h 30 à Paris : encore la même semaine
    expect(weekOf(new Date("2026-11-08T22:30:00Z")).weekStart).toBe(
      "2026-11-02",
    );
    // Lundi 0 h 30 à Paris (dimanche 23 h 30 UTC) : semaine suivante
    expect(weekOf(new Date("2026-11-08T23:30:00Z")).weekStart).toBe(
      "2026-11-09",
    );
    // Passage à l'heure d'été (dimanche 29 mars 2026)
    expect(weekOf(new Date("2026-03-29T20:00:00Z"))).toEqual({
      weekStart: "2026-03-23",
      weekEnd: "2026-03-29",
    });
  });

  it("libellés des jours et des semaines", () => {
    expect(dayHeading("2026-11-01")).toBe("Dimanche 1er novembre");
    expect(weekRangeLabel("2026-11-02", "2026-11-08")).toBe(
      "du 2 au 8 novembre",
    );
    expect(weekRangeLabel("2026-11-30", "2026-12-06")).toBe(
      "du 30 novembre au 6 décembre",
    );
    expect(weekRangeLabel("2026-12-28", "2027-01-03")).toBe(
      "du 28 décembre 2026 au 3 janvier 2027",
    );
  });
});
