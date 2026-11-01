/**
 * Rôle sans aucun droit : aucune lecture des données de l'espace.
 *
 * Le test parcourt TOUTES les Query GraphQL (resolvers fusionnés) avec un
 * rôle personnalisé qui n'a aucune action sur aucune page : chacune doit
 * être refusée (FORBIDDEN), sauf celles de la liste READABLE_WITHOUT_RIGHTS
 * (compte de l'utilisateur, liens publics, référentiels, réglages lus par
 * l'interface pour tout membre). Une nouvelle Query sans contrôle de droit
 * fait échouer ce test.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

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

import mongoose from "mongoose";
import { startMongo, stopMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { MODULES } from "../../src/config/rolePermissions.js";

/** Query lisibles sans aucun droit sur les pages de l'espace. */
const READABLE_WITHOUT_RIGHTS = {
  // Compte, préférences, notifications et connexions de l'utilisateur
  account: [
    "me",
    "myDeletionRequest",
    "getEmailPreferences",
    "getNotificationPreferences",
    "getNotifications",
    "getUnreadNotificationsCount",
    "calendarWeeklyDigest",
    "getCalendarConnections",
    "getAvailableCalendars",
    "testEmailReminder",
    "gmailConnection",
    "gmailSyncStats",
    "integrations",
    "lookupUsersByEmails",
    "getImageUrl",
  ],
  // Droits et abonnement de l'espace, lus par l'interface pour tout membre
  workspaceAccess: [
    "myPermissions",
    "roleCatalog",
    "organizationRoles",
    "mySubscription",
    "organizationMembers",
    "usersInfo",
    // Liste vide sans « Voir » sur les projets (minuteur présent partout)
    "activeTimers",
  ],
  // État des intégrations et réglages par défaut des documents
  workspaceSettings: [
    "getInstalledApps",
    "myAbbyAccount",
    "myPennylaneAccount",
    "myQontoAccount",
    "qontoSandboxAvailable",
    "myStripeConnectAccount",
    "getDocumentSettings",
  ],
  // Droits testés à part (coordonnées bancaires de l'espace)
  testedSeparately: ["getOrganizationBankDetails"],
  // Liens publics (tableau partagé, transfert, invités)
  publicLinks: [
    "getPublicBoard",
    "validatePublicToken",
    "checkInvitedEmail",
    "getInvitedUser",
    "getInvitedUserByEmail",
    "validateInvitedSession",
    "getFileTransferByLink",
  ],
  // Contenus communs à tous les clients et référentiels publics
  public: [
    "getAllBlogPosts",
    "getBlogPostBySlug",
    "getBlogPostsByCategory",
    "getBlogPostsByTag",
    "getPopularBlogPosts",
    "searchBlogPosts",
    "getCommunitySuggestions",
    "getCommunitySuggestion",
    "getCommunitySuggestionStats",
    "getCommissionTiers",
    "pcgAccounts",
    "pcgMappingTable",
    "searchCompaniesByName",
    "searchCompanyBySiret",
  ],
};

const organizationId = buildOrganizationId();
const userId = buildUserId();
const ROLE = `role_${"c".repeat(24)}`;
const emailLogId = new mongoose.Types.ObjectId();
let resolvers;

// Arguments minimaux pour atteindre le contrôle de droit
const ARGS = {
  documentEmailLogs: { documentType: "invoice" },
  documentEmailLog: { id: String(emailLogId) },
};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("__TIMEOUT__")), ms),
    ),
  ]);

/** Code d'erreur de la Query (« OK » si elle répond). */
const outcome = async (name) => {
  const ctx = buildContext({ userId, organizationId: String(organizationId) });
  try {
    await withTimeout(
      Promise.resolve().then(() =>
        resolvers.Query[name](
          null,
          {
            workspaceId: String(organizationId),
            organizationId: String(organizationId),
            ...(ARGS[name] || {}),
          },
          ctx,
          { fieldName: name },
        ),
      ),
      5000,
    );
    return "OK";
  } catch (error) {
    return error?.extensions?.code || error?.code || error?.message;
  }
};

beforeAll(async () => {
  await startMongo();
  mongoose.set("bufferCommands", false);
  await seedOrgMembership({ userId, organizationId, role: ROLE });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId,
    role: ROLE,
    name: "Aucun droit",
    actions: Object.fromEntries(MODULES.map((m) => [m.key, []])),
    permission: "{}",
  });
  resolvers = (await import("../../src/resolvers/index.js")).default;
  await mongoose.model("DocumentEmailLog").collection.insertOne({
    _id: emailLogId,
    workspaceId: organizationId,
    documentType: "invoice",
    documentId: new mongoose.Types.ObjectId(),
    sentAt: new Date(),
  });
}, 120000);

afterAll(async () => {
  mongoose.set("bufferCommands", true);
  await stopMongo();
});

describe("Rôle sans aucun droit", () => {
  it("la liste des lectures permises ne cite que des Query existantes", () => {
    const allowed = Object.values(READABLE_WITHOUT_RIGHTS).flat();
    expect(allowed.filter((name) => !resolvers.Query[name])).toEqual([]);
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it("toute autre Query est refusée", async () => {
    const allowed = new Set(Object.values(READABLE_WITHOUT_RIGHTS).flat());
    const answered = [];
    for (const name of Object.keys(resolvers.Query).sort()) {
      if (allowed.has(name) || typeof resolvers.Query[name] !== "function") {
        continue;
      }
      const code = await outcome(name);
      if (code !== "FORBIDDEN") answered.push(`${name} (${code})`);
    }
    expect(answered).toEqual([]);
  }, 300000);
});
