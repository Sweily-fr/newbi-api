/**
 * Prospection : le schéma GraphQL complet se construit (typeDefs et
 * resolvers fusionnés, comme server.js) et respecte à la lettre le contrat
 * technique V1 partagé avec le site : chaque type, champ, argument et
 * valeur d'énumération du contrat existe avec exactement la même
 * signature, chaque requête et mutation a son resolver, toutes sont
 * fermées par l'accès anticipé (clé « prospecting »).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

vi.hoisted(() => {
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

import {
  buildSchema,
  isObjectType,
  isInputObjectType,
  isEnumType,
} from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";

// Types des campagnes réutilisés par le contrat
const CAMPAIGN_TYPES = `
enum EmailCampaignAudienceMode { ALL LISTS }
enum EmailCampaignCheckLevel { OK INFO WARNING ERROR }
type EmailCampaignAudience { mode: EmailCampaignAudienceMode! listIds: [ID!]! excludeListIds: [ID!]! }
input EmailCampaignAudienceInput { mode: EmailCampaignAudienceMode! listIds: [ID!] excludeListIds: [ID!] }
type EmailCampaignVariable { key: String! label: String! example: String! }
type EmailCampaignCheck { id: String! category: String! level: EmailCampaignCheckLevel! title: String! detail: String }
`;

// Contrat technique V1 (section GraphQL), tel quel
const CONTRACT = `
enum MailboxProvider { GOOGLE MICROSOFT }
enum MailboxStatus { ACTIVE EXPIRED PAUSED DISCONNECTED }
enum ProspectingSequenceStatus { DRAFT ACTIVE PAUSED COMPLETED CANCELED }
enum ProspectingRecipientStatus { PENDING SENT SIMULATED REPLIED BOUNCED UNSUBSCRIBED FAILED SKIPPED }
enum ProspectingRecipientAction { REPLIED DO_NOT_CONTACT }

type ProspectingSendWindow { days: [Int!]! startHour: Int! endHour: Int! }

type ProspectingMailbox {
  id: ID!
  provider: MailboxProvider!
  accountEmail: String!
  accountName: String
  "Adresse gratuite (gmail.com, outlook.*, hotmail.*, live.*) : conseil d'utiliser une adresse pro"
  isPersonalAddress: Boolean!
  status: MailboxStatus!
  pausedReason: String
  dailyLimit: Int!
  "Limite du jour après la montée progressive"
  effectiveDailyLimit: Int!
  sentToday: Int!
  sendWindow: ProspectingSendWindow!
  signatureId: ID
  connectedAt: String!
  "Boîte du membre connecté"
  isMine: Boolean!
  ownerName: String
}

type ProspectingProviders { google: Boolean! microsoft: Boolean! }

type ProspectingSettings {
  providers: ProspectingProviders!
  myMailbox: ProspectingMailbox
  mailboxes: [ProspectingMailbox!]!
  variables: [EmailCampaignVariable!]!
  defaultDailyLimit: Int!
  maxDailyLimit: Int!
  dataPageUrl: String!
}

type ProspectingStats {
  recipients: Int! pending: Int! sent: Int! simulated: Int! replied: Int!
  bounced: Int! unsubscribed: Int! failed: Int! skipped: Int!
}

type ProspectingSequence {
  id: ID!
  name: String!
  status: ProspectingSequenceStatus!
  pauseKind: String
  pausedReason: String
  mailbox: ProspectingMailbox
  audience: EmailCampaignAudience!
  subject: String!
  body: String!
  signatureId: ID
  stats: ProspectingStats!
  "AAAA-MM-JJ, fin prévue au rythme de la boîte (null sans boîte ni destinataire)"
  estimatedEndDate: String
  consentAt: String
  startedAt: String
  completedAt: String
  createdAt: String!
  updatedAt: String!
  createdByName: String
  "Le membre connecté peut lancer, mettre en pause, reprendre ou arrêter (sa boîte + droit send)"
  canSend: Boolean!
}

type ProspectingAudienceCount {
  total: Int! sendable: Int! noEmail: Int! invalidEmail: Int!
  "Fiches de particuliers : jamais prospectées par e-mail sans consentement"
  individuals: Int!
  blocked: Int! suppressed: Int!
  "Déjà prospectés par l'espace depuis moins de 30 jours"
  recentlyContacted: Int!
  duplicates: Int! excludedByList: Int! missingFirstName: Int!
}

type ProspectingVerification {
  canSend: Boolean!
  checks: [EmailCampaignCheck!]!
  audience: ProspectingAudienceCount!
  "Jours ouvrés d'envoi prévus au rythme actuel de la boîte"
  estimatedDays: Int
  estimatedEndDate: String
}

type ProspectingPreview { subject: String! html: String! text: String! }

type ProspectingRecipient {
  id: ID!
  clientId: ID
  email: String!
  name: String!
  company: String
  status: ProspectingRecipientStatus!
  sentAt: String
  repliedAt: String
  bouncedAt: String
  unsubscribedAt: String
  error: String
}

type ProspectingRecipientPage { items: [ProspectingRecipient!]! total: Int! }

input ProspectingSendWindowInput { days: [Int!]! startHour: Int! endHour: Int! }
input ProspectingMailboxInput { dailyLimit: Int sendWindow: ProspectingSendWindowInput signatureId: ID }
input ProspectingSequenceInput {
  name: String
  audience: EmailCampaignAudienceInput
  subject: String
  body: String
  signatureId: ID
}

extend type Query {
  prospectingSettings(workspaceId: ID!): ProspectingSettings!
  prospectingSequences(workspaceId: ID!, status: ProspectingSequenceStatus): [ProspectingSequence!]!
  prospectingSequence(workspaceId: ID!, id: ID!): ProspectingSequence
  prospectingAudienceCount(workspaceId: ID!, audience: EmailCampaignAudienceInput!): ProspectingAudienceCount!
  prospectingVerification(workspaceId: ID!, id: ID!): ProspectingVerification!
  "subject/body facultatifs : aperçu du brouillon en cours d'édition sans l'enregistrer ; clientId : un vrai prospect, sinon valeurs d'exemple"
  prospectingPreview(workspaceId: ID!, id: ID!, subject: String, body: String, clientId: ID): ProspectingPreview!
  prospectingRecipients(workspaceId: ID!, id: ID!, status: ProspectingRecipientStatus, search: String, offset: Int, limit: Int): ProspectingRecipientPage!
  "Envois de prospection reçus par un contact (fiche contact)"
  clientProspectingHistory(workspaceId: ID!, clientId: ID!): [ProspectingRecipient!]!
}

extend type Mutation {
  updateProspectingMailbox(workspaceId: ID!, id: ID!, input: ProspectingMailboxInput!): ProspectingMailbox!
  "Révoque le jeton chez le fournisseur si possible, efface les jetons, met les prospections ACTIVE de la boîte en PAUSED (MAILBOX)"
  disconnectProspectingMailbox(workspaceId: ID!, id: ID!): Boolean!
  "La boîte est celle du membre connecté (refus s'il n'en a pas)"
  createProspectingSequence(workspaceId: ID!, input: ProspectingSequenceInput!): ProspectingSequence!
  updateProspectingSequence(workspaceId: ID!, id: ID!, input: ProspectingSequenceInput!): ProspectingSequence!
  deleteProspectingSequence(workspaceId: ID!, id: ID!): Boolean!
  "Envoie le brouillon depuis la boîte à 1 à 5 adresses (défaut : l'adresse de la boîte), objet préfixé « [Test] », variables d'exemple ou du premier destinataire ; renvoie les adresses servies"
  sendProspectingTest(workspaceId: ID!, id: ID!, emails: [String!]): [String!]!
  launchProspectingSequence(workspaceId: ID!, id: ID!, consent: Boolean!): ProspectingSequence!
  pauseProspectingSequence(workspaceId: ID!, id: ID!): ProspectingSequence!
  resumeProspectingSequence(workspaceId: ID!, id: ID!): ProspectingSequence!
  cancelProspectingSequence(workspaceId: ID!, id: ID!): ProspectingSequence!
  markProspectingRecipient(workspaceId: ID!, id: ID!, action: ProspectingRecipientAction!): ProspectingRecipient!
}
`;

let schema;
let contract;
let resolvers;

const signature = (field) => ({
  type: String(field.type),
  args: (field.args || []).map((arg) => ({
    name: arg.name,
    type: String(arg.type),
    defaultValue: arg.defaultValue ?? null,
  })),
});

const SKIPPED_TYPES = new Set([
  "Query",
  "Mutation",
  "Boolean",
  "String",
  "Int",
  "Float",
  "ID",
]);

beforeAll(async () => {
  const typeDefs = (await import("../../src/schemas/index.js")).default;
  resolvers = (await import("../../src/resolvers/index.js")).default;
  schema = makeExecutableSchema({ typeDefs, resolvers });
  contract = buildSchema(
    `type Query { _: Boolean } type Mutation { _: Boolean } ${CAMPAIGN_TYPES} ${CONTRACT}`,
  );
}, 120000);

describe("schéma de la prospection", () => {
  it("se construit avec tous les resolvers fusionnés", () => {
    expect(schema.getQueryType().getFields().prospectingSettings).toBeDefined();
    expect(
      schema.getType("WorkspaceFeatures").getFields().prospecting,
    ).toBeDefined();
  });

  it("chaque type du contrat existe à l'identique", () => {
    const differences = [];
    for (const type of Object.values(contract.getTypeMap())) {
      if (type.name.startsWith("__") || SKIPPED_TYPES.has(type.name)) continue;
      const actual = schema.getType(type.name);
      if (!actual) {
        differences.push(`${type.name} absent`);
        continue;
      }
      if (isEnumType(type)) {
        const expected = type.getValues().map((v) => v.name);
        const got = actual.getValues().map((v) => v.name);
        if (JSON.stringify(expected) !== JSON.stringify(got)) {
          differences.push(`${type.name} : ${got.join(",")}`);
        }
        continue;
      }
      if (isObjectType(type) || isInputObjectType(type)) {
        const expectedFields = type.getFields();
        const actualFields = actual.getFields();
        if (
          Object.keys(expectedFields).sort().join() !==
          Object.keys(actualFields).sort().join()
        ) {
          differences.push(`${type.name} : champs différents`);
        }
        for (const [name, field] of Object.entries(expectedFields)) {
          const got = actualFields[name];
          if (
            !got ||
            JSON.stringify(signature(field)) !== JSON.stringify(signature(got))
          ) {
            differences.push(`${type.name}.${name}`);
          }
        }
      }
    }
    expect(differences).toEqual([]);
  });

  it("requêtes et mutations du contrat : mêmes signatures et un resolver chacune", () => {
    const differences = [];
    for (const root of ["Query", "Mutation"]) {
      const expectedFields = contract.getType(root).getFields();
      const actualFields = schema.getType(root).getFields();
      for (const [name, field] of Object.entries(expectedFields)) {
        if (name === "_") continue;
        const got = actualFields[name];
        if (
          !got ||
          JSON.stringify(signature(field)) !== JSON.stringify(signature(got))
        ) {
          differences.push(`${root}.${name}`);
        }
        if (typeof resolvers[root][name] !== "function") {
          differences.push(`${root}.${name} sans resolver`);
        }
      }
    }
    expect(differences).toEqual([]);
  });
});

describe("accès anticipé", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("toutes les requêtes et mutations sont fermées aux espaces hors BETA_WORKSPACE_IDS", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "prospecting");
    vi.stubEnv("BETA_WORKSPACE_IDS", "69acc3e24ddf8f41fec80c04");
    const context = {
      user: { _id: "65a1b2c3d4e5f6a7b8c9d0e1" },
      req: { headers: {} },
    };
    const names = ["Query", "Mutation"].flatMap((root) =>
      Object.keys(contract.getType(root).getFields())
        .filter((name) => name !== "_")
        .map((name) => [root, name]),
    );
    // 8 requêtes, 11 mutations
    expect(names.length).toBe(19);
    for (const [root, name] of names) {
      const error = await resolvers[root][name](
        null,
        { workspaceId: "68cda7820000000000000001" },
        context,
        { fieldName: name },
      ).catch((caught) => caught);
      expect(error?.details?.reason, name).toBe("FEATURE_NOT_AVAILABLE");
    }
  });
});
