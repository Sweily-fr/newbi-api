/**
 * Temps réel de la page d'un visiteur (accès client des documents partagés) :
 * connexion anonyme gardée par le lien et la session, aucun contenu transmis,
 * flux coupé dès que l'accès n'est plus permis.
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
import { PubSub } from "graphql-subscriptions";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET = "secret-de-test";
});

// PubSub en mémoire à la place de Redis : la souscription reçoit réellement
// les publications
const pubsub = new PubSub();
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => pubsub,
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: async () => {}, sharedDocumentsBucketName: "test" },
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
} from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import DocumentShare from "../../src/models/DocumentShare.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import shareResolvers from "../../src/resolvers/documentShare.js";
import { publishSharedDocsChanged } from "../../src/resolvers/sharedDocument.js";
import { createDocumentShareSession } from "../../src/utils/documentShareAccessToken.js";

const { publicDocumentShareChanged } = shareResolvers.Subscription;
const CLIENT = "client@dupont.fr";

const workspaceId = buildOrganizationId();
const otherWorkspaceId = buildOrganizationId();
const owner = buildUserId();
const folderId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateSubCache(String(workspaceId));
  invalidateOrganizationRoles();
  await seedOrgMembership({
    userId: owner,
    organizationId: workspaceId,
    role: "owner",
  });
  await SharedFolder.collection.insertOne({
    _id: folderId,
    name: "Client Dupont",
    workspaceId,
    createdBy: owner,
    parentId: null,
    visibility: "public",
    trashedAt: null,
  });
});

async function createShare() {
  return DocumentShare.create({
    token: DocumentShare.generateToken(),
    workspaceId,
    folderIds: [folderId],
    createdBy: owner,
  });
}

const subscribe = (share, session) =>
  publicDocumentShareChanged.subscribe(
    null,
    { token: share.token, session },
    { user: null, isPublic: true },
  );

// Prochain événement, ou « rien » au bout d'un court délai
const nextOrNothing = (iterator, ms = 150) =>
  Promise.race([
    iterator.next(),
    new Promise((resolve) => setTimeout(() => resolve("rien"), ms)),
  ]);

const ownerContext = () =>
  buildContext({ userId: owner, organizationId: workspaceId });

describe("Souscription du visiteur", () => {
  it("refuse sans session valable, avec un lien inconnu ou fermé", async () => {
    const share = await createShare();
    const other = await createShare();
    await expect(subscribe(share, "session-inventee")).rejects.toThrow();
    // Session d'un autre accès
    await expect(
      subscribe(share, createDocumentShareSession(other, CLIENT)),
    ).rejects.toThrow();
    await expect(
      publicDocumentShareChanged.subscribe(
        null,
        { token: "0".repeat(64), session: "x" },
        {},
      ),
    ).rejects.toThrow();

    share.isActive = false;
    await share.save();
    await expect(
      subscribe(share, createDocumentShareSession(share, CLIENT)),
    ).rejects.toThrow();
  });

  it("refuse un visiteur dont l'accès a été retiré", async () => {
    const share = await createShare();
    share.bannedEmails.push({ email: CLIENT });
    await share.save();
    await expect(
      subscribe(share, createDocumentShareSession(share, CLIENT)),
    ).rejects.toThrow();
  });

  it("signale un changement dans l'espace, sans rien en transmettre", async () => {
    const share = await createShare();
    const iterator = await subscribe(
      share,
      createDocumentShareSession(share, CLIENT),
    );
    const pending = iterator.next();
    publishSharedDocsChanged(String(workspaceId), "CREATED", folderId);
    const { value, done } = await pending;
    expect(done).toBe(false);
    expect(value).toEqual({ type: "CHANGED" });
    expect(publicDocumentShareChanged.resolve(value)).toEqual({
      type: "CHANGED",
    });

    // Un autre espace : rien
    publishSharedDocsChanged(String(otherWorkspaceId), "CREATED", folderId);
    expect(await nextOrNothing(iterator)).toBe("rien");
    await iterator.return();
  });

  it("signale une modification de l'accès par son propriétaire", async () => {
    const share = await createShare();
    const iterator = await subscribe(
      share,
      createDocumentShareSession(share, CLIENT),
    );
    const pending = iterator.next();
    await shareResolvers.Mutation.updateDocumentShare(
      null,
      {
        workspaceId: String(workspaceId),
        id: String(share._id),
        input: { allowUploads: true },
      },
      ownerContext(),
    );
    expect((await pending).value).toEqual({ type: "CHANGED" });
    await iterator.return();
  });

  it("visiteur retiré pendant la visite : CLOSED puis fin du flux", async () => {
    const share = await createShare();
    const iterator = await subscribe(
      share,
      createDocumentShareSession(share, CLIENT),
    );
    await DocumentShare.updateOne(
      { _id: share._id },
      { $push: { bannedEmails: { email: CLIENT } } },
    );
    const pending = iterator.next();
    publishSharedDocsChanged(String(workspaceId), "UPDATED");
    expect((await pending).value).toEqual({ type: "CLOSED" });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it("lien désactivé pendant la visite : CLOSED", async () => {
    const share = await createShare();
    const iterator = await subscribe(
      share,
      createDocumentShareSession(share, CLIENT),
    );
    await DocumentShare.updateOne({ _id: share._id }, { isActive: false });
    const pending = iterator.next();
    publishSharedDocsChanged(String(workspaceId), "UPDATED");
    expect((await pending).value).toEqual({ type: "CLOSED" });
  });
});
