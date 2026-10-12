/**
 * Analytiques : le détail par client ne relit que les clients de l'espace.
 *
 * financialAnalytics complétait « Détail par client » avec des fiches Client
 * lues par leur seul id : celui d'un tableau kanban (Board.clientId, non
 * vérifié à l'écriture) ou d'une facture importée (client.id). Un tableau ou
 * une importée de A pointant vers un client de B affichait son nom et son type.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import "../../src/models/Invoice.js";
import "../../src/models/ImportedInvoice.js";
import "../../src/models/PurchaseInvoice.js";
import "../../src/models/CreditNote.js";
import "../../src/models/Quote.js";
import "../../src/models/Transaction.js";
import Client from "../../src/models/Client.js";
import { Board, Task } from "../../src/models/kanban.js";
import financialAnalyticsResolvers from "../../src/resolvers/financialAnalytics.js";

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

const START = "2026-01-01T00:00:00.000Z";
const END = "2026-12-31T23:59:59.999Z";

async function insertClient(workspaceId, name) {
  const { insertedId } = await Client.collection.insertOne({
    workspaceId,
    type: "COMPANY",
    name,
    email: `${name.replace(/\s+/g, "").toLowerCase()}@test.fr`,
    createdBy: userId,
  });
  return insertedId;
}

async function insertTrackedBoard(workspaceId, clientId) {
  const { insertedId: boardId } = await Board.collection.insertOne({
    workspaceId,
    title: "Tableau",
    userId: userId.toString(),
    clientId,
    createdAt: new Date("2026-03-01"),
    updatedAt: new Date("2026-03-01"),
  });
  await Task.collection.insertOne({
    workspaceId,
    boardId,
    title: "Tâche",
    userId: userId.toString(),
    timeTracking: { totalSeconds: 7200, isRunning: false, hourlyRate: 50 },
    createdAt: new Date("2026-03-01"),
    updatedAt: new Date("2026-03-02"),
  });
}

async function insertLinkedImported(workspaceId, clientId, ocrName) {
  await mongoose.model("ImportedInvoice").collection.insertOne({
    workspaceId,
    importedBy: userId,
    status: "VALIDATED",
    invoiceDate: new Date("2026-03-10"),
    totalHT: 100,
    totalTTC: 120,
    totalVAT: 20,
    client: { id: String(clientId), name: ocrName },
    vendor: { name: "Ma Societe" },
    file: { url: "https://r2/x.pdf", cloudflareKey: "k-1" },
    createdAt: new Date("2026-03-10"),
    updatedAt: new Date("2026-03-10"),
  });
}

const runAnalytics = () =>
  financialAnalyticsResolvers.Query.financialAnalytics(
    null,
    { startDate: START, endDate: END },
    buildContext({ userId, organizationId: orgA }),
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
});

describe("financialAnalytics : clients d'un autre espace", () => {
  it("n'affiche pas le client d'un autre espace lié à un tableau kanban", async () => {
    const clientB = await insertClient(orgB, "Secret B");
    await insertTrackedBoard(orgA, clientB);

    const result = await runAnalytics();
    const names = result.revenueByClient.map((c) => c.clientName);
    expect(names).not.toContain("Secret B");
    expect(
      result.revenueByClient.find((c) => c.clientId === String(clientB)),
    ).toBeUndefined();
  });

  it("garde le nom OCR d'une importée liée à un client d'un autre espace", async () => {
    const clientB = await insertClient(orgB, "Secret B");
    await insertLinkedImported(orgA, clientB, "Nom OCR");

    const result = await runAnalytics();
    const names = result.revenueByClient.map((c) => c.clientName);
    expect(names).not.toContain("Secret B");
    expect(names).toContain("Nom OCR");
  });

  it("enrichit toujours avec les clients de l'espace", async () => {
    const clientA = await insertClient(orgA, "Client A");
    const clientA2 = await insertClient(orgA, "Client A2");
    await insertTrackedBoard(orgA, clientA);
    await insertLinkedImported(orgA, clientA2, "nom ocr a2");

    const result = await runAnalytics();
    const byId = new Map(result.revenueByClient.map((c) => [c.clientId, c]));
    expect(byId.get(String(clientA))?.clientName).toBe("Client A");
    expect(byId.get(String(clientA))?.totalHours).toBe(2);
    expect(byId.get(String(clientA2))?.clientName).toBe("Client A2");
    expect(byId.get(String(clientA2))?.clientType).toBe("COMPANY");
  });
});
