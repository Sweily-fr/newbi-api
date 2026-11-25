/**
 * Campagnes e-mail, durée de conservation du suivi (recommandation CNIL sur
 * les pixels de suivi) : passé 13 mois après le lancement, le détail par
 * destinataire est effacé et les totaux restent (campagne, liens) ; plus
 * rien n'est enregistré ensuite ; reprise sans perte après un arrêt ; une
 * campagne en échec n'arrête pas les autres ; durée remplaçable par variable
 * d'environnement.
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
import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildOrganizationId } from "../../factories/index.js";
import EmailCampaign from "../../../src/models/EmailCampaign.js";
import EmailCampaignClick from "../../../src/models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../../src/models/EmailCampaignRecipient.js";
import {
  recordClick,
  recordOpen,
} from "../../../src/services/emailCampaigns/events.js";
import {
  DEFAULT_TRACKING_RETENTION_MONTHS,
  purgeExpiredCampaignTracking,
  trackingRetentionCutoff,
  trackingRetentionMonths,
} from "../../../src/services/emailCampaigns/retention.js";

const workspaceId = buildOrganizationId();
const NOW = new Date("2027-12-26T02:30:00.000Z");
// 13 mois avant NOW : 26/11/2026
const OLD = new Date("2026-11-20T10:00:00.000Z");
const RECENT = new Date("2026-12-01T10:00:00.000Z");

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    EmailCampaign.init(),
    EmailCampaignRecipient.init(),
    EmailCampaignClick.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Campagne lancée à `startedAt` : Marie ouvre et clique deux fois le lien 0, Paul clique le lien 1. */
async function launchedCampaign(startedAt, name = "Nouveautés") {
  const campaign = await EmailCampaign.create({
    workspaceId,
    name,
    status: "SENT",
    trackOpens: true,
    trackClicks: true,
    startedAt,
    links: ["https://atelier.fr/a", "https://atelier.fr/b"],
  });
  const [marie, paul] = await EmailCampaignRecipient.create([
    {
      workspaceId,
      campaignId: campaign._id,
      email: "marie@exemple.fr",
      status: "DELIVERED",
      sentAt: startedAt,
    },
    {
      workspaceId,
      campaignId: campaign._id,
      email: "paul@exemple.fr",
      status: "DELIVERED",
      sentAt: startedAt,
    },
  ]);
  await recordOpen(marie._id, startedAt);
  await recordClick(marie.toObject(), 0, startedAt);
  await recordClick(marie.toObject(), 0, startedAt);
  await recordClick(paul.toObject(), 1, startedAt);
  return { campaign, marie, paul };
}

const recipientsOf = (campaign) =>
  EmailCampaignRecipient.find({ campaignId: campaign._id })
    .sort({ email: 1 })
    .lean();
const campaignOf = (campaign) => EmailCampaign.findById(campaign._id).lean();

describe("effacement du suivi après 13 mois", () => {
  it("efface le détail par destinataire, garde les totaux de la campagne et des liens", async () => {
    const old = await launchedCampaign(OLD);
    const recent = await launchedCampaign(RECENT, "Récente");
    const draft = await EmailCampaign.create({
      workspaceId,
      name: "Brouillon",
    });

    expect(await purgeExpiredCampaignTracking({ now: NOW })).toBe(1);

    const purged = await campaignOf(old.campaign);
    expect(purged.trackingPurgedAt).toEqual(NOW);
    expect(purged.linkStats).toEqual([
      { clicks: 2, uniqueClicks: 1 },
      { clicks: 1, uniqueClicks: 1 },
    ]);
    expect(purged.stats).toMatchObject({
      opened: 2,
      opens: 2,
      clicked: 2,
      clicks: 3,
    });
    for (const recipient of await recipientsOf(old.campaign)) {
      expect(recipient).toMatchObject({
        trackingExpired: true,
        openedAt: null,
        openCount: 0,
        clickedAt: null,
        clickCount: 0,
        status: "DELIVERED",
      });
      expect(recipient.sentAt).toEqual(OLD);
    }
    expect(
      await EmailCampaignClick.countDocuments({ campaignId: old.campaign._id }),
    ).toBe(0);

    // Campagne de moins de 13 mois et brouillon : intacts
    const kept = await campaignOf(recent.campaign);
    expect(kept.trackingPurgedAt).toBeNull();
    expect(kept.linkStats).toBeUndefined();
    const [marie] = await recipientsOf(recent.campaign);
    expect(marie).toMatchObject({ openCount: 1, clickCount: 2 });
    expect(
      await EmailCampaignClick.countDocuments({
        campaignId: recent.campaign._id,
      }),
    ).toBe(3);
    expect((await campaignOf(draft)).trackingPurgedAt).toBeNull();

    // Déjà effacée : rien à refaire
    expect(await purgeExpiredCampaignTracking({ now: NOW })).toBe(0);
  });

  it("plus rien n'est enregistré ensuite (pixel, clic)", async () => {
    const { campaign, marie } = await launchedCampaign(OLD);
    await purgeExpiredCampaignTracking({ now: NOW });
    const expired = await EmailCampaignRecipient.findById(marie._id).lean();

    expect(await recordOpen(marie._id, NOW)).toBe(false);
    await recordClick(expired, 1, NOW);

    expect(
      await EmailCampaignRecipient.findById(marie._id).lean(),
    ).toMatchObject({
      openedAt: null,
      openCount: 0,
      clickedAt: null,
      clickCount: 0,
    });
    expect(await EmailCampaignClick.countDocuments()).toBe(0);
    expect((await campaignOf(campaign)).stats).toMatchObject({
      opens: 2,
      clicks: 3,
    });
  });

  it("arrêt en plein effacement : repris au passage suivant, totaux par lien jamais réécrits, les autres campagnes continuent", async () => {
    const first = await launchedCampaign(OLD, "Première");
    const second = await launchedCampaign(
      new Date("2026-11-21T10:00:00.000Z"),
      "Seconde",
    );
    const realDeleteMany =
      EmailCampaignClick.deleteMany.bind(EmailCampaignClick);
    vi.spyOn(EmailCampaignClick, "deleteMany").mockImplementationOnce(
      async (filter) => {
        // Un clic effacé, puis arrêt
        await EmailCampaignClick.collection.deleteOne(filter);
        throw new Error("arrêt simulé");
      },
    );

    expect(await purgeExpiredCampaignTracking({ now: NOW })).toBe(1);
    const interrupted = await campaignOf(first.campaign);
    expect(interrupted.trackingPurgedAt).toBeNull();
    expect(interrupted.linkStats).toEqual([
      { clicks: 2, uniqueClicks: 1 },
      { clicks: 1, uniqueClicks: 1 },
    ]);
    expect((await campaignOf(second.campaign)).trackingPurgedAt).toEqual(NOW);

    EmailCampaignClick.deleteMany.mockImplementation(realDeleteMany);
    expect(await purgeExpiredCampaignTracking({ now: NOW })).toBe(1);
    const done = await campaignOf(first.campaign);
    expect(done.trackingPurgedAt).toEqual(NOW);
    expect(done.linkStats).toEqual([
      { clicks: 2, uniqueClicks: 1 },
      { clicks: 1, uniqueClicks: 1 },
    ]);
    expect(await EmailCampaignClick.countDocuments()).toBe(0);
  });
});

describe("durée de conservation", () => {
  it("13 mois par défaut, remplaçable par EMAIL_CAMPAIGN_TRACKING_RETENTION_MONTHS", () => {
    expect(DEFAULT_TRACKING_RETENTION_MONTHS).toBe(13);
    expect(trackingRetentionMonths()).toBe(13);
    expect(trackingRetentionCutoff(NOW, 13)).toEqual(
      new Date("2026-11-26T02:30:00.000Z"),
    );
    vi.stubEnv("EMAIL_CAMPAIGN_TRACKING_RETENTION_MONTHS", "6");
    expect(trackingRetentionMonths()).toBe(6);
    for (const invalid of ["", "0", "-2", "1.5", "treize"]) {
      vi.stubEnv("EMAIL_CAMPAIGN_TRACKING_RETENTION_MONTHS", invalid);
      expect(trackingRetentionMonths(), invalid).toBe(13);
    }
  });

  it("durée raccourcie : campagne effacée plus tôt", async () => {
    const { campaign } = await launchedCampaign(
      new Date("2027-05-01T10:00:00.000Z"),
    );
    expect(await purgeExpiredCampaignTracking({ now: NOW })).toBe(0);
    vi.stubEnv("EMAIL_CAMPAIGN_TRACKING_RETENTION_MONTHS", "6");
    expect(await purgeExpiredCampaignTracking({ now: NOW })).toBe(1);
    expect((await campaignOf(campaign)).trackingPurgedAt).toEqual(NOW);
  });
});

describe("mongoose", () => {
  it("base de test seulement", () => {
    expect(mongoose.connection.name).toMatch(/^test_/);
  });
});
