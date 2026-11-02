/**
 * emailTrackingUpdated : le suivi (ouverture, clic) d'un document ne part
 * qu'aux membres qui voient ce type de document, comme la page de l'envoi
 * (documentEmailLog).
 *
 * Seule l'appartenance à l'espace était vérifiée : un rôle sans accès aux
 * factures recevait l'identifiant de chaque facture envoyée et ses dates
 * d'ouverture et de clic.
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
import mongoose from "mongoose";
import { PubSub } from "graphql-subscriptions";

const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import documentEmailResolvers, {
  publishEmailTrackingUpdate,
} from "../../src/resolvers/documentEmail.js";

const workspaceId = buildOrganizationId();
const owner = buildUserId();
const quotesOnly = buildUserId();
const outsider = buildUserId();
const ROLE_DEVIS = "role_devis_seulement";

const subscribe = (userId) =>
  documentEmailResolvers.Subscription.emailTrackingUpdated.subscribe(
    {},
    { workspaceId: String(workspaceId) },
    { user: userId ? { _id: userId, id: String(userId) } : null },
    {},
  );

const tracking = (documentType, documentId) => ({
  documentId,
  documentType,
  workspaceId: String(workspaceId),
  emailTracking: {
    emailSentAt: new Date().toISOString(),
    emailOpenedAt: new Date().toISOString(),
    emailOpenCount: 1,
  },
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await seedOrgMembership({
    userId: quotesOnly,
    organizationId: workspaceId,
    role: ROLE_DEVIS,
  });
  await seedOrgMembership({
    userId: outsider,
    organizationId: buildOrganizationId(),
  });
  await mongoose.connection.db.collection("organizationRole").insertOne({
    organizationId: workspaceId,
    role: ROLE_DEVIS,
    name: "Devis seulement",
    permission: "{}",
    actions: { quotes: ["view"] },
    createdAt: new Date(),
  });
  invalidateOrganizationRoles();
  invalidateOrgCache();
});

describe("emailTrackingUpdated", () => {
  it("un rôle sans « Voir » des factures ne reçoit que le suivi de ses devis", async () => {
    const iterator = await subscribe(quotesOnly);
    const next = iterator.next();

    publishEmailTrackingUpdate(tracking("invoice", "facture-1"));
    publishEmailTrackingUpdate(tracking("quote", "devis-1"));

    const { value } = await next;
    expect(value.emailTrackingUpdated).toMatchObject({
      documentType: "quote",
      documentId: "devis-1",
    });
    await iterator.return?.();
  });

  it("le propriétaire reçoit le suivi des factures", async () => {
    const iterator = await subscribe(owner);
    const next = iterator.next();

    publishEmailTrackingUpdate(tracking("invoice", "facture-2"));

    const { value } = await next;
    expect(value.emailTrackingUpdated.documentId).toBe("facture-2");
    await iterator.return?.();
  });

  it("type de document inconnu : jamais transmis", async () => {
    const iterator = await subscribe(owner);
    const next = iterator.next();

    publishEmailTrackingUpdate(tracking("inconnu", "x"));
    publishEmailTrackingUpdate(tracking("quote", "devis-3"));

    const { value } = await next;
    expect(value.emailTrackingUpdated.documentId).toBe("devis-3");
    await iterator.return?.();
  });

  it("sans session ou hors de l'espace : refusé", async () => {
    await expect(subscribe(null)).rejects.toThrow(/Non authentifié/);
    await expect(subscribe(outsider)).rejects.toThrow(/pas membre/);
  });
});
