/**
 * Mode lecture seule : un espace sans abonnement actif ne peut faire AUCUNE
 * écriture, quels que soient les en-têtes envoyés.
 *
 * Le test parcourt TOUTES les mutations GraphQL (resolvers fusionnés) pour le
 * propriétaire d'un espace sans abonnement, avec un contexte construit comme
 * celui de server.js :
 * - sans en-tête d'espace (l'espace vient de l'argument ou de l'espace par
 *   défaut) ;
 * - avec des en-têtes contradictoires (x-organization-id = l'espace sans
 *   abonnement, x-workspace-id = l'espace abonné d'un autre client).
 * Chaque mutation doit être refusée, sauf celles de la liste
 * ALLOWED_WITHOUT_SUBSCRIPTION (compte personnel, liens publics, retrait
 * d'accès, déconnexions, corbeille...). Une nouvelle mutation qui oublie le
 * contrôle d'abonnement fait échouer ce test.
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
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";

/**
 * Mutations permises sans abonnement actif.
 */
const ALLOWED_WITHOUT_SUBSCRIPTION = {
  // Compte, préférences et données personnelles de l'utilisateur
  account: [
    "updatePassword",
    "updateProfile",
    "uploadProfilePicture",
    "deleteProfilePicture",
    "uploadUserProfileImage",
    "deleteUserProfileImage",
    "requestAccountDeletion",
    "cancelAccountDeletion",
    "confirmAccountDeletion",
    "exportMyData",
    "updateEmailPreferences",
    "updateNotificationPreferences",
    "setCalendarWeeklyDigest",
    "sendTestEmail",
    "registerPushToken",
    "removePushToken",
    "markNotificationAsRead",
    "markAllNotificationsAsRead",
    "deleteNotification",
    "requestModuleAccess",
    "updateCompany",
    "uploadCompanyLogo",
    "deleteCompanyLogo",
    "connectStripe",
    "linkInvitedUserToNewbi",
    "regenerateCalendarFeedLink",
    "disableCalendarFeedLink",
    "setTaskPresence",
  ],
  // Suggestions de la communauté Newbi (hors espace)
  community: [
    "createCommunitySuggestion",
    "updateCommunitySuggestion",
    "deleteCommunitySuggestion",
    "voteCommunitySuggestion",
    "validateCommunitySuggestion",
    "unvalidateCommunitySuggestion",
  ],
  // Visiteurs d'un lien public (tableau partagé, transfert payant)
  publicLinks: [
    "addExternalComment",
    "updateVisitorProfile",
    "uploadVisitorImage",
    "uploadExternalCommentImage",
    "requestAccess",
    "authenticateInvitedUser",
    "setInvitedUserPassword",
    "removeInvitedUserPassword",
    "updateInvitedUserProfile",
    "logoutInvitedUser",
    "requestInvitedEmailCode",
    "createPaymentSessionForFileTransfer",
    "consumePaymentReturnToken",
  ],
  // Retirer un accès ou un partage (jamais en ouvrir un)
  revokeAccess: [
    "deletePublicShare",
    "revokePublicShare",
    "revokeVisitorAccess",
    "banInvitedUserFromBoard",
    "unbanInvitedUserFromBoard",
    "unbanVisitor",
  ],
  // Déconnecter une intégration ou une application
  disconnect: [
    "disconnectAbby",
    "disconnectCalendar",
    "disconnectGmail",
    "disconnectPennylane",
    "disconnectQonto",
    "disconnectStripe",
    "uninstallApp",
  ],
  // Paiements Stripe Connect : état du compte et tableau de bord Stripe
  stripeConnect: [
    "checkStripeConnectAccountStatus",
    "generateStripeDashboardLink",
  ],
  // Vider la corbeille des documents partagés, retirer une image
  cleanup: [
    "emptyTrash",
    "permanentlyDeleteDocuments",
    "permanentlyDeleteFolders",
    "deleteSignatureImage",
    "abortMultipartUpload",
  ],
  // Gestion de l'espace : rôles, propriété, coordonnées bancaires
  workspaceAdmin: [
    "createOrganizationRole",
    "updateOrganizationRole",
    "deleteOrganizationRole",
    "resetOrganizationRole",
    "transferOrganizationOwnership",
    "updateOrganizationBankDetails",
  ],
  // Programme partenaire (compte du partenaire, administration Newbi)
  partner: [
    "requestWithdrawal",
    "approveWithdrawal",
    "rejectWithdrawal",
    "updatePartnerStatus",
  ],
  // Fichiers de l'utilisateur (dossier personnel, logo d'un espace en cours
  // de création) : leur enregistrement passe par une mutation contrôlée
  ownStorage: [
    "uploadDocument",
    "deleteDocument",
    "promoteTemporaryFile",
    "generateSignedImageUrl",
  ],
  // Simples lectures ou envoi de test à sa propre adresse
  readOnly: [
    "checkRecipientEInvoicing",
    "previewInvoiceRouting",
    "sendEmailSignatureV2Test",
  ],
};

// Arguments minimaux pour atteindre le contrôle
const ARGS = {
  uploadDocumentAnnex: { documentType: "INVOICE" },
};

const expiredOrg = buildOrganizationId(); // espace sans abonnement
const foreignOrg = buildOrganizationId(); // abonné, sans l'utilisateur
const userId = buildUserId();
const strangerId = buildUserId();
let resolvers;

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("__TIMEOUT__")), ms),
    ),
  ]);

// Contexte GraphQL tel que server.js le construit : aucun espace posé avant
// le RBAC, en-têtes du client tels quels
const serverContext = (headers = {}) => ({
  req: { headers },
  user: {
    _id: new mongoose.Types.ObjectId(String(userId)),
    id: String(userId),
    email: "proprietaire@test.fr",
    name: "Propriétaire",
  },
  organizationId: headers["x-organization-id"] || null,
});

/** Code d'erreur de la mutation (null si elle aboutit). */
const outcome = async (name, headers) => {
  try {
    await withTimeout(
      Promise.resolve().then(() =>
        resolvers.Mutation[name](
          null,
          {
            workspaceId: String(expiredOrg),
            organizationId: String(expiredOrg),
            ...(ARGS[name] || {}),
          },
          serverContext(headers),
          { fieldName: name },
        ),
      ),
      5000,
    );
    return null;
  } catch (error) {
    return error?.extensions?.code || error?.code || error?.message || "ERREUR";
  }
};

const checkedMutations = () => {
  const allowed = new Set(Object.values(ALLOWED_WITHOUT_SUBSCRIPTION).flat());
  return Object.keys(resolvers.Mutation)
    .filter((name) => !allowed.has(name))
    .sort();
};

beforeAll(async () => {
  await startMongo();
  mongoose.set("bufferCommands", false);
  await seedOrgMembership({
    userId,
    organizationId: expiredOrg,
    role: "owner",
    subscriptionStatus: null,
  });
  await mongoose.connection.db.collection("subscription").insertOne({
    referenceId: String(expiredOrg),
    status: "canceled",
    periodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });
  await seedOrgMembership({ userId: strangerId, organizationId: foreignOrg });
  invalidateOrgCache();
  invalidateSubCache(String(expiredOrg));
  invalidateSubCache(String(foreignOrg));
  resolvers = (await import("../../src/resolvers/index.js")).default;
}, 120000);

afterAll(async () => {
  mongoose.set("bufferCommands", true);
  await stopMongo();
});

describe("Espace à l'abonnement échu", () => {
  it("la liste des mutations permises ne cite que des mutations existantes", () => {
    const allowed = Object.values(ALLOWED_WITHOUT_SUBSCRIPTION).flat();
    expect(allowed.filter((name) => !resolvers.Mutation[name])).toEqual([]);
    expect(new Set(allowed).size).toBe(allowed.length);
  });

  it("sans en-tête d'espace, toute autre mutation est refusée", async () => {
    const accepted = [];
    for (const name of checkedMutations()) {
      const code = await outcome(name, {});
      if (code !== "SUBSCRIPTION_READ_ONLY") accepted.push(`${name} (${code})`);
    }
    expect(accepted).toEqual([]);
  }, 600000);

  it("avec l'espace abonné d'un autre client en x-workspace-id, toute autre mutation est refusée", async () => {
    const accepted = [];
    const headers = {
      "x-organization-id": String(expiredOrg),
      "x-workspace-id": String(foreignOrg),
    };
    for (const name of checkedMutations()) {
      const code = await outcome(name, headers);
      if (code !== "SUBSCRIPTION_READ_ONLY" && code !== "FORBIDDEN") {
        accepted.push(`${name} (${code})`);
      }
    }
    expect(accepted).toEqual([]);
  }, 600000);
});
