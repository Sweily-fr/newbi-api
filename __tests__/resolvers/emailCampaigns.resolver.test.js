/**
 * Campagnes e-mail, tableau de bord (GraphQL) : droits par rôle (Comptable
 * refusé, Membre en lecture, Éditeur sans suppression), cloisonnement par
 * espace, création depuis un modèle, brouillon seul modifiable et saisies
 * contrôlées, duplication, suppression, envoi (consentement, vérification),
 * programmation, pause, reprise, annulation, aperçu, envoi de test, rapport,
 * liste d'exclusion, image. Aucun envoi réel (Resend simulé).
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

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
const resendMock = vi.hoisted(() => ({ calls: [] }));
vi.mock("resend", () => ({
  Resend: class {
    constructor() {
      this.batch = {
        send: async (payloads, options) => {
          resendMock.calls.push({ payloads, options });
          return {
            data: { data: payloads.map((_, i) => ({ id: `re_${i}` })) },
            error: null,
          };
        },
      };
    }
  },
}));
vi.mock("../../src/services/signatureAssets.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ensureIcons: vi.fn(async () => {}),
}));
const storage = vi.hoisted(() => ({
  assertStorageAvailable: vi.fn(async () => null),
  recordStoredFile: vi.fn(async () => {}),
}));
vi.mock("../../src/services/storage/storageService.js", () => storage);
const cloudflare = vi.hoisted(() => ({
  uploadSignatureImage: vi.fn(async (buffer, fileName, userId, folder) => ({
    key: `${userId}/${folder}/banner/image.jpg`,
    url: `https://images.exemple.test/${userId}/${folder}/banner/image.jpg`,
  })),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    uploadSignatureImage: cloudflare.uploadSignatureImage,
    signatureBucketName: "image-signature-test",
  },
}));
const dnsRecords = vi.hoisted(() => new Map());
vi.mock("node:dns", () => {
  const resolveTxt = async (name) => {
    const value = dnsRecords.get(name);
    if (!value) throw Object.assign(new Error("absent"), { code: "ENOTFOUND" });
    return value.map((record) => [record]);
  };
  return { default: { promises: { resolveTxt } }, promises: { resolveTxt } };
});

import { Readable } from "node:stream";
import mongoose from "mongoose";
import sharp from "sharp";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import {
  buildClientDoc,
  buildOrganizationId,
  buildUserId,
} from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import { resetMemoryAttempts } from "../../src/utils/attemptLimiter.js";
import Client from "../../src/models/Client.js";
import ClientList from "../../src/models/ClientList.js";
import EmailCampaign from "../../src/models/EmailCampaign.js";
import EmailCampaignClick from "../../src/models/EmailCampaignClick.js";
import EmailCampaignRecipient from "../../src/models/EmailCampaignRecipient.js";
import EmailSuppression from "../../src/models/EmailSuppression.js";
import emailCampaignsResolvers from "../../src/resolvers/emailCampaigns.js";
import { resetDnsCache } from "../../src/services/emailCampaigns/deliverability.js";
import { resetResendClient } from "../../src/services/emailCampaigns/sender.js";
import { getCampaignQuota } from "../../src/services/emailCampaigns/quota.js";

const { Query, Mutation } = emailCampaignsResolvers;
const Types = emailCampaignsResolvers;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();
const outsider = buildUserId();

const ctx = (userId, organizationId = workspaceId) =>
  buildContext({ userId, organizationId });
const call = (resolver, userId, args = {}, organizationId = workspaceId) =>
  resolver(
    null,
    { workspaceId: String(organizationId), ...args },
    ctx(userId, organizationId),
    { fieldName: "test" },
  );
const codeOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.code || error.extensions?.code || error.message;
  }
};
const messageOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.message;
  }
};

const GOOD_TEXT = `<p>Bonjour {{prenom|à vous}},</p><p>${"Voici les nouvelles de notre atelier, avec nos créations du mois. ".repeat(4)}</p>`;

async function draft(userId = owner, input = {}) {
  const campaign = await call(Mutation.createEmailCampaign, userId, {
    input: { name: "Nouveautés de novembre", templateKey: "plain" },
  });
  return call(Mutation.updateEmailCampaign, userId, {
    id: String(campaign._id),
    input: {
      subject: "Les nouveautés de l'atelier en novembre",
      preheader: "Nos créations du mois",
      design: { version: 1, blocks: [{ type: "text", html: GOOD_TEXT }] },
      ...input,
    },
  });
}

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Client.init(),
    ClientList.init(),
    EmailCampaign.init(),
    EmailCampaignRecipient.init(),
    EmailSuppression.init(),
  ]);
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  resetMemoryAttempts();
  resetDnsCache();
  resetResendClient();
  resendMock.calls = [];
  vi.clearAllMocks();
  vi.stubEnv("JWT_SECRET", "secret-de-test");
  vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
  vi.stubEnv("EMAIL_CAMPAIGN_FROM_EMAIL", "campagnes@envoi.newbi.fr");
  // Hors production, sans liste d'adresses autorisées : tout est simulé
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
  vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
  vi.stubEnv("RESEND_API_KEY", "re_test_aucun_envoi");
  dnsRecords.clear();
  dnsRecords.set("resend._domainkey.envoi.newbi.fr", ["p=abc"]);
  dnsRecords.set("send.envoi.newbi.fr", ["v=spf1 include:amazonses.com ~all"]);
  dnsRecords.set("_dmarc.newbi.fr", ["v=DMARC1; p=none"]);
  for (const [userId, role] of [
    [owner, "owner"],
    [editor, "member"],
    [viewer, "viewer"],
    [accountant, "accountant"],
  ]) {
    await seedOrgMembership({
      userId,
      organizationId: workspaceId,
      role,
      organizationName: "Atelier Durand",
    });
  }
  await seedOrgMembership({
    userId: outsider,
    organizationId: otherWorkspace,
    role: "owner",
    organizationName: "Autre espace",
  });
  await mongoose.connection.db.collection("user").insertMany([
    { _id: owner, name: "Jean Dupont", email: "jean@atelier.fr" },
    { _id: editor, name: "Paul Martin", email: "paul@atelier.fr" },
  ]);
  await Client.insertMany(
    ["marie", "luc", "ines"].map((first) =>
      buildClientDoc({
        workspaceId,
        createdBy: owner,
        type: "INDIVIDUAL",
        firstName:
          first === "luc" ? "" : first[0].toUpperCase() + first.slice(1),
        lastName: "Durand",
        name: `${first} Durand`,
        email: `${first}@exemple.fr`,
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("droits", () => {
  it("Comptable : aucun accès", async () => {
    expect(await codeOf(call(Query.emailCampaigns, accountant))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(call(Query.emailCampaignSettings, accountant))).toBe(
      "FORBIDDEN",
    );
    expect(
      await codeOf(
        call(Mutation.createEmailCampaign, accountant, {
          input: { name: "X" },
        }),
      ),
    ).toBe("FORBIDDEN");
  });

  it("Membre : lecture seule", async () => {
    const campaign = await draft();
    const list = await call(Query.emailCampaigns, viewer);
    expect(list.total).toBe(1);
    expect(
      await call(Query.emailCampaign, viewer, { id: String(campaign._id) }),
    ).not.toBeNull();
    for (const [mutation, args] of [
      [Mutation.createEmailCampaign, { input: { name: "X" } }],
      [Mutation.updateEmailCampaign, { id: String(campaign._id), input: {} }],
      [Mutation.duplicateEmailCampaign, { id: String(campaign._id) }],
      [Mutation.deleteEmailCampaign, { id: String(campaign._id) }],
      [Mutation.sendEmailCampaign, { id: String(campaign._id), consent: true }],
      [
        Mutation.sendEmailCampaignTest,
        { id: String(campaign._id), emails: ["a@b.fr"] },
      ],
      [Mutation.addEmailSuppression, { email: "a@b.fr" }],
    ]) {
      expect(await codeOf(call(mutation, viewer, args))).toBe("FORBIDDEN");
    }
  });

  it("Éditeur : crée, modifie et envoie, ne supprime pas", async () => {
    const campaign = await draft(editor);
    expect(campaign.createdByName).toBe("Paul Martin");
    expect(
      await codeOf(
        call(Mutation.deleteEmailCampaign, editor, {
          id: String(campaign._id),
        }),
      ),
    ).toBe("FORBIDDEN");
    const sent = await call(Mutation.sendEmailCampaign, editor, {
      id: String(campaign._id),
      consent: true,
    });
    expect(sent.status).toBe("SENDING");
  });

  it("cloisonnement : la campagne d'un autre espace est introuvable", async () => {
    const campaign = await draft();
    const id = String(campaign._id);
    expect(
      await call(Query.emailCampaign, outsider, { id }, otherWorkspace),
    ).toBeNull();
    expect(
      await codeOf(
        call(
          Mutation.updateEmailCampaign,
          outsider,
          { id, input: { name: "Piratée" } },
          otherWorkspace,
        ),
      ),
    ).toBe("NOT_FOUND");
    expect(
      await codeOf(
        call(
          Query.emailCampaignRecipients,
          outsider,
          { campaignId: id },
          otherWorkspace,
        ),
      ),
    ).toBe("NOT_FOUND");
    // Espace demandé dont l'utilisateur n'est pas membre : refusé
    expect(
      await codeOf(call(Query.emailCampaigns, outsider, {}, workspaceId)),
    ).toBe("FORBIDDEN");
    expect(
      (await call(Query.emailCampaigns, outsider, {}, otherWorkspace)).total,
    ).toBe(0);
  });
});

describe("brouillon", () => {
  it("création depuis un modèle : expéditeur et réponse par défaut", async () => {
    const campaign = await call(Mutation.createEmailCampaign, owner, {
      input: { name: "  Lancement  ", templateKey: "newsletter" },
    });
    expect(campaign).toMatchObject({
      name: "Lancement",
      status: "DRAFT",
      templateKey: "newsletter",
      fromName: "Atelier Durand",
      replyTo: "contact@test.fr",
      createdByName: "Jean Dupont",
    });
    expect(campaign.design.blocks.length).toBeGreaterThan(3);
    expect(Types.EmailCampaign.senderEmail(campaign)).toBe(
      "campagnes@envoi.newbi.fr",
    );
    expect(Types.EmailCampaign.stats(campaign)).toMatchObject({
      recipients: 0,
      opened: 0,
    });
    expect(
      await codeOf(
        call(Mutation.createEmailCampaign, owner, {
          input: { name: "X", templateKey: "inconnu" },
        }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      await codeOf(
        call(Mutation.createEmailCampaign, owner, { input: { name: "   " } }),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  it("saisies contrôlées, texte riche nettoyé à l'enregistrement", async () => {
    const campaign = await draft();
    const id = String(campaign._id);
    const update = (input) =>
      call(Mutation.updateEmailCampaign, owner, { id, input });
    expect(await codeOf(update({ replyTo: "pas-une-adresse" }))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await messageOf(update({ fromName: "x".repeat(61) }))).toBe(
      "Le nom de l'expéditeur ne doit pas dépasser 60 caractères.",
    );
    expect(
      await messageOf(
        update({
          design: {
            blocks: Array.from({ length: 81 }, () => ({ type: "spacer" })),
          },
        }),
      ),
    ).toBe("Un e-mail ne peut pas contenir plus de 80 blocs.");
    const foreignList = await ClientList.create({
      name: "Autre",
      workspaceId: otherWorkspace,
      createdBy: outsider,
    });
    expect(
      await messageOf(
        update({
          audience: { mode: "LISTS", listIds: [String(foreignList._id)] },
        }),
      ),
    ).toBe("Liste de contacts introuvable.");

    const updated = await update({
      subject: "Objet\nsur deux lignes ",
      replyTo: " Contact@Atelier.FR ",
      design: {
        blocks: [
          {
            type: "text",
            html: '<p onclick="x()">Salut<script>alert(1)</script></p>',
          },
        ],
      },
      trackClicks: false,
    });
    expect(updated.subject).toBe("Objet sur deux lignes ");
    expect(updated.replyTo).toBe("contact@atelier.fr");
    expect(updated.design.blocks[0].html).toBe("<p>Salut</p>");
    expect(updated.trackClicks).toBe(false);
  });

  it("seul un brouillon se modifie", async () => {
    const campaign = await draft();
    await call(Mutation.sendEmailCampaign, owner, {
      id: String(campaign._id),
      consent: true,
    });
    expect(
      await messageOf(
        call(Mutation.updateEmailCampaign, owner, {
          id: String(campaign._id),
          input: { name: "Autre" },
        }),
      ),
    ).toMatch(/^Seul un brouillon peut être modifié/);
  });

  it("duplication en brouillon « (copie) »", async () => {
    const campaign = await draft();
    await call(Mutation.sendEmailCampaign, owner, {
      id: String(campaign._id),
      consent: true,
    });
    const copy = await call(Mutation.duplicateEmailCampaign, editor, {
      id: String(campaign._id),
    });
    expect(copy).toMatchObject({
      name: "Nouveautés de novembre (copie)",
      status: "DRAFT",
      subject: "Les nouveautés de l'atelier en novembre",
      createdByName: "Paul Martin",
    });
    expect(Types.EmailCampaign.stats(copy).recipients).toBe(0);
  });

  it("liste : filtre, recherche sans accents, pages, contenu chargé à la demande", async () => {
    await draft();
    const other = await call(Mutation.createEmailCampaign, owner, {
      input: { name: "Été solaire" },
    });
    const page = await call(Query.emailCampaigns, owner, {
      search: "ete",
      page: 1,
      limit: 10,
    });
    expect(page.items.map((c) => c.name)).toEqual(["Été solaire"]);
    expect(page.items[0].design).toBeUndefined();
    const design = await Types.EmailCampaign.design(page.items[0]);
    expect(design.blocks.length).toBeGreaterThan(0);
    const drafts = await call(Query.emailCampaigns, owner, {
      status: "DRAFT",
      page: 1,
      limit: 1,
    });
    expect(drafts).toMatchObject({ total: 2, page: 1, limit: 1 });
    expect(String(drafts.items[0]._id)).toBe(String(other._id));
  });
});

describe("suppression", () => {
  it("brouillon supprimé, envoi en cours refusé, envoyée masquée", async () => {
    const draftCampaign = await draft();
    expect(
      await call(Mutation.deleteEmailCampaign, owner, {
        id: String(draftCampaign._id),
      }),
    ).toBe(true);
    expect(await EmailCampaign.countDocuments()).toBe(0);

    const sending = await draft();
    await call(Mutation.sendEmailCampaign, owner, {
      id: String(sending._id),
      consent: true,
    });
    expect(
      await messageOf(
        call(Mutation.deleteEmailCampaign, owner, { id: String(sending._id) }),
      ),
    ).toBe("Annulez l'envoi de cette campagne avant de la supprimer.");

    await EmailCampaign.updateOne(
      { _id: sending._id },
      { $set: { status: "SENT" } },
    );
    await EmailCampaignRecipient.updateMany(
      { campaignId: sending._id },
      { $set: { status: "SENT", sentAt: new Date() } },
    );
    await call(Mutation.deleteEmailCampaign, owner, {
      id: String(sending._id),
    });
    expect((await call(Query.emailCampaigns, owner)).total).toBe(0);
    // Toujours comptée dans le quota du mois
    expect((await getCampaignQuota(String(workspaceId))).usedThisMonth).toBe(3);
  });
});

describe("envoi", () => {
  it("consentement obligatoire", async () => {
    const campaign = await draft();
    expect(
      await messageOf(
        call(Mutation.sendEmailCampaign, owner, {
          id: String(campaign._id),
          consent: false,
        }),
      ),
    ).toBe(
      "Confirmez que ces contacts sont vos clients ou ont accepté de recevoir vos e-mails.",
    );
  });

  it("refus expliqué par la première erreur de la vérification", async () => {
    const campaign = await draft(owner, { subject: "" });
    expect(
      await messageOf(
        call(Mutation.sendEmailCampaign, owner, {
          id: String(campaign._id),
          consent: true,
        }),
      ),
    ).toBe("Ajoutez un objet avant d'envoyer");
  });

  it("maintenant : destinataires figés ; programmée : SCHEDULED puis déprogrammée", async () => {
    const now = await draft();
    const sent = await call(Mutation.sendEmailCampaign, owner, {
      id: String(now._id),
      consent: true,
    });
    expect(sent.status).toBe("SENDING");
    expect(Types.EmailCampaign.stats(sent).recipients).toBe(3);

    const later = await draft();
    const at = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const scheduled = await call(Mutation.sendEmailCampaign, owner, {
      id: String(later._id),
      consent: true,
      scheduledAt: at,
    });
    expect(scheduled.status).toBe("SCHEDULED");
    expect(scheduled.scheduledAt.toISOString()).toBe(at.toISOString());
    const back = await call(Mutation.unscheduleEmailCampaign, owner, {
      id: String(later._id),
    });
    expect(back).toMatchObject({ status: "DRAFT", scheduledAt: null });

    expect(
      await messageOf(
        call(Mutation.sendEmailCampaign, owner, {
          id: String(later._id),
          consent: true,
          scheduledAt: new Date(Date.now() - 3600 * 1000),
        }),
      ),
    ).toBe("La date d'envoi programmée est déjà passée.");
  });

  it("pause, reprise et annulation par le tableau de bord", async () => {
    const campaign = await draft();
    const id = String(campaign._id);
    await call(Mutation.sendEmailCampaign, owner, { id, consent: true });
    expect(
      (await call(Mutation.pauseEmailCampaign, editor, { id })).status,
    ).toBe("PAUSED");
    expect(
      await codeOf(call(Mutation.pauseEmailCampaign, viewer, { id })),
    ).toBe("FORBIDDEN");
    expect(
      (await call(Mutation.resumeEmailCampaign, editor, { id })).status,
    ).toBe("SENDING");
    const canceled = await call(Mutation.cancelEmailCampaign, owner, { id });
    expect(canceled.status).toBe("CANCELED");
    expect(
      await EmailCampaignRecipient.countDocuments({
        campaignId: campaign._id,
        status: "SKIPPED",
      }),
    ).toBe(3);
    expect(
      await codeOf(call(Mutation.resumeEmailCampaign, owner, { id })),
    ).toBe("VALIDATION_ERROR");
  });
});

describe("aperçu, vérification, audience", () => {
  it("aperçu du brouillon non enregistré, personnalisé pour un contact", async () => {
    const campaign = await draft();
    const marie = await Client.findOne({ email: "marie@exemple.fr" });
    const preview = await call(Query.emailCampaignPreview, owner, {
      id: String(campaign._id),
      subject: "Pour {{prenom}} <3",
      design: {
        blocks: [
          { type: "text", html: "<p>Bonjour {{prenom}} de {{ville}}</p>" },
        ],
      },
      clientId: String(marie._id),
    });
    expect(preview.subject).toBe("Pour Marie <3");
    expect(preview.html).toContain("Bonjour Marie de Paris");
    expect(preview.html).toContain("<title>Pour Marie &lt;3</title>");
    expect(preview.text).toContain("Bonjour Marie de Paris");
    // Rien d'enregistré
    const saved = await EmailCampaign.findById(campaign._id).lean();
    expect(saved.subject).toBe("Les nouveautés de l'atelier en novembre");

    const foreign = await Client.create(
      buildClientDoc({ workspaceId: otherWorkspace, createdBy: outsider }),
    );
    expect(
      await codeOf(
        call(Query.emailCampaignPreview, owner, {
          id: String(campaign._id),
          clientId: String(foreign._id),
        }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("vérification avant envoi et comptage de l'audience", async () => {
    const campaign = await draft();
    const report = await call(Query.emailCampaignDeliverability, owner, {
      id: String(campaign._id),
    });
    expect(report.canSend).toBe(true);
    expect(report.score).toBeGreaterThan(8);
    expect(report.checks.find((c) => c.id === "audience").title).toBe(
      "3 destinataires",
    );
    await EmailSuppression.create({
      workspaceId,
      email: "ines@exemple.fr",
      reason: "UNSUBSCRIBED",
    });
    const count = await call(Query.emailCampaignAudienceCount, owner, {
      audience: { mode: "ALL" },
    });
    expect(count).toMatchObject({
      total: 3,
      sendable: 2,
      suppressed: 1,
      missingFirstName: 1,
    });
  });

  it("réglages et modèles", async () => {
    const settings = await call(Query.emailCampaignSettings, viewer);
    expect(settings).toMatchObject({
      senderEmail: "campagnes@envoi.newbi.fr",
      defaultFromName: "Atelier Durand",
      defaultReplyTo: "contact@test.fr",
      companyAddress: "1 rue du Test, 75001 Paris",
      sendMode: "RESTRICTED",
      quota: {
        plan: "pme",
        monthlyLimit: 2500,
        usedThisMonth: 0,
        remaining: 2500,
      },
    });
    expect(settings.variables.map((v) => v.key)).toEqual([
      "prenom",
      "nom",
      "nom_complet",
      "entreprise",
      "email",
      "ville",
    ]);
    const templates = await call(Query.emailCampaignTemplates, viewer);
    expect(templates.map((t) => t.key)).toEqual([
      "blank",
      "newsletter",
      "promotion",
      "event",
      "plain",
    ]);
  });
});

describe("rapport", () => {
  it("destinataires filtrés et liens les plus cliqués", async () => {
    const campaign = await draft();
    await call(Mutation.sendEmailCampaign, owner, {
      id: String(campaign._id),
      consent: true,
    });
    const recipients = await EmailCampaignRecipient.find({
      campaignId: campaign._id,
    }).sort({ _id: 1 });
    await EmailCampaign.updateOne(
      { _id: campaign._id },
      { $set: { links: ["https://a.fr/", "https://b.fr/"] } },
    );
    await EmailCampaignRecipient.updateOne(
      { _id: recipients[0]._id },
      {
        $set: {
          status: "DELIVERED",
          openedAt: new Date(),
          clickedAt: new Date(),
        },
      },
    );
    await EmailCampaignRecipient.updateOne(
      { _id: recipients[1]._id },
      { $set: { status: "BOUNCED", bouncedAt: new Date() } },
    );
    await EmailCampaignClick.insertMany([
      {
        workspaceId,
        campaignId: campaign._id,
        recipientId: recipients[0]._id,
        linkIndex: 1,
      },
      {
        workspaceId,
        campaignId: campaign._id,
        recipientId: recipients[0]._id,
        linkIndex: 1,
      },
      {
        workspaceId,
        campaignId: campaign._id,
        recipientId: recipients[2]._id,
        linkIndex: 1,
      },
      {
        workspaceId,
        campaignId: campaign._id,
        recipientId: recipients[2]._id,
        linkIndex: 0,
      },
    ]);
    const opened = await call(Query.emailCampaignRecipients, viewer, {
      campaignId: String(campaign._id),
      filter: "OPENED",
    });
    expect(opened.items.map((r) => r.email)).toEqual(["marie@exemple.fr"]);
    const bounced = await call(Query.emailCampaignRecipients, viewer, {
      campaignId: String(campaign._id),
      filter: "BOUNCED",
    });
    expect(bounced.total).toBe(1);
    const searched = await call(Query.emailCampaignRecipients, viewer, {
      campaignId: String(campaign._id),
      filter: "ALL",
      search: "INES",
    });
    expect(searched.items.map((r) => r.email)).toEqual(["ines@exemple.fr"]);
    expect(Types.EmailCampaignRecipient.openCount(searched.items[0])).toBe(0);

    expect(
      await call(Query.emailCampaignLinkStats, viewer, {
        campaignId: String(campaign._id),
      }),
    ).toEqual([
      { url: "https://b.fr/", clicks: 3, uniqueClicks: 2 },
      { url: "https://a.fr/", clicks: 1, uniqueClicks: 1 },
    ]);
  });
});

describe("e-mail de test", () => {
  it("1 à 5 adresses valides, simulé hors production", async () => {
    const campaign = await draft();
    const id = String(campaign._id);
    expect(
      await messageOf(
        call(Mutation.sendEmailCampaignTest, owner, { id, emails: [] }),
      ),
    ).toBe("Indiquez de 1 à 5 adresses e-mail.");
    expect(
      await messageOf(
        call(Mutation.sendEmailCampaignTest, owner, {
          id,
          emails: ["a@b.fr", "c@d.fr", "e@f.fr", "g@h.fr", "i@j.fr", "k@l.fr"],
        }),
      ),
    ).toBe("Indiquez de 1 à 5 adresses e-mail.");
    expect(
      await messageOf(
        call(Mutation.sendEmailCampaignTest, owner, {
          id,
          emails: ["pas-une"],
        }),
      ),
    ).toBe("Adresse e-mail invalide : pas-une");
    const result = await call(Mutation.sendEmailCampaignTest, editor, {
      id,
      emails: ["Moi@Atelier.fr", "moi@atelier.fr"],
    });
    expect(result).toEqual({
      success: true,
      sentTo: ["moi@atelier.fr"],
      simulated: true,
    });
    expect(resendMock.calls).toHaveLength(0);
  });

  it("adresse autorisée hors production : envoi réel (simulé ici), objet préfixé", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "@atelier.fr");
    const campaign = await draft();
    const result = await call(Mutation.sendEmailCampaignTest, owner, {
      id: String(campaign._id),
      emails: ["moi@atelier.fr"],
    });
    expect(result.simulated).toBe(false);
    expect(resendMock.calls[0].payloads[0].subject).toBe(
      "[Test] Les nouveautés de l'atelier en novembre",
    );
  });

  it("adresse rejetée ou plaignante : refusée", async () => {
    const campaign = await draft();
    await EmailSuppression.create({
      workspaceId,
      email: "plainte@exemple.fr",
      reason: "COMPLAINED",
    });
    expect(
      await codeOf(
        call(Mutation.sendEmailCampaignTest, owner, {
          id: String(campaign._id),
          emails: ["plainte@exemple.fr"],
        }),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  it("limité à 20 envois de test par heure", async () => {
    const campaign = await draft();
    for (let i = 0; i < 20; i += 1) {
      await call(Mutation.sendEmailCampaignTest, owner, {
        id: String(campaign._id),
        emails: ["moi@atelier.fr"],
      });
    }
    expect(
      await messageOf(
        call(Mutation.sendEmailCampaignTest, owner, {
          id: String(campaign._id),
          emails: ["moi@atelier.fr"],
        }),
      ),
    ).toBe("Trop d'e-mails de test envoyés : réessayez dans une heure.");
  });
});

describe("liste d'exclusion", () => {
  it("ajout à la main, recherche, retrait des seuls ajouts manuels", async () => {
    const manual = await call(Mutation.addEmailSuppression, editor, {
      email: " Ancien@Client.fr ",
    });
    expect(manual).toMatchObject({
      email: "ancien@client.fr",
      reason: "MANUAL",
    });
    const again = await call(Mutation.addEmailSuppression, editor, {
      email: "ancien@client.fr",
    });
    expect(String(again._id)).toBe(String(manual._id));
    const unsubscribed = await EmailSuppression.create({
      workspaceId,
      email: "parti@exemple.fr",
      reason: "UNSUBSCRIBED",
    });
    const page = await call(Query.emailSuppressions, viewer, {
      search: "ancien",
    });
    expect(page.items.map((s) => s.email)).toEqual(["ancien@client.fr"]);
    expect(
      await messageOf(
        call(Mutation.removeEmailSuppression, editor, {
          id: String(unsubscribed._id),
        }),
      ),
    ).toMatch(/^Seules les adresses ajoutées à la main/);
    expect(
      await call(Mutation.removeEmailSuppression, editor, {
        id: String(manual._id),
      }),
    ).toBe(true);
    expect(await EmailSuppression.countDocuments()).toBe(1);
    expect(
      await codeOf(
        call(Mutation.addEmailSuppression, owner, { email: "pas-une-adresse" }),
      ),
    ).toBe("VALIDATION_ERROR");
  });
});

describe("image", () => {
  it("image redimensionnée, envoyée au stockage public, comptée", async () => {
    const png = await sharp({
      create: { width: 2400, height: 1200, channels: 3, background: "#5a50ff" },
    })
      .png()
      .toBuffer();
    const file = Promise.resolve({
      filename: "bandeau.png",
      mimetype: "image/png",
      createReadStream: () => Readable.from([png]),
    });
    const image = await call(Mutation.uploadEmailCampaignImage, editor, {
      file,
    });
    expect(image.url).toMatch(/^https:\/\/images\.exemple\.test\//);
    const [buffer, , userId, folder, kind, options] =
      cloudflare.uploadSignatureImage.mock.calls[0];
    expect((await sharp(buffer).metadata()).width).toBe(1200);
    expect([userId, folder, kind, options]).toEqual([
      String(editor),
      `campagnes-${workspaceId}`,
      "banner",
      { keepPrevious: true },
    ]);
    expect(storage.recordStoredFile).toHaveBeenCalledWith(
      expect.objectContaining({ category: "branding", key: image.key }),
    );

    const notImage = Promise.resolve({
      filename: "texte.txt",
      mimetype: "text/plain",
      createReadStream: () => Readable.from([Buffer.from("x")]),
    });
    expect(
      await codeOf(
        call(Mutation.uploadEmailCampaignImage, editor, { file: notImage }),
      ),
    ).toBe("VALIDATION_ERROR");
  });
});
