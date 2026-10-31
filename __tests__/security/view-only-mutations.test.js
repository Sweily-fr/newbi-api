/**
 * Droits « Voir » seulement : un rôle qui n'a que « Voir » sur une page ne
 * peut faire AUCUNE autre action sur cette page.
 *
 * Le test parcourt TOUTES les mutations GraphQL (resolvers fusionnés) avec un
 * rôle personnalisé qui a « Voir » sur chaque page et rien d'autre : chacune
 * doit être refusée, sauf celles de la liste OPEN_TO_ANY_MEMBER (compte
 * personnel, liens publics, préférences personnelles…). Une nouvelle mutation
 * sans contrôle de droit fait donc échouer ce test.
 *
 * Contrôle inverse : les mutations protégées par cette passe acceptent un
 * rôle qui a l'action attendue (le refus vient bien du droit manquant).
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
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";

/**
 * Mutations ouvertes à tout membre, quel que soit son rôle : elles ne
 * relèvent d'aucune page d'un espace (ou se contentent de lire).
 */
const OPEN_TO_ANY_MEMBER = {
  // Compte et préférences de l'utilisateur
  account: [
    "login",
    "register",
    "verifyEmail",
    "resendVerificationEmail",
    "requestPasswordReset",
    "resetPassword",
    "updatePassword",
    "updateProfile",
    "uploadProfilePicture",
    "deleteProfilePicture",
    "uploadUserProfileImage",
    "deleteUserProfileImage",
    "disableAccount",
    "reactivateAccount",
    "requestAccountDeletion",
    "cancelAccountDeletion",
    "confirmAccountDeletion",
    "exportMyData",
    "updateEmailPreferences",
    "updateNotificationPreferences",
    "setCalendarWeeklyDigest", // récap du lundi, préférence personnelle
    "sendTestEmail",
    "registerPushToken",
    "removePushToken",
    "markNotificationAsRead",
    "markAllNotificationsAsRead",
    "deleteNotification",
    "requestModuleAccess",
    // Anciennes données de l'utilisateur (User.company, intégration
    // personnelle), sans lien avec l'espace
    "updateCompany",
    "uploadCompanyLogo",
    "deleteCompanyLogo",
    "setStripeCustomerId",
    "connectStripe",
    // Lier son propre compte à l'invité de la même adresse (refus sinon)
    "linkInvitedUserToNewbi",
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
    "createPaymentSessionForFileTransfer",
    "consumePaymentReturnToken",
    // Code de vérification de l'adresse d'un visiteur (lien de partage)
    "requestInvitedEmailCode",
  ],
  // Réglages personnels dans une page, sans effet pour les autres membres
  personal: [
    "toggleBoardFavorite", // favori de l'utilisateur
    "setTaskPresence", // présence sur une tâche consultée
    "disconnectCalendar", // retirer l'accès à son propre agenda externe
    "disconnectGmail", // retirer l'accès à sa propre boîte
    // Lien d'abonnement à son propre calendrier : il ne montre que ce que
    // le rôle voit déjà (« Voir » du calendrier exigé)
    "regenerateCalendarFeedLink",
    "disableCalendarFeedLink",
  ],
  // Fichier déposé dans l'espace de stockage de l'utilisateur : son
  // enregistrement passe ensuite par une mutation contrôlée
  ownStorage: [
    "uploadDocument",
    "deleteDocument",
    "promoteTemporaryFile",
    "generateSignedImageUrl",
  ],
  // Simples lectures
  readOnly: ["checkRecipientEInvoicing", "previewInvoiceRouting"],
};

// Arguments minimaux pour atteindre le contrôle de droit
const ARGS = {
  uploadDocumentAnnex: { documentType: "INVOICE" },
  // Espace actif, coordonnées invalides : refus métier, pas de droit
  updateOrganizationBankDetails: {
    organizationId: null, // espace du test, posé plus bas
    bankName: "Banque",
    bankIban: "invalide",
    bankBic: "invalide",
  },
};

/** Mutations protégées par cette passe → action qui les autorise. */
const NEWLY_PROTECTED = {
  banInvitedUserFromBoard: ["kanban", "share"],
  unbanInvitedUserFromBoard: ["kanban", "share"],
  connectAppleCalendar: ["calendar", "edit"],
  updateSelectedCalendars: ["calendar", "edit"],
  syncCalendar: ["calendar", "edit"],
  syncAllCalendars: ["calendar", "edit"],
  pushEventToCalendar: ["calendar", "edit"],
  updateAutoSync: ["calendar", "edit"],
  triggerGmailSync: ["purchaseInvoices", "create"],
  updateGmailScanPeriod: ["purchaseInvoices", "create"],
  processDocumentOcr: ["purchaseInvoices", "create"],
  processDocumentOcrFromUrl: ["purchaseInvoices", "create"],
  uploadSignatureImage: ["signatures", "edit"],
  uploadSocialLogo: ["signatures", "edit"],
  deleteSignatureImage: ["signatures", "delete"],
  sendEmailSignatureV2Test: ["signatures", "edit"],
  syncInvoiceToPennylane: ["integrations", "manage"],
  syncExpenseToPennylane: ["integrations", "manage"],
  syncQuoteToPennylane: ["integrations", "manage"],
  syncInvoiceToAbby: ["integrations", "manage"],
  syncQuoteToAbby: ["integrations", "manage"],
  syncInvoiceToQonto: ["integrations", "manage"],
  syncPurchaseInvoiceToQonto: ["integrations", "manage"],
  syncQuoteToQonto: ["integrations", "manage"],
  enableEInvoicing: ["integrations", "manage"],
  disableEInvoicing: ["integrations", "manage"],
  testSuperPdpConnection: ["integrations", "manage"],
  registerEInvoicingDirectory: ["integrations", "manage"],
  updateEInvoicingVatRegime: ["orgSettings", "edit"],
  // Choix d'action rendus cohérents
  deleteTaskImage: ["kanban", "edit"],
  updateEmailSettings: ["orgSettings", "edit"],
  purchaseExtraOcrImports: ["billing", "manage"],
  updateOrganizationBankDetails: ["orgSettings", "edit"],
};

/**
 * Transformations d'un document en un autre : action « Transformer » sur la
 * source ET « Créer » sur la cible, toutes deux exigées (comme l'écran).
 */
const REQUIRES_BOTH = {
  convertQuoteToInvoice: [
    ["quotes", "convert"],
    ["invoices", "create"],
  ],
  createLinkedInvoice: [
    ["quotes", "convert"],
    ["invoices", "create"],
  ],
  convertQuoteToPurchaseOrder: [
    ["quotes", "convert"],
    ["purchaseOrders", "create"],
  ],
  createDeliveryNoteFromQuote: [
    ["quotes", "convert"],
    ["deliveryNotes", "create"],
  ],
  convertPurchaseOrderToInvoice: [
    ["purchaseOrders", "convert"],
    ["invoices", "create"],
  ],
  createInvoiceFromDeliveryNote: [
    ["deliveryNotes", "convert"],
    ["invoices", "create"],
  ],
};

const organizationId = buildOrganizationId();
const userId = buildUserId();
const ROLE = `role_${"a".repeat(24)}`;
ARGS.updateOrganizationBankDetails.organizationId = String(organizationId);
let resolvers;

/**
 * « Voir » partout, plus les actions données : un couple [page, action] ou
 * une liste de couples.
 */
const setRoleActions = async (extra = null) => {
  const actions = Object.fromEntries(MODULES.map((m) => [m.key, ["view"]]));
  const pairs = !extra ? [] : Array.isArray(extra[0]) ? extra : [extra];
  for (const [moduleKey, action] of pairs) {
    actions[moduleKey] = [...actions[moduleKey], action];
  }
  await mongoose.connection.db
    .collection("organizationRole")
    .updateOne({ role: ROLE }, { $set: { actions } });
  invalidateOrganizationRoles();
  invalidateOrgCache();
};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("__TIMEOUT__")), ms),
    ),
  ]);

/**
 * Appelle la mutation sans données : renvoie true si le rôle est refusé
 * (erreur FORBIDDEN, ou réponse « Votre rôle ne permet pas… »).
 */
const isRefused = async (name) => {
  const ctx = buildContext({ userId, organizationId: String(organizationId) });
  try {
    const result = await withTimeout(
      Promise.resolve().then(() =>
        resolvers.Mutation[name](null, ARGS[name] || {}, ctx, {
          fieldName: name,
        }),
      ),
      5000,
    );
    return (
      result?.success === false &&
      /Votre rôle ne permet pas/.test(result?.message || "")
    );
  } catch (error) {
    return (error?.extensions?.code || error?.code) === "FORBIDDEN";
  }
};

beforeAll(async () => {
  await startMongo();
  // Une requête vers une collection absente échoue tout de suite au lieu
  // d'attendre une connexion
  mongoose.set("bufferCommands", false);
  await seedOrgMembership({ userId, organizationId, role: ROLE });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId,
    role: ROLE,
    name: "Lecture seule",
    actions: Object.fromEntries(MODULES.map((m) => [m.key, ["view"]])),
    permission: "{}",
  });
  resolvers = (await import("../../src/resolvers/index.js")).default;
}, 120000);

afterAll(async () => {
  mongoose.set("bufferCommands", true);
  await stopMongo();
});

describe("Rôle avec « Voir » seulement sur chaque page", () => {
  it("la liste des mutations ouvertes ne cite que des mutations existantes", () => {
    const open = Object.values(OPEN_TO_ANY_MEMBER).flat();
    const unknown = open.filter((name) => !resolvers.Mutation[name]);
    expect(unknown).toEqual([]);
  });

  it("toute autre mutation est refusée", async () => {
    await setRoleActions();
    const open = new Set(Object.values(OPEN_TO_ANY_MEMBER).flat());
    const allowed = [];
    for (const name of Object.keys(resolvers.Mutation).sort()) {
      if (open.has(name)) continue;
      if (!(await isRefused(name))) allowed.push(name);
    }
    expect(allowed).toEqual([]);
  }, 300000);

  it("les mutations protégées par cette passe acceptent l'action attendue", async () => {
    const stillRefused = [];
    for (const [name, [moduleKey, action]] of Object.entries(NEWLY_PROTECTED)) {
      await setRoleActions([moduleKey, action]);
      if (await isRefused(name)) stillRefused.push(name);
    }
    expect(stillRefused).toEqual([]);
  }, 120000);

  it("les transformations exigent les deux droits, source et cible", async () => {
    const allowedWithOne = [];
    const refusedWithBoth = [];
    for (const [name, pairs] of Object.entries(REQUIRES_BOTH)) {
      for (const pair of pairs) {
        await setRoleActions(pair);
        if (!(await isRefused(name))) allowedWithOne.push(`${name} ${pair}`);
      }
      await setRoleActions(pairs);
      if (await isRefused(name)) refusedWithBoth.push(name);
    }
    expect(allowedWithOne).toEqual([]);
    expect(refusedWithBoth).toEqual([]);
  }, 120000);
});
