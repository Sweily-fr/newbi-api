/**
 * uploadDocument : types acceptés.
 *
 * Le type générique application/octet-stream était accepté avec n'importe
 * quelle extension, et c'est l'extension qui fixe le type servi par R2 : un
 * .html ou un .exe passait. Sous ce type, seules les extensions des types
 * acceptés (JPEG, PNG, WebP, SVG, PDF) restent permises. R2 est simulé.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "stream";

const r2 = vi.hoisted(() => ({
  uploadImage: vi.fn(async (_buffer, name) => ({
    key: `documents/u/${name}`,
    url: `https://docs.example/${name}`,
    contentType: "application/pdf",
  })),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({ default: r2 }));
vi.mock("../../src/middlewares/rbac.js", async (importOriginal) => ({
  ...(await importOriginal()),
  checkSubscriptionActive: async () => {},
}));
vi.mock("../../src/config/redis.js", () => ({
  getPubSub: () => ({ publish: async () => {} }),
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
  getCacheClient: () => null,
}));

import documentUploadResolvers from "../../src/resolvers/documentUpload.js";

const { Mutation } = documentUploadResolvers;
const ctx = {
  user: { _id: "u", id: "650000000000000000000001" },
  req: { headers: {} },
};
const envoyer = (filename, mimetype) =>
  Mutation.uploadDocument(
    {},
    {
      file: Promise.resolve({
        filename,
        mimetype,
        createReadStream: () => Readable.from([Buffer.from("contenu")]),
      }),
      folderType: "documents",
    },
    ctx,
  );

beforeEach(() => r2.uploadImage.mockClear());

describe("uploadDocument : type réel", () => {
  it.each([
    ["page.html", "application/octet-stream"],
    ["outil.exe", "application/octet-stream"],
    ["sans-extension", "application/octet-stream"],
    ["page.html", "text/html"],
  ])("%s envoyé en %s : refusé sans envoi", async (name, type) => {
    const res = await envoyer(name, type);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/Type de fichier non supporté/);
    expect(r2.uploadImage).not.toHaveBeenCalled();
  });

  it.each([
    ["Facture n° 12.PDF", "application/octet-stream"],
    ["logo.svg", "application/octet-stream"],
    ["photo.jpg", "image/jpeg"],
    ["scan.pdf", "application/pdf"],
  ])("%s envoyé en %s : accepté", async (name, type) => {
    const res = await envoyer(name, type);
    expect(res.success).toBe(true);
    expect(r2.uploadImage).toHaveBeenCalledTimes(1);
  });
});
