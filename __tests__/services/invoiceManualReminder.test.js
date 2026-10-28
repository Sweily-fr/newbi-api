/**
 * Relance immédiate depuis le calendrier (sendInvoiceReminderNow) et
 * corrections des relances : montant TTC réel dans l'e-mail (il valait
 * 0,00 €) et libellé « 1ère / 2ème relance » dans la chronologie du client.
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

const { sendMail } = vi.hoisted(() => ({
  sendMail: vi.fn(),
}));
vi.mock("../../src/services/emailReminderService.js", () => ({
  default: { transporter: { sendMail } },
}));
// Pas de génération de PDF en test : la relance part sans pièce jointe
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
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import Client from "../../src/models/Client.js";
import InvoiceReminderLog from "../../src/models/InvoiceReminderLog.js";
import InvoiceReminderSettings from "../../src/models/InvoiceReminderSettings.js";
import { sendReminder } from "../../src/services/invoiceReminderService.js";
import invoiceReminderSettingsResolvers from "../../src/resolvers/invoiceReminderSettings.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const orgA = buildOrganizationId();

const sendNow = (invoiceId, role = "owner") =>
  seedOrgMembership({ userId, organizationId: orgA, role }).then(() =>
    invoiceReminderSettingsResolvers.Mutation.sendInvoiceReminderNow(
      null,
      { invoiceId: invoiceId.toString() },
      buildContext({ userId, organizationId: orgA }),
      { fieldName: "sendInvoiceReminderNow" },
    ),
  );

let seeded = 0;

async function seedInvoice(fields = {}) {
  // Fiche client valide : la chronologie s'écrit par client.save()
  seeded += 1;
  const client = await Client.create(
    buildClientDoc({
      workspaceId: orgA,
      createdBy: userId,
      name: "Atelier Lumière",
      email: `compta${seeded}@atelier.fr`,
    }),
  );
  const clientId = client._id;
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId: orgA,
    prefix: "F-202610",
    number: "0001",
    status: "OVERDUE",
    finalTotalTTC: 1200,
    dueDate: new Date("2026-10-10T00:00:00Z"),
    client: {
      id: clientId.toString(),
      name: "Atelier Lumière",
      email: "compta@atelier.fr",
      type: "COMPANY",
    },
    companyInfo: { name: "Studio Test", email: "studio@test.fr" },
    ...fields,
  });
  return { invoiceId: insertedId, clientId };
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  sendMail.mockReset();
  sendMail.mockResolvedValue({ messageId: "message-1" });
});

describe("relance immédiate", () => {
  it("envoie le rappel avec le vrai montant et le note MANUAL", async () => {
    const { invoiceId, clientId } = await seedInvoice();

    const result = await sendNow(invoiceId);

    expect(result).toEqual({
      success: true,
      message: "Rappel envoyé à compta@atelier.fr.",
    });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("compta@atelier.fr");
    expect(mail.html).toContain("1200,00 €");
    const logs = await InvoiceReminderLog.find({ invoiceId }).lean();
    expect(logs.map((l) => [l.reminderType, l.status])).toEqual([
      ["MANUAL", "SENT"],
    ]);
    const client = await Client.collection.findOne({ _id: clientId });
    expect(client.activity[0].description).toBe(
      "a envoyé une relance pour la facture F-202610-0001",
    );
  });

  it("une seule relance manuelle toutes les 12 heures", async () => {
    const { invoiceId } = await seedInvoice();
    await sendNow(invoiceId);

    const second = await sendNow(invoiceId);

    expect(second.success).toBe(false);
    expect(second.message).toMatch(/12 dernières heures/);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("refuse une facture payée ou un client sans adresse", async () => {
    const paid = await seedInvoice({ status: "COMPLETED" });
    const noEmail = await seedInvoice({
      number: "0002",
      client: { name: "Sans e-mail", type: "COMPANY" },
    });

    expect((await sendNow(paid.invoiceId)).message).toMatch(
      /en attente de paiement/,
    );
    expect((await sendNow(noEmail.invoiceId)).message).toBe(
      "Le client n'a pas d'adresse e-mail.",
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("n'écrit pas dans un autre espace", async () => {
    const { invoiceId } = await seedInvoice({ workspaceId: new ObjectId() });

    const result = await sendNow(invoiceId);

    expect(result).toEqual({ success: false, message: "Facture introuvable." });
  });

  it("réservée au droit d'envoi des factures", async () => {
    const { invoiceId } = await seedInvoice();

    await expect(sendNow(invoiceId, "viewer")).rejects.toThrow();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("relances automatiques", () => {
  it("la 1re relance est libellée « 1ère » dans la chronologie", async () => {
    const { invoiceId, clientId } = await seedInvoice();
    const invoice = await Invoice.findById(invoiceId);

    await sendReminder(
      invoice,
      new InvoiceReminderSettings({ workspaceId: orgA }),
      "FIRST",
      null,
    );

    const client = await Client.collection.findOne({ _id: clientId });
    expect(client.activity[0].description).toBe(
      "a envoyé la 1ère relance pour la facture F-202610-0001",
    );
    expect(sendMail.mock.calls[0][0].html).toContain("1200,00 €");
  });
});
