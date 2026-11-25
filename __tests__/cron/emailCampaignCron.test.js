/**
 * Cron des campagnes e-mail : envoi chaque minute, domaines d'envoi
 * connectés relus toutes les 10 minutes (heure de Paris), sans chevauchement
 * d'un passage sur le suivant, une erreur n'arrête pas la tâche.
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
  runEmailCampaignTick: vi.fn(async () => ({})),
  refreshSendingDomains: vi.fn(async () => ({})),
  purgeExpiredCampaignTracking: vi.fn(async () => 0),
}));
vi.mock("../../src/services/emailCampaigns/campaignService.js", () => ({
  runEmailCampaignTick: services.runEmailCampaignTick,
}));
vi.mock("../../src/services/emailCampaigns/sendingDomains.js", () => ({
  refreshSendingDomains: services.refreshSendingDomains,
}));
vi.mock("../../src/services/emailCampaigns/retention.js", () => ({
  purgeExpiredCampaignTracking: services.purgeExpiredCampaignTracking,
}));

import {
  EMAIL_CAMPAIGN_CRON,
  EMAIL_SENDING_DOMAIN_CRON,
  EMAIL_TRACKING_RETENTION_CRON,
  startEmailCampaignCron,
} from "../../src/cron/emailCampaignCron.js";

beforeEach(() => {
  cronMock.tasks = [];
  services.runEmailCampaignTick.mockClear();
  services.refreshSendingDomains.mockClear();
  services.purgeExpiredCampaignTracking.mockClear();
});

describe("cron des campagnes e-mail", () => {
  it("envoi chaque minute, domaines toutes les 10 minutes, effacement du suivi chaque nuit, heure de Paris", async () => {
    const { task, domainsTask, retentionTask } = startEmailCampaignCron();
    expect(cronMock.tasks.map((t) => t.expression)).toEqual([
      "* * * * *",
      "*/10 * * * *",
      "30 3 * * *",
    ]);
    expect(EMAIL_CAMPAIGN_CRON).toBe("* * * * *");
    expect(EMAIL_SENDING_DOMAIN_CRON).toBe("*/10 * * * *");
    expect(EMAIL_TRACKING_RETENTION_CRON).toBe("30 3 * * *");
    expect(task.options.timezone).toBe("Europe/Paris");
    expect(domainsTask.options.timezone).toBe("Europe/Paris");
    expect(retentionTask.options.timezone).toBe("Europe/Paris");
    await retentionTask.run();
    expect(services.purgeExpiredCampaignTracking).toHaveBeenCalledTimes(1);
  });

  it("pas de chevauchement ; une erreur n'arrête pas la tâche", async () => {
    startEmailCampaignCron();
    const domains = cronMock.tasks[1];
    let release;
    services.refreshSendingDomains.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = domains.run();
    await domains.run();
    expect(services.refreshSendingDomains).toHaveBeenCalledTimes(1);
    release();
    await first;
    services.refreshSendingDomains.mockRejectedValueOnce(new Error("panne"));
    await domains.run();
    await domains.run();
    expect(services.refreshSendingDomains).toHaveBeenCalledTimes(3);
    await cronMock.tasks[0].run();
    expect(services.runEmailCampaignTick).toHaveBeenCalledTimes(1);
  });
});
