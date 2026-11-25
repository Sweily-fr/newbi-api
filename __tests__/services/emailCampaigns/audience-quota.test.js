/**
 * Campagnes e-mail : audience (exclusions, doublons, contacts bloqués,
 * listes, cloisonnement par espace) et quota mensuel par offre (essai,
 * variable d'environnement, envoyés du mois et destinataires en attente).
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
import { seedOrgMembership } from "../../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../../factories/index.js";
import { invalidateSubCache } from "../../../src/middlewares/rbac.js";
import Client from "../../../src/models/Client.js";
import ClientList from "../../../src/models/ClientList.js";
import EmailCampaignRecipient from "../../../src/models/EmailCampaignRecipient.js";
import EmailSuppression from "../../../src/models/EmailSuppression.js";
import { resolveAudience } from "../../../src/services/emailCampaigns/audience.js";
import {
  DEFAULT_MONTHLY_QUOTAS,
  getCampaignQuota,
  monthlyQuotas,
} from "../../../src/services/emailCampaigns/quota.js";
import { parisMonthBounds } from "../../../src/services/esignatureQuota.js";

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const userId = buildUserId();

const individual = (email, extra = {}) =>
  buildClientDoc({
    workspaceId,
    createdBy: userId,
    type: "INDIVIDUAL",
    firstName: "Marie",
    lastName: "Durand",
    name: "Marie Durand",
    email,
    ...extra,
  });

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Client.init(),
    EmailSuppression.init(),
    EmailCampaignRecipient.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateSubCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAudience", () => {
  async function seedContacts() {
    const [ok, company, blocked, suppressed, listed] = await Client.create([
      individual("marie@exemple.fr"),
      buildClientDoc({
        workspaceId,
        createdBy: userId,
        type: "COMPANY",
        name: "Boulangerie Martin",
        email: "contact@boulangerie.fr",
        firstName: undefined,
        lastName: undefined,
      }),
      individual("bloque@exemple.fr", { isBlocked: true }),
      individual("parti@exemple.fr"),
      individual("liste-exclue@exemple.fr"),
    ]);
    // Contacts hors validation (anciennes données) : sans e-mail, e-mail
    // invalide, doublon par la casse
    await Client.collection.insertMany([
      {
        ...individual(null),
        email: null,
        prospect: { provider: "societeinfo" },
      },
      { ...individual("pas-une-adresse"), email: "pas-une-adresse" },
      { ...individual("MARIE@exemple.fr"), email: "MARIE@exemple.fr" },
    ]);
    // Autre espace : jamais compté
    await Client.create(
      buildClientDoc({
        workspaceId: otherWorkspace,
        createdBy: userId,
        email: "ailleurs@exemple.fr",
      }),
    );
    await EmailSuppression.create({
      workspaceId,
      email: "parti@exemple.fr",
      reason: "UNSUBSCRIBED",
    });
    const excluded = await ClientList.create({
      name: "Exclus",
      workspaceId,
      createdBy: userId,
      clients: [listed._id],
    });
    return { ok, company, blocked, suppressed, listed, excluded };
  }

  it("compte chaque contact dans une seule case", async () => {
    const { excluded } = await seedContacts();
    const { counts, recipients } = await resolveAudience(
      String(workspaceId),
      { mode: "ALL", excludeListIds: [String(excluded._id)] },
      { withRecipients: true },
    );
    expect(counts).toEqual({
      total: 8,
      sendable: 2,
      noEmail: 1,
      invalidEmail: 1,
      blocked: 1,
      suppressed: 1,
      duplicates: 1,
      excludedByList: 1,
      missingFirstName: 1,
      prospects: 0,
    });
    expect(recipients.map((r) => r.email)).toEqual([
      "marie@exemple.fr",
      "contact@boulangerie.fr",
    ]);
    expect(recipients[0]).toMatchObject({
      name: "Marie Durand",
      vars: { prenom: "Marie", nom: "Durand", email: "marie@exemple.fr" },
    });
    expect(recipients[1].vars).toMatchObject({
      entreprise: "Boulangerie Martin",
      prenom: "",
    });
  });

  it("listes : seulement leurs contacts, jamais une liste d'un autre espace", async () => {
    const { ok, company } = await seedContacts();
    const mine = await ClientList.create({
      name: "Clients fidèles",
      workspaceId,
      createdBy: userId,
      clients: [ok._id],
    });
    const foreign = await ClientList.create({
      name: "Autre espace",
      workspaceId: otherWorkspace,
      createdBy: userId,
      clients: [company._id],
    });
    const { counts, recipients } = await resolveAudience(
      String(workspaceId),
      { mode: "LISTS", listIds: [String(mine._id), String(foreign._id)] },
      { withRecipients: true },
    );
    expect(counts.total).toBe(1);
    expect(recipients.map((r) => r.email)).toEqual(["marie@exemple.fr"]);
  });

  it("listes sans liste choisie : personne", async () => {
    await seedContacts();
    const { counts } = await resolveAudience(String(workspaceId), {
      mode: "LISTS",
      listIds: [],
    });
    expect(counts.total).toBe(0);
    expect(counts.sendable).toBe(0);
  });

  it("écarte les prospects générés : jamais destinataires d'une campagne", async () => {
    await Client.create([
      individual("client@exemple.fr"),
      {
        ...individual("prospect@exemple.fr"),
        prospect: { provider: "societeinfo", siren: "123456789" },
      },
    ]);
    const { counts, recipients } = await resolveAudience(
      String(workspaceId),
      { mode: "ALL" },
      { withRecipients: true },
    );
    expect(counts).toMatchObject({ total: 2, sendable: 1, prospects: 1 });
    expect(recipients.map((r) => r.email)).toEqual(["client@exemple.fr"]);
  });

  it("un prospect sans adresse ou dans une liste exclue reste dans sa case", async () => {
    const [listed] = await Client.create([
      {
        ...individual("liste@exemple.fr"),
        prospect: { provider: "societeinfo" },
      },
    ]);
    // Prospect sans e-mail (un téléphone seulement) : hors validation
    await Client.collection.insertOne({
      ...individual(null),
      email: null,
      prospect: { provider: "societeinfo" },
    });
    const excluded = await ClientList.create({
      name: "Exclus",
      workspaceId,
      createdBy: userId,
      clients: [listed._id],
    });
    const { counts } = await resolveAudience(String(workspaceId), {
      mode: "ALL",
      excludeListIds: [String(excluded._id)],
    });
    expect(counts).toMatchObject({
      noEmail: 1,
      excludedByList: 1,
      prospects: 0,
      sendable: 0,
    });
  });

  it("exclut aussi par adresse un contact présent dans une liste exclue", async () => {
    const [a] = await Client.create([individual("double@exemple.fr")]);
    await Client.collection.insertOne({
      ...individual("DOUBLE@exemple.fr"),
      email: "DOUBLE@exemple.fr",
    });
    const excluded = await ClientList.create({
      name: "Exclus",
      workspaceId,
      createdBy: userId,
      clients: [a._id],
    });
    const { counts } = await resolveAudience(String(workspaceId), {
      mode: "ALL",
      excludeListIds: [String(excluded._id)],
    });
    expect(counts.excludedByList).toBe(2);
    expect(counts.sendable).toBe(0);
  });
});

describe("quota mensuel", () => {
  it("valeurs par offre, remplaçables par la variable d'environnement", () => {
    expect(monthlyQuotas({})).toEqual({
      trial: 100,
      freelance: 500,
      pme: 2500,
      entreprise: 10000,
    });
    expect(
      monthlyQuotas({
        EMAIL_CAMPAIGN_MONTHLY_QUOTAS: '{"pme":3000,"trial":-5}',
      }),
    ).toEqual({ ...DEFAULT_MONTHLY_QUOTAS, pme: 3000 });
    expect(
      monthlyQuotas({ EMAIL_CAMPAIGN_MONTHLY_QUOTAS: "pas du json" }),
    ).toEqual(DEFAULT_MONTHLY_QUOTAS);
  });

  it("essai sans abonnement : 100 e-mails", async () => {
    await seedOrgMembership({
      userId,
      organizationId: workspaceId,
      subscriptionStatus: null,
    });
    const quota = await getCampaignQuota(String(workspaceId));
    expect(quota).toMatchObject({
      plan: "trial",
      monthlyLimit: 100,
      usedThisMonth: 0,
      remaining: 100,
    });
  });

  it("compte les envois du mois et les destinataires en attente", async () => {
    await seedOrgMembership({ userId, organizationId: workspaceId });
    await mongoose.connection.db
      .collection("subscription")
      .updateOne(
        { referenceId: String(workspaceId) },
        { $set: { plan: "freelance" } },
      );
    vi.stubEnv("EMAIL_CAMPAIGN_MONTHLY_QUOTAS", '{"freelance":10}');
    const now = new Date();
    const { start } = parisMonthBounds(now);
    const campaignId = new mongoose.Types.ObjectId();
    const base = (email, extra) => ({
      workspaceId,
      campaignId,
      email,
      ...extra,
    });
    await EmailCampaignRecipient.insertMany([
      base("a@x.fr", { status: "SENT", sentAt: now }),
      base("b@x.fr", { status: "SIMULATED", sentAt: now }),
      base("c@x.fr", { status: "DELIVERED", sentAt: now }),
      // Rejeté après l'envoi : compte quand même
      base("d@x.fr", { status: "BOUNCED", sentAt: now }),
      // Mois précédent : ne compte pas
      base("e@x.fr", {
        status: "SENT",
        sentAt: new Date(start.getTime() - 1000),
      }),
      // En attente : réservé
      base("f@x.fr", { status: "PENDING" }),
      // Jamais parti : ne compte pas
      base("g@x.fr", { status: "SKIPPED" }),
      base("h@x.fr", { status: "FAILED" }),
      // Autre espace
      {
        ...base("i@x.fr", { status: "SENT", sentAt: now }),
        workspaceId: otherWorkspace,
      },
    ]);
    const quota = await getCampaignQuota(String(workspaceId), now);
    expect(quota).toMatchObject({
      plan: "freelance",
      monthlyLimit: 10,
      sent: 4,
      pending: 1,
      usedThisMonth: 5,
      remaining: 5,
    });
  });
});
