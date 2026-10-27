/**
 * Calendrier : échéances des autres pages (factures de vente et d'achat,
 * devis en attente, tâches, factures récurrentes) relues dans les documents
 * à chaque affichage, filtrées par les droits du rôle.
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
import { buildASTSchema, defaultFieldResolver, graphql } from "graphql";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {}, asyncIterator: () => ({}) }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import Invoice from "../../src/models/Invoice.js";
import Quote from "../../src/models/Quote.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import InvoiceRecurrence from "../../src/models/InvoiceRecurrence.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import {
  getCalendarLinkedItems,
  isDoneColumnTitle,
  validateRange,
} from "../../src/services/calendar/linkedItemsService.js";
import calendarLinkedItemsResolvers from "../../src/resolvers/calendarLinkedItems.js";
import typeDefs from "../../src/schemas/index.js";

const { ObjectId } = mongoose.Types;

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();

// Mercredi 28 octobre 2026, 10 h à Paris
const NOW = new Date("2026-10-28T09:00:00Z");
const FROM = "2026-10-01";
const TO = "2026-11-30";

const allowAll = {
  hasPermission: () => true,
  canDelete: () => true,
};

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

async function insertInvoice(fields) {
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId: orgA,
    prefix: "F-202610",
    number: "0001",
    status: "PENDING",
    finalTotalTTC: 1200,
    client: { name: "Atelier Lumière", type: "COMPANY" },
    ...fields,
  });
  return insertedId;
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
});

describe("factures de vente", () => {
  it("place l'échéance au jour de Paris et calcule l'état", async () => {
    // 23 h 30 UTC le 14 = 15 novembre à Paris
    await insertInvoice({ dueDate: new Date("2026-11-14T23:30:00Z") });
    await insertInvoice({
      number: "0002",
      dueDate: new Date("2026-10-20T00:00:00Z"),
    });
    await insertInvoice({
      number: "0003",
      status: "COMPLETED",
      dueDate: new Date("2026-10-10T00:00:00Z"),
    });

    const invoices = byKind(await run(), "INVOICE");

    expect(invoices.map((i) => [i.reference, i.day, i.state])).toEqual([
      ["F-202610-0003", "2026-10-10", "DONE"],
      ["F-202610-0002", "2026-10-20", "OVERDUE"],
      ["F-202610-0001", "2026-11-15", "UPCOMING"],
    ]);
    expect(invoices[2]).toMatchObject({
      title: "Atelier Lumière",
      counterparty: "Atelier Lumière",
      amount: 1200,
      currency: "EUR",
    });
  });

  it("ignore les brouillons, les annulées, les autres espaces et la période", async () => {
    await insertInvoice({
      status: "DRAFT",
      dueDate: new Date("2026-11-02T10:00:00Z"),
    });
    await insertInvoice({
      status: "CANCELED",
      dueDate: new Date("2026-11-02T10:00:00Z"),
    });
    await insertInvoice({
      workspaceId: orgB,
      dueDate: new Date("2026-11-02T10:00:00Z"),
    });
    await insertInvoice({ dueDate: new Date("2026-12-01T10:00:00Z") });

    expect(byKind(await run(), "INVOICE")).toEqual([]);
  });

  it("une échéance du jour n'est pas en retard", async () => {
    await insertInvoice({ dueDate: new Date("2026-10-28T08:00:00Z") });

    const [invoice] = byKind(await run(), "INVOICE");

    expect(invoice.state).toBe("UPCOMING");
  });

  it("nomme un client particulier par son prénom et son nom", async () => {
    await insertInvoice({
      client: { type: "INDIVIDUAL", firstName: "Léa", lastName: "Martin" },
      dueDate: new Date("2026-11-02T10:00:00Z"),
    });

    const [invoice] = byKind(await run(), "INVOICE");

    expect(invoice.title).toBe("Léa Martin");
  });
});

describe("factures d'achat", () => {
  it("échéances à payer, payées en terminé, archivées masquées", async () => {
    await PurchaseInvoice.collection.insertMany([
      {
        workspaceId: orgA,
        supplierName: "OVH",
        invoiceNumber: "FR-77",
        status: "TO_PAY",
        amountTTC: 59.99,
        currency: "EUR",
        dueDate: new Date("2026-11-05T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        supplierName: "Figma",
        status: "PAID",
        amountTTC: 45,
        currency: "USD",
        dueDate: new Date("2026-10-12T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        supplierName: "Archivé",
        status: "ARCHIVED",
        amountTTC: 10,
        dueDate: new Date("2026-11-05T00:00:00Z"),
      },
    ]);

    const purchases = byKind(await run(), "PURCHASE_INVOICE");

    expect(purchases.map((p) => [p.title, p.state, p.currency])).toEqual([
      ["Figma", "DONE", "USD"],
      ["OVH", "UPCOMING", "EUR"],
    ]);
    expect(purchases[1]).toMatchObject({ reference: "FR-77", amount: 59.99 });
  });
});

describe("devis", () => {
  it("seuls les devis en attente apparaissent, à leur fin de validité", async () => {
    await Quote.collection.insertMany([
      {
        workspaceId: orgA,
        prefix: "D-202610",
        number: "0004",
        status: "PENDING",
        finalTotalTTC: 3400,
        client: { name: "Studio Nord", type: "COMPANY" },
        validUntil: new Date("2026-11-12T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        prefix: "D-202610",
        number: "0005",
        status: "PENDING",
        finalTotalTTC: 800,
        client: { name: "Studio Sud", type: "COMPANY" },
        validUntil: new Date("2026-10-15T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        prefix: "D-202610",
        number: "0006",
        status: "COMPLETED",
        finalTotalTTC: 900,
        client: { name: "Signé", type: "COMPANY" },
        validUntil: new Date("2026-11-12T00:00:00Z"),
      },
    ]);

    const quotes = byKind(await run(), "QUOTE");

    expect(quotes.map((q) => [q.reference, q.state])).toEqual([
      ["D-202610-0005", "OVERDUE"],
      ["D-202610-0004", "UPCOMING"],
    ]);
  });
});

describe("tâches des projets", () => {
  async function seedBoard({ members = [], owner = new ObjectId() } = {}) {
    const { insertedId: boardId } = await Board.collection.insertOne({
      workspaceId: orgA,
      userId: owner,
      title: members.length ? "Privé" : "Site vitrine",
      emoji: "🚀",
      color: "#3b82f6",
      members,
    });
    const { insertedIds } = await Column.collection.insertMany([
      { workspaceId: orgA, boardId, title: "En cours", color: "#f59e0b" },
      { workspaceId: orgA, boardId, title: "Terminées", color: "#10b981" },
    ]);
    return { boardId, doingId: insertedIds[0], doneId: insertedIds[1] };
  }

  it("échéances, colonne terminée et membres assignés", async () => {
    const { boardId, doingId, doneId } = await seedBoard();
    await mongoose.connection.db.collection("user").insertOne({
      _id: userId,
      name: "Sofia",
      lastName: "Ruiz",
      email: "sofia@test.fr",
    });
    await Task.collection.insertMany([
      {
        workspaceId: orgA,
        boardId,
        columnId: doingId.toString(),
        title: "Maquettes",
        status: "todo",
        priority: "high",
        assignedMembers: [userId.toString()],
        dueDate: new Date("2026-10-20T17:00:00Z"),
      },
      {
        workspaceId: orgA,
        boardId,
        columnId: doneId.toString(),
        title: "Brief",
        status: "done",
        dueDate: new Date("2026-10-21T17:00:00Z"),
      },
      {
        workspaceId: orgA,
        boardId,
        columnId: doingId.toString(),
        title: "Sans échéance",
        status: "todo",
      },
    ]);

    const tasks = byKind(await run(), "TASK");

    expect(tasks.map((t) => [t.title, t.state])).toEqual([
      ["Maquettes", "OVERDUE"],
      ["Brief", "DONE"],
    ]);
    expect(tasks[0]).toMatchObject({
      boardTitle: "Site vitrine",
      boardEmoji: "🚀",
      columnTitle: "En cours",
      priority: "high",
    });
    expect(tasks[0].assignedMembersInfo).toEqual([
      {
        id: userId.toString(),
        userId: userId.toString(),
        name: "Sofia Ruiz",
        email: "sofia@test.fr",
        image: null,
      },
    ]);
  });

  it("un membre ne voit pas les tâches d'un tableau réservé à d'autres", async () => {
    const open = await seedBoard();
    const closed = await seedBoard({ members: [new ObjectId().toString()] });
    for (const { boardId, doingId } of [open, closed]) {
      await Task.collection.insertOne({
        workspaceId: orgA,
        boardId,
        columnId: doingId.toString(),
        title: `Tâche ${boardId}`,
        status: "todo",
        dueDate: new Date("2026-11-03T10:00:00Z"),
      });
    }
    const member = { hasPermission: () => true, canDelete: () => false };

    const tasks = byKind(await run({ permissions: member }), "TASK");
    const adminTasks = byKind(await run(), "TASK");

    expect(tasks.map((t) => t.boardId)).toEqual([open.boardId.toString()]);
    expect(adminTasks).toHaveLength(2);
  });
});

describe("factures récurrentes", () => {
  it("une entrée par prochaine émission de la période", async () => {
    const sourceId = await insertInvoice({
      status: "COMPLETED",
      finalTotalTTC: 500,
      client: { name: "Cabinet Ortiz", type: "COMPANY" },
      dueDate: new Date("2026-09-30T00:00:00Z"),
    });
    await InvoiceRecurrence.collection.insertMany([
      {
        workspaceId: orgA,
        sourceInvoiceId: sourceId,
        userId,
        frequency: "WEEKLY",
        interval: 2,
        startDate: "2026-10-01",
        endDate: "2026-11-20",
        nextRunDate: "2026-10-29",
        status: "ACTIVE",
      },
      {
        workspaceId: orgA,
        sourceInvoiceId: new ObjectId(),
        userId,
        frequency: "MONTHLY",
        interval: 1,
        startDate: "2026-10-01",
        nextRunDate: "2026-11-01",
        status: "PAUSED",
      },
    ]);

    const recurring = byKind(await run(), "RECURRING_INVOICE");

    // 29/10, 12/11 puis fin le 20/11 (le 26/11 est après la date de fin)
    expect(recurring.map((r) => [r.day, r.state])).toEqual([
      ["2026-10-29", "UPCOMING"],
      ["2026-11-12", "UPCOMING"],
    ]);
    expect(recurring[0]).toMatchObject({
      title: "Cabinet Ortiz",
      amount: 500,
      sourceInvoiceId: sourceId.toString(),
      frequency: "WEEKLY",
      interval: 2,
    });
    expect(new Set(recurring.map((r) => r.id)).size).toBe(2);
  });
});

describe("droits", () => {
  it("chaque source suit le droit « Voir » de sa page", async () => {
    await insertInvoice({ dueDate: new Date("2026-11-02T10:00:00Z") });
    await PurchaseInvoice.collection.insertOne({
      workspaceId: orgA,
      supplierName: "OVH",
      status: "TO_PAY",
      amountTTC: 10,
      dueDate: new Date("2026-11-05T00:00:00Z"),
    });
    const noInvoices = {
      hasPermission: (module) => module !== "invoices",
      canDelete: () => true,
    };

    const result = await run({ permissions: noInvoices });

    expect(result.kinds).toEqual(["PURCHASE_INVOICE", "QUOTE", "TASK"]);
    expect(result.items.map((i) => i.kind)).toEqual(["PURCHASE_INVOICE"]);
  });
});

describe("resolver calendarLinkedItems", () => {
  const query = (args, organizationId = orgA) =>
    calendarLinkedItemsResolvers.Query.calendarLinkedItems(
      null,
      args,
      buildContext({ userId, organizationId }),
      { fieldName: "calendarLinkedItems" },
    );

  it("renvoie les éléments de l'espace du membre", async () => {
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
    await insertInvoice({ dueDate: new Date("2026-11-02T10:00:00Z") });

    const result = await query({ from: "2026-11-01", to: "2026-11-30" });

    expect(result.items.map((i) => i.kind)).toEqual(["INVOICE"]);
    expect(result.kinds).toContain("TASK");
    expect(result.truncated).toBe(false);
  });

  it("refuse une période invalide", async () => {
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });

    await expect(
      query({ from: "2026-11-30", to: "2026-11-01" }),
    ).rejects.toThrow("La date de fin précède la date de début.");
  });

  it("refuse un espace dont on n'est pas membre", async () => {
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });

    await expect(
      query({ from: "2026-11-01", to: "2026-11-30" }, orgB),
    ).rejects.toThrow();
  });
});

describe("utilitaires", () => {
  it("validateRange", () => {
    expect(validateRange("2026-11-01", "2026-11-30")).toBeNull();
    expect(validateRange("2026-11-1", "2026-11-30")).toMatch(/AAAA-MM-JJ/);
    expect(validateRange("2026-01-01", "2026-12-31")).toMatch(/100 jours/);
  });

  it("isDoneColumnTitle", () => {
    expect(isDoneColumnTitle("Terminées")).toBe(true);
    expect(isDoneColumnTitle("  Clôturé")).toBe(true);
    expect(isDoneColumnTitle("Done")).toBe(true);
    expect(isDoneColumnTitle("En cours")).toBe(false);
    expect(isDoneColumnTitle("À valider")).toBe(false);
    expect(isDoneColumnTitle(null)).toBe(false);
  });
});

describe("schéma GraphQL", () => {
  const schema = buildASTSchema(typeDefs, { assumeValidSDL: true });
  const QUERY = `query ($from: String!, $to: String!) {
    calendarLinkedItems(from: $from, to: $to) {
      kinds
      truncated
      items {
        id kind entityId day title reference counterparty amount currency
        state documentStatus boardId boardTitle boardEmoji boardColor
        columnTitle columnColor priority sourceInvoiceId frequency interval
        assignedMembersInfo { id userId name email image }
      }
    }
  }`;

  it("sert toutes les sources sans erreur de type", async () => {
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
    const sourceId = await insertInvoice({
      dueDate: new Date("2026-11-02T10:00:00Z"),
    });
    await InvoiceRecurrence.collection.insertOne({
      workspaceId: orgA,
      sourceInvoiceId: sourceId,
      userId,
      frequency: "MONTHLY",
      interval: 1,
      startDate: "2026-11-10",
      nextRunDate: "2026-11-10",
      status: "ACTIVE",
    });
    const { insertedId: boardId } = await Board.collection.insertOne({
      workspaceId: orgA,
      userId,
      title: "Site",
      members: [],
    });
    await Task.collection.insertOne({
      workspaceId: orgA,
      boardId,
      columnId: "colonne-inconnue",
      title: "Livraison",
      status: "todo",
      assignedMembers: [new ObjectId().toString()],
      dueDate: new Date("2026-11-04T10:00:00Z"),
    });

    const res = await graphql({
      schema,
      source: QUERY,
      variableValues: { from: "2026-11-01", to: "2026-11-30" },
      contextValue: buildContext({
        userId,
        organizationId: orgA,
        extra: { db: mongoose.connection.db },
      }),
      fieldResolver: (parent, args, context, info) => {
        const resolver =
          calendarLinkedItemsResolvers[info.parentType.name]?.[info.fieldName];
        return resolver
          ? resolver(parent, args, context, info)
          : defaultFieldResolver(parent, args, context, info);
      },
    });

    expect(res.errors).toBeUndefined();
    expect(
      res.data.calendarLinkedItems.items.map((i) => [i.kind, i.day]),
    ).toEqual([
      ["INVOICE", "2026-11-02"],
      ["TASK", "2026-11-04"],
      ["RECURRING_INVOICE", "2026-11-10"],
    ]);
    const task = res.data.calendarLinkedItems.items[1];
    expect(task.columnTitle).toBeNull();
    expect(task.assignedMembersInfo).toHaveLength(1);
  });
});
