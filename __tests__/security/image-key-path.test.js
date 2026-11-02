/**
 * Clés d'images envoyées par le client (lecture d'URL, URL signée,
 * suppression d'une image de signature) : seules les clés du dossier de
 * l'utilisateur, sans remontée de dossier, atteignent le stockage.
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

const r2 = vi.hoisted(() => ({ calls: [] }));
vi.mock("../../src/services/cloudflareService.js", () => ({
  default: {
    getImageUrl: (key) => {
      r2.calls.push(["url", key]);
      return `https://images.test/${key}`;
    },
    getSignedUrl: async (key) => {
      r2.calls.push(["signed", key]);
      return `https://images.test/${key}?sig=1`;
    },
    deleteImage: async (key) => {
      r2.calls.push(["delete", key]);
      return true;
    },
  },
}));

import { startMongo, stopMongo } from "../helpers/mongo.js";
import { buildContext, seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import imageUploadResolvers from "../../src/resolvers/imageUpload.js";

const userId = buildUserId();
const otherUserId = buildUserId();
const organizationId = buildOrganizationId();
const ctx = () => buildContext({ userId, organizationId });

const OPERATIONS = {
  getImageUrl: (key) =>
    imageUploadResolvers.Query.getImageUrl(null, { key }, ctx()),
  generateSignedImageUrl: (key) =>
    imageUploadResolvers.Mutation.generateSignedImageUrl(null, { key }, ctx()),
  deleteSignatureImage: (key) =>
    imageUploadResolvers.Mutation.deleteSignatureImage(
      null,
      { key, workspaceId: String(organizationId) },
      ctx(),
    ),
};

const attempt = async (operation, key) => {
  try {
    return { result: await OPERATIONS[operation](key) };
  } catch (error) {
    return { error };
  }
};

beforeAll(async () => {
  await startMongo();
  await seedOrgMembership({ userId, organizationId });
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(() => {
  r2.calls = [];
});

const BAD_KEYS = () => [
  `${userId}/../${otherUserId}/image/x.webp`,
  `${userId}/sig/../../${otherUserId}/image/x.webp`,
  `${userId}//${otherUserId}/image/x.webp`,
  `${userId}/%2e%2e/${otherUserId}/image/x.webp`,
  `${userId}/..\\${otherUserId}/image/x.webp`,
  `${otherUserId}/image/x.webp`,
];

describe.each(Object.keys(OPERATIONS))("%s", (operation) => {
  it("refuse une clé hors du dossier de l'utilisateur, sans appel au stockage", async () => {
    for (const key of BAD_KEYS()) {
      const { result, error } = await attempt(operation, key);
      expect(error || result?.success === false).toBeTruthy();
    }
    expect(r2.calls).toEqual([]);
  });

  it("accepte une clé de son dossier", async () => {
    const key = `${userId}/signature-1/ImgProfil/photo.webp`;
    const { result, error } = await attempt(operation, key);
    expect(error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(r2.calls).toHaveLength(1);
    expect(r2.calls[0][1]).toBe(key);
  });
});
