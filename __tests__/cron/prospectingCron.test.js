/**
 * Cron de la prospection : un passage chaque minute (heure de Paris), sans
 * chevauchement d'un passage sur le suivant ; une erreur n'arrête pas la
 * tâche.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const cronMock = vi.hoisted(() => ({ tasks: [] }));
vi.mock("node-cron", () => ({
  default: {
    schedule: (expression, run, options) => {
      const task = { expression, run, options };
      cronMock.tasks.push(task);
      return task;
    },
  },
}));
const services = vi.hoisted(() => ({
  runProspectingTick: vi.fn(async () => ({})),
}));
vi.mock("../../src/services/prospecting/sending.js", () => ({
  runProspectingTick: services.runProspectingTick,
}));

import {
  PROSPECTING_CRON,
  startProspectingCron,
} from "../../src/cron/prospectingCron.js";

beforeEach(() => {
  cronMock.tasks = [];
  services.runProspectingTick.mockReset();
  services.runProspectingTick.mockImplementation(async () => ({}));
});

describe("cron de la prospection", () => {
  it("chaque minute, heure de Paris", () => {
    const { task } = startProspectingCron();
    expect(PROSPECTING_CRON).toBe("* * * * *");
    expect(task.expression).toBe("* * * * *");
    expect(task.options).toMatchObject({
      scheduled: true,
      timezone: "Europe/Paris",
    });
  });

  it("pas de chevauchement ; une erreur n'arrête pas la tâche", async () => {
    const { task } = startProspectingCron();
    let release;
    services.runProspectingTick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = task.run();
    await task.run();
    expect(services.runProspectingTick).toHaveBeenCalledTimes(1);
    release();
    await first;

    services.runProspectingTick.mockRejectedValueOnce(new Error("panne"));
    await expect(task.run()).resolves.toBeUndefined();
    await task.run();
    expect(services.runProspectingTick).toHaveBeenCalledTimes(3);
  });
});
