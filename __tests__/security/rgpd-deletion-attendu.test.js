/**
 * Suppression de compte RGPD (audit D8, manque G7) :
 *   - super admin d'un espace qui a d'autres membres : suppression refusée
 *     tant que la propriété n'est pas transférée ;
 *   - dernier membre d'un espace abonné : abonnement résilié chez Stripe et
 *     document subscription supprimé.
 * Stripe est simulé.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.SMTP_ENCRYPTION_KEY =
    process.env.SMTP_ENCRYPTION_KEY || "a".repeat(64);
  process.env.CALENDAR_ENCRYPTION_KEY =
    process.env.CALENDAR_ENCRYPTION_KEY || "a".repeat(64);
});

// Client Stripe simulé (src/utils/stripe.js), créé avant tout import
const stripeMock = vi.hoisted(() => ({
  subscriptions: {
    cancel: vi.fn(async (id) => ({ id, status: "canceled" })),
    update: vi.fn(async (id) => ({ id })),
  },
  customers: { del: vi.fn(async (id) => ({ id, deleted: true })) },
}));
vi.mock("../../src/utils/stripe.js", () => ({ default: stripeMock }));

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    signatureBucketName: "signatures-test",
    client: {
      send: vi.fn().mockResolvedValue({ Contents: [], IsTruncated: false }),
    },
  },
}));

import mongoose from "mongoose";
import { clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { startReplicaSet } from "../helpers/numberingSimulation.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import User from "../../src/models/User.js";
import { deleteUserAccount } from "../../src/services/rgpd.js";

const leaver = buildUserId();
const colleague = buildUserId();
const activeOrg = buildOrganizationId(); // espace actif, seul membre
const sharedOrg = buildOrganizationId(); // autre espace : leaver owner + collègue

const db = () => mongoose.connection.db;

let replSet;

beforeAll(async () => {
  replSet = await startReplicaSet("rgpd_attendu");
  // Modules chargés à la demande par deleteUserAccount (réseaux sociaux de
  // l'espace supprimé) : leurs modèles sont enregistrés ici, sinon leurs
  // collections et index naîtraient pendant la transaction du test suivant
  // (« catalog changes »)
  await import("../../src/services/social/socialMediaCleanup.js");
  await import("../../src/services/social/socialPublishingService.js");
  // Collections et index créés avant la transaction de deleteUserAccount :
  // une collection créée pendant la transaction provoque, sous charge, un
  // LockTimeout qui ferait échouer le test pour une autre raison
  await Promise.all(
    mongoose.modelNames().map(async (name) => {
      const Model = mongoose.model(name);
      await Model.createCollection().catch(() => {});
      await Model.init().catch(() => {});
    }),
  );
  for (const name of [
    "session",
    "account",
    "member",
    "organization",
    "invitation",
    "subscription",
    // Tableaux, colonnes et cartes : modèles mongoose ci-dessus
    "kanban_collab_docs",
    "events",
    "calendar_feed_tokens",
    "calendar_digest_log",
  ]) {
    await db()
      .createCollection(name)
      .catch(() => {});
  }
}, 180000);

afterAll(async () => {
  await mongoose.disconnect();
  await replSet?.stop();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  vi.clearAllMocks();
  await User.collection.insertMany([
    { _id: leaver, email: "leaver@test.fr", createdAt: new Date() },
    { _id: colleague, email: "colleague@test.fr", createdAt: new Date() },
  ]);
});

describe("RGPD : autres espaces de l'utilisateur", () => {
  it("super admin d'un second espace avec d'autres membres : suppression refusée (ou transfert exigé), l'espace garde un super admin existant", async () => {
    await seedOrgMembership({
      userId: leaver,
      organizationId: activeOrg,
      role: "owner",
    });
    await seedOrgMembership({
      userId: leaver,
      organizationId: sharedOrg,
      role: "owner",
    });
    await seedOrgMembership({
      userId: colleague,
      organizationId: sharedOrg,
      role: "member",
    });

    let refused = false;
    try {
      await deleteUserAccount(String(leaver), String(activeOrg));
    } catch {
      refused = true;
    }

    // Quelle que soit l'issue (refus, ou transfert automatique au collègue),
    // l'espace partagé doit garder un super admin dont le compte existe.
    const owners = await db()
      .collection("member")
      .find({ organizationId: sharedOrg, role: /owner/i })
      .toArray();
    const existingOwners = [];
    for (const m of owners) {
      if (await User.collection.countDocuments({ _id: m.userId })) {
        existingOwners.push(m);
      }
    }
    expect(
      existingOwners.length,
      "l'espace partagé ne doit pas se retrouver avec un super admin dont le compte a été supprimé",
    ).toBeGreaterThan(0);

    if (refused) {
      // Refus : le compte n'est pas supprimé
      expect(await User.collection.countDocuments({ _id: leaver })).toBe(1);
    }
  });
});

describe("RGPD : abonnement Stripe", () => {
  it("dernier membre d'un espace abonné : abonnement annulé chez Stripe et document subscription supprimé", async () => {
    await seedOrgMembership({
      userId: leaver,
      organizationId: activeOrg,
      role: "owner",
      subscriptionStatus: null,
    });
    await db()
      .collection("subscription")
      .insertOne({
        referenceId: String(activeOrg),
        status: "active",
        plan: "pme",
        stripeCustomerId: "cus_rgpd_test",
        stripeSubscriptionId: "sub_rgpd_test",
      });

    const summary = await deleteUserAccount(String(leaver), String(activeOrg));
    expect(summary.organizationDeleted).toBe(true);

    expect(
      stripeMock.subscriptions.cancel.mock.calls.map(([id]) => id),
      "l'abonnement Stripe de l'espace supprimé doit être annulé (sinon il continue d'être facturé)",
    ).toContain("sub_rgpd_test");
    expect(
      await db()
        .collection("subscription")
        .countDocuments({ referenceId: String(activeOrg) }),
      "le document subscription de l'espace supprimé doit être supprimé",
    ).toBe(0);
  });

  it("seul membre d'un autre espace abonné : abonnement aussi résilié, abonnement résilié ignoré", async () => {
    const autre = buildOrganizationId();
    await seedOrgMembership({
      userId: leaver,
      organizationId: activeOrg,
      role: "owner",
      subscriptionStatus: null,
    });
    await seedOrgMembership({
      userId: leaver,
      organizationId: autre,
      role: "owner",
      subscriptionStatus: null,
    });
    await db()
      .collection("subscription")
      .insertMany([
        {
          referenceId: String(autre),
          status: "trialing",
          stripeSubscriptionId: "sub_autre",
        },
        {
          referenceId: String(activeOrg),
          status: "canceled",
          stripeSubscriptionId: "sub_deja_resilie",
        },
      ]);

    await deleteUserAccount(String(leaver), String(activeOrg));

    const annules = stripeMock.subscriptions.cancel.mock.calls.map(
      ([id]) => id,
    );
    expect(annules).toContain("sub_autre");
    expect(annules).not.toContain("sub_deja_resilie");
    expect(
      await db().collection("member").countDocuments({ userId: leaver }),
    ).toBe(0);
  });
});

describe("RGPD : propriété à transférer", () => {
  it("super admin de l'espace actif qui a d'autres membres : refusé, rien n'est supprimé", async () => {
    await seedOrgMembership({
      userId: leaver,
      organizationId: sharedOrg,
      role: "owner",
    });
    await seedOrgMembership({
      userId: colleague,
      organizationId: sharedOrg,
      role: "member",
    });

    await expect(
      deleteUserAccount(String(leaver), String(sharedOrg)),
    ).rejects.toMatchObject({
      details: { reason: "OWNER_TRANSFER_REQUIRED" },
    });
    expect(await User.collection.countDocuments({ _id: leaver })).toBe(1);
    expect(
      await db().collection("member").countDocuments({ userId: leaver }),
    ).toBe(1);
  });

  it("un autre super admin reste dans l'espace : suppression permise", async () => {
    await seedOrgMembership({
      userId: leaver,
      organizationId: sharedOrg,
      role: "owner",
    });
    await seedOrgMembership({
      userId: colleague,
      organizationId: sharedOrg,
      role: "owner",
    });

    await deleteUserAccount(String(leaver), String(sharedOrg));
    expect(await User.collection.countDocuments({ _id: leaver })).toBe(0);
    expect(
      await db()
        .collection("member")
        .countDocuments({ organizationId: sharedOrg }),
    ).toBe(1);
  });
});
