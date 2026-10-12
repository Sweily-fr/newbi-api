/**
 * Envoi et relance d'un document : l'activité ne va qu'à un client de l'espace.
 *
 * sendDocumentEmail (documentEmailService) et sendReminder
 * (invoiceReminderService) relisaient la fiche Client par le seul client.id
 * du document, qui vient du client à la création. Un document de A pointant
 * vers un client de B écrivait une activité (numéro, destinataire) dans la
 * fiche de B.
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
  sendMail: async () => ({ messageId: "msg-1" }),
}));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { useResend: false, resend: null, transporter: mailer },
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

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import Client from "../../src/models/Client.js";
import Invoice from "../../src/models/Invoice.js";
import { sendDocumentEmail } from "../../src/services/documentEmailService.js";
import { sendReminder } from "../../src/services/invoiceReminderService.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

async function insertClient(workspaceId) {
  const { insertedId } = await Client.collection.insertOne({
    ...buildClientDoc({ workspaceId, createdBy: userId }),
    activity: [],
  });
  return insertedId;
}

async function insertInvoice(workspaceId, clientId) {
  const { insertedId } = await Invoice.collection.insertOne({
    _id: new ObjectId(),
    workspaceId,
    prefix: "F-2026",
    number: "000042",
    status: "PENDING",
    issueDate: new Date("2026-09-01"),
    dueDate: new Date("2026-09-15"),
    client: {
      id: String(clientId),
      name: "Client",
      email: "client@test.fr",
      type: "COMPANY",
    },
    items: [],
    finalTotalHT: 100,
    finalTotalTTC: 120,
    finalTotalVAT: 20,
    companyInfo: { name: "Société A", email: "a@test.fr" },
    createdBy: userId,
  });
  return insertedId;
}

const sendByEmail = (invoiceId) =>
  sendDocumentEmail({
    documentId: invoiceId.toString(),
    documentType: "invoice",
    workspaceId: orgA,
    emailSubject: "Facture {documentNumber}",
    emailBody: "Bonjour",
    recipientEmail: "destinataire@test.fr",
    pdfBase64: Buffer.from("%PDF-1.4").toString("base64"),
  });

const remind = async (invoiceId) =>
  sendReminder(
    await Invoice.findById(invoiceId),
    { emailSubject: "Relance {invoiceNumber}", emailBody: "Bonjour" },
    "FIRST",
    null,
  );

const activityOf = async (clientId) =>
  (await Client.collection.findOne({ _id: clientId })).activity || [];

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("envoi d'un document par e-mail", () => {
  it("n'écrit pas dans la fiche d'un client d'un autre espace", async () => {
    const clientB = await insertClient(orgB);
    const invoiceA = await insertInvoice(orgA, clientB);

    await sendByEmail(invoiceA);

    expect(await activityOf(clientB)).toEqual([]);
  });

  it("ajoute l'activité au client de l'espace", async () => {
    const clientA = await insertClient(orgA);
    const invoiceA = await insertInvoice(orgA, clientA);

    await sendByEmail(invoiceA);

    const activity = await activityOf(clientA);
    expect(activity).toHaveLength(1);
    expect(activity[0].type).toBe("document_email_sent");
  });
});

describe("relance automatique d'une facture", () => {
  it("n'écrit pas dans la fiche d'un client d'un autre espace", async () => {
    const clientB = await insertClient(orgB);
    const invoiceA = await insertInvoice(orgA, clientB);

    await remind(invoiceA);

    expect(await activityOf(clientB)).toEqual([]);
  });

  it("ajoute l'activité au client de l'espace", async () => {
    const clientA = await insertClient(orgA);
    const invoiceA = await insertInvoice(orgA, clientA);

    await remind(invoiceA);

    const activity = await activityOf(clientA);
    expect(activity).toHaveLength(1);
    expect(activity[0].type).toBe("invoice_reminder_sent");
  });
});
