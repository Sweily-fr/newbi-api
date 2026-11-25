/**
 * Campagnes e-mail : le schéma GraphQL complet se construit (typeDefs et
 * resolvers fusionnés, comme server.js) et respecte à la lettre le contrat
 * partagé avec le site (spécification d'origine, puis adresse d'envoi Newbi
 * et « Connecter mon domaine ») : chaque type, champ, argument et valeur par
 * défaut du contrat existe avec exactement la même signature.
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

// Contrat de la spécification (section 4), tel quel
const CONTRACT = `
enum EmailCampaignStatus { DRAFT SCHEDULED SENDING PAUSED SENT CANCELED }
enum EmailCampaignAudienceMode { ALL LISTS }
enum EmailCampaignRecipientStatus { PENDING SENT DELIVERED BOUNCED COMPLAINED FAILED SIMULATED SKIPPED }
enum EmailCampaignRecipientFilter { ALL OPENED CLICKED NOT_OPENED BOUNCED UNSUBSCRIBED FAILED }
enum EmailCampaignCheckLevel { OK INFO WARNING ERROR }

type EmailCampaignAudience { mode: EmailCampaignAudienceMode! listIds: [ID!]! excludeListIds: [ID!]! }
input EmailCampaignAudienceInput { mode: EmailCampaignAudienceMode! listIds: [ID!] excludeListIds: [ID!] }

type EmailCampaignStats {
  recipients: Int!  sent: Int!  simulated: Int!  delivered: Int!
  opened: Int!
  clicked: Int!
  opens: Int!  clicks: Int!  bounced: Int!  complained: Int!  unsubscribed: Int!  failed: Int!
}

type EmailCampaign {
  id: ID!  workspaceId: ID!  name: String!  status: EmailCampaignStatus!
  subject: String!  preheader: String!  fromName: String!  replyTo: String!
  senderEmail: String!
  design: JSON!  audience: EmailCampaignAudience!
  trackOpens: Boolean!  trackClicks: Boolean!
  privacyPolicyUrl: String!  trackingPurgedAt: DateTime
  scheduledAt: DateTime  startedAt: DateTime  completedAt: DateTime  pausedReason: String
  stats: EmailCampaignStats!
  createdByName: String  createdAt: DateTime!  updatedAt: DateTime!
}
type EmailCampaignPage { items: [EmailCampaign!]! total: Int! page: Int! limit: Int! }

type EmailCampaignAudienceCount {
  total: Int!  sendable: Int!  noEmail: Int!  invalidEmail: Int!  blocked: Int!
  suppressed: Int!
  duplicates: Int!  excludedByList: Int!  missingFirstName: Int!
  prospects: Int!
}
type EmailCampaignQuota { plan: String!  monthlyLimit: Int!  usedThisMonth: Int!  remaining: Int! }
type EmailCampaignVariable { key: String!  label: String!  example: String! }
type EmailCampaignSettings {
  senderEmail: String!  defaultFromName: String!  defaultReplyTo: String!
  companyAddress: String
  sendMode: String!
  quota: EmailCampaignQuota!  variables: [EmailCampaignVariable!]!
  newbiSenderEmail: String!
  sendingDomain: EmailSendingDomain
  canManageSendingDomain: Boolean!
}

enum EmailSendingDomainStatus {
  NOT_STARTED PENDING VERIFIED PARTIALLY_VERIFIED PARTIALLY_FAILED
  TEMPORARY_FAILURE FAILED EXPIRED
}

type EmailSendingDomainRecord {
  kind: String!
  type: String!
  name: String!
  fqdn: String!
  value: String!
  priority: Int
  status: String!
}

type EmailSendingDomain {
  id: ID!
  domain: String!
  fromEmail: String!
  status: EmailSendingDomainStatus!
  active: Boolean!
  records: [EmailSendingDomainRecord!]!
  zone: String!
  dnsProvider: String
  lastCheckedAt: DateTime
  verifiedAt: DateTime
  expiresAt: DateTime
  createdAt: DateTime!
}
type EmailCampaignTemplate { key: String!  name: String!  description: String!  design: JSON! }
type EmailCampaignPreview { subject: String!  preheader: String!  html: String!  text: String! }
type EmailCampaignCheck { id: String!  category: String!  level: EmailCampaignCheckLevel!  title: String!  detail: String }
type EmailCampaignDeliverability { score: Float!  canSend: Boolean!  checks: [EmailCampaignCheck!]! }
type EmailCampaignRecipient {
  id: ID!  email: String!  name: String  clientId: ID  status: EmailCampaignRecipientStatus!
  sentAt: DateTime  deliveredAt: DateTime  openedAt: DateTime  clickedAt: DateTime
  bouncedAt: DateTime  complainedAt: DateTime  unsubscribedAt: DateTime
  openCount: Int!  clickCount: Int!  error: String
}
type EmailCampaignRecipientPage { items: [EmailCampaignRecipient!]!  total: Int!  page: Int!  limit: Int! }
type EmailCampaignLinkStat { url: String!  clicks: Int!  uniqueClicks: Int! }
type EmailCampaignTestResult { success: Boolean!  sentTo: [String!]!  simulated: Boolean! }
type EmailSuppression { id: ID!  email: String!  reason: String!  createdAt: DateTime!  campaignId: ID }
type EmailSuppressionPage { items: [EmailSuppression!]!  total: Int!  page: Int!  limit: Int! }
type EmailCampaignImage { url: String!  key: String! }

input CreateEmailCampaignInput { name: String!  templateKey: String }
input UpdateEmailCampaignInput {
  name: String  subject: String  preheader: String  fromName: String  replyTo: String
  design: JSON  audience: EmailCampaignAudienceInput  trackOpens: Boolean  trackClicks: Boolean
  privacyPolicyUrl: String
}

extend type Query {
  emailCampaigns(workspaceId: ID!, status: EmailCampaignStatus, search: String, page: Int = 1, limit: Int = 20): EmailCampaignPage!
  emailCampaign(workspaceId: ID!, id: ID!): EmailCampaign
  emailCampaignSettings(workspaceId: ID!): EmailCampaignSettings!
  emailCampaignTemplates(workspaceId: ID!): [EmailCampaignTemplate!]!
  emailCampaignAudienceCount(workspaceId: ID!, audience: EmailCampaignAudienceInput!): EmailCampaignAudienceCount!
  emailCampaignPreview(workspaceId: ID!, id: ID!, design: JSON, subject: String, preheader: String, clientId: ID): EmailCampaignPreview!
  emailCampaignDeliverability(workspaceId: ID!, id: ID!): EmailCampaignDeliverability!
  emailCampaignRecipients(workspaceId: ID!, campaignId: ID!, filter: EmailCampaignRecipientFilter = ALL, search: String, page: Int = 1, limit: Int = 50): EmailCampaignRecipientPage!
  emailCampaignLinkStats(workspaceId: ID!, campaignId: ID!): [EmailCampaignLinkStat!]!
  emailSuppressions(workspaceId: ID!, search: String, page: Int = 1, limit: Int = 50): EmailSuppressionPage!
  emailSendingDomain(workspaceId: ID!): EmailSendingDomain
}

extend type Mutation {
  createEmailCampaign(workspaceId: ID!, input: CreateEmailCampaignInput!): EmailCampaign!
  updateEmailCampaign(workspaceId: ID!, id: ID!, input: UpdateEmailCampaignInput!): EmailCampaign!
  duplicateEmailCampaign(workspaceId: ID!, id: ID!): EmailCampaign!
  deleteEmailCampaign(workspaceId: ID!, id: ID!): Boolean!
  sendEmailCampaignTest(workspaceId: ID!, id: ID!, emails: [String!]!, clientId: ID): EmailCampaignTestResult!
  sendEmailCampaign(workspaceId: ID!, id: ID!, scheduledAt: DateTime, consent: Boolean!, trackingConsent: Boolean): EmailCampaign!
  unscheduleEmailCampaign(workspaceId: ID!, id: ID!): EmailCampaign!
  pauseEmailCampaign(workspaceId: ID!, id: ID!): EmailCampaign!
  resumeEmailCampaign(workspaceId: ID!, id: ID!): EmailCampaign!
  cancelEmailCampaign(workspaceId: ID!, id: ID!): EmailCampaign!
  uploadEmailCampaignImage(workspaceId: ID!, file: Upload!): EmailCampaignImage!
  addEmailSuppression(workspaceId: ID!, email: String!): EmailSuppression!
  removeEmailSuppression(workspaceId: ID!, id: ID!): Boolean!
  connectEmailSendingDomain(workspaceId: ID!, fromEmail: String!): EmailSendingDomain!
  verifyEmailSendingDomain(workspaceId: ID!): EmailSendingDomain!
  updateEmailSendingDomainSender(workspaceId: ID!, fromEmail: String!): EmailSendingDomain!
  disconnectEmailSendingDomain(workspaceId: ID!): Boolean!
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

beforeAll(async () => {
  const typeDefs = (await import("../../src/schemas/index.js")).default;
  resolvers = (await import("../../src/resolvers/index.js")).default;
  schema = makeExecutableSchema({ typeDefs, resolvers });
  contract = buildSchema(
    `scalar JSON scalar DateTime scalar Upload type Query { _: Boolean } type Mutation { _: Boolean } ${CONTRACT}`,
  );
}, 120000);

describe("schéma des campagnes e-mail", () => {
  it("se construit avec tous les resolvers fusionnés", () => {
    expect(schema.getQueryType().getFields().emailCampaigns).toBeDefined();
    expect(
      schema.getType("WorkspaceFeatures").getFields().emailCampaigns,
    ).toBeDefined();
  });

  it("chaque type du contrat existe à l'identique", () => {
    const differences = [];
    for (const type of Object.values(contract.getTypeMap())) {
      if (type.name.startsWith("__")) continue;
      if (
        [
          "Query",
          "Mutation",
          "JSON",
          "DateTime",
          "Upload",
          "Boolean",
          "String",
          "Int",
          "Float",
          "ID",
        ].includes(type.name)
      ) {
        continue;
      }
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

  it("fermé en production aux espaces hors BETA_WORKSPACE_IDS", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETA_FEATURES", "emailCampaigns");
    vi.stubEnv("BETA_WORKSPACE_IDS", "69acc3e24ddf8f41fec80c04");
    const context = {
      user: { _id: "65a1b2c3d4e5f6a7b8c9d0e1" },
      req: { headers: {} },
    };
    for (const [root, name] of [
      ["Query", "emailCampaigns"],
      ["Query", "emailCampaignSettings"],
      ["Query", "emailSendingDomain"],
      ["Mutation", "createEmailCampaign"],
      ["Mutation", "sendEmailCampaign"],
      ["Mutation", "connectEmailSendingDomain"],
      ["Mutation", "disconnectEmailSendingDomain"],
    ]) {
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
