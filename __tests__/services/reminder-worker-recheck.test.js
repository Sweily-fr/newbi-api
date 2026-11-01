/**
 * Relances automatiques : le worker relit l'état au moment d'envoyer. Un job
 * mis en file avant un paiement, une annulation, la désactivation des
 * relances ou l'exclusion du client ne part pas : aucun e-mail, aucun
 * journal « envoyée ».
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
import mongoose from "mongoose";

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
vi.mock("bullmq", () => {
  class Queue {
    add = vi.fn();
    close = vi.fn();
  }
  class Worker {
    on = vi.fn();
    close = vi.fn();
  }
  return { Queue, Worker };
});
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { transporter: { sendMail } },
}));
vi.mock("axios", () => ({
  default: { post: vi.fn().mockRejectedValue(new Error("pas de PDF")) },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import InvoiceReminderSettings from "../../src/models/InvoiceReminderSettings.js";
import InvoiceReminderLog from "../../src/models/InvoiceReminderLog.js";
import { processReminderJob } from "../../src/queues/reminderQueue.js";

const { ObjectId } = mongoose.Types;
const workspaceId = buildOrganizationId();
const userId = buildUserId();
const clientId = new ObjectId();

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: "message-1" });
  await InvoiceReminderSettings.collection.insertOne({
    workspaceId,
    enabled: true,
    firstReminderDays: 0,
    secondReminderDays: 7,
    excludedClientIds: [],
    emailSubject: "Relance {invoiceNumber}",
    emailBody: "Bonjour {clientName}",
  });
});

const seedInvoice = async (fields = {}) => {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId,
    createdBy: userId,
    prefix: "F-102026",
    number: "0007",
    status: "PENDING",
    finalTotalTTC: 1080,
    dueDate: new Date("2026-10-01T00:00:00Z"),
    client: {
      id: clientId.toString(),
      name: "Atelier Lumière",
      email: "compta@atelier.fr",
      type: "COMPANY",
    },
    companyInfo: { name: "Studio Test", email: "studio@test.fr" },
    ...fields,
  });
  return insertedId;
};

const job = (invoiceId) => ({
  data: {
    invoiceId: invoiceId.toString(),
    reminderType: "FIRST",
    workspaceId: workspaceId.toString(),
  },
});

const sentLogs = () => InvoiceReminderLog.countDocuments({ status: "SENT" });

describe("Worker des relances : état relu à l'envoi", () => {
  it("facture toujours due : la relance part et est journalisée", async () => {
    const id = await seedInvoice();

    const result = await processReminderJob(job(id));

    expect(result.success).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(await sentLogs()).toBe(1);
  });

  for (const [cas, avant] of [
    [
      "facture marquée payée",
      (id) =>
        Invoice.collection.updateOne(
          { _id: id },
          { $set: { status: "COMPLETED", paymentDate: new Date() } },
        ),
    ],
    [
      "facture annulée",
      (id) =>
        Invoice.collection.updateOne(
          { _id: id },
          { $set: { status: "CANCELED" } },
        ),
    ],
    [
      "relances désactivées",
      () =>
        InvoiceReminderSettings.collection.updateOne(
          { workspaceId },
          { $set: { enabled: false } },
        ),
    ],
    [
      "client exclu des relances",
      () =>
        InvoiceReminderSettings.collection.updateOne(
          { workspaceId },
          { $set: { excludedClientIds: [clientId] } },
        ),
    ],
  ]) {
    it(`${cas} après la mise en file : aucun e-mail, aucun journal « envoyée »`, async () => {
      const id = await seedInvoice();
      await avant(id);

      const result = await processReminderJob(job(id));

      expect(result.skipped).toBe(true);
      expect(sendMail).not.toHaveBeenCalled();
      expect(await sentLogs()).toBe(0);
    });
  }
});
