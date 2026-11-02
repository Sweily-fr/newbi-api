/**
 * Journal des envois de documents : aperçu de l'e-mail reçu par le client
 * (lien du reçu à l'émetteur) et historique des envois d'un document.
 *
 * L'aperçu ne doit contenir ni pixel ni lien de suivi (le consulter ne doit
 * pas marquer le document « Ouvert »), et ne se lit que par un membre de
 * l'espace du document, même si un autre espace est actif.
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
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const storage = vi.hoisted(() => ({
  uploadImage: vi.fn(),
  getDocumentObjectBuffer: vi.fn(),
  uploadEmailAttachment: vi.fn(),
  sanitizeFileName: (name) => name.replace(/[^\w\d.-]/g, "-"),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: storage,
}));
vi.mock("axios", () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: Buffer.from("%PDF-1.4") }),
    get: vi.fn().mockResolvedValue({ data: Buffer.from("%PDF-1.4") }),
  },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import DocumentEmailLog from "../../src/models/DocumentEmailLog.js";
import { sendDocumentEmail } from "../../src/services/documentEmailService.js";
import { recordDeliveryEvent } from "../../src/services/documentDeliveryService.js";
import { markEmailLogOpened } from "../../src/services/documentEmailLogService.js";
import documentEmailResolvers from "../../src/resolvers/documentEmail.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const orgId = buildOrganizationId();
const otherOrgId = buildOrganizationId();
const CLIENT_EMAIL = "client@test.fr";
const SENDER_EMAIL = "emetteur@test.fr";

async function insertInvoice() {
  const { insertedId } = await Invoice.collection.insertOne({
    _id: new ObjectId(),
    workspaceId: orgId,
    prefix: "F-2026",
    number: "000042",
    status: "PENDING",
    issueDate: new Date("2026-09-01"),
    dueDate: new Date("2026-09-15"),
    client: { name: "Client", email: CLIENT_EMAIL, type: "COMPANY" },
    items: [],
    finalTotalHT: 100,
    finalTotalTTC: 120,
    finalTotalVAT: 20,
    companyInfo: { name: "Société A", email: "a@test.fr" },
    createdBy: userId,
  });
  return insertedId;
}

const sendByEmail = (invoiceId, overrides = {}) =>
  sendDocumentEmail({
    documentId: invoiceId.toString(),
    documentType: "invoice",
    workspaceId: orgId,
    emailSubject: "Facture {documentNumber}",
    emailBody: "Bonjour,\nVoici votre facture.",
    recipientEmail: CLIENT_EMAIL,
    ccEmails: ["compta@test.fr"],
    bccEmails: ["archive@test.fr"],
    pdfBase64: Buffer.from("%PDF-1.4").toString("base64"),
    extraAttachments: [
      {
        filename: "cgv.pdf",
        content: Buffer.from("conditions").toString("base64"),
        contentType: "application/pdf",
      },
    ],
    senderEmail: SENDER_EMAIL,
    ...overrides,
  });

const delivered = (emailId) => ({
  type: "email.delivered",
  created_at: "2026-10-26T10:00:05.000Z",
  data: { email_id: emailId, to: [CLIENT_EMAIL] },
});

const resolve = (field, args, context) =>
  documentEmailResolvers.Query[field](null, args, context, {
    fieldName: field,
  });

beforeAll(async () => {
  await startMongo();
  await DocumentEmailLog.syncIndexes();
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
  storage.uploadImage.mockResolvedValue({ key: "k", url: "https://r2/k" });
  storage.getDocumentObjectBuffer.mockResolvedValue(null);
  storage.uploadEmailAttachment.mockResolvedValue({});
});

describe("journal de l'envoi", () => {
  it("garde l'e-mail reçu par le client, sans pixel ni lien de suivi", async () => {
    const id = await insertInvoice();

    await sendByEmail(id);

    const [log] = await DocumentEmailLog.find({ documentId: id }).lean();
    expect(log.workspaceId).toEqual(orgId);
    expect(log.documentType).toBe("invoice");
    expect(log.documentNumber).toBe("F-2026-000042");
    expect(log.subject).toBe("Facture F-2026-000042");
    expect(log.from).toBe("Société A <no-reply@newbi.fr>");
    expect(log.to).toBe(CLIENT_EMAIL);
    expect(log.cc).toEqual(["compta@test.fr"]);
    expect(log.bcc).toEqual(["archive@test.fr"]);
    expect(log.senderEmail).toBe(SENDER_EMAIL);
    expect(log.resendMessageId).toBe("resend-1");
    expect(log.deliveryStatus).toBe("SENT");
    expect(log.attachments).toMatchObject([
      { filename: "F-2026-000042.pdf", size: 8, isDocument: true },
      { filename: "cgv.pdf", size: 10, isDocument: false },
    ]);
    expect(log.html).toContain("Voici votre facture.");
    expect(log.html).not.toContain("/tracking/open/");
    expect(log.html).not.toContain("/tracking/click/");

    // L'e-mail réellement envoyé, lui, garde son suivi
    const sent = mailer.resend.emails.send.mock.calls[0][0];
    expect(sent.html).toContain("/tracking/open/");
  });

  it("conserve les fichiers ajoutés à la main, pas le PDF du document", async () => {
    const id = await insertInvoice();

    await sendByEmail(id);

    const log = await DocumentEmailLog.findOne({ documentId: id }).lean();
    const key = `email-attachments/${orgId}/${log._id}/1-cgv.pdf`;
    await vi.waitFor(async () => {
      const stored = await DocumentEmailLog.findById(log._id).lean();
      expect(stored.attachments[1]).toMatchObject({
        storageKey: key,
        contentType: "application/pdf",
      });
    });
    expect(storage.uploadEmailAttachment).toHaveBeenCalledTimes(1);
    const [uploadedKey, content] = storage.uploadEmailAttachment.mock.calls[0];
    expect(uploadedKey).toBe(key);
    expect(content.toString()).toBe("conditions");
    const stored = await DocumentEmailLog.findById(log._id).lean();
    expect(stored.attachments[0].storageKey).toBeUndefined();
  });

  it("un fichier non conservé ne bloque pas l'envoi", async () => {
    storage.uploadEmailAttachment.mockRejectedValue(
      new Error("R2 indisponible"),
    );
    const id = await insertInvoice();

    await expect(sendByEmail(id)).resolves.toBeTruthy();

    await vi.waitFor(() =>
      expect(storage.uploadEmailAttachment).toHaveBeenCalled(),
    );
    const log = await DocumentEmailLog.findOne({ documentId: id }).lean();
    expect(log.attachments[1].storageKey).toBeUndefined();
  });

  it("le reçu, envoyé à la remise, pointe vers l'aperçu de l'envoi", async () => {
    const id = await insertInvoice();
    await sendByEmail(id);
    const log = await DocumentEmailLog.findOne({ documentId: id }).lean();

    await recordDeliveryEvent(delivered("resend-1"));

    expect(mailer.sendEmail).toHaveBeenCalledTimes(1);
    const receipt = mailer.sendEmail.mock.calls[0][0];
    expect(receipt.html).toContain(`/dashboard/emails-envoyes/${log._id}`);
    expect(receipt.html).toContain("Voir l'e-mail envoyé");
    const updated = await DocumentEmailLog.findById(log._id).lean();
    expect(updated.deliveryStatus).toBe("DELIVERED");
  });

  it("un document renvoyé garde l'état de chaque envoi", async () => {
    const id = await insertInvoice();
    await sendByEmail(id);
    mailer.resend.emails.send.mockResolvedValue({
      data: { id: "resend-2" },
      error: null,
    });
    await sendByEmail(id, { recipientEmail: "nouvelle@test.fr" });

    // Rejet du premier envoi, arrivé après le second
    await recordDeliveryEvent({
      type: "email.bounced",
      created_at: "2026-10-26T10:00:05.000Z",
      data: {
        email_id: "resend-1",
        to: [CLIENT_EMAIL],
        bounce: { type: "Permanent", subType: "NoEmail", message: "x" },
      },
    });

    const logs = await DocumentEmailLog.find({ documentId: id })
      .sort({ sentAt: 1 })
      .lean();
    expect(logs.map((log) => log.deliveryStatus)).toEqual(["FAILED", "SENT"]);
    expect(logs[0].deliveryFailureReason).toBe("L'adresse e-mail n'existe pas");
    // Le document suit le dernier envoi
    const invoice = await Invoice.collection.findOne({ _id: id });
    expect(invoice.emailTracking.deliveryStatus).toBe("SENT");
  });

  it("note la première ouverture d'un envoi", async () => {
    const id = await insertInvoice();
    await sendByEmail(id);
    const log = await DocumentEmailLog.findOne({ documentId: id }).lean();

    const first = new Date("2026-10-26T11:00:00.000Z");
    await markEmailLogOpened({ trackingToken: log.trackingToken }, first);
    await markEmailLogOpened({ resendMessageId: "resend-1" });

    const updated = await DocumentEmailLog.findById(log._id).lean();
    expect(updated.openedAt).toEqual(first);
  });

  it("via SMTP, le reçu immédiat pointe aussi vers l'aperçu", async () => {
    const id = await insertInvoice();
    mailer.useResend = false;
    mailer.transporter.sendMail.mockResolvedValue({ messageId: "smtp-1" });

    await sendByEmail(id);
    await new Promise((resolve) => setImmediate(resolve));

    const log = await DocumentEmailLog.findOne({ documentId: id }).lean();
    expect(log.resendMessageId).toBeNull();
    expect(log.from).toBe('"Société A" <a@test.fr>');
    expect(mailer.sendEmail.mock.calls[0][0].html).toContain(
      `/dashboard/emails-envoyes/${log._id}`,
    );
  });
});

describe("contrôles de l'envoi", () => {
  const sentCount = () => mailer.resend.emails.send.mock.calls.length;

  for (const [cas, overrides] of [
    ["destinataire", { recipientEmail: "pas-une-adresse" }],
    ["copie", { ccEmails: ["compta@test.fr", "client@@test"] }],
    ["copie cachée", { bccEmails: ["archive test.fr"] }],
  ]) {
    it(`adresse ${cas} invalide : refus avec un message, rien n'est envoyé ni journalisé`, async () => {
      const id = await insertInvoice();

      await expect(sendByEmail(id, overrides)).rejects.toThrow(
        /Adresse e-mail invalide/,
      );

      expect(sentCount()).toBe(0);
      expect(await DocumentEmailLog.countDocuments({ documentId: id })).toBe(0);
    });
  }

  it("un objet sur plusieurs lignes part sur une seule ligne", async () => {
    const id = await insertInvoice();

    await sendByEmail(id, {
      emailSubject: "Facture {documentNumber}\r\nBcc: autre@test.fr",
    });

    const sent = mailer.resend.emails.send.mock.calls[0][0];
    expect(sent.subject).not.toMatch(/[\r\n]/);
    expect(sent.subject).toBe("Facture F-2026-000042 Bcc: autre@test.fr");
  });

  it("un « PDF » joint qui n'en est pas un : refus, rien n'est envoyé", async () => {
    const id = await insertInvoice();

    await expect(
      sendByEmail(id, {
        pdfBase64: Buffer.from("<html>autre IBAN</html>").toString("base64"),
      }),
    ).rejects.toThrow(/n'est pas un PDF valide/);

    expect(sentCount()).toBe(0);
  });

  it("le PDF joint par l'éditeur n'est jamais gardé comme copie du document", async () => {
    const id = await insertInvoice();

    await sendByEmail(id);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(storage.uploadImage).not.toHaveBeenCalled();
    const saved = await Invoice.collection.findOne({ _id: id });
    expect(saved.cachedPdf ?? null).toBeNull();
  });

  it("un nom de client piégé reste du texte dans l'e-mail et son journal", async () => {
    const { insertedId: id } = await Invoice.collection.insertOne({
      workspaceId: orgId,
      prefix: "F-2026",
      number: "000043",
      status: "PENDING",
      issueDate: new Date("2026-09-01"),
      dueDate: new Date("2026-09-15"),
      client: {
        name: "<img src=x onerror=alert(1)>",
        email: CLIENT_EMAIL,
        type: "COMPANY",
      },
      items: [],
      finalTotalHT: 100,
      finalTotalTTC: 120,
      finalTotalVAT: 20,
      companyInfo: { name: "Société A", email: "a@test.fr" },
      createdBy: userId,
    });

    await sendByEmail(id, { emailBody: "Bonjour {clientName}" });

    const [log] = await DocumentEmailLog.find({ documentId: id }).lean();
    expect(log.html).not.toContain("<img src=x");
    expect(log.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("lecture des envois (GraphQL)", () => {
  async function sentLog() {
    const id = await insertInvoice();
    await sendByEmail(id);
    return {
      invoiceId: id,
      log: await DocumentEmailLog.findOne({ documentId: id }).lean(),
    };
  }

  it("l'aperçu se lit depuis un autre espace actif dont on est membre", async () => {
    await seedOrgMembership({ userId, organizationId: orgId });
    await seedOrgMembership({
      userId,
      organizationId: otherOrgId,
      organizationName: "Autre espace",
    });
    const { log } = await sentLog();

    const result = await resolve(
      "documentEmailLog",
      { id: log._id.toString() },
      buildContext({ userId, organizationId: otherOrgId }),
    );

    expect(result.id).toBe(log._id.toString());
    expect(result.workspaceId).toBe(orgId.toString());
    expect(result.workspaceName).toBe("Test Org");
    expect(result.html).toContain("Voici votre facture.");
    expect(result.cc).toEqual(["compta@test.fr"]);
  });

  it("indique les pièces jointes consultables, sans exposer leur clé", async () => {
    await seedOrgMembership({ userId, organizationId: orgId });
    const { log } = await sentLog();
    await DocumentEmailLog.collection.insertOne({
      ...log,
      _id: new ObjectId(),
      attachments: [
        ...log.attachments.slice(0, 1),
        { filename: "ancien.docx", size: 5, isDocument: false },
      ],
    });
    await vi.waitFor(async () => {
      const stored = await DocumentEmailLog.findById(log._id).lean();
      expect(stored.attachments[1].storageKey).toBeTruthy();
    });

    const [recent, older] = await Promise.all(
      [
        log._id,
        (await DocumentEmailLog.findOne({ _id: { $ne: log._id } }))._id,
      ].map((id) =>
        resolve(
          "documentEmailLog",
          { id: id.toString() },
          buildContext({ userId, organizationId: orgId }),
        ),
      ),
    );

    expect(recent.attachments).toEqual([
      {
        filename: "F-2026-000042.pdf",
        size: 8,
        isDocument: true,
        available: true,
      },
      { filename: "cgv.pdf", size: 10, isDocument: false, available: true },
    ]);
    // Envoi antérieur à la conservation : nom seulement
    expect(older.attachments[1]).toEqual({
      filename: "ancien.docx",
      size: 5,
      isDocument: false,
      available: false,
    });
  });

  it("refuse l'aperçu à un utilisateur hors de l'espace du document", async () => {
    const stranger = buildUserId();
    await seedOrgMembership({ userId: stranger, organizationId: otherOrgId });
    const { log } = await sentLog();

    await expect(
      resolve(
        "documentEmailLog",
        { id: log._id.toString() },
        buildContext({ userId: stranger, organizationId: otherOrgId }),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("aperçu introuvable", async () => {
    await seedOrgMembership({ userId, organizationId: orgId });

    await expect(
      resolve(
        "documentEmailLog",
        { id: new ObjectId().toString() },
        buildContext({ userId, organizationId: orgId }),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("historique d'un document, sans le contenu des e-mails", async () => {
    await seedOrgMembership({ userId, organizationId: orgId });
    const { invoiceId } = await sentLog();
    mailer.resend.emails.send.mockResolvedValue({
      data: { id: "resend-2" },
      error: null,
    });
    await sendByEmail(invoiceId, { recipientEmail: "nouvelle@test.fr" });

    const logs = await resolve(
      "documentEmailLogs",
      {
        workspaceId: orgId.toString(),
        documentType: "invoice",
        documentId: invoiceId.toString(),
      },
      buildContext({ userId, organizationId: orgId }),
    );

    expect(logs.map((log) => log.to)).toEqual([
      "nouvelle@test.fr",
      CLIENT_EMAIL,
    ]);
    expect(logs[0].html).toBeNull();
  });

  it("l'historique d'un autre espace reste vide", async () => {
    await seedOrgMembership({ userId, organizationId: orgId });
    await seedOrgMembership({ userId, organizationId: otherOrgId });
    const { invoiceId } = await sentLog();

    const logs = await resolve(
      "documentEmailLogs",
      {
        workspaceId: otherOrgId.toString(),
        documentType: "invoice",
        documentId: invoiceId.toString(),
      },
      buildContext({ userId, organizationId: otherOrgId }),
    );

    expect(logs).toEqual([]);
  });
});
