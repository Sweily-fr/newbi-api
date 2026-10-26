/**
 * Remise des e-mails de documents : le reçu « Envoi confirmé » ne part qu'une
 * fois l'e-mail remis au serveur du destinataire, un rejet prévient
 * l'émetteur, et le suivi n'est écrit qu'après l'acceptation par Resend.
 *
 * Avant : le reçu partait dès l'acceptation par Resend, même quand l'adresse
 * du client n'existait pas, et un envoi refusé marquait quand même le
 * document « Envoyé ».
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

const mailer = vi.hoisted(() => ({
  useResend: true,
  resendFromEmail: "no-reply@newbi.fr",
  resend: { emails: { send: vi.fn(), get: vi.fn() } },
  transporter: { sendMail: vi.fn() },
  sendEmail: vi.fn(),
}));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: mailer,
}));
vi.mock("../../src/resolvers/documentEmail.js", () => ({
  publishEmailTrackingUpdate: vi.fn(),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    uploadImage: vi.fn().mockResolvedValue({ key: "k", url: "https://r2/k" }),
    getDocumentObjectBuffer: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("axios", () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: Buffer.from("%PDF-1.4") }),
    get: vi.fn().mockResolvedValue({ data: Buffer.from("%PDF-1.4") }),
  },
}));

import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import { sendDocumentEmail } from "../../src/services/documentEmailService.js";
import {
  recordDeliveryEvent,
  checkPendingDeliveries,
} from "../../src/services/documentDeliveryService.js";
import resendWebhookRouter from "../../src/routes/resendWebhook.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const orgId = buildOrganizationId();
const CLIENT_EMAIL = "client@test.fr";
const SENDER_EMAIL = "emetteur@test.fr";

async function insertInvoice(emailTracking) {
  const { insertedId } = await Invoice.collection.insertOne({
    _id: new ObjectId(),
    workspaceId: orgId,
    prefix: "F-2026",
    number: "000042",
    status: "PENDING",
    issueDate: new Date("2026-09-01"),
    dueDate: new Date("2026-09-15"),
    client: { name: "Dupont & Fils", email: CLIENT_EMAIL, type: "COMPANY" },
    items: [],
    finalTotalHT: 100,
    finalTotalTTC: 120,
    finalTotalVAT: 20,
    companyInfo: { name: "Société A", email: "a@test.fr" },
    createdBy: userId,
    ...(emailTracking ? { emailTracking } : {}),
  });
  return insertedId;
}

const sentTracking = (overrides = {}) => ({
  trackingToken: "token",
  emailSentAt: new Date(Date.now() - 10 * 60 * 1000),
  emailOpenCount: 0,
  emailClickCount: 0,
  resendMessageId: "resend-1",
  deliveryStatus: "SENT",
  recipientEmail: CLIENT_EMAIL,
  senderEmail: SENDER_EMAIL,
  senderNotifiedAt: null,
  ...overrides,
});

const trackingOf = async (id) =>
  (await Invoice.collection.findOne({ _id: id })).emailTracking;

const event = (type, data = {}) => ({
  type,
  created_at: "2026-10-26T10:00:05.000Z",
  data: { email_id: "resend-1", to: [CLIENT_EMAIL], ...data },
});

const sendByEmail = (invoiceId) =>
  sendDocumentEmail({
    documentId: invoiceId.toString(),
    documentType: "invoice",
    workspaceId: orgId,
    emailSubject: "Facture {documentNumber}",
    emailBody: "Bonjour",
    recipientEmail: CLIENT_EMAIL,
    pdfBase64: Buffer.from("%PDF-1.4").toString("base64"),
    senderEmail: SENDER_EMAIL,
  });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  vi.clearAllMocks();
  mailer.useResend = true;
  mailer.resend.emails.send.mockResolvedValue({
    data: { id: "resend-1" },
    error: null,
  });
  mailer.sendEmail.mockResolvedValue({});
});

describe("envoi d'un document par e-mail", () => {
  it("enregistre le suivi après l'acceptation, sans reçu immédiat", async () => {
    const id = await insertInvoice();

    await sendByEmail(id);
    await new Promise((resolve) => setImmediate(resolve));

    const tracking = await trackingOf(id);
    expect(tracking.emailSentAt).toBeInstanceOf(Date);
    expect(tracking.resendMessageId).toBe("resend-1");
    expect(tracking.deliveryStatus).toBe("SENT");
    expect(tracking.recipientEmail).toBe(CLIENT_EMAIL);
    expect(tracking.senderEmail).toBe(SENDER_EMAIL);
    expect(tracking.senderNotifiedAt).toBeNull();
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("ne marque pas le document envoyé quand Resend refuse l'e-mail", async () => {
    const id = await insertInvoice();
    mailer.resend.emails.send.mockResolvedValue({
      data: null,
      error: { message: "Invalid `to` field" },
    });

    await expect(sendByEmail(id)).rejects.toThrow("Erreur Resend");

    expect(await trackingOf(id)).toBeUndefined();
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("garde un envoi précédent intact quand le nouvel envoi échoue", async () => {
    const previous = sentTracking({ deliveryStatus: "DELIVERED" });
    const id = await insertInvoice(previous);
    mailer.resend.emails.send.mockRejectedValue(new Error("timeout"));

    await expect(sendByEmail(id)).rejects.toThrow("timeout");

    expect((await trackingOf(id)).deliveryStatus).toBe("DELIVERED");
  });

  it("envoie le reçu tout de suite via SMTP (pas de suivi de remise)", async () => {
    const id = await insertInvoice();
    mailer.useResend = false;
    mailer.transporter.sendMail.mockResolvedValue({ messageId: "smtp-1" });

    await sendByEmail(id);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
    expect(mailer.sendEmail.mock.calls[0][0].to).toBe(SENDER_EMAIL);
    expect((await trackingOf(id)).senderNotifiedAt).toBeInstanceOf(Date);
  });
});

describe("événements de remise (webhook Resend)", () => {
  it("e-mail remis : état « remis » et un seul reçu à l'émetteur", async () => {
    const id = await insertInvoice(sentTracking());

    await recordDeliveryEvent(event("email.delivered"));
    await recordDeliveryEvent(event("email.delivered"));

    const tracking = await trackingOf(id);
    expect(tracking.deliveryStatus).toBe("DELIVERED");
    expect(tracking.deliveredAt).toEqual(new Date("2026-10-26T10:00:05.000Z"));
    expect(tracking.senderNotifiedAt).toBeInstanceOf(Date);
    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
    const receipt = mailer.sendEmail.mock.calls[0][0];
    expect(receipt.to).toBe(SENDER_EMAIL);
    expect(receipt.subject).toBe(
      "Facture F-2026-000042 envoyée à Dupont & Fils",
    );
    expect(receipt.html).toContain("Remis le");
    expect(receipt.html).toContain("Dupont &amp; Fils");
  });

  it("e-mail rejeté : état « rejeté », raison et alerte à l'émetteur", async () => {
    const id = await insertInvoice(sentTracking());

    await recordDeliveryEvent(
      event("email.bounced", {
        bounce: {
          type: "Permanent",
          subType: "Suppressed",
          message: "on the suppression list",
        },
      }),
    );

    const tracking = await trackingOf(id);
    expect(tracking.deliveryStatus).toBe("FAILED");
    expect(tracking.deliveryFailureReason).toBe(
      "L'adresse a déjà été rejetée lors d'un envoi précédent",
    );
    expect(tracking.senderFailureNotifiedAt).toBeInstanceOf(Date);
    expect(tracking.senderNotifiedAt).toBeNull();
    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
    const alert = mailer.sendEmail.mock.calls[0][0];
    expect(alert.subject).toBe(
      "Facture F-2026-000042 non remise à Dupont & Fils",
    );
    expect(alert.html).toContain("Non remis");
    expect(alert.html).toContain("client@test.fr");
  });

  it("un rejet du devis s'accorde au masculin", async () => {
    const { insertedId } = await Quote.collection.insertOne({
      _id: new ObjectId(),
      workspaceId: orgId,
      prefix: "D-2026",
      number: "000007",
      status: "PENDING",
      issueDate: new Date("2026-09-01"),
      client: { name: "Client", email: CLIENT_EMAIL, type: "COMPANY" },
      items: [],
      finalTotalTTC: 50,
      createdBy: userId,
      emailTracking: sentTracking(),
    });

    await recordDeliveryEvent(
      event("email.failed", { failed: { reason: "x" } }),
    );

    const quote = await Quote.collection.findOne({ _id: insertedId });
    expect(quote.emailTracking.deliveryFailureReason).toBe(
      "L'envoi a échoué chez notre prestataire d'e-mails",
    );
    expect(mailer.sendEmail.mock.calls[0][0].subject).toBe(
      "Devis D-2026-000007 non remis à Client",
    );
  });

  it("ignore le rejet d'une adresse en copie", async () => {
    const id = await insertInvoice(sentTracking());

    await recordDeliveryEvent(
      event("email.bounced", {
        to: ["copie@test.fr"],
        bounce: { type: "Permanent", subType: "General", message: "x" },
      }),
    );

    expect((await trackingOf(id)).deliveryStatus).toBe("SENT");
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("une remise arrivée après un rejet ne l'efface pas", async () => {
    const id = await insertInvoice(sentTracking());

    await recordDeliveryEvent(
      event("email.bounced", {
        bounce: { type: "Permanent", subType: "NoEmail", message: "x" },
      }),
    );
    await recordDeliveryEvent(event("email.delivered"));

    const tracking = await trackingOf(id);
    expect(tracking.deliveryStatus).toBe("FAILED");
    expect(tracking.deliveryFailureReason).toBe(
      "L'adresse e-mail n'existe pas",
    );
    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("remise retardée : état « retardé », sans e-mail à l'émetteur", async () => {
    const id = await insertInvoice(sentTracking());

    await recordDeliveryEvent(event("email.delivery_delayed"));

    expect((await trackingOf(id)).deliveryStatus).toBe("DELAYED");
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });

  it("ignore un événement d'un ancien envoi du document", async () => {
    const id = await insertInvoice(
      sentTracking({ resendMessageId: "resend-2" }),
    );

    await recordDeliveryEvent(event("email.delivered"));

    expect((await trackingOf(id)).deliveryStatus).toBe("SENT");
  });

  it("route du webhook : un rejet signé met le document à jour", async () => {
    const id = await insertInvoice(sentTracking());
    const secretBytes = crypto.randomBytes(24);
    const previousSecret = process.env.RESEND_WEBHOOK_SECRET;
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${secretBytes.toString("base64")}`;

    const app = express();
    app.use("/webhook/resend", resendWebhookRouter);
    const server = app.listen(0);
    try {
      const body = JSON.stringify(
        event("email.bounced", {
          bounce: { type: "Permanent", subType: "MailboxFull", message: "x" },
        }),
      );
      const svixId = "msg_1";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = crypto
        .createHmac("sha256", secretBytes)
        .update(`${svixId}.${timestamp}.${body}`)
        .digest("base64");
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/webhook/resend`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": svixId,
            "svix-timestamp": timestamp,
            "svix-signature": `v1,${signature}`,
          },
          body,
        },
      );

      expect(response.status).toBe(200);
      const tracking = await trackingOf(id);
      expect(tracking.deliveryStatus).toBe("FAILED");
      expect(tracking.deliveryFailureReason).toBe(
        "La boîte de réception du destinataire est pleine",
      );
    } finally {
      server.close();
      if (previousSecret === undefined) {
        delete process.env.RESEND_WEBHOOK_SECRET;
      } else {
        process.env.RESEND_WEBHOOK_SECRET = previousSecret;
      }
    }
  });
});

describe("vérification planifiée de la remise", () => {
  it("relit chez Resend un e-mail sans nouvelle et envoie le reçu", async () => {
    const id = await insertInvoice(sentTracking());
    mailer.resend.emails.get.mockResolvedValue({
      data: { id: "resend-1", last_event: "delivered" },
      error: null,
    });

    const result = await checkPendingDeliveries({ pauseMs: 0 });

    expect(result).toEqual({ checked: 1, updated: 1 });
    expect(mailer.resend.emails.get).toHaveBeenCalledWith("resend-1");
    const tracking = await trackingOf(id);
    expect(tracking.deliveryStatus).toBe("DELIVERED");
    expect(tracking.deliveryCheckedAt).toBeInstanceOf(Date);
    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("laisse passer quelques minutes après l'envoi, puis espace les relectures", async () => {
    await insertInvoice(
      sentTracking({ emailSentAt: new Date(Date.now() - 60 * 1000) }),
    );
    await insertInvoice(
      sentTracking({
        resendMessageId: "resend-3",
        deliveryCheckedAt: new Date(Date.now() - 5 * 60 * 1000),
      }),
    );

    const result = await checkPendingDeliveries({ pauseMs: 0 });

    expect(result.checked).toBe(0);
    expect(mailer.resend.emails.get).not.toHaveBeenCalled();
  });

  it("toujours en cours chez Resend : rien ne change, relu plus tard", async () => {
    const id = await insertInvoice(sentTracking());
    mailer.resend.emails.get.mockResolvedValue({
      data: { id: "resend-1", last_event: "sent" },
      error: null,
    });

    const result = await checkPendingDeliveries({ pauseMs: 0 });

    expect(result).toEqual({ checked: 1, updated: 0 });
    const tracking = await trackingOf(id);
    expect(tracking.deliveryStatus).toBe("SENT");
    expect(tracking.deliveryCheckedAt).toBeInstanceOf(Date);
    expect(mailer.sendEmail).not.toHaveBeenCalled();
  });
});
