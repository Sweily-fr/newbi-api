/**
 * Photo de profil et fichiers envoyés : aucun chemin hors du dossier attendu.
 *
 * updateProfile gardait toute valeur de profilePicture commençant par
 * « /uploads/ », puis deleteProfilePicture la passait à deleteFile, qui
 * joignait les segments du chemin sans refuser « .. » ni vérifier à qui
 * appartenait le fichier. deleteFile n'accepte plus que
 * « /uploads/<dossier connu>/<fichier> » résolu dans ce dossier,
 * updateProfile ignore un chemin choisi par le client, et la suppression
 * saute un fichier référencé par un autre compte.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";

vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  UPLOADS_ROOT,
  resolveUploadPath,
  deleteFile,
} from "../../src/utils/fileUpload.js";
import User from "../../src/models/User.js";
import userResolvers from "../../src/resolvers/user.js";

const PUBLIC_ROOT = path.resolve(UPLOADS_ROOT, "..");
const created = [];

// Fichier témoin réel, supprimé en fin de test
const canary = (absolutePath) => {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, "témoin");
  created.push(absolutePath);
  return absolutePath;
};
const randomName = (ext = ".png") =>
  `${crypto.randomBytes(8).toString("hex")}${ext}`;

afterEach(() => {
  for (const file of created.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // déjà supprimé
    }
  }
  for (const dir of ["sub-test"]) {
    try {
      fs.rmSync(path.join(UPLOADS_ROOT, "profile-pictures", dir), {
        recursive: true,
        force: true,
      });
    } catch {
      // absent
    }
  }
});

describe("resolveUploadPath", () => {
  it("accepte /uploads/<dossier connu>/<fichier>", () => {
    expect(resolveUploadPath("/uploads/profile-pictures/abc123.png")).toBe(
      path.join(UPLOADS_ROOT, "profile-pictures", "abc123.png"),
    );
  });

  it.each([
    "/uploads/../robots.txt",
    "/uploads/../../package.json",
    "/uploads/profile-pictures/../../../.env",
    "/uploads/profile-pictures/..",
    "/uploads/profile-pictures/%2e%2e",
    "/uploads/inconnu/x.png",
    "/uploads/profile-pictures/autre-compte/x.png",
    "uploads/profile-pictures/x.png",
    "/autre/profile-pictures/x.png",
    "/uploads/profile-pictures/",
    "/uploads/profile-pictures/.cache",
    "https://cdn.exemple.fr/uploads/profile-pictures/x.png",
  ])("refuse %s", (relativePath) => {
    expect(resolveUploadPath(relativePath)).toBeNull();
  });

  it("refuse un dossier différent de celui attendu", () => {
    expect(
      resolveUploadPath("/uploads/company-logos/x.png", "profile-pictures"),
    ).toBeNull();
  });
});

describe("deleteFile", () => {
  it("supprime un fichier de son dossier", () => {
    const name = randomName();
    const file = canary(path.join(UPLOADS_ROOT, "profile-pictures", name));
    expect(deleteFile(`/uploads/profile-pictures/${name}`)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("ne supprime rien hors du dossier des envois (/uploads/../<fichier>)", () => {
    const name = randomName(".txt");
    const file = canary(path.join(PUBLIC_ROOT, name));
    expect(deleteFile(`/uploads/../${name}`)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("ne supprime rien dans un sous-dossier (/uploads/profile-pictures/<autre>/x.png)", () => {
    const name = randomName();
    const file = canary(
      path.join(UPLOADS_ROOT, "profile-pictures", "sub-test", name),
    );
    expect(deleteFile(`/uploads/profile-pictures/sub-test/${name}`)).toBe(
      false,
    );
    expect(fs.existsSync(file)).toBe(true);
  });

  it("respecte le dossier imposé par l'appelant", () => {
    const name = randomName();
    const file = canary(path.join(UPLOADS_ROOT, "company-logos", name));
    expect(
      deleteFile(`/uploads/company-logos/${name}`, {
        directory: "profile-pictures",
      }),
    ).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("resolvers de la photo de profil", () => {
  const M = userResolvers.Mutation;

  const insertUser = async (profilePicture) => {
    const _id = new mongoose.Types.ObjectId();
    await User.collection.insertOne({
      _id,
      email: `u-${_id}@exemple.fr`,
      password: "empreinte-factice",
      profile: { firstName: "Jean", profilePicture },
    });
    return _id;
  };
  const ctx = (_id) => ({
    user: { _id, id: String(_id) },
    req: { headers: {} },
  });

  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });
  beforeEach(async () => {
    await clearMongo();
  });

  it("updateProfile ignore un chemin /uploads/ choisi par le client", async () => {
    const userId = await insertUser("");
    await M.updateProfile(
      {},
      { input: { profilePicture: "/uploads/../robots.txt" } },
      ctx(userId),
    );
    const stored = await User.collection.findOne({ _id: userId });
    expect(stored.profile.profilePicture).toBe("");
  });

  it("updateProfile n'accepte pas la photo d'un autre compte", async () => {
    const otherPath = `/uploads/profile-pictures/${randomName()}`;
    await insertUser(otherPath);
    const userId = await insertUser("");
    await M.updateProfile(
      {},
      { input: { profilePicture: otherPath, firstName: "Paul" } },
      ctx(userId),
    );
    const stored = await User.collection.findOne({ _id: userId });
    expect(stored.profile.profilePicture).toBe("");
    expect(stored.profile.firstName).toBe("Paul");
  });

  it("updateProfile garde la photo déjà enregistrée sur le compte", async () => {
    const ownPath = `/uploads/profile-pictures/${randomName()}`;
    const userId = await insertUser(ownPath);
    await M.updateProfile(
      {},
      { input: { profilePicture: ownPath, firstName: "Paul" } },
      ctx(userId),
    );
    const stored = await User.collection.findOne({ _id: userId });
    expect(stored.profile.profilePicture).toBe(ownPath);
  });

  it("deleteProfilePicture supprime sa propre photo", async () => {
    const name = randomName();
    const file = canary(path.join(UPLOADS_ROOT, "profile-pictures", name));
    const userId = await insertUser(`/uploads/profile-pictures/${name}`);
    await M.deleteProfilePicture({}, {}, ctx(userId));
    expect(fs.existsSync(file)).toBe(false);
    const stored = await User.collection.findOne({ _id: userId });
    expect(stored.profile.profilePicture).toBe("");
  });

  it("deleteProfilePicture ne supprime pas un fichier référencé par un autre compte", async () => {
    const name = randomName();
    const file = canary(path.join(UPLOADS_ROOT, "profile-pictures", name));
    const sharedPath = `/uploads/profile-pictures/${name}`;
    await insertUser(sharedPath); // propriétaire du fichier
    const userId = await insertUser(sharedPath); // valeur héritée identique
    await M.deleteProfilePicture({}, {}, ctx(userId));
    expect(fs.existsSync(file)).toBe(true);
    const stored = await User.collection.findOne({ _id: userId });
    expect(stored.profile.profilePicture).toBe("");
  });

  it("deleteProfilePicture ne supprime rien hors du dossier (valeur héritée /uploads/../x)", async () => {
    const name = randomName(".txt");
    const file = canary(path.join(PUBLIC_ROOT, name));
    const userId = await insertUser(`/uploads/../${name}`);
    await M.deleteProfilePicture({}, {}, ctx(userId));
    expect(fs.existsSync(file)).toBe(true);
  });
});
