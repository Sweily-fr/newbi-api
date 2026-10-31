/**
 * Documents partagés : un dossier ne peut pas devenir son propre parent, ni
 * descendre sous un de ses sous-dossiers, ni sous un dossier en corbeille ;
 * les parcours d'arborescence terminent même si un cycle existe déjà en base.
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

vi.mock("../../src/services/cloudflareService.js", () => ({
  default: { deleteImage: async () => {} },
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({
    publish: async () => {},
    asyncIterableIterator: () => ({}),
  }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import { invalidateOrganizationRoles } from "../../src/services/organizationRoleService.js";
import SharedFolder from "../../src/models/SharedFolder.js";
import sharedDocumentResolvers from "../../src/resolvers/sharedDocument.js";
import {
  loadSharedFolderAccess,
  getEffectiveVisibility,
  isFolderOrDescendant,
} from "../../src/services/sharedFolderAccess.js";
import {
  getAllSubfolders,
  buildFolderPath,
} from "../../src/services/sharedDocumentZipService.js";

const { Mutation } = sharedDocumentResolvers;
const { ObjectId } = mongoose.Types;

const owner = buildUserId();
const workspaceId = buildOrganizationId();
const A = new ObjectId();
const B = new ObjectId(); // sous-dossier de A
const C = new ObjectId(); // sous-dossier de B
const D = new ObjectId(); // à la racine
const T = new ObjectId(); // en corbeille

const CYCLE_MESSAGE =
  "Impossible de déplacer un dossier dans lui-même ou dans un de ses sous-dossiers";

const folder = (_id, name, parentId = null, extra = {}) => ({
  _id,
  name,
  workspaceId,
  parentId,
  createdBy: owner,
  visibility: "public",
  allowedUserIds: [],
  isSystem: false,
  order: 0,
  trashedAt: null,
  ...extra,
});

const call = (name, args) =>
  Mutation[name](
    null,
    { workspaceId: String(workspaceId), ...args },
    buildContext({ userId: owner, organizationId: workspaceId }),
    { fieldName: name },
  );

const parentOf = async (id) =>
  (await SharedFolder.collection.findOne({ _id: id })).parentId;

// Échoue au lieu de bloquer si un parcours ne termine pas
const withinTwoSeconds = (promise) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("parcours sans fin")), 2000),
    ),
  ]);

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  invalidateOrganizationRoles();
  await seedOrgMembership({ userId: owner, organizationId: workspaceId });
  await SharedFolder.collection.insertMany([
    folder(A, "A"),
    folder(B, "B", A),
    folder(C, "C", B),
    folder(D, "D"),
    folder(T, "T", null, { trashedAt: new Date() }),
  ]);
});

describe("updateSharedFolder : dossier parent", () => {
  it("refuse le dossier lui-même comme parent", async () => {
    const result = await call("updateSharedFolder", {
      id: String(A),
      input: { parentId: String(A) },
    });
    expect(result).toMatchObject({ success: false, message: CYCLE_MESSAGE });
    expect(await parentOf(A)).toBeNull();
  });

  it("refuse un sous-dossier (direct ou non) comme parent", async () => {
    for (const child of [B, C]) {
      const result = await call("updateSharedFolder", {
        id: String(A),
        input: { parentId: String(child) },
      });
      expect(result).toMatchObject({ success: false, message: CYCLE_MESSAGE });
    }
    expect(await parentOf(A)).toBeNull();
  });

  it("refuse un dossier en corbeille comme parent", async () => {
    const result = await call("updateSharedFolder", {
      id: String(D),
      input: { parentId: String(T) },
    });
    expect(result).toMatchObject({
      success: false,
      message: "Le dossier de destination est dans la corbeille",
    });
    expect(await parentOf(D)).toBeNull();
  });

  it("accepte un déplacement valide", async () => {
    const result = await call("updateSharedFolder", {
      id: String(C),
      input: { parentId: String(D) },
    });
    expect(result.success).toBe(true);
    expect(String(await parentOf(C))).toBe(String(D));
  });

  it("createSharedFolder refuse un parent en corbeille", async () => {
    const result = await call("createSharedFolder", {
      input: { name: "Nouveau", parentId: String(T) },
    });
    expect(result.success).toBe(false);
    expect(await SharedFolder.countDocuments({ name: "Nouveau" })).toBe(0);
  });
});

describe("parcours sur un cycle déjà présent en base", () => {
  beforeEach(async () => {
    // A → B → C → A, et un dossier qui hérite de sa visibilité
    await SharedFolder.collection.updateOne(
      { _id: A },
      { $set: { parentId: C } },
    );
    await SharedFolder.collection.updateMany(
      { _id: { $in: [A, B, C] } },
      { $set: { visibility: null } },
    );
  });

  it("deleteSharedFolder met l'arborescence en corbeille et termine", async () => {
    const result = await withinTwoSeconds(
      call("deleteSharedFolder", { id: String(A) }),
    );
    expect(result.success).toBe(true);
    expect(
      await SharedFolder.countDocuments({
        _id: { $in: [A, B, C] },
        trashedAt: { $ne: null },
      }),
    ).toBe(3);
  });

  it("getAllSubfolders renvoie chaque dossier une seule fois", async () => {
    const folders = await withinTwoSeconds(
      getAllSubfolders(String(A), String(workspaceId)),
    );
    expect(folders.map((f) => f.name).sort()).toEqual(["A", "B", "C"]);
  });

  it("buildFolderPath termine", () => {
    const map = new Map(
      [
        { _id: A, name: "A", parentId: C },
        { _id: B, name: "B", parentId: A },
        { _id: C, name: "C", parentId: B },
      ].map((f) => [String(f._id), f]),
    );
    expect(buildFolderPath(map.get(String(C)), map, String(D))).toBe("A/B/C");
  });

  it("la visibilité effective et les droits d'accès se calculent", async () => {
    const access = await loadSharedFolderAccess(
      String(workspaceId),
      String(owner),
    );
    expect(access.canAccess(A)).toBe(true);
    const map = new Map(
      (await SharedFolder.find({ workspaceId })).map((f) => [String(f._id), f]),
    );
    expect(getEffectiveVisibility(map.get(String(B)), map).visibility).toBe(
      "public",
    );
    expect(isFolderOrDescendant(map, D, A)).toBe(true);
  });
});
