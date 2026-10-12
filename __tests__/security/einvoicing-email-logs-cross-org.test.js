import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";

import eInvoicingResolvers from "../../src/resolvers/eInvoicing.js";
import emailReminderResolvers from "../../src/resolvers/emailReminder.js";
import Invoice from "../../src/models/Invoice.js";
import EmailLog from "../../src/models/EmailLog.js";

// user A : owner de l'espace A, simple membre de l'espace C ;
// user B : owner de l'espace B (la victime) et de l'espace C
const userA = buildUserId();
const userB = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
const orgC = buildOrganizationId();

// Membre de l'espace A (en-tête A) qui vise l'espace B en argument
const attackerContext = () =>
  buildContext({ userId: userA, organizationId: orgA });

const seedEmailLog = (workspaceId, recipientUserId, title) =>
  EmailLog.collection.insertOne({
    eventId: new mongoose.Types.ObjectId(),
    workspaceId,
    recipientEmail: "destinataire@exemple.fr",
    recipientUserId,
    reminderType: "due",
    status: "sent",
    sentAt: new Date(),
    scheduledFor: new Date(),
    eventSnapshot: { title, start: new Date(), end: new Date() },
    createdAt: new Date(),
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: userA, organizationId: orgA });
  await seedOrgMembership({ userId: userB, organizationId: orgB });
  await seedOrgMembership({ userId: userB, organizationId: orgC });
  await seedOrgMembership({
    userId: userA,
    organizationId: orgC,
    role: "member",
  });
});

describe("E-invoicing : l'espace passé en argument est contrôlé", () => {
  it("eInvoicingStats ne lit pas l'espace d'un autre (en-tête de son propre espace)", async () => {
    await Invoice.collection.insertOne({
      workspaceId: orgB,
      eInvoiceStatus: "ACCEPTED",
    });

    await expect(
      eInvoicingResolvers.Query.eInvoicingStats(
        null,
        { workspaceId: orgB.toString() },
        attackerContext(),
      ),
    ).rejects.toThrow(/membre/);
  });

  it("eInvoicingSettings, previewInvoiceRouting et resendInvoiceToSuperPdp refusent aussi", async () => {
    const { insertedId: invoiceId } = await Invoice.collection.insertOne({
      workspaceId: orgB,
      status: "PENDING",
    });
    const args = {
      workspaceId: orgB.toString(),
      invoiceId: invoiceId.toString(),
    };

    await expect(
      eInvoicingResolvers.Query.eInvoicingSettings(
        null,
        args,
        attackerContext(),
      ),
    ).rejects.toThrow(/membre/);
    await expect(
      eInvoicingResolvers.Mutation.previewInvoiceRouting(
        null,
        args,
        attackerContext(),
      ),
    ).rejects.toThrow(/membre/);
    await expect(
      eInvoicingResolvers.Mutation.resendInvoiceToSuperPdp(
        null,
        args,
        attackerContext(),
      ),
    ).rejects.toThrow(/membre/);
  });

  it("reste accessible sur son propre espace", async () => {
    await Invoice.collection.insertOne({
      workspaceId: orgA,
      eInvoiceStatus: "ACCEPTED",
    });
    const stats = await eInvoicingResolvers.Query.eInvoicingStats(
      null,
      { workspaceId: orgA.toString() },
      attackerContext(),
    );
    expect(stats.ACCEPTED).toBe(1);
  });
});

describe("getEmailLogs", () => {
  it("refuse l'espace d'un autre", async () => {
    await seedEmailLog(orgB, userB, "Rendez-vous confidentiel");

    let result;
    let error;
    try {
      result = await emailReminderResolvers.Query.getEmailLogs(
        null,
        { workspaceId: orgB.toString() },
        attackerContext(),
      );
    } catch (e) {
      error = e;
    }
    expect(result?.logs || []).toHaveLength(0);
    expect(error?.message).toMatch(/membre/);
  });

  it("ne renvoie que ses propres rappels dans un espace partagé", async () => {
    await seedEmailLog(orgC, userB, "Événement privé de B");
    await seedEmailLog(orgC, userA, "Mon rappel");

    const result = await emailReminderResolvers.Query.getEmailLogs(
      null,
      { workspaceId: orgC.toString() },
      buildContext({ userId: userA, organizationId: orgC }),
    );
    expect(result.logs.map((l) => l.eventSnapshot.title)).toEqual([
      "Mon rappel",
    ]);
    expect(result.totalCount).toBe(1);
  });
});
