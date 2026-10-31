/**
 * Envoi programmé des e-mails CRM (cron horaire), processus en UTC comme le
 * serveur de prod :
 *   - « Le jour même », « X jours avant », « X jours après » : la date
 *     cherchée est celle du jour de Paris, même à 0 h 05 ;
 *   - un deuxième passage le même jour n'envoie rien de plus ;
 *   - contact bloqué, espace passé à l'offre d'entrée, abonnement terminé :
 *     aucun envoi ;
 *   - l'expéditeur n'est jamais une adresse étrangère à l'espace.
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
  process.env.TZ = "UTC";
});

const sendMail = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { transporter: { sendMail } },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import Client from "../../src/models/Client.js";
import ClientCustomField from "../../src/models/ClientCustomField.js";
import CrmEmailAutomation from "../../src/models/CrmEmailAutomation.js";
import CrmEmailAutomationLog from "../../src/models/CrmEmailAutomationLog.js";
import {
  processCrmEmailAutomations,
  calculateTargetDate,
} from "../../src/services/crmEmailAutomationService.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();

let field;

// 31/10/2026 à 0 h 05 heure de Paris (UTC+1) : 30/10 à 23 h 05 en UTC
const MINUIT_CINQ_PARIS = new Date("2026-10-30T23:05:00Z");
// 31/10/2026 à 9 h 05 heure de Paris
const NEUF_HEURES_PARIS = new Date("2026-10-31T08:05:00Z");

async function contactWithDate(date, extra = {}) {
  return Client.create(
    buildClientDoc({
      workspaceId: organizationId,
      createdBy: userId,
      customFields: [{ fieldId: field._id, value: date }],
      ...extra,
    }),
  );
}

async function automation({ sendHour = 9, timing = {}, email = {} } = {}) {
  return CrmEmailAutomation.create({
    name: "Relance",
    workspaceId: organizationId,
    createdBy: userId,
    customFieldId: field._id,
    timing: { type: "ON_DATE", daysOffset: 0, sendHour, ...timing },
    email: { subject: "Bonjour {clientName}", body: "Texte", ...email },
  });
}

async function setSubscription(changes) {
  await mongoose.connection.db
    .collection("subscription")
    .updateOne({ referenceId: organizationId.toString() }, { $set: changes });
}

const recipients = () => sendMail.mock.calls.map(([options]) => options.to);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  sendMail.mockClear();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  field = await ClientCustomField.create({
    name: "Date d'échéance du contrat",
    fieldType: "DATE",
    workspaceId: organizationId,
    createdBy: userId,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Date cherchée", () => {
  it("jour de Paris, même quand le serveur en UTC est encore la veille", () => {
    const target = calculateTargetDate(
      { type: "ON_DATE", daysOffset: 0 },
      MINUIT_CINQ_PARIS,
    );
    expect(target.toISOString().slice(0, 10)).toBe("2026-10-31");
  });

  it("« 3 jours avant » cherche les dates dans 3 jours, « 2 jours après » celles d'avant-hier", () => {
    const before = calculateTargetDate(
      { type: "BEFORE_DATE", daysOffset: 3 },
      NEUF_HEURES_PARIS,
    );
    const after = calculateTargetDate(
      { type: "AFTER_DATE", daysOffset: 2 },
      NEUF_HEURES_PARIS,
    );
    expect(before.toISOString().slice(0, 10)).toBe("2026-11-03");
    expect(after.toISOString().slice(0, 10)).toBe("2026-10-29");
  });

  it("à 0 h heure de Paris, les contacts du jour sont relancés le jour même", async () => {
    vi.useFakeTimers({ now: MINUIT_CINQ_PARIS, toFake: ["Date"] });
    const today = await contactWithDate("2026-10-31", {
      email: "aujourdhui@test.fr",
    });
    await contactWithDate("2026-10-30", { email: "hier@test.fr" });
    await automation({ sendHour: 0 });

    expect(await processCrmEmailAutomations()).toBe(1);
    expect(recipients()).toEqual([today.email]);
  });
});

describe("Envois", () => {
  it("un deuxième passage le même jour n'envoie rien de plus, statistiques justes", async () => {
    vi.useFakeTimers({ now: NEUF_HEURES_PARIS, toFake: ["Date"] });
    await contactWithDate("2026-10-31", { email: "contact@test.fr" });
    const auto = await automation();

    expect(await processCrmEmailAutomations()).toBe(1);
    expect(await processCrmEmailAutomations()).toBe(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((await CrmEmailAutomation.findById(auto._id)).stats.totalSent).toBe(
      1,
    );
    expect(await CrmEmailAutomationLog.countDocuments({ status: "SENT" })).toBe(
      1,
    );
  });

  it("contact bloqué : aucun e-mail, aucun journal", async () => {
    vi.useFakeTimers({ now: NEUF_HEURES_PARIS, toFake: ["Date"] });
    await contactWithDate("2026-10-31", {
      email: "bloque@test.fr",
      isBlocked: true,
      blockedAt: new Date(),
    });
    await automation();

    expect(await processCrmEmailAutomations()).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
    expect(await CrmEmailAutomationLog.countDocuments()).toBe(0);
  });

  for (const [label, changes] of [
    ["espace passé à l'offre d'entrée", { plan: "freelance" }],
    [
      "abonnement résilié et expiré",
      { status: "canceled", periodEnd: new Date("2026-10-01T00:00:00Z") },
    ],
  ]) {
    it(`${label} : aucun e-mail`, async () => {
      vi.useFakeTimers({ now: NEUF_HEURES_PARIS, toFake: ["Date"] });
      await contactWithDate("2026-10-31", { email: "contact@test.fr" });
      await automation();
      await setSubscription(changes);

      expect(await processCrmEmailAutomations()).toBe(0);
      expect(sendMail).not.toHaveBeenCalled();
      expect(await CrmEmailAutomationLog.countDocuments()).toBe(0);
    });
  }

  it("une adresse d'expéditeur étrangère à l'espace n'est jamais utilisée", async () => {
    vi.useFakeTimers({ now: NEUF_HEURES_PARIS, toFake: ["Date"] });
    await contactWithDate("2026-10-31", { email: "contact@test.fr" });
    // Enregistrée avant les contrôles de l'expéditeur
    await automation({
      email: {
        fromName: "Service client",
        fromEmail: "direction@banque-exemple.fr",
      },
    });

    await processCrmEmailAutomations();

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].from).not.toContain("banque-exemple");
  });
});

describe("Dates d'anniversaire", () => {
  // Décision produit attendue : un champ « Date d'anniversaire » (1990-10-31)
  // n'est jamais relancé, la date étant comparée année comprise. Relancer
  // chaque année tous les champs date changerait le sens des dates uniques
  // (fin de contrat) : il faut une option « chaque année » sur l'automatisation.
  it.todo(
    "une date d'une année passée (1990-10-31) est relancée le 31/10 de l'année en cours si l'automatisation est annuelle",
  );
});
