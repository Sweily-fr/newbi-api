/**
 * Campagnes e-mail, événements de Resend (webhook) : remis, rejeté
 * (définitif ou non), plainte, échec, adresse bloquée ; compteurs sans
 * double comptage ; liste d'exclusion ; coupe-circuit de réputation (plus
 * de 3 % de rejets ou 0,05 % de plaintes après 100 envois, sous les seuils
 * du compte Resend : 4 % et 0,08 %).
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

vi.mock("../../../src/resolvers/documentEmail.js", () => ({
  publishEmailTrackingUpdate: vi.fn(),
}));
const documents = vi.hoisted(() => ({
  recordDeliveryEvent: vi.fn(async () => {}),
}));
vi.mock("../../../src/services/documentDeliveryService.js", () => ({
  findDocumentByResendId: vi.fn(async () => null),
  isDeliveryEvent: () => true,
  recordDeliveryEvent: documents.recordDeliveryEvent,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildOrganizationId } from "../../factories/index.js";
import EmailCampaign from "../../../src/models/EmailCampaign.js";
import EmailCampaignRecipient from "../../../src/models/EmailCampaignRecipient.js";
import EmailSuppression from "../../../src/models/EmailSuppression.js";
import resendWebhookRouter from "../../../src/routes/resendWebhook.js";
import {
  MAX_BOUNCE_RATE,
  MAX_COMPLAINT_RATE,
  REPUTATION_MIN_SENT,
  recordCampaignEmailEvent,
} from "../../../src/services/emailCampaigns/events.js";

const workspaceId = buildOrganizationId();
let campaign;

const handler = resendWebhookRouter.stack[0].route.stack.at(-1).handle;

async function webhook(type, data) {
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  await handler(
    { body: Buffer.from(JSON.stringify({ type, data })), headers: {} },
    res,
  );
  return res;
}

async function addRecipients(count, { sent = true } = {}) {
  const docs = Array.from({ length: count }, (_, i) => ({
    workspaceId,
    campaignId: campaign._id,
    email: `contact${i}@exemple.fr`,
    status: sent ? "SENT" : "PENDING",
    sentAt: sent ? new Date() : null,
    resendId: sent ? `re_${i}` : undefined,
  }));
  await EmailCampaignRecipient.insertMany(docs);
}

const campaignNow = () => EmailCampaign.findById(campaign._id).lean();
const recipient = (i) =>
  EmailCampaignRecipient.findOne({ resendId: `re_${i}` }).lean();

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EmailCampaign.init(),
    EmailCampaignRecipient.init(),
    EmailSuppression.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  delete process.env.RESEND_WEBHOOK_SECRET;
  campaign = await EmailCampaign.create({
    workspaceId,
    name: "Nouveautés",
    status: "SENDING",
    stats: { recipients: 10, sent: 10 },
  });
});

describe("événements d'un destinataire", () => {
  it("remis : date et compteur, une seule fois ; documents non sollicités", async () => {
    await addRecipients(1);
    const res = await webhook("email.delivered", { email_id: "re_0" });
    expect(res.statusCode).toBe(200);
    await webhook("email.delivered", { email_id: "re_0" });
    const saved = await recipient(0);
    expect(saved.status).toBe("DELIVERED");
    expect(saved.deliveredAt).toBeInstanceOf(Date);
    expect((await campaignNow()).stats.delivered).toBe(1);
    expect(documents.recordDeliveryEvent).not.toHaveBeenCalled();
  });

  it("rejet définitif : exclusion de l'adresse ; rejet temporaire : non", async () => {
    await addRecipients(2);
    await webhook("email.bounced", {
      email_id: "re_0",
      bounce: { type: "Permanent", subType: "General", message: "Inconnu" },
    });
    await webhook("email.bounced", {
      email_id: "re_1",
      bounce: { type: "Transient", message: "Boîte pleine" },
    });
    await webhook("email.bounced", { email_id: "re_0" });
    expect((await recipient(0)).status).toBe("BOUNCED");
    expect((await recipient(0)).error).toBe("Inconnu");
    expect((await recipient(1)).bounceType).toBe("Transient");
    const suppressions = await EmailSuppression.find().lean();
    expect(suppressions.map((s) => [s.email, s.reason])).toEqual([
      ["contact0@exemple.fr", "BOUNCED"],
    ]);
    expect((await campaignNow()).stats.bounced).toBe(2);
  });

  it("rejet sans type précisé : considéré comme définitif", async () => {
    await addRecipients(1);
    await recordCampaignEmailEvent("email.bounced", { email_id: "re_0" });
    expect(await EmailSuppression.countDocuments({ reason: "BOUNCED" })).toBe(
      1,
    );
  });

  it("plainte : exclusion (motif le plus fort), compteur unique", async () => {
    await addRecipients(1);
    await EmailSuppression.create({
      workspaceId,
      email: "contact0@exemple.fr",
      reason: "UNSUBSCRIBED",
    });
    await webhook("email.complained", { email_id: "re_0" });
    await webhook("email.complained", { email_id: "re_0" });
    expect((await recipient(0)).status).toBe("COMPLAINED");
    expect((await EmailSuppression.findOne().lean()).reason).toBe("COMPLAINED");
    expect((await campaignNow()).stats.complained).toBe(1);
  });

  it("échec et adresse bloquée par le service : FAILED", async () => {
    await addRecipients(2);
    await webhook("email.failed", {
      email_id: "re_0",
      failed: { reason: "Domaine introuvable" },
    });
    await webhook("email.suppressed", {
      email_id: "re_1",
      suppressed: { type: "bounce", message: "Déjà rejetée" },
    });
    expect((await recipient(0)).error).toBe("Domaine introuvable");
    expect((await recipient(1)).status).toBe("FAILED");
    expect((await campaignNow()).stats.failed).toBe(2);
    expect(
      (await EmailSuppression.findOne({ email: "contact1@exemple.fr" }).lean())
        .reason,
    ).toBe("BOUNCED");
  });

  it("e-mail inconnu des campagnes : laissé aux autres traitements", async () => {
    expect(
      await recordCampaignEmailEvent("email.delivered", { email_id: "autre" }),
    ).toBe(false);
    await webhook("email.delivered", { email_id: "autre" });
    expect(documents.recordDeliveryEvent).toHaveBeenCalledTimes(1);
    expect(
      await recordCampaignEmailEvent("email.delivered", {
        email_id: { $ne: null },
      }),
    ).toBe(false);
  });
});

describe("coupe-circuit de réputation", () => {
  it("seuils sous ceux du compte Resend (rejets 4 %, plaintes 0,08 %)", () => {
    expect(REPUTATION_MIN_SENT).toBe(100);
    expect(MAX_BOUNCE_RATE).toBe(0.03);
    expect(MAX_BOUNCE_RATE).toBeLessThan(0.04);
    expect(MAX_COMPLAINT_RATE).toBe(0.0005);
    expect(MAX_COMPLAINT_RATE).toBeLessThan(0.0008);
  });

  it("plus de 3 % de rejets après 100 envois : pause sans reprise", async () => {
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { "stats.sent": 100 } },
    );
    await addRecipients(4);
    for (let i = 0; i < 3; i += 1) {
      await webhook("email.bounced", { email_id: `re_${i}` });
    }
    // 3 % pile : sous le seuil
    expect((await campaignNow()).status).toBe("SENDING");
    await webhook("email.bounced", { email_id: "re_3" });
    const paused = await campaignNow();
    expect(paused).toMatchObject({ status: "PAUSED", pauseKind: "REPUTATION" });
    expect(paused.pausedReason).toMatch(
      /^Envoi suspendu pour protéger votre réputation : 4\s% des e-mails ont été rejetés \(seuil : 3\s%\)/u,
    );
  });

  it("plus de 0,05 % de plaintes : pause", async () => {
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { "stats.sent": 3000 } },
    );
    await addRecipients(2);
    // 1 sur 3 000 : 0,033 %, sous le seuil
    await webhook("email.complained", { email_id: "re_0" });
    expect((await campaignNow()).status).toBe("SENDING");
    await webhook("email.complained", { email_id: "re_1" });
    const paused = await campaignNow();
    expect(paused.pauseKind).toBe("REPUTATION");
    expect(paused.pausedReason).toMatch(
      /^Envoi suspendu pour protéger votre réputation : 0,07\s% des destinataires ont signalé l'e-mail comme indésirable \(seuil : 0,05\s%\)/u,
    );
  });

  it("moins de 100 envois : pas de pause", async () => {
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { "stats.sent": 20 } },
    );
    await addRecipients(5);
    for (let i = 0; i < 5; i += 1) {
      await webhook("email.bounced", { email_id: `re_${i}` });
    }
    expect((await campaignNow()).status).toBe("SENDING");
  });
});

describe("mongoose", () => {
  it("base de test seulement", () => {
    expect(mongoose.connection.name).toMatch(/^test_/);
  });
});
