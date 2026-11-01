/**
 * Kanban : total facturable d'un tableau (Board.totalBillableAmount),
 * calculé par MongoDB d'après le suivi de temps de chaque tâche. Mêmes cas
 * que le montant affiché par le site (NewbiV2 taskAmount.js,
 * __tests__/app/kanban-task-amount.test.js) : même total au centime près.
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
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { Task } from "../../src/models/kanban.js";
import kanbanResolvers from "../../src/resolvers/kanban.js";

const NOW = new Date("2026-11-01T10:00:00Z");
const HOUR_30 = 90 * 60;
const boardId = new mongoose.Types.ObjectId();
const workspaceId = new mongoose.Types.ObjectId();
const otherBoard = new mongoose.Types.ObjectId();

const board = { id: String(boardId), workspaceId: String(workspaceId) };
const total = () => kanbanResolvers.Board.totalBillableAmount(board);

async function seedTask(timeTracking, fields = {}) {
  await Task.collection.insertOne({
    title: "Tâche",
    status: "a-faire",
    columnId: "a-faire",
    boardId,
    workspaceId,
    timeTracking,
    ...fields,
  });
}

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("totalBillableAmount", () => {
  it.each([
    ["up", 100],
    ["down", 50],
    ["none", 75],
  ])("1 h 30 à 50 €/h, arrondi %s : %s €", async (roundingOption, expected) => {
    await seedTask({ totalSeconds: HOUR_30, hourlyRate: 50, roundingOption });

    expect(await total()).toBe(expected);
  });

  it("sans option d'arrondi : valeur exacte", async () => {
    await seedTask({ totalSeconds: HOUR_30, hourlyRate: 50 });

    expect(await total()).toBe(75);
  });

  it("minuteur en cours depuis 30 min ajouté au temps passé", async () => {
    await seedTask({
      totalSeconds: 3600,
      hourlyRate: 40,
      isRunning: true,
      currentStartTime: new Date(NOW.getTime() - 30 * 60_000),
    });

    expect(await total()).toBeCloseTo(60, 2);
  });

  it("taux nul exclu, arrondi inférieur sous l'heure à 0 €, total vide : null", async () => {
    await seedTask({ totalSeconds: 7200, hourlyRate: 0 });
    await seedTask({
      totalSeconds: 1800,
      hourlyRate: 50,
      roundingOption: "down",
    });

    expect(await total()).toBeNull();
  });

  it("somme de plusieurs tâches : même total que le site (227,50 €)", async () => {
    await seedTask({
      totalSeconds: HOUR_30,
      hourlyRate: 50,
      roundingOption: "up",
    });
    await seedTask({
      totalSeconds: HOUR_30,
      hourlyRate: 50,
      roundingOption: "down",
    });
    await seedTask({ totalSeconds: HOUR_30, hourlyRate: 50 });
    await seedTask({ totalSeconds: 180, hourlyRate: 50 });
    await seedTask({ totalSeconds: 7200, hourlyRate: 0 });

    expect(await total()).toBeCloseTo(227.5, 2);
  });

  it("tâches d'un autre tableau ou d'un autre espace non comptées", async () => {
    await seedTask({ totalSeconds: 3600, hourlyRate: 50 });
    await seedTask(
      { totalSeconds: 3600, hourlyRate: 999 },
      { boardId: otherBoard },
    );
    await seedTask(
      { totalSeconds: 3600, hourlyRate: 999 },
      { workspaceId: new mongoose.Types.ObjectId() },
    );

    expect(await total()).toBe(50);
  });
});
