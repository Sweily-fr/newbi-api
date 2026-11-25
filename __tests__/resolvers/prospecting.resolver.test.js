/**
 * Prospection, tableau de bord (GraphQL) : droits par rôle (Comptable
 * refusé, Membre en lecture), propriétaire de la boîte seul à lancer,
 * mettre en pause, reprendre, arrêter, tester, régler ou déconnecter ;
 * réglages ; brouillon (saisies contrôlées, corps nettoyé, signature du
 * propriétaire) ; décompte et vérification ; lancement (consentement,
 * exclusions : particuliers, sans adresse, bloqués, désinscrits, déjà
 * prospectés depuis moins de 30 jours, listes exclues ; variables et
 * identité figées) ; pause, reprise (boîte suspendue réactivée), arrêt ;
 * marquages (« A répondu », « Ne plus contacter ») ; rapport et historique
 * d'un contact ; aperçu ; e-mail de test (simulé, ou Gmail simulé par
 * fetch) ; suppression. Aucun envoi réel.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));
vi.mock("../../src/services/signatureAssets.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ensureIcons: vi.fn(async () => {}),
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { decodeHeader, parseMime } from "../helpers/mime.js";
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
import EmailSignatureV2 from "../../src/models/EmailSignatureV2.js";
import EmailSuppression from "../../src/models/EmailSuppression.js";
import MailboxConnection from "../../src/models/MailboxConnection.js";
import ProspectingRecipient from "../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../src/models/ProspectingSequence.js";
import prospectingResolvers from "../../src/resolvers/prospecting.js";
import {
  TOKEN_KINDS,
  verifyCampaignToken,
} from "../../src/services/emailCampaigns/tracking.js";
import { OWNER_ONLY_MESSAGE } from "../../src/services/prospecting/sequences.js";

const { Query, Mutation } = prospectingResolvers;

const workspaceId = buildOrganizationId();
const otherWorkspace = buildOrganizationId();
const owner = buildUserId();
const editor = buildUserId();
const viewer = buildUserId();
const accountant = buildUserId();
const outsider = buildUserId();
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const ctx = (userId, organizationId = workspaceId) =>
  buildContext({ userId, organizationId });
const call = (resolver, userId, args = {}, organizationId = workspaceId) =>
  resolver(
    null,
    { workspaceId: String(organizationId), ...args },
    ctx(userId, organizationId),
    { fieldName: "test" },
  );
const failure = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return {
      code: error.code || error.extensions?.code,
      message: error.message,
      details: error.details,
    };
  }
};

const gmail = { sends: [] };
let clients;
let lists;

async function connectMailbox(userId = owner, overrides = {}) {
  return MailboxConnection.create({
    workspaceId,
    userId,
    provider: "GOOGLE",
    accountEmail: "jean@atelier-durand.fr",
    accountName: "Jean Dupont",
    accessToken: "acces",
    refreshToken: "rafraichissement",
    tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    status: "ACTIVE",
    connectedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
    ...overrides,
  });
}

const GOOD_BODY =
  "<p>Bonjour {{prenom|à vous}},</p><p>Votre activité ({{activite|votre métier}}) correspond à nos services.</p>";

async function draft(input = {}, userId = owner) {
  return call(Mutation.createProspectingSequence, userId, {
    input: {
      name: "Menuisiers de Lyon",
      subject: "Une idée pour {{entreprise}}",
      body: GOOD_BODY,
      audience: { mode: "LISTS", listIds: [String(lists.prospects._id)] },
      ...input,
    },
  });
}

beforeAll(async () => {
  await startMongo();
  await Promise.all([
    Client.init(),
    ClientList.init(),
    EmailSignatureV2.init(),
    EmailSuppression.init(),
    MailboxConnection.init(),
    ProspectingSequence.init(),
    ProspectingRecipient.init(),
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
  gmail.sends = [];
  vi.clearAllMocks();
  vi.stubEnv("CALENDAR_ENCRYPTION_KEY", "cle-de-test-boites");
  vi.stubEnv("JWT_SECRET", "secret-de-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
  vi.stubEnv("FRONTEND_URL", "https://app.exemple.test");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("PROSPECTING_GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_ID", "");
  vi.stubEnv("PROSPECTING_MICROSOFT_CLIENT_SECRET", "");
  vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_ID", "");
  vi.stubEnv("MICROSOFT_CALENDAR_CLIENT_SECRET", "");
  vi.stubEnv("PROSPECTING_MAX_DAILY_PER_MAILBOX", "");
  // Hors production, sans adresse autorisée : tout est simulé
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
  vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
  vi.stubGlobal("fetch", async (url, options = {}) => {
    if (String(url) === SEND_URL) {
      const { raw } = JSON.parse(options.body);
      gmail.sends.push(Buffer.from(raw, "base64url").toString("utf8"));
      return new Response(JSON.stringify({ id: "msg-test", threadId: "t" }), {
        status: 200,
      });
    }
    if (String(url) === "https://oauth2.googleapis.com/revoke") {
      gmail.revoked = Object.fromEntries(new URLSearchParams(options.body));
      return new Response("{}", { status: 200 });
    }
    throw new Error(`appel réseau inattendu : ${url}`);
  });
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
    { _id: owner, name: "Jean Dupont", email: "jean@newbi-membre.fr" },
    { _id: editor, name: "Paul Martin", email: "paul@newbi-membre.fr" },
  ]);
  const company = (name, email, extra = {}) =>
    buildClientDoc({
      workspaceId,
      createdBy: owner,
      type: "COMPANY",
      name,
      email,
      ...extra,
    });
  const generated = (activityLabel) => ({
    prospect: {
      provider: "societeinfo",
      siren: "123456789",
      activityLabel,
      website: "www.exemple.fr",
    },
  });
  clients = {
    lemoine: await Client.create(
      company("Menuiserie Lemoine", "contact@lemoine.fr", {
        firstName: "Marie",
        lastName: "Lemoine",
        ...generated("Menuiserie"),
      }),
    ),
    bois: await Client.create(
      company("Bois et Fils", "contact@bois-fils.fr", generated("Charpente")),
    ),
    saisi: await Client.create(company("Atelier Saisi", "bonjour@saisi.fr")),
    particulier: await Client.create(
      buildClientDoc({
        workspaceId,
        createdBy: owner,
        type: "INDIVIDUAL",
        firstName: "Luc",
        lastName: "Martin",
        name: "Luc Martin",
        email: "luc.martin@exemple.fr",
      }),
    ),
    bloque: await Client.create(
      company("Entreprise Bloquée", "contact@bloquee.fr", { isBlocked: true }),
    ),
    desinscrit: await Client.create(
      company("Entreprise Désinscrite", "contact@desinscrite.fr"),
    ),
    recent: await Client.create(
      company("Déjà Contactée", "contact@deja.fr", generated("Plomberie")),
    ),
    sansEmail: await Client.create({
      ...company("Sans Adresse", undefined, generated("Peinture")),
      email: undefined,
    }),
    exclu: await Client.create(company("Concurrent Exclu", "contact@exclu.fr")),
  };
  lists = {
    prospects: await ClientList.create({
      workspaceId,
      createdBy: owner,
      name: "Prospects",
      clients: Object.values(clients).map((c) => c._id),
    }),
    exclusions: await ClientList.create({
      workspaceId,
      createdBy: owner,
      name: "Concurrents",
      clients: [clients.exclu._id],
    }),
    foreign: await ClientList.create({
      workspaceId: otherWorkspace,
      createdBy: outsider,
      name: "Autre",
      clients: [],
    }),
  };
  await EmailSuppression.create({
    workspaceId,
    email: "contact@desinscrite.fr",
    reason: "UNSUBSCRIBED",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Prospection lancée par le propriétaire (boîte connectée). */
async function launched(input = {}) {
  await connectMailbox();
  const sequence = await draft({
    audience: {
      mode: "LISTS",
      listIds: [String(lists.prospects._id)],
      excludeListIds: [String(lists.exclusions._id)],
    },
    ...input,
  });
  return call(Mutation.launchProspectingSequence, owner, {
    id: sequence.id,
    consent: true,
  });
}

describe("droits", () => {
  it("Comptable : aucun accès ; Membre : lecture seule", async () => {
    expect(
      (await failure(call(Query.prospectingSequences, accountant))).code,
    ).toBe("FORBIDDEN");
    expect(
      (await failure(call(Query.prospectingSettings, accountant))).code,
    ).toBe("FORBIDDEN");
    expect(await call(Query.prospectingSequences, viewer)).toEqual([]);
    expect(
      (
        await failure(
          call(Mutation.createProspectingSequence, viewer, { input: {} }),
        )
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("une prospection d'un autre espace est introuvable", async () => {
    await connectMailbox();
    const sequence = await draft();
    expect(
      await call(
        Query.prospectingSequence,
        outsider,
        { id: sequence.id },
        otherWorkspace,
      ),
    ).toBeNull();
    expect(
      (
        await failure(
          call(
            Query.prospectingVerification,
            outsider,
            { id: sequence.id },
            otherWorkspace,
          ),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });
});

describe("réglages et boîte d'envoi", () => {
  it("sans boîte : fournisseurs, variables, limites, page « Vos données »", async () => {
    const settings = await call(Query.prospectingSettings, owner);
    expect(settings.providers).toEqual({ google: true, microsoft: false });
    expect(settings.myMailbox).toBeNull();
    expect(settings.mailboxes).toEqual([]);
    expect(settings.variables.map((v) => v.key)).toEqual([
      "prenom",
      "nom",
      "nom_complet",
      "entreprise",
      "email",
      "ville",
      "activite",
      "site",
    ]);
    expect(settings.defaultDailyLimit).toBe(30);
    expect(settings.maxDailyLimit).toBe(50);
    expect(settings.dataPageUrl).toMatch(
      /^https:\/\/api\.exemple\.test\/api\/prospection\/donnees\//,
    );
    // Mode d'envoi des campagnes : hors production, envois simulés sauf
    // adresses autorisées
    expect(settings.sendMode).toBe("RESTRICTED");
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "simulation");
    expect((await call(Query.prospectingSettings, owner)).sendMode).toBe(
      "SIMULATION",
    );
    vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "live");
    expect((await call(Query.prospectingSettings, owner)).sendMode).toBe(
      "LIVE",
    );
  });

  it("boîte connectée : vue du propriétaire et des autres membres", async () => {
    await connectMailbox(owner, {
      accountEmail: "jean.dupont@gmail.com",
      connectedAt: new Date(),
    });
    const mine = (await call(Query.prospectingSettings, owner)).myMailbox;
    expect(mine).toMatchObject({
      provider: "GOOGLE",
      accountEmail: "jean.dupont@gmail.com",
      accountName: "Jean Dupont",
      isPersonalAddress: true,
      status: "ACTIVE",
      dailyLimit: 30,
      effectiveDailyLimit: 10,
      sentToday: 0,
      sendWindow: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 },
      signatureId: null,
      isMine: true,
      ownerName: "Jean Dupont",
    });
    expect(mine.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const seenByViewer = await call(Query.prospectingSettings, viewer);
    expect(seenByViewer.myMailbox).toBeNull();
    expect(seenByViewer.mailboxes).toHaveLength(1);
    expect(seenByViewer.mailboxes[0].isMine).toBe(false);
  });

  it("réglages de la boîte : propriétaire seul, valeurs contrôlées, signature du propriétaire", async () => {
    const mailbox = await connectMailbox();
    const signature = await EmailSignatureV2.create({
      workspaceId,
      createdBy: owner,
      name: "Ma signature",
      identity: { firstName: "Jean", lastName: "Dupont" },
    });
    const foreignSignature = await EmailSignatureV2.create({
      workspaceId,
      createdBy: editor,
      name: "Signature de Paul",
      identity: { firstName: "Paul" },
    });
    const update = (input, userId = owner) =>
      call(Mutation.updateProspectingMailbox, userId, {
        id: String(mailbox._id),
        input,
      });
    const updated = await update({
      dailyLimit: 40,
      sendWindow: { days: [5, 1, 3], startHour: 8, endHour: 12 },
      signatureId: String(signature._id),
    });
    expect(updated).toMatchObject({
      dailyLimit: 40,
      sendWindow: { days: [1, 3, 5], startHour: 8, endHour: 12 },
      signatureId: String(signature._id),
    });
    expect((await failure(update({ dailyLimit: 3 }))).message).toBe(
      "Choisissez entre 5 et 50 e-mails par jour.",
    );
    expect((await failure(update({ dailyLimit: 60 }))).code).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      (
        await failure(
          update({ sendWindow: { days: [], startHour: 9, endHour: 18 } }),
        )
      ).message,
    ).toMatch(/^Plage d'envoi invalide/);
    expect(
      (
        await failure(
          update({ sendWindow: { days: [1], startHour: 18, endHour: 9 } }),
        )
      ).code,
    ).toBe("VALIDATION_ERROR");
    expect(
      (await failure(update({ signatureId: String(foreignSignature._id) })))
        .message,
    ).toBe("Signature introuvable.");
    expect((await failure(update({ dailyLimit: 20 }, editor))).code).toBe(
      "FORBIDDEN",
    );
    expect(await update({ signatureId: null })).toMatchObject({
      signatureId: null,
    });
  });

  it("déconnexion : accès Google révoqué, jetons effacés, prospections en pause", async () => {
    const { id } = await launched();
    const mailbox = await MailboxConnection.findOne().lean();
    expect(
      (
        await failure(
          call(Mutation.disconnectProspectingMailbox, editor, {
            id: String(mailbox._id),
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      await call(Mutation.disconnectProspectingMailbox, owner, {
        id: String(mailbox._id),
      }),
    ).toBe(true);
    expect(gmail.revoked).toEqual({ token: "rafraichissement" });
    const after = await MailboxConnection.findById(mailbox._id).lean();
    expect(after).toMatchObject({
      status: "DISCONNECTED",
      accessToken: null,
      refreshToken: null,
    });
    const sequence = await call(Query.prospectingSequence, owner, { id });
    expect(sequence).toMatchObject({ status: "PAUSED", pauseKind: "MAILBOX" });
    expect(sequence.mailbox.status).toBe("DISCONNECTED");
    expect((await call(Query.prospectingSettings, owner)).myMailbox).toBeNull();
  });
});

describe("brouillon", () => {
  it("création refusée sans boîte connectée", async () => {
    expect(
      (
        await failure(
          call(Mutation.createProspectingSequence, owner, { input: {} }),
        )
      ).message,
    ).toBe("Connectez d'abord votre boîte d'envoi (Gmail ou Outlook).");
  });

  it("création : boîte du membre, listes choisies par défaut, signature de la boîte, corps nettoyé", async () => {
    const signature = await EmailSignatureV2.create({
      workspaceId,
      createdBy: owner,
      name: "Ma signature",
      identity: { firstName: "Jean", lastName: "Dupont" },
    });
    await connectMailbox(owner, { signatureId: signature._id });
    const sequence = await call(Mutation.createProspectingSequence, owner, {
      input: { body: '<p onclick="x()">Bonjour</p><script>alert(1)</script>' },
    });
    expect(sequence).toMatchObject({
      name: "Nouvelle prospection",
      status: "DRAFT",
      audience: { mode: "LISTS", listIds: [], excludeListIds: [] },
      body: "<p>Bonjour</p>",
      subject: "",
      signatureId: String(signature._id),
      createdByName: "Jean Dupont",
      canSend: true,
      estimatedEndDate: null,
      stats: { recipients: 0, pending: 0 },
    });
    expect(sequence.mailbox.accountEmail).toBe("jean@atelier-durand.fr");
    expect(sequence.createdAt).toMatch(/^\d{4}-/);
  });

  it("modification : brouillon seul, saisies contrôlées", async () => {
    await connectMailbox();
    const sequence = await draft();
    const update = (input) =>
      call(Mutation.updateProspectingSequence, editor, {
        id: sequence.id,
        input,
      });
    expect(
      (await update({ subject: "Nouvel objet", body: "<p>A<img src=x></p>" }))
        .body,
    ).toBe("<p>A</p>");
    expect((await failure(update({ subject: "x".repeat(201) }))).message).toBe(
      "L'objet ne doit pas dépasser 200 caractères.",
    );
    expect((await failure(update({ name: "  " }))).message).toBe(
      "Donnez un nom à la prospection.",
    );
    expect(
      (
        await failure(
          update({
            audience: { mode: "LISTS", listIds: [String(lists.foreign._id)] },
          }),
        )
      ).message,
    ).toBe("Liste de contacts introuvable.");
    await call(Mutation.launchProspectingSequence, owner, {
      id: sequence.id,
      consent: true,
    });
    expect((await failure(update({ subject: "Trop tard" }))).message).toBe(
      "Seul un brouillon peut être modifié.",
    );
  });

  it("suppression : brouillon effacé, prospection en cours refusée, terminée masquée", async () => {
    await connectMailbox();
    const first = await draft();
    expect(
      await call(Mutation.deleteProspectingSequence, owner, { id: first.id }),
    ).toBe(true);
    expect(await ProspectingSequence.countDocuments()).toBe(0);

    const second = await draft();
    await call(Mutation.launchProspectingSequence, owner, {
      id: second.id,
      consent: true,
    });
    expect(
      (
        await failure(
          call(Mutation.deleteProspectingSequence, owner, { id: second.id }),
        )
      ).message,
    ).toBe("Arrêtez la prospection avant de la supprimer.");
    await call(Mutation.cancelProspectingSequence, owner, { id: second.id });
    expect(
      await call(Mutation.deleteProspectingSequence, owner, { id: second.id }),
    ).toBe(true);
    expect(await call(Query.prospectingSequences, owner)).toEqual([]);
    // Ses envois restent (règle des 30 jours, historique des contacts)
    expect(await ProspectingRecipient.countDocuments()).toBeGreaterThan(0);
  });
});

describe("décompte et vérification", () => {
  it("décompte de l'audience : chaque contact écarté dans sa case", async () => {
    const other = await ProspectingSequence.create({
      workspaceId,
      mailboxId: new mongoose.Types.ObjectId(),
      name: "Ancienne",
      status: "COMPLETED",
    });
    await ProspectingRecipient.create({
      workspaceId,
      sequenceId: other._id,
      mailboxId: other.mailboxId,
      email: "contact@deja.fr",
      status: "SENT",
      sentAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    });
    const count = await call(Query.prospectingAudienceCount, viewer, {
      audience: {
        mode: "LISTS",
        listIds: [String(lists.prospects._id)],
        excludeListIds: [String(lists.exclusions._id)],
      },
    });
    expect(count).toEqual({
      total: 9,
      sendable: 3,
      noEmail: 1,
      invalidEmail: 0,
      individuals: 1,
      blocked: 1,
      suppressed: 1,
      recentlyContacted: 1,
      duplicates: 0,
      excludedByList: 1,
      missingFirstName: 2,
    });
  });

  it("vérification d'un brouillon prêt : aucune erreur, exclusions, durée prévue", async () => {
    await connectMailbox(owner, { accountEmail: "jean.dupont@gmail.com" });
    const sequence = await draft();
    const report = await call(Query.prospectingVerification, owner, {
      id: sequence.id,
    });
    expect(report.canSend).toBe(true);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.mailbox.level).toBe("OK");
    expect(byId.mailbox_personal.level).toBe("INFO");
    expect(byId.legal.level).toBe("OK");
    expect(byId.audience.title).toBe("5 destinataires");
    expect(byId.audience_exclusions).toMatchObject({ level: "INFO" });
    expect(byId.audience_exclusions.detail).toContain(
      "1 particulier (jamais prospecté par e-mail)",
    );
    expect(byId.schedule.level).toBe("INFO");
    expect(report.audience.sendable).toBe(5);
    expect(report.estimatedDays).toBeGreaterThanOrEqual(1);
    expect(report.estimatedEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(report)).not.toContain("—");
  });

  it("erreurs bloquantes : objet, variable inconnue, accolades, adresse de l'entreprise, audience vide ; prénom sans repli", async () => {
    await connectMailbox();
    await mongoose.connection.db
      .collection("organization")
      .updateOne({ _id: workspaceId }, { $set: { addressStreet: "" } });
    const sequence = await draft({
      subject: "",
      body: "<p>Bonjour {{prenom}} {{prénom}} {{ville</p>",
      audience: { mode: "LISTS", listIds: [] },
    });
    const report = await call(Query.prospectingVerification, owner, {
      id: sequence.id,
    });
    expect(report.canSend).toBe(false);
    const errors = report.checks
      .filter((c) => c.level === "ERROR")
      .map((c) => c.id);
    expect(errors).toEqual(
      expect.arrayContaining([
        "subject_empty",
        "variables_unknown_1",
        "variables_braces",
        "legal_address",
        "audience_empty",
      ]),
    );
    const withFirstNames = await draft({ body: "<p>Bonjour {{prenom}},</p>" });
    const warning = (
      await call(Query.prospectingVerification, owner, {
        id: withFirstNames.id,
      })
    ).checks.find((c) => c.id === "variables_first_name");
    expect(warning).toMatchObject({
      level: "WARNING",
      title: "4 destinataires n'ont pas de prénom",
    });
  });
});

describe("lancement", () => {
  it("consentement exigé", async () => {
    await connectMailbox();
    const sequence = await draft();
    const error = await failure(
      call(Mutation.launchProspectingSequence, owner, {
        id: sequence.id,
        consent: false,
      }),
    );
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      message:
        "Cochez la case : vos destinataires doivent être des professionnels et votre message doit concerner leur activité.",
    });
    expect((await ProspectingSequence.findById(sequence.id)).status).toBe(
      "DRAFT",
    );
  });

  it("seul le propriétaire de la boîte lance", async () => {
    await connectMailbox();
    const sequence = await draft();
    expect(
      await failure(
        call(Mutation.launchProspectingSequence, editor, {
          id: sequence.id,
          consent: true,
        }),
      ),
    ).toMatchObject({ code: "FORBIDDEN", message: OWNER_ONLY_MESSAGE });
    const seenByEditor = await call(Query.prospectingSequence, editor, {
      id: sequence.id,
    });
    expect(seenByEditor.canSend).toBe(false);
  });

  it("vérification en erreur : refus avec la première erreur", async () => {
    await connectMailbox(owner, { status: "EXPIRED" });
    const sequence = await draft();
    const error = await failure(
      call(Mutation.launchProspectingSequence, owner, {
        id: sequence.id,
        consent: true,
      }),
    );
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Reconnectez votre boîte d'envoi",
    });
    expect(error.details.checks.map((c) => c.id)).toContain("mailbox_expired");
    expect(await ProspectingRecipient.countDocuments()).toBe(0);
  });

  it("destinataires figés (exclusions appliquées), identité et consentement tracés", async () => {
    const signature = await EmailSignatureV2.create({
      workspaceId,
      createdBy: owner,
      name: "Ma signature",
      identity: { firstName: "Jean", lastName: "Dupont", jobTitle: "Gérant" },
    });
    const other = await ProspectingSequence.create({
      workspaceId,
      mailboxId: new mongoose.Types.ObjectId(),
      name: "Ancienne",
      status: "COMPLETED",
    });
    await ProspectingRecipient.create({
      workspaceId,
      sequenceId: other._id,
      mailboxId: other.mailboxId,
      email: "contact@deja.fr",
      status: "SENT",
      sentAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
    });
    const sequence = await launched({ signatureId: String(signature._id) });
    expect(sequence).toMatchObject({
      status: "ACTIVE",
      canSend: true,
      stats: { recipients: 3, pending: 3 },
    });
    expect(sequence.startedAt).toMatch(/^\d{4}-/);
    expect(sequence.consentAt).toMatch(/^\d{4}-/);
    expect(sequence.estimatedEndDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const stored = await ProspectingSequence.findById(sequence.id).lean();
    expect(String(stored.consentBy)).toBe(String(owner));
    expect(stored.snapshot).toMatchObject({
      senderEmail: "jean@atelier-durand.fr",
      senderName: "Jean Dupont",
      companyName: "Atelier Durand",
      companyAddress: "1 rue du Test, 75001 Paris",
    });
    expect(stored.snapshot.dataPageUrl).toMatch(
      /\/api\/prospection\/donnees\//,
    );
    expect(stored.snapshot.signatureHtml).toContain("Gérant");
    const recipients = await ProspectingRecipient.find({
      sequenceId: sequence.id,
    })
      .sort({ email: 1 })
      .lean();
    expect(recipients.map((r) => r.email)).toEqual([
      "bonjour@saisi.fr",
      "contact@bois-fils.fr",
      "contact@lemoine.fr",
    ]);
    const lemoine = recipients.find((r) => r.email === "contact@lemoine.fr");
    expect(lemoine).toMatchObject({
      name: "Menuiserie Lemoine",
      company: "Menuiserie Lemoine",
      isGeneratedProspect: true,
      status: "PENDING",
      vars: {
        prenom: "Marie",
        entreprise: "Menuiserie Lemoine",
        activite: "Menuiserie",
        site: "www.exemple.fr",
      },
    });
    expect(
      recipients.find((r) => r.email === "bonjour@saisi.fr")
        .isGeneratedProspect,
    ).toBe(false);
    expect(
      (
        await failure(
          call(Mutation.launchProspectingSequence, owner, {
            id: sequence.id,
            consent: true,
          }),
        )
      ).message,
    ).toBe("Seul un brouillon peut être lancé.");
  });
});

describe("pause, reprise, arrêt", () => {
  it("pause et reprise par le propriétaire seulement", async () => {
    const { id } = await launched();
    expect(
      (await failure(call(Mutation.pauseProspectingSequence, editor, { id })))
        .code,
    ).toBe("FORBIDDEN");
    expect(
      await call(Mutation.pauseProspectingSequence, owner, { id }),
    ).toMatchObject({
      status: "PAUSED",
      pauseKind: "MANUAL",
      pausedReason: "Prospection mise en pause.",
      estimatedEndDate: null,
    });
    expect(
      (await failure(call(Mutation.resumeProspectingSequence, editor, { id })))
        .code,
    ).toBe("FORBIDDEN");
    expect(
      await call(Mutation.resumeProspectingSequence, owner, { id }),
    ).toMatchObject({ status: "ACTIVE", pauseKind: null, pausedReason: null });
  });

  it("reprise : boîte suspendue par le coupe-circuit réactivée ; boîte expirée refusée", async () => {
    const { id } = await launched();
    const mailbox = await MailboxConnection.findOne();
    await MailboxConnection.updateOne(
      { _id: mailbox._id },
      {
        $set: {
          status: "PAUSED",
          pauseKind: "REPUTATION",
          pausedReason: "Envois suspendus pour protéger votre réputation.",
        },
      },
    );
    await ProspectingSequence.updateOne(
      { _id: id },
      { $set: { status: "PAUSED", pauseKind: "MAILBOX" } },
    );
    const resumed = await call(Mutation.resumeProspectingSequence, owner, {
      id,
    });
    expect(resumed.status).toBe("ACTIVE");
    expect(resumed.mailbox).toMatchObject({
      status: "ACTIVE",
      pausedReason: null,
    });

    await call(Mutation.pauseProspectingSequence, owner, { id });
    await MailboxConnection.updateOne(
      { _id: mailbox._id },
      { $set: { status: "EXPIRED" } },
    );
    expect(
      (await failure(call(Mutation.resumeProspectingSequence, owner, { id })))
        .message,
    ).toBe(
      "Reconnectez votre boîte d'envoi avant de reprendre la prospection.",
    );
  });

  it("arrêt : destinataires en attente écartés", async () => {
    const { id } = await launched();
    const canceled = await call(Mutation.cancelProspectingSequence, owner, {
      id,
    });
    expect(canceled).toMatchObject({
      status: "CANCELED",
      stats: { recipients: 4, pending: 0, skipped: 4 },
    });
    expect(canceled.completedAt).toMatch(/^\d{4}-/);
    const skipped = await ProspectingRecipient.find({ sequenceId: id }).lean();
    expect(
      skipped.every((r) => r.skippedReason === "prospection arrêtée"),
    ).toBe(true);
    expect(
      (await failure(call(Mutation.cancelProspectingSequence, owner, { id })))
        .message,
    ).toBe("Seule une prospection en cours ou en pause peut être arrêtée.");
  });
});

describe("marquages, rapport et historique", () => {
  async function sentRecipient() {
    const { id } = await launched();
    const recipient = await ProspectingRecipient.findOne({
      sequenceId: id,
      email: "contact@lemoine.fr",
    });
    await ProspectingRecipient.updateOne(
      { _id: recipient._id },
      { $set: { status: "SENT", sentAt: new Date() } },
    );
    return { sequenceId: id, recipient };
  }

  it("« A répondu » : message parti seulement, dernier contact posé sur la fiche", async () => {
    const { sequenceId, recipient } = await sentRecipient();
    const pending = await ProspectingRecipient.findOne({
      sequenceId,
      status: "PENDING",
    });
    expect(
      (
        await failure(
          call(Mutation.markProspectingRecipient, editor, {
            id: String(pending._id),
            action: "REPLIED",
          }),
        )
      ).message,
    ).toBe(
      "Seul un destinataire à qui le message est parti peut être marqué « A répondu ».",
    );
    const marked = await call(Mutation.markProspectingRecipient, editor, {
      id: String(recipient._id),
      action: "REPLIED",
    });
    expect(marked).toMatchObject({
      status: "REPLIED",
      email: "contact@lemoine.fr",
      sequenceId: String(sequenceId),
      sequenceName: "Menuisiers de Lyon",
    });
    expect(marked.repliedAt).toMatch(/^\d{4}-/);
    const client = await Client.findById(clients.lemoine._id).lean();
    expect(client.prospect.lastContactAt).toBeInstanceOf(Date);
    expect(client.prospect.provider).toBe("societeinfo");
    expect(
      (await ProspectingSequence.findById(sequenceId).lean()).stats.replied,
    ).toBe(1);
    expect(
      (
        await failure(
          call(Mutation.markProspectingRecipient, viewer, {
            id: String(recipient._id),
            action: "REPLIED",
          }),
        )
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("« Ne plus contacter » : liste d'exclusion commune, désinscrit (ou écarté s'il attendait)", async () => {
    const { sequenceId, recipient } = await sentRecipient();
    const marked = await call(Mutation.markProspectingRecipient, owner, {
      id: String(recipient._id),
      action: "DO_NOT_CONTACT",
    });
    expect(marked.status).toBe("UNSUBSCRIBED");
    expect(marked.unsubscribedAt).toMatch(/^\d{4}-/);
    const suppression = await EmailSuppression.findOne({
      email: "contact@lemoine.fr",
    }).lean();
    expect(suppression).toMatchObject({
      reason: "UNSUBSCRIBED",
      source: "prospecting-reply",
    });
    expect(String(suppression.sequenceId)).toBe(String(sequenceId));
    expect(String(suppression.createdBy)).toBe(String(owner));

    const pending = await ProspectingRecipient.findOne({
      sequenceId,
      status: "PENDING",
    });
    const skipped = await call(Mutation.markProspectingRecipient, owner, {
      id: String(pending._id),
      action: "DO_NOT_CONTACT",
    });
    expect(skipped).toMatchObject({
      status: "SKIPPED",
      error: "ne plus contacter",
    });
  });

  it("rapport : filtre par statut, recherche, pagination ; historique d'un contact", async () => {
    const { sequenceId } = await sentRecipient();
    const all = await call(Query.prospectingRecipients, viewer, {
      id: sequenceId,
    });
    expect(all.total).toBe(4);
    const sent = await call(Query.prospectingRecipients, viewer, {
      id: sequenceId,
      status: "SENT",
    });
    expect(sent.items.map((r) => r.email)).toEqual(["contact@lemoine.fr"]);
    expect(sent.items[0]).toMatchObject({
      sequenceId: String(sequenceId),
      sequenceName: "Menuisiers de Lyon",
      name: "Menuiserie Lemoine",
      company: "Menuiserie Lemoine",
      clientId: String(clients.lemoine._id),
      error: null,
    });
    const searched = await call(Query.prospectingRecipients, viewer, {
      id: sequenceId,
      search: "bois",
    });
    expect(searched.items.map((r) => r.email)).toEqual([
      "contact@bois-fils.fr",
    ]);
    const page = await call(Query.prospectingRecipients, viewer, {
      id: sequenceId,
      offset: 1,
      limit: 1,
    });
    expect(page).toMatchObject({ total: 4 });
    expect(page.items).toHaveLength(1);

    const history = await call(Query.clientProspectingHistory, viewer, {
      clientId: String(clients.lemoine._id),
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: "SENT",
      email: "contact@lemoine.fr",
      sequenceId: String(sequenceId),
      sequenceName: "Menuisiers de Lyon",
    });
    expect(history[0].sentAt).toMatch(/^\d{4}-/);
    expect(
      await call(Query.clientProspectingHistory, viewer, {
        clientId: String(clients.bois._id),
      }),
    ).toEqual([]);
  });
});

describe("prospection d'origine des destinataires", () => {
  it("historique d'un contact : nom de chaque prospection, une seule lecture groupée", async () => {
    const mailboxId = new mongoose.Types.ObjectId();
    const make = (name, extra = {}) =>
      ProspectingSequence.create({
        workspaceId,
        mailboxId,
        name,
        status: "COMPLETED",
        ...extra,
      });
    const spring = await make("Printemps");
    const autumn = await make("Automne");
    // Supprimée après son lancement : masquée, son nom reste
    const hidden = await make("Ancienne", { deletedAt: new Date() });
    const missing = new mongoose.Types.ObjectId();
    const sentAt = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);
    await ProspectingRecipient.create(
      [spring, autumn, hidden, { _id: missing }].map((sequence, index) => ({
        workspaceId,
        sequenceId: sequence._id,
        mailboxId,
        clientId: clients.lemoine._id,
        email: "contact@lemoine.fr",
        status: "SENT",
        sentAt: sentAt(index + 1),
      })),
    );
    const find = vi.spyOn(ProspectingSequence, "find");
    const history = await call(Query.clientProspectingHistory, viewer, {
      clientId: String(clients.lemoine._id),
    });
    expect(history.map((r) => [r.sequenceId, r.sequenceName])).toEqual([
      [String(spring._id), "Printemps"],
      [String(autumn._id), "Automne"],
      [String(hidden._id), "Ancienne"],
      [String(missing), "Prospection supprimée"],
    ]);
    expect(find).toHaveBeenCalledTimes(1);
    find.mockRestore();
  });

  it("rapport : le nom vient de la prospection déjà lue (aucune lecture en plus)", async () => {
    const { id } = await launched();
    const find = vi.spyOn(ProspectingSequence, "find");
    const page = await call(Query.prospectingRecipients, viewer, { id });
    expect(page.items.length).toBeGreaterThan(0);
    expect(
      page.items.every(
        (r) => r.sequenceId === id && r.sequenceName === "Menuisiers de Lyon",
      ),
    ).toBe(true);
    expect(find).not.toHaveBeenCalled();
    find.mockRestore();
  });
});

describe("aperçu et e-mail de test", () => {
  it("aperçu avec un vrai prospect, objet et message non enregistrés", async () => {
    await connectMailbox();
    const sequence = await draft();
    const preview = await call(Query.prospectingPreview, viewer, {
      id: sequence.id,
      subject: "Bonjour {{entreprise}}",
      body: "<p>Activité : {{activite}}</p>",
      clientId: String(clients.lemoine._id),
    });
    expect(preview.subject).toBe("Bonjour Menuiserie Lemoine");
    expect(preview.text).toContain("Activité : Menuiserie");
    expect(preview.text).toContain("Societeinfo");
    const unsubscribe = /Se désinscrire : (\S+)/.exec(preview.text)[1];
    expect(
      verifyCampaignToken(
        TOKEN_KINDS.prospectingTestUnsubscribe,
        new URL(unsubscribe).searchParams.get("t"),
      ),
    ).toBe(sequence.id);
    const example = await call(Query.prospectingPreview, viewer, {
      id: sequence.id,
    });
    expect(example.subject).toBe("Une idée pour Atelier Durand");
    expect(
      (
        await failure(
          call(Query.prospectingPreview, viewer, {
            id: sequence.id,
            clientId: String(new mongoose.Types.ObjectId()),
          }),
        )
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("test : propriétaire seul, simulé par défaut (adresse de la boîte)", async () => {
    await connectMailbox();
    const sequence = await draft();
    expect(
      await call(Mutation.sendProspectingTest, owner, { id: sequence.id }),
    ).toEqual(["jean@atelier-durand.fr"]);
    expect(gmail.sends).toHaveLength(0);
    expect(
      (
        await failure(
          call(Mutation.sendProspectingTest, editor, { id: sequence.id }),
        )
      ).code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await failure(
          call(Mutation.sendProspectingTest, owner, {
            id: sequence.id,
            emails: [
              "a@x.fr",
              "b@x.fr",
              "c@x.fr",
              "d@x.fr",
              "e@x.fr",
              "f@x.fr",
            ],
          }),
        )
      ).message,
    ).toBe("Indiquez de 1 à 5 adresses e-mail.");
    expect(
      (
        await failure(
          call(Mutation.sendProspectingTest, owner, {
            id: sequence.id,
            emails: ["pas-une-adresse"],
          }),
        )
      ).message,
    ).toBe("Adresse e-mail invalide : pas-une-adresse");
  });

  it("test vers une adresse autorisée : envoyé depuis la boîte, objet « [Test] », désinscription sans effet", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "@atelier-durand.fr");
    await connectMailbox();
    const sequence = await draft();
    expect(
      await call(Mutation.sendProspectingTest, owner, {
        id: sequence.id,
        emails: ["Moi@Atelier-Durand.fr"],
      }),
    ).toEqual(["moi@atelier-durand.fr"]);
    expect(gmail.sends).toHaveLength(1);
    const message = parseMime(gmail.sends[0]);
    expect(message.headers.from).toBe('"Jean Dupont" <jean@atelier-durand.fr>');
    expect(message.headers.to).toBe("moi@atelier-durand.fr");
    expect(decodeHeader(message.headers.subject)).toMatch(
      /^\[Test\] Une idée pour /,
    );
    const unsubscribe = /^<(.+)>$/.exec(message.headers["list-unsubscribe"])[1];
    expect(
      verifyCampaignToken(
        TOKEN_KINDS.prospectingTestUnsubscribe,
        new URL(unsubscribe).searchParams.get("t"),
      ),
    ).toBe(sequence.id);
  });
});
