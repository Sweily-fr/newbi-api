/**
 * Photo de profil : suppression réelle, limitée aux fichiers du compte.
 *
 * L'envoi va dans le bucket des photos de profil, mais l'ancienne photo et
 * la photo supprimée l'étaient dans le bucket par défaut (images) : rien
 * n'était effacé. La clé était tirée de l'URL d'avatar, modifiable par le
 * client, sans contrôle de son préfixe : elle pouvait désigner le fichier
 * d'un autre compte. R2 est simulé.
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
import { Readable } from "stream";

const r2 = vi.hoisted(() => ({
  profileBucketName: "profils-test",
  deleteImage: vi.fn(async () => true),
  isValidFileSize: () => true,
  isValidImageFile: () => true,
  uploadImage: vi.fn(async (_buffer, _name, userId) => ({
    key: `${userId}/image/nouvelle.webp`,
    url: `https://profils.example/${userId}/image/nouvelle.webp`,
    contentType: "image/webp",
  })),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({ default: r2 }));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserId } from "../factories/index.js";
import User from "../../src/models/User.js";
import imageUploadResolvers, {
  ownProfileImageKey,
} from "../../src/resolvers/imageUpload.js";

const { Mutation } = imageUploadResolvers;

let userId;
let other;
const ctx = () => ({
  user: { _id: userId, id: String(userId), email: "moi@test.fr" },
});

const seedUser = (_id, fields) =>
  User.collection.insertOne({ _id, email: `${_id}@test.fr`, ...fields });

const deleted = () =>
  r2.deleteImage.mock.calls.map(([key, bucket]) => ({ key, bucket }));

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  r2.deleteImage.mockClear();
  r2.uploadImage.mockClear();
  userId = buildUserId();
  other = buildUserId();
});

describe("deleteUserProfileImage", () => {
  it("sa photo : supprimée dans le bucket des photos de profil, profil vidé", async () => {
    await seedUser(userId, {
      avatar: `https://profils.example/${userId}/image/abc.webp`,
    });

    const res = await Mutation.deleteUserProfileImage({}, {}, ctx());

    expect(res.success).toBe(true);
    expect(deleted()).toEqual([
      { key: `${userId}/image/abc.webp`, bucket: "profils-test" },
    ]);
    const relu = await User.collection.findOne({ _id: userId });
    expect(relu.avatar).toBeUndefined();
  });

  it("avatar pointant vers la photo d'un autre compte : rien n'est supprimé sur R2", async () => {
    await seedUser(userId, {
      avatar: `https://profils.example/${other}/image/sienne.webp`,
    });

    const res = await Mutation.deleteUserProfileImage({}, {}, ctx());

    expect(res.success).toBe(true);
    expect(r2.deleteImage).not.toHaveBeenCalled();
    // Le lien est quand même retiré de son profil
    expect((await User.collection.findOne({ _id: userId })).avatar).toBeUndefined();
  });

  it.each([
    "https://lh3.googleusercontent.com/a/photo=s96-c",
    "https://images.example/userVisitor/abc/def.png",
  ])("image hébergée ailleurs (%s) : rien n'est supprimé sur R2", async (url) => {
    await seedUser(userId, { avatar: url });

    await Mutation.deleteUserProfileImage({}, {}, ctx());

    expect(r2.deleteImage).not.toHaveBeenCalled();
  });
});

describe("uploadUserProfileImage", () => {
  const fichier = () =>
    Promise.resolve({
      filename: "moi.png",
      mimetype: "image/png",
      createReadStream: () => Readable.from([Buffer.from("png")]),
    });

  it("remplace sa photo : l'ancienne est supprimée du bucket des photos de profil", async () => {
    await seedUser(userId, {
      avatar: `https://profils.example/${userId}/image/ancienne.webp`,
    });

    const res = await Mutation.uploadUserProfileImage({}, { file: fichier() }, ctx());

    expect(res.success).toBe(true);
    expect(deleted()).toEqual([
      { key: `${userId}/image/ancienne.webp`, bucket: "profils-test" },
    ]);
  });

  it("ancienne photo désignant le fichier d'un autre compte : gardée", async () => {
    await seedUser(userId, {
      avatar: `https://profils.example/${other}/image/sienne.webp`,
    });

    await Mutation.uploadUserProfileImage({}, { file: fichier() }, ctx());

    expect(r2.deleteImage).not.toHaveBeenCalled();
  });
});

describe("ownProfileImageKey", () => {
  it.each([
    [{ key: "U/image/a.webp" }, "U/image/a.webp"],
    [{ url: "https://cdn.example/x/U/image/a.webp?v=2" }, "U/image/a.webp"],
    [{ key: "V/image/a.webp" }, null],
    [{ key: "U/image/../V/a.webp" }, null],
    [{ key: "U/image/sous/a.webp" }, null],
    [{ key: "U/image/" }, null],
    [{}, null],
  ])("%j → %j", (input, attendu) => {
    expect(ownProfileImageKey("U", input)).toBe(attendu);
  });
});

void mongoose;
