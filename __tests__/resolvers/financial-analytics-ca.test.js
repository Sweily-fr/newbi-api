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
import "../../src/models/Client.js";
import financialAnalyticsResolvers from "../../src/resolvers/financialAnalytics.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const organizationId = buildOrganizationId();

const START = "2026-01-01T00:00:00.000Z";
const END = "2026-07-31T23:59:59.999Z";

const Invoice = () => mongoose.model("Invoice");
const ImportedInvoice = () => mongoose.model("ImportedInvoice");

/** Insertion brute : on court-circuite la validation mongoose, l'analytics ne
 * lit que via des pipelines d'agrégation. */
function invoiceDoc({ number, status, issueDate, paymentDate, ht, ttc }) {
  return {
    _id: new ObjectId(),
    workspaceId: organizationId,
    prefix: "F-2026",
    number,
    status,
    issueDate: new Date(issueDate),
    dueDate: new Date(issueDate),
    paymentDate: paymentDate ? new Date(paymentDate) : null,
    client: { id: "client-1", name: "Client Test", type: "COMPANY" },
    items: [],
    finalTotalHT: ht,
    finalTotalTTC: ttc,
    finalTotalVAT: ttc - ht,
    createdBy: userId,
    createdAt: new Date(issueDate),
    updatedAt: new Date(issueDate),
  };
}

function importedDoc({ status, invoiceDate, paymentDate, ht, ttc, key }) {
  return {
    _id: new ObjectId(),
    workspaceId: organizationId,
    importedBy: userId,
    status,
    invoiceDate: new Date(invoiceDate),
    paymentDate: paymentDate ? new Date(paymentDate) : null,
    totalHT: ht,
    totalTTC: ttc,
    totalVAT: ttc - ht,
    client: { name: "Client Test" },
    vendor: { name: "Ma Societe" },
    file: { url: "https://r2/x.pdf", cloudflareKey: key },
    createdAt: new Date(invoiceDate),
    updatedAt: new Date(invoiceDate),
  };
}

async function runAnalytics() {
  return financialAnalyticsResolvers.Query.financialAnalytics(
    null,
    {
      workspaceId: organizationId.toString(),
      startDate: START,
      endDate: END,
    },
    buildContext({ userId, organizationId }),
  );
}

const monthOf = (result, month) =>
  result.monthlyRevenue.find((m) => m.month === month) || null;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache?.(organizationId.toString());
  await seedOrgMembership({ userId, organizationId });
});

describe("financialAnalytics — CA mensuel (graphique CA / Dépenses / Marge brute)", () => {
  it("compte les factures Newbi payées avec ET sans date de paiement", async () => {
    await Invoice().collection.insertMany([
      // Payée + rapprochée (paymentDate posée par le rapprochement bancaire)
      invoiceDoc({
        number: "000001",
        status: "COMPLETED",
        issueDate: "2026-03-01T10:00:00Z",
        paymentDate: "2026-03-15T10:00:00Z",
        ht: 2000,
        ttc: 2400,
      }),
      // Payée SANS rapprochement : changeInvoiceStatus PENDING -> COMPLETED
      // ne pose aucune paymentDate
      invoiceDoc({
        number: "000002",
        status: "COMPLETED",
        issueDate: "2026-03-05T10:00:00Z",
        paymentDate: null,
        ht: 3000,
        ttc: 3600,
      }),
      // Non payée : ne doit pas entrer dans le CA
      invoiceDoc({
        number: "000003",
        status: "PENDING",
        issueDate: "2026-03-08T10:00:00Z",
        paymentDate: null,
        ht: 500,
        ttc: 600,
      }),
      invoiceDoc({
        number: "000004",
        status: "COMPLETED",
        issueDate: "2026-06-01T10:00:00Z",
        paymentDate: "2026-06-20T10:00:00Z",
        ht: 4000,
        ttc: 4800,
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-03")?.netRevenueHT).toBe(5000);
    expect(monthOf(result, "2026-06")?.netRevenueHT).toBe(4000);
  });

  it("rattache au mois d'émission une facture payée sans date de paiement", async () => {
    // Facture émise en janvier, marquée payée en mars sans paymentDate
    await Invoice().collection.insertMany([
      invoiceDoc({
        number: "000010",
        status: "COMPLETED",
        issueDate: "2026-01-10T10:00:00Z",
        paymentDate: null,
        ht: 1000,
        ttc: 1200,
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-01")?.netRevenueHT).toBe(1000);
  });

  it("compte les factures de vente importées VALIDATED", async () => {
    await ImportedInvoice().collection.insertMany([
      importedDoc({
        status: "VALIDATED",
        invoiceDate: "2026-02-10T10:00:00Z",
        paymentDate: null,
        ht: 1500,
        ttc: 1800,
        key: "ws/imp-validated.pdf",
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-02")?.netRevenueHT).toBe(1500);
  });

  it("compte les factures de vente importées en attente de vérification (PENDING_REVIEW)", async () => {
    await ImportedInvoice().collection.insertMany([
      importedDoc({
        status: "PENDING_REVIEW",
        invoiceDate: "2026-02-15T10:00:00Z",
        paymentDate: null,
        ht: 2500,
        ttc: 3000,
        key: "ws/imp-pending-fev.pdf",
      }),
      importedDoc({
        status: "PENDING_REVIEW",
        invoiceDate: "2026-04-10T10:00:00Z",
        paymentDate: "2026-04-12T10:00:00Z",
        ht: 800,
        ttc: 960,
        key: "ws/imp-pending-avr.pdf",
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-02")?.netRevenueHT).toBe(2500);
    expect(monthOf(result, "2026-04")?.netRevenueHT).toBe(800);
  });

  it("scénario complet du ticket : mars/avril et mois antérieurs", async () => {
    await Invoice().collection.insertMany([
      invoiceDoc({
        number: "000021",
        status: "COMPLETED",
        issueDate: "2026-03-01T10:00:00Z",
        paymentDate: "2026-03-15T10:00:00Z",
        ht: 2000,
        ttc: 2400,
      }),
      invoiceDoc({
        number: "000022",
        status: "COMPLETED",
        issueDate: "2026-03-05T10:00:00Z",
        paymentDate: null,
        ht: 3000,
        ttc: 3600,
      }),
      invoiceDoc({
        number: "000023",
        status: "COMPLETED",
        issueDate: "2026-06-02T10:00:00Z",
        paymentDate: "2026-06-10T10:00:00Z",
        ht: 4000,
        ttc: 4800,
      }),
    ]);
    await ImportedInvoice().collection.insertMany([
      importedDoc({
        status: "PENDING_REVIEW",
        invoiceDate: "2026-01-20T10:00:00Z",
        paymentDate: null,
        ht: 1200,
        ttc: 1440,
        key: "ws/hist-jan.pdf",
      }),
      importedDoc({
        status: "PENDING_REVIEW",
        invoiceDate: "2026-04-05T10:00:00Z",
        paymentDate: null,
        ht: 900,
        ttc: 1080,
        key: "ws/hist-avr.pdf",
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-01")?.netRevenueHT).toBe(1200);
    expect(monthOf(result, "2026-03")?.netRevenueHT).toBe(5000);
    expect(monthOf(result, "2026-04")?.netRevenueHT).toBe(900);
    expect(monthOf(result, "2026-06")?.netRevenueHT).toBe(4000);

    // Le KPI « CA net » doit coller à la somme des mois du graphique
    const sumOfMonths = result.monthlyRevenue.reduce(
      (acc, m) => acc + m.netRevenueHT,
      0,
    );
    expect(result.kpi.netRevenueHT).toBe(11100);
    expect(Math.round(sumOfMonths * 100) / 100).toBe(result.kpi.netRevenueHT);

    // ... et les graphiques clients doivent voir les mêmes factures
    // (2400 + 3600 + 4800 en Newbi, 1440 + 1080 en importées)
    const clientTotalTTC = result.topClients.reduce(
      (acc, c) => acc + (c.totalTTC ?? 0),
      0,
    );
    expect(clientTotalTTC).toBe(13320);
  });

  it("exclut les factures importées converties en factures d'achat", async () => {
    await ImportedInvoice().collection.insertMany([
      importedDoc({
        status: "PENDING_REVIEW",
        invoiceDate: "2026-05-05T10:00:00Z",
        paymentDate: null,
        ht: 700,
        ttc: 840,
        key: "ws/converted-en-achat.pdf",
      }),
    ]);
    // La conversion recopie la clé Cloudflare dans PurchaseInvoice.files.filename
    await mongoose.model("PurchaseInvoice").collection.insertOne({
      _id: new ObjectId(),
      workspaceId: organizationId,
      source: "OCR",
      status: "TO_PROCESS",
      files: [{ filename: "ws/converted-en-achat.pdf" }],
      createdAt: new Date("2026-05-05T10:00:00Z"),
    });

    const result = await runAnalytics();

    expect(monthOf(result, "2026-05")?.netRevenueHT ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Côté DÉPENSES : factures d'achat + transactions bancaires sortantes
// ---------------------------------------------------------------------------

function purchaseDoc({ status, issueDate, paymentDate, ht, tva, linkedTx }) {
  return {
    _id: new ObjectId(),
    workspaceId: organizationId,
    status,
    issueDate: new Date(issueDate),
    paymentDate: paymentDate ? new Date(paymentDate) : null,
    amountHT: ht,
    amountTVA: tva,
    amountTTC: ht + tva,
    category: "OTHER",
    linkedTransactionIds: linkedTx ? [linkedTx] : [],
    createdAt: new Date(issueDate),
    updatedAt: new Date(issueDate),
  };
}

function txDoc({ _id, date, amount }) {
  return {
    _id: _id || new ObjectId(),
    workspaceId: organizationId.toString(), // String sur Transaction
    amount, // négatif = sortie
    status: "completed",
    date: new Date(date),
    deletedAt: null,
    createdAt: new Date(date),
    updatedAt: new Date(date),
  };
}

const PurchaseInvoice = () => mongoose.model("PurchaseInvoice");
const Transaction = () => mongoose.model("Transaction");

describe("financialAnalytics — Dépenses (factures d'achat + transactions)", () => {
  it("compte les factures d'achat PAYÉES, avec ou sans date de paiement", async () => {
    await PurchaseInvoice().collection.insertMany([
      purchaseDoc({
        status: "PAID",
        issueDate: "2026-03-02T10:00:00Z",
        paymentDate: "2026-03-20T10:00:00Z",
        ht: 1000,
        tva: 200,
      }),
      purchaseDoc({
        status: "PAID",
        issueDate: "2026-03-04T10:00:00Z",
        paymentDate: null,
        ht: 500,
        tva: 100,
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-03")?.expenseAmountHT).toBe(1500);
  });

  it("ignore les factures d'achat non marquées payées", async () => {
    await PurchaseInvoice().collection.insertMany([
      purchaseDoc({
        status: "TO_PAY",
        issueDate: "2026-03-02T10:00:00Z",
        paymentDate: null,
        ht: 1000,
        tva: 200,
      }),
      purchaseDoc({
        status: "PENDING",
        issueDate: "2026-03-03T10:00:00Z",
        paymentDate: null,
        ht: 300,
        tva: 60,
      }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-03")?.expenseAmountHT ?? 0).toBe(0);
  });

  it("compte une sortie bancaire sans justificatif", async () => {
    await Transaction().collection.insertMany([
      txDoc({ date: "2026-04-10T10:00:00Z", amount: -250 }),
    ]);

    const result = await runAnalytics();

    expect(monthOf(result, "2026-04")?.expenseAmountHT).toBe(250);
  });

  it("ne compte pas deux fois une transaction rapprochée à une facture d'achat payée", async () => {
    const txId = new ObjectId();
    await Transaction().collection.insertMany([
      txDoc({ _id: txId, date: "2026-05-10T10:00:00Z", amount: -1200 }),
    ]);
    await PurchaseInvoice().collection.insertMany([
      purchaseDoc({
        status: "PAID",
        issueDate: "2026-05-02T10:00:00Z",
        paymentDate: "2026-05-10T10:00:00Z",
        ht: 1000,
        tva: 200,
        linkedTx: txId,
      }),
    ]);

    const result = await runAnalytics();

    // 1000 HT via la facture d'achat, la transaction rapprochée est exclue
    expect(monthOf(result, "2026-05")?.expenseAmountHT).toBe(1000);
  });

  it("perd la dépense quand la transaction est liée à une facture d'achat non payée", async () => {
    const txId = new ObjectId();
    await Transaction().collection.insertMany([
      txDoc({ _id: txId, date: "2026-06-10T10:00:00Z", amount: -800 }),
    ]);
    await PurchaseInvoice().collection.insertMany([
      purchaseDoc({
        status: "TO_PAY",
        issueDate: "2026-06-02T10:00:00Z",
        paymentDate: null,
        ht: 666.67,
        tva: 133.33,
        linkedTx: txId,
      }),
    ]);

    const result = await runAnalytics();

    // Trou constaté : la transaction est exclue (rapprochée) et la facture
    // d'achat aussi (non PAID) → 800 € de sortie n'apparaissent nulle part.
    expect(monthOf(result, "2026-06")?.expenseAmountHT ?? 0).toBe(0);
  });
});
