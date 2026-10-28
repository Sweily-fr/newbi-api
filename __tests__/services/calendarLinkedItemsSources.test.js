/**
 * Calendrier, deuxième vague de sources : prévisions de trésorerie,
 * relances automatiques, livraisons, fin des transferts, signature des
 * devis, dates exactes des tâches et trésorerie au jour le jour.
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
import mongoose from "mongoose";

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
import Quote from "../../src/models/Quote.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import SignatureRequest from "../../src/models/SignatureRequest.js";
import InvoiceReminderSettings from "../../src/models/InvoiceReminderSettings.js";
import InvoiceReminderLog from "../../src/models/InvoiceReminderLog.js";
import DetectedRecurrence from "../../src/models/DetectedRecurrence.js";
import ManualCashflowEntry from "../../src/models/ManualCashflowEntry.js";
import AccountBanking from "../../src/models/AccountBanking.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import { getCalendarLinkedItems } from "../../src/services/calendar/linkedItemsService.js";
import { getCalendarTreasury } from "../../src/services/calendar/treasuryService.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const orgA = buildOrganizationId();

// Mercredi 28 octobre 2026, 10 h à Paris (après l'heure des relances, 9 h)
const NOW = new Date("2026-10-28T09:00:00Z");
const FROM = "2026-10-01";
const TO = "2026-11-30";

const allowAll = { hasPermission: () => true, canDelete: () => true };

const run = (overrides = {}) =>
  getCalendarLinkedItems({
    workspaceId: orgA.toString(),
    userId: userId.toString(),
    permissions: allowAll,
    db: mongoose.connection.db,
    from: FROM,
    to: TO,
    now: NOW,
    ...overrides,
  });

const byKind = (result, kind) => result.items.filter((i) => i.kind === kind);

const insertInvoice = async (fields) => {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId: orgA,
    prefix: "F-202610",
    number: "0001",
    status: "PENDING",
    finalTotalTTC: 1200,
    client: {
      id: new ObjectId().toString(),
      name: "Atelier Lumière",
      email: "compta@atelier.fr",
      type: "COMPANY",
    },
    ...fields,
  });
  return insertedId;
};

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  // La projection de la page Prévision lit l'horloge (mois en cours)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("prévisions de trésorerie", () => {
  it("récurrence détectée et saisie manuelle, dans le sens du mouvement", async () => {
    await DetectedRecurrence.collection.insertOne({
      workspaceId: orgA,
      source: "TRANSACTION",
      type: "EXPENSE",
      partyKey: "loyer bureau",
      partyName: "Loyer bureau",
      averageAmount: 1100,
      frequency: "MONTHLY",
      intervalDays: 30,
      lastSeenDate: new Date("2026-10-05T10:00:00Z"),
      lastSeenMonth: "2026-10",
      isActive: true,
      isMuted: false,
    });
    await ManualCashflowEntry.collection.insertOne({
      workspaceId: orgA,
      name: "Subvention région",
      type: "INCOME",
      amount: 2000,
      startDate: new Date("2026-11-20T10:00:00Z"),
      frequency: "ONCE",
    });

    const forecasts = byKind(await run(), "FORECAST");

    expect(
      forecasts.map((f) => [f.day, f.title, f.flowType, f.forecastOrigin]),
    ).toEqual([
      ["2026-11-05", "Loyer bureau", "EXPENSE", "DETECTED"],
      ["2026-11-20", "Subvention région", "INCOME", "MANUAL"],
    ]);
    expect(forecasts[0]).toMatchObject({ amount: 1100, state: "UPCOMING" });
  });

  it("réservées à qui voit la page Prévision", async () => {
    await ManualCashflowEntry.collection.insertOne({
      workspaceId: orgA,
      name: "Subvention région",
      type: "INCOME",
      amount: 2000,
      startDate: new Date("2026-11-20T10:00:00Z"),
      frequency: "ONCE",
    });
    const noForecast = {
      hasPermission: (module) => module !== "forecast",
      canDelete: () => true,
    };

    const result = await run({ permissions: noForecast });

    expect(result.kinds).not.toContain("FORECAST");
    expect(byKind(result, "FORECAST")).toEqual([]);
  });
});

describe("relances automatiques", () => {
  const enable = (fields = {}) =>
    InvoiceReminderSettings.collection.insertOne({
      workspaceId: orgA,
      enabled: true,
      firstReminderDays: 7,
      secondReminderDays: 14,
      reminderHour: 9,
      excludedClientIds: [],
      ...fields,
    });

  it("relances envoyées, en échec et à venir, comme le cron", async () => {
    const excludedClient = new ObjectId();
    await enable({ excludedClientIds: [excludedClient] });
    // Échue le 25/10 : 1re le 01/11, 2e le 08/11
    await insertInvoice({ dueDate: new Date("2026-10-25T00:00:00Z") });
    // Échue le 10/10, 1re partie le 17/10 : la 2e (due le 24) part au
    // prochain passage, demain (10 h passées, relances à 9 h)
    const late = await insertInvoice({
      number: "0002",
      status: "OVERDUE",
      dueDate: new Date("2026-10-10T00:00:00Z"),
    });
    await InvoiceReminderLog.collection.insertOne({
      invoiceId: late,
      workspaceId: orgA,
      reminderType: "FIRST",
      sentAt: new Date("2026-10-17T07:00:00Z"),
      recipientEmail: "compta@atelier.fr",
      emailSubject: "Rappel",
      emailBody: "Bonjour",
      status: "SENT",
    });
    // Client exclu des relances
    await insertInvoice({
      number: "0003",
      dueDate: new Date("2026-10-25T00:00:00Z"),
      client: {
        id: excludedClient.toString(),
        name: "Exclu",
        email: "x@x.fr",
        type: "COMPANY",
      },
    });
    // Sans adresse e-mail : relance prévue mais signalée
    await insertInvoice({
      number: "0004",
      dueDate: new Date("2026-11-02T00:00:00Z"),
      client: { name: "Sans e-mail", type: "COMPANY" },
    });
    // Payée depuis, relance en échec dans le journal
    const paid = await insertInvoice({
      number: "0005",
      status: "COMPLETED",
      dueDate: new Date("2026-10-05T00:00:00Z"),
    });
    await InvoiceReminderLog.collection.insertOne({
      invoiceId: paid,
      workspaceId: orgA,
      reminderType: "FIRST",
      sentAt: new Date("2026-10-12T07:00:00Z"),
      recipientEmail: "compta@atelier.fr",
      emailSubject: "Rappel",
      emailBody: "Bonjour",
      status: "FAILED",
    });

    const reminders = byKind(await run(), "REMINDER");

    expect(
      reminders.map((r) => [
        r.reference,
        r.day,
        r.reminderStep,
        r.reminderStatus,
        r.state,
      ]),
    ).toEqual([
      ["F-202610-0005", "2026-10-12", 1, "FAILED", "OVERDUE"],
      ["F-202610-0002", "2026-10-17", 1, "SENT", "DONE"],
      ["F-202610-0002", "2026-10-29", 2, "PLANNED", "UPCOMING"],
      ["F-202610-0001", "2026-11-01", 1, "PLANNED", "UPCOMING"],
      ["F-202610-0001", "2026-11-08", 2, "PLANNED", "UPCOMING"],
      ["F-202610-0004", "2026-11-09", 1, "NO_EMAIL", "UPCOMING"],
      ["F-202610-0004", "2026-11-16", 2, "NO_EMAIL", "UPCOMING"],
    ]);
  });

  it("deux relances dues ensemble partent deux jours de suite", async () => {
    await enable();
    // Échue le 01/10 : 1re et 2e dues, rien d'envoyé → demain puis après
    await insertInvoice({ dueDate: new Date("2026-10-01T00:00:00Z") });

    const reminders = byKind(await run(), "REMINDER");

    expect(reminders.map((r) => [r.day, r.reminderStep])).toEqual([
      ["2026-10-29", 1],
      ["2026-10-30", 2],
    ]);
  });

  it("relances coupées : seulement le journal", async () => {
    await enable({ enabled: false });
    await insertInvoice({ dueDate: new Date("2026-10-25T00:00:00Z") });

    expect(byKind(await run(), "REMINDER")).toEqual([]);
  });
});

describe("livraisons", () => {
  const seed = async () => {
    await PurchaseOrder.collection.insertOne({
      workspaceId: orgA,
      prefix: "BC-202610",
      number: "0001",
      status: "CONFIRMED",
      finalTotalTTC: 4200,
      client: { name: "Studio Sud", type: "COMPANY" },
      deliveryDate: new Date("2026-11-03T00:00:00Z"),
    });
    await DeliveryNote.collection.insertMany([
      {
        workspaceId: orgA,
        prefix: "BL-202610",
        number: "0001",
        status: "DELIVERED",
        client: { name: "Studio Nord", type: "COMPANY" },
        deliveryDate: new Date("2026-10-15T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        prefix: "BL-202610",
        number: "0002",
        status: "DRAFT",
        client: { name: "Brouillon", type: "COMPANY" },
        deliveryDate: new Date("2026-10-16T00:00:00Z"),
      },
    ]);
  };

  it("bons de commande et de livraison, brouillons exclus", async () => {
    await seed();

    const deliveries = byKind(await run(), "DELIVERY");

    expect(
      deliveries.map((d) => [d.reference, d.documentKind, d.state, d.amount]),
    ).toEqual([
      ["BL-202610-0001", "DELIVERY_NOTE", "DONE", null],
      ["BC-202610-0001", "PURCHASE_ORDER", "UPCOMING", 4200],
    ]);
  });

  it("chaque type suit le droit de sa page", async () => {
    await seed();
    const noDeliveryNotes = {
      hasPermission: (module) => module !== "deliveryNotes",
      canDelete: () => true,
    };

    const deliveries = byKind(
      await run({ permissions: noDeliveryNotes }),
      "DELIVERY",
    );

    expect(deliveries.map((d) => d.documentKind)).toEqual(["PURCHASE_ORDER"]);
  });
});

describe("transferts de fichiers", () => {
  it("fin des liens de l'utilisateur, expirés atténués", async () => {
    await FileTransfer.collection.insertMany([
      {
        userId,
        workspaceId: orgA.toString(),
        title: "Maquettes V2",
        shareLink: "lien-1",
        downloadLink: "telechargement-1",
        accessKey: "cle-1",
        status: "active",
        downloadCount: 3,
        recipientEmail: "client@studio.fr",
        expiryDate: new Date("2026-11-04T10:00:00Z"),
      },
      {
        userId,
        title: "Ancien transfert",
        shareLink: "lien-2",
        downloadLink: "telechargement-2",
        accessKey: "cle-2",
        status: "expired",
        downloadCount: 0,
        expiryDate: new Date("2026-10-10T10:00:00Z"),
      },
      {
        userId: new ObjectId(),
        workspaceId: orgA.toString(),
        title: "Transfert d'un collègue",
        shareLink: "lien-3",
        downloadLink: "telechargement-3",
        accessKey: "cle-3",
        status: "active",
        expiryDate: new Date("2026-11-05T10:00:00Z"),
      },
    ]);

    const transfers = byKind(await run(), "FILE_TRANSFER");

    expect(transfers.map((t) => [t.title, t.state, t.downloadCount])).toEqual([
      ["Ancien transfert", "DONE", 0],
      ["Maquettes V2", "UPCOMING", 3],
    ]);
    expect(transfers[1].counterparty).toBe("client@studio.fr");
  });
});

describe("devis et tâches", () => {
  it("signature électronique en attente sur le devis", async () => {
    const { insertedId: quoteId } = await Quote.collection.insertOne({
      workspaceId: orgA,
      prefix: "D-202610",
      number: "0002",
      status: "PENDING",
      finalTotalTTC: 4200,
      client: { name: "Studio Sud", type: "COMPANY" },
      validUntil: new Date("2026-11-12T00:00:00Z"),
    });
    await SignatureRequest.collection.insertOne({
      organizationId: orgA.toString(),
      workspaceId: orgA,
      documentType: "quote",
      documentId: quoteId,
      status: "WAIT_SIGN",
      createdAt: new Date("2026-10-26T08:00:00Z"),
    });

    const [quote] = byKind(await run(), "QUOTE");

    expect(quote.signatureStatus).toBe("PENDING");
    expect(quote.signatureSentAt).toEqual(new Date("2026-10-26T08:00:00Z"));
  });

  it("la tâche porte ses dates exactes", async () => {
    const { insertedId: boardId } = await Board.collection.insertOne({
      workspaceId: orgA,
      userId,
      title: "Site",
      members: [],
    });
    const { insertedId: columnId } = await Column.collection.insertOne({
      workspaceId: orgA,
      boardId,
      title: "En cours",
      color: "#f59e0b",
    });
    await Task.collection.insertOne({
      workspaceId: orgA,
      boardId,
      columnId: columnId.toString(),
      title: "Livraison",
      status: "todo",
      startDate: new Date("2026-11-02T08:00:00Z"),
      dueDate: new Date("2026-11-04T17:00:00Z"),
    });

    const [task] = byKind(await run(), "TASK");

    expect(task.startDate).toBe("2026-11-02T08:00:00.000Z");
    expect(task.dueDate).toBe("2026-11-04T17:00:00.000Z");
  });
});

describe("trésorerie au jour le jour", () => {
  const treasury = (overrides = {}) =>
    getCalendarTreasury({
      workspaceId: orgA.toString(),
      userId: userId.toString(),
      permissions: allowAll,
      db: mongoose.connection.db,
      from: FROM,
      to: "2026-11-05",
      now: NOW,
      ...overrides,
    });

  it("solde actuel puis échéances et prévisions jour par jour", async () => {
    await AccountBanking.collection.insertMany([
      // provider + externalId : index unique du modèle
      {
        workspaceId: orgA.toString(),
        provider: "bridge",
        externalId: "compte-1",
        status: "active",
        balance: 5000,
      },
      {
        workspaceId: orgA.toString(),
        provider: "bridge",
        externalId: "compte-2",
        status: "active",
        balance: { current: 1000 },
      },
      {
        workspaceId: orgA.toString(),
        provider: "bridge",
        externalId: "compte-3",
        status: "inactive",
        balance: 99999,
      },
    ]);
    // À encaisser le 30, en retard depuis le 10 (hors projection)
    await insertInvoice({ dueDate: new Date("2026-10-30T00:00:00Z") });
    await insertInvoice({
      number: "0002",
      status: "OVERDUE",
      finalTotalTTC: 800,
      dueDate: new Date("2026-10-10T00:00:00Z"),
    });
    // À payer le 29 ; en dollars : hors calcul
    await PurchaseInvoice.collection.insertMany([
      {
        workspaceId: orgA,
        supplierName: "OVH",
        status: "TO_PAY",
        amountTTC: 300,
        currency: "EUR",
        dueDate: new Date("2026-10-29T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        supplierName: "Figma",
        status: "TO_PAY",
        amountTTC: 45,
        currency: "USD",
        dueDate: new Date("2026-10-29T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        supplierName: "Adobe",
        status: "OVERDUE",
        amountTTC: 72,
        currency: "EUR",
        dueDate: new Date("2026-10-20T00:00:00Z"),
      },
    ]);
    // Prévision : charge sociale le 2 novembre
    await ManualCashflowEntry.collection.insertOne({
      workspaceId: orgA,
      name: "URSSAF",
      type: "EXPENSE",
      amount: 1500,
      startDate: new Date("2026-11-02T10:00:00Z"),
      frequency: "ONCE",
    });

    const result = await treasury();

    expect(result.today).toBe("2026-10-28");
    expect(result.currentBalance).toBe(6000);
    expect(result.hasBankAccounts).toBe(true);
    expect(result.days.map((d) => [d.day, d.balance])).toEqual([
      ["2026-10-28", 6000],
      ["2026-10-29", 5700],
      ["2026-10-30", 6900],
      ["2026-10-31", 6900],
      ["2026-11-01", 6900],
      ["2026-11-02", 5400],
      ["2026-11-03", 5400],
      ["2026-11-04", 5400],
      ["2026-11-05", 5400],
    ]);
    expect(result.lowest).toMatchObject({ day: "2026-11-02", balance: 5400 });
    expect(result.overdueIncome).toBe(800);
    expect(result.overdueExpense).toBe(72);
    expect(result.sources).toEqual(["INVOICE", "PURCHASE_INVOICE", "FORECAST"]);
  });

  it("réservée à qui voit Prévision ou Analytiques", async () => {
    const noForecast = {
      hasPermission: (module) => !["forecast", "analytics"].includes(module),
      canDelete: () => true,
    };

    expect(await treasury({ permissions: noForecast })).toBeNull();
  });

  it("période passée : seulement le solde actuel", async () => {
    const result = await treasury({ from: "2026-09-01", to: "2026-09-30" });

    expect(result.days).toEqual([]);
    expect(result.lowest).toBeNull();
    expect(result.hasBankAccounts).toBe(false);
  });
});
