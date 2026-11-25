/**
 * Prospection, saisies vues par GraphQL (schéma complet, comme server.js) :
 *   - `signatureId: null` présent dans l'entrée RETIRE la signature d'une
 *     prospection ou d'une boîte, un champ absent la laisse inchangée ;
 *   - e-mail de test sans adresses (`emails: null`, vide ou absent) : envoyé
 *     à l'adresse de la boîte ;
 *   - mode d'envoi et prospection d'origine des destinataires exposés.
 * Gmail simulé par fetch : aucun appel réel, aucun e-mail réel.
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

vi.hoisted(() => {
  // Services instanciés à l'import : configuration factice, aucun appel réel
  const buckets = [
    "USER_IMAGE_BUCKET",
    "PROFILE_IMAGE_BUCKET",
    "COMPANY_IMAGE_BUCKET",
    "SIGNATURE_BUCKET",
    "ICONS_BUCKET",
    "OCR_BUCKET",
    "LOGO_BUCKET",
    "TRANSFER_BUCKET",
    "INVOICES_BUCKET",
    "QUOTES_BUCKET",
    "CREDIT_NOTES_BUCKET",
    "PURCHASE_ORDERS_BUCKET",
  ];
  for (const key of buckets) process.env[key] = process.env[key] || "test";
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
  process.env.SMTP_ENCRYPTION_KEY =
    process.env.SMTP_ENCRYPTION_KEY || "a".repeat(64);
});

// Pas de .env réel chargé par les services : aucune clé d'API utilisable
vi.mock("dotenv", () => ({
  default: { config: () => ({ parsed: {} }) },
  config: () => ({ parsed: {} }),
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterator: () => ({}),
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
  default: {},
}));
vi.mock("../../src/services/signatureAssets.js", async (importOriginal) => ({
  ...(await importOriginal()),
  ensureIcons: vi.fn(async () => {}),
}));

import { ApolloServer } from "apollo-server-express";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { parseMime } from "../helpers/mime.js";
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
import MailboxConnection from "../../src/models/MailboxConnection.js";
import ProspectingRecipient from "../../src/models/ProspectingRecipient.js";
import ProspectingSequence from "../../src/models/ProspectingSequence.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const MAILBOX_EMAIL = "jean@atelier-durand.fr";

let server;
let mailbox;
let signatures;
let list;
const sends = [];

/** Opération GraphQL du propriétaire de la boîte ; erreur levée si refus. */
async function run(source, variables = {}) {
  const result = await server.executeOperation(
    {
      query: source,
      variables: { workspaceId: String(workspaceId), ...variables },
    },
    buildContext({ userId: owner, organizationId: workspaceId }),
  );
  if (result.errors?.length) {
    throw new Error(result.errors.map((error) => error.message).join(" | "));
  }
  return result.data;
}

const CREATE = `mutation ($workspaceId: ID!, $input: ProspectingSequenceInput!) {
  createProspectingSequence(workspaceId: $workspaceId, input: $input) {
    id
    signatureId
  }
}`;

const UPDATE_SEQUENCE = `mutation ($workspaceId: ID!, $id: ID!, $input: ProspectingSequenceInput!) {
  updateProspectingSequence(workspaceId: $workspaceId, id: $id, input: $input) {
    subject
    signatureId
  }
}`;

const UPDATE_MAILBOX = `mutation ($workspaceId: ID!, $id: ID!, $input: ProspectingMailboxInput!) {
  updateProspectingMailbox(workspaceId: $workspaceId, id: $id, input: $input) {
    dailyLimit
    signatureId
  }
}`;

async function createDraft() {
  const data = await run(CREATE, {
    input: {
      name: "Menuisiers de Lyon",
      subject: "Une idée pour {{entreprise}}",
      body: "<p>Bonjour {{prenom|à vous}},</p>",
      audience: { mode: "LISTS", listIds: [String(list._id)] },
    },
  });
  return data.createProspectingSequence;
}

beforeAll(async () => {
  await startMongo();
  const typeDefs = (await import("../../src/schemas/index.js")).default;
  const resolvers = (await import("../../src/resolvers/index.js")).default;
  // Schéma complet, contexte de la requête passé tel quel (comme server.js)
  server = new ApolloServer({
    typeDefs,
    resolvers,
    context: (requestContext) => requestContext,
  });
  await Promise.all([
    Client.init(),
    ClientList.init(),
    EmailSignatureV2.init(),
    MailboxConnection.init(),
    ProspectingSequence.init(),
    ProspectingRecipient.init(),
  ]);
}, 120000);

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache();
  invalidateOrganizationRoles();
  resetMemoryAttempts();
  sends.length = 0;
  vi.stubEnv("JWT_SECRET", "secret-de-test");
  vi.stubEnv("BETTER_AUTH_SECRET", "");
  vi.stubEnv("BACKEND_URL", "https://api.exemple.test");
  vi.stubEnv("EMAIL_CAMPAIGN_SEND_MODE", "");
  vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "");
  vi.stubGlobal("fetch", async (url, options = {}) => {
    if (String(url) !== SEND_URL) {
      throw new Error(`appel réseau inattendu : ${url}`);
    }
    const { raw } = JSON.parse(options.body);
    sends.push(parseMime(Buffer.from(raw, "base64url").toString("utf8")));
    return new Response(JSON.stringify({ id: "msg-test", threadId: "t" }), {
      status: 200,
    });
  });
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
    organizationName: "Atelier Durand",
  });
  await mongoose.connection.db
    .collection("user")
    .insertOne({ _id: owner, name: "Jean Dupont", email: "jean@newbi.test" });
  signatures = await EmailSignatureV2.create([
    {
      workspaceId,
      createdBy: owner,
      name: "Signature A",
      identity: { firstName: "Jean", lastName: "Dupont" },
    },
    {
      workspaceId,
      createdBy: owner,
      name: "Signature B",
      identity: { firstName: "Jean", lastName: "Dupont", jobTitle: "Gérant" },
    },
  ]);
  mailbox = await MailboxConnection.create({
    workspaceId,
    userId: owner,
    provider: "GOOGLE",
    accountEmail: MAILBOX_EMAIL,
    accountName: "Jean Dupont",
    accessToken: "acces",
    refreshToken: "rafraichissement",
    tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    status: "ACTIVE",
    signatureId: signatures[0]._id,
  });
  const client = await Client.create(
    buildClientDoc({
      workspaceId,
      createdBy: owner,
      type: "COMPANY",
      name: "Menuiserie Lemoine",
      email: "contact@lemoine.fr",
    }),
  );
  list = await ClientList.create({
    workspaceId,
    createdBy: owner,
    name: "Prospects",
    clients: [client._id],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("signatureId : absent = inchangée, null = retirée", () => {
  it("prospection (updateProspectingSequence)", async () => {
    const draft = await createDraft();
    // Signature de la boîte reprise à la création
    expect(draft.signatureId).toBe(String(signatures[0]._id));

    const untouched = await run(UPDATE_SEQUENCE, {
      id: draft.id,
      input: { subject: "Nouvel objet" },
    });
    expect(untouched.updateProspectingSequence).toEqual({
      subject: "Nouvel objet",
      signatureId: String(signatures[0]._id),
    });

    const changed = await run(UPDATE_SEQUENCE, {
      id: draft.id,
      input: { signatureId: String(signatures[1]._id) },
    });
    expect(changed.updateProspectingSequence.signatureId).toBe(
      String(signatures[1]._id),
    );

    const removed = await run(UPDATE_SEQUENCE, {
      id: draft.id,
      input: { signatureId: null },
    });
    expect(removed.updateProspectingSequence).toEqual({
      subject: "Nouvel objet",
      signatureId: null,
    });
    expect((await ProspectingSequence.findById(draft.id)).signatureId).toBe(
      null,
    );

    // Écrit en dur dans la requête : même effet
    const again = await run(UPDATE_SEQUENCE, {
      id: draft.id,
      input: { signatureId: String(signatures[0]._id) },
    });
    expect(again.updateProspectingSequence.signatureId).toBe(
      String(signatures[0]._id),
    );
    const literal = await run(
      `mutation ($workspaceId: ID!, $id: ID!) {
        updateProspectingSequence(workspaceId: $workspaceId, id: $id, input: { signatureId: null }) {
          signatureId
        }
      }`,
      { id: draft.id },
    );
    expect(literal.updateProspectingSequence.signatureId).toBeNull();
  });

  it("boîte d'envoi (updateProspectingMailbox)", async () => {
    const id = String(mailbox._id);
    const untouched = await run(UPDATE_MAILBOX, {
      id,
      input: { dailyLimit: 20 },
    });
    expect(untouched.updateProspectingMailbox).toEqual({
      dailyLimit: 20,
      signatureId: String(signatures[0]._id),
    });

    const removed = await run(UPDATE_MAILBOX, {
      id,
      input: { signatureId: null },
    });
    expect(removed.updateProspectingMailbox).toEqual({
      dailyLimit: 20,
      signatureId: null,
    });
    expect((await MailboxConnection.findById(id)).signatureId).toBeNull();

    const set = await run(UPDATE_MAILBOX, {
      id,
      input: { signatureId: String(signatures[1]._id) },
    });
    expect(set.updateProspectingMailbox.signatureId).toBe(
      String(signatures[1]._id),
    );
  });
});

describe("e-mail de test sans adresses : adresse de la boîte", () => {
  it("emails null, liste vide ou argument absent", async () => {
    // Adresse de la boîte autorisée : envoi réel (vers Gmail simulé)
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "@atelier-durand.fr");
    const draft = await createDraft();
    const withEmails = `mutation ($workspaceId: ID!, $id: ID!, $emails: [String!]) {
      sendProspectingTest(workspaceId: $workspaceId, id: $id, emails: $emails)
    }`;
    const withoutEmails = `mutation ($workspaceId: ID!, $id: ID!) {
      sendProspectingTest(workspaceId: $workspaceId, id: $id)
    }`;

    for (const [source, variables] of [
      [withEmails, { id: draft.id, emails: null }],
      [withEmails, { id: draft.id, emails: [] }],
      [withoutEmails, { id: draft.id }],
    ]) {
      const data = await run(source, variables);
      expect(data.sendProspectingTest).toEqual([MAILBOX_EMAIL]);
    }
    expect(sends).toHaveLength(3);
    for (const message of sends) {
      expect(message.headers.to).toBe(MAILBOX_EMAIL);
      expect(message.headers.from).toBe(`"Jean Dupont" <${MAILBOX_EMAIL}>`);
    }
  });

  it("adresses données : elles seules sont servies", async () => {
    vi.stubEnv("EMAIL_CAMPAIGN_DEV_RECIPIENTS", "@atelier-durand.fr");
    const draft = await createDraft();
    const data = await run(
      `mutation ($workspaceId: ID!, $id: ID!, $emails: [String!]) {
        sendProspectingTest(workspaceId: $workspaceId, id: $id, emails: $emails)
      }`,
      { id: draft.id, emails: ["Paul@Atelier-Durand.fr"] },
    );
    expect(data.sendProspectingTest).toEqual(["paul@atelier-durand.fr"]);
    expect(sends.map((message) => message.headers.to)).toEqual([
      "paul@atelier-durand.fr",
    ]);
  });
});

describe("champs ajoutés au contrat", () => {
  it("mode d'envoi des réglages, prospection d'origine des destinataires", async () => {
    const settings = await run(`query ($workspaceId: ID!) {
      prospectingSettings(workspaceId: $workspaceId) { sendMode }
    }`);
    expect(settings.prospectingSettings.sendMode).toBe("RESTRICTED");

    const draft = await createDraft();
    await run(
      `mutation ($workspaceId: ID!, $id: ID!) {
        launchProspectingSequence(workspaceId: $workspaceId, id: $id, consent: true) { status }
      }`,
      { id: draft.id },
    );
    const report = await run(
      `query ($workspaceId: ID!, $id: ID!) {
        prospectingRecipients(workspaceId: $workspaceId, id: $id) {
          total
          items { email sequenceId sequenceName }
        }
      }`,
      { id: draft.id },
    );
    expect(report.prospectingRecipients).toEqual({
      total: 1,
      items: [
        {
          email: "contact@lemoine.fr",
          sequenceId: draft.id,
          sequenceName: "Menuisiers de Lyon",
        },
      ],
    });
  });
});
