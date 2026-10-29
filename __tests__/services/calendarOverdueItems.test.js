/**
 * Liste « En retard » du calendrier (calendarOverdueItems) : tout ce qui
 * est en retard quelle que soit la date, sans les documents réglés, les
 * tâches terminées ni les livraisons faites, avec les droits de chaque page.
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
import PurchaseOrder from "../../src/models/PurchaseOrder.js";
import DeliveryNote from "../../src/models/DeliveryNote.js";
import { Board, Column, Task } from "../../src/models/kanban.js";
import { getCalendarOverdueItems } from "../../src/services/calendar/linkedItemsService.js";
import calendarLinkedItemsResolvers from "../../src/resolvers/calendarLinkedItems.js";

const userId = buildUserId();
const orgA = buildOrganizationId();
const orgB = buildOrganizationId();
// Jeudi 29 octobre 2026, 10 h à Paris
const NOW = new Date("2026-10-29T09:00:00Z");
const allowAll = { hasPermission: () => true, canDelete: () => true };

const run = (permissions = allowAll) =>
  getCalendarOverdueItems({
    workspaceId: orgA.toString(),
    userId: userId.toString(),
    permissions,
    db: mongoose.connection.db,
    now: NOW,
  });

let number = 0;
const invoice = (fields) => {
  number += 1;
  return {
    workspaceId: orgA,
    prefix: "F",
    number: String(number).padStart(4, "0"),
    status: "PENDING",
    finalTotalTTC: 100,
    client: { name: "Client", type: "COMPANY" },
    ...fields,
  };
};

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

describe("liste « En retard »", () => {
  it("retards anciens compris, réglés, du jour et à venir exclus", async () => {
    await Invoice.collection.insertMany([
      invoice({ dueDate: new Date("2023-05-10T00:00:00Z") }),
      invoice({ status: "OVERDUE", dueDate: new Date("2026-10-20T00:00:00Z") }),
      invoice({
        status: "COMPLETED",
        dueDate: new Date("2026-10-01T00:00:00Z"),
      }),
      invoice({ dueDate: new Date("2026-10-29T08:00:00Z") }),
      invoice({ dueDate: new Date("2026-11-05T00:00:00Z") }),
      invoice({
        workspaceId: orgB,
        dueDate: new Date("2026-10-01T00:00:00Z"),
      }),
    ]);
    await PurchaseInvoice.collection.insertMany([
      {
        workspaceId: orgA,
        supplierName: "OVH",
        status: "TO_PAY",
        amountTTC: 60,
        currency: "EUR",
        dueDate: new Date("2026-09-15T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        supplierName: "Payé",
        status: "PAID",
        amountTTC: 10,
        currency: "EUR",
        dueDate: new Date("2026-09-16T00:00:00Z"),
      },
    ]);
    await Quote.collection.insertMany([
      {
        workspaceId: orgA,
        prefix: "D",
        number: "0001",
        status: "PENDING",
        finalTotalTTC: 900,
        client: { name: "Studio Sud", type: "COMPANY" },
        validUntil: new Date("2026-10-10T00:00:00Z"),
      },
      {
        workspaceId: orgA,
        prefix: "D",
        number: "0002",
        status: "COMPLETED",
        finalTotalTTC: 900,
        client: { name: "Signé", type: "COMPANY" },
        validUntil: new Date("2026-10-10T00:00:00Z"),
      },
    ]);
    await PurchaseOrder.collection.insertOne({
      workspaceId: orgA,
      prefix: "BC",
      number: "0001",
      status: "CONFIRMED",
      finalTotalTTC: 4200,
      client: { name: "Studio Sud", type: "COMPANY" },
      deliveryDate: new Date("2026-10-25T00:00:00Z"),
    });
    await DeliveryNote.collection.insertOne({
      workspaceId: orgA,
      prefix: "BL",
      number: "0001",
      status: "DELIVERED",
      client: { name: "Livré", type: "COMPANY" },
      deliveryDate: new Date("2026-10-24T00:00:00Z"),
    });

    const result = await run();

    expect(result.items.map((i) => [i.kind, i.day, i.state, i.title])).toEqual([
      ["INVOICE", "2023-05-10", "OVERDUE", "Client"],
      ["PURCHASE_INVOICE", "2026-09-15", "OVERDUE", "OVH"],
      ["QUOTE", "2026-10-10", "OVERDUE", "Studio Sud"],
      ["INVOICE", "2026-10-20", "OVERDUE", "Client"],
      ["DELIVERY", "2026-10-25", "OVERDUE", "Studio Sud"],
    ]);
    expect(result.kinds).toEqual([
      "INVOICE",
      "PURCHASE_INVOICE",
      "QUOTE",
      "TASK",
      "DELIVERY",
    ]);
  });

  it("les tâches des colonnes « terminé » ne prennent pas la place", async () => {
    const { insertedId: boardId } = await Board.collection.insertOne({
      workspaceId: orgA,
      userId,
      title: "Site",
      members: [],
    });
    const { insertedIds } = await Column.collection.insertMany([
      { workspaceId: orgA, boardId, title: "En cours", color: "#f59e0b" },
      { workspaceId: orgA, boardId, title: "Terminées", color: "#10b981" },
    ]);
    const doing = insertedIds[0].toString();
    const done = insertedIds[1].toString();
    await Task.collection.insertMany([
      ...Array.from({ length: 5 }, (_, i) => ({
        workspaceId: orgA,
        boardId,
        columnId: done,
        title: `Finie ${i}`,
        status: "done",
        dueDate: new Date(`2026-0${i + 1}-10T10:00:00Z`),
      })),
      {
        workspaceId: orgA,
        boardId,
        columnId: doing,
        title: "Maquettes",
        status: "todo",
        dueDate: new Date("2026-10-20T10:00:00Z"),
      },
    ]);

    const tasks = (await run()).items.filter((i) => i.kind === "TASK");

    expect(tasks.map((t) => t.title)).toEqual(["Maquettes"]);
  });

  it("chaque source suit le droit « Voir » de sa page", async () => {
    await Invoice.collection.insertOne(
      invoice({ dueDate: new Date("2026-10-20T00:00:00Z") }),
    );
    const noInvoices = {
      hasPermission: (module) => module !== "invoices",
      canDelete: () => true,
    };

    const result = await run(noInvoices);

    expect(result.kinds).not.toContain("INVOICE");
    expect(result.items).toEqual([]);
  });

  it("resolver : espace du membre seulement", async () => {
    await seedOrgMembership({ userId, organizationId: orgA, role: "owner" });
    await Invoice.collection.insertMany([
      invoice({ dueDate: new Date("2026-01-20T00:00:00Z") }),
      invoice({
        workspaceId: orgB,
        dueDate: new Date("2026-01-20T00:00:00Z"),
      }),
    ]);

    const result =
      await calendarLinkedItemsResolvers.Query.calendarOverdueItems(
        null,
        {},
        buildContext({
          userId,
          organizationId: orgA,
          extra: { db: mongoose.connection.db },
        }),
        { fieldName: "calendarOverdueItems" },
      );

    expect(result.items.map((i) => i.kind)).toEqual(["INVOICE"]);
  });
});
