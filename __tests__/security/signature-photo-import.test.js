/**
 * Import de la photo de profil dans une signature de mail : le serveur ne
 * joint que des hôtes autorisés (stockages de Newbi, photos Google et
 * GitHub), en https, à une adresse IP publique, sans redirection hors de ces
 * hôtes, avec une taille et une durée plafonnées.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import https from "node:https";
import dns from "node:dns";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import sharp from "sharp";

const r2 = vi.hoisted(() => ({
  profilePublicUrl: "https://profil.newbi.test",
  publicUrl: "https://images.newbi.test",
  signaturePublicUrl: "https://signature.newbi.test",
  companyImagesPublicUrl: "https://entreprise.newbi.test",
  uploadSignatureImage: vi.fn(async (buffer, fileName) => ({
    url: `https://signature.newbi.test/${fileName}`,
    key: `u/s/imgProfil/${fileName}`,
  })),
}));
vi.mock("../../src/services/cloudflareService.js", () => ({ default: r2 }));

import {
  importSignatureImage,
  isImportablePhotoUrl,
  MAX_IMAGE_BYTES,
} from "../../src/services/signatureAssets.js";
import {
  isPublicIp,
  publicOnlyLookup,
} from "../../src/utils/publicHttpsFetch.js";

const GOOGLE_PHOTO = "https://lh3.googleusercontent.com/a/photo=s96-c";

// Réponses simulées de https.get, dans l'ordre des appels
function fakeHttps(responses) {
  return vi.spyOn(https, "get").mockImplementation((url, options, cb) => {
    const spec = responses.shift() || { status: 500 };
    const request = new EventEmitter();
    process.nextTick(async () => {
      const response = new PassThrough();
      response.statusCode = spec.status ?? 200;
      response.headers = spec.headers ?? {};
      cb(response);
      for (const chunk of spec.chunks ?? [spec.body ?? Buffer.alloc(0)]) {
        if (response.destroyed) return;
        response.write(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
      if (!response.destroyed) response.end();
    });
    return request;
  });
}

const importPhoto = (url) =>
  importSignatureImage({ url, kind: "PHOTO", userId: "u", signatureId: "s" });

let pngPhoto;

beforeEach(async () => {
  r2.uploadSignatureImage.mockClear();
  pngPhoto ??= await sharp({
    create: {
      width: 40,
      height: 40,
      channels: 3,
      background: { r: 90, g: 80, b: 255 },
    },
  })
    .png()
    .toBuffer();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("adresses IP publiques", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
  ])("refuse %s", (address) => {
    expect(isPublicIp(address)).toBe(false);
  });

  it.each(["8.8.8.8", "142.250.74.97", "2a00:1450:4007:80b::2001"])(
    "accepte %s",
    (address) => {
      expect(isPublicIp(address)).toBe(true);
    },
  );

  it("la résolution DNS refuse un nom qui pointe vers une adresse interne", async () => {
    vi.spyOn(dns, "lookup").mockImplementation((host, options, cb) =>
      cb(null, [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    const error = await new Promise((resolve) =>
      publicOnlyLookup("interne.exemple", {}, (err) => resolve(err)),
    );
    expect(error?.code).toBe("ENOTPUBLIC");
  });

  it("la résolution DNS rend une adresse publique", async () => {
    vi.spyOn(dns, "lookup").mockImplementation((host, options, cb) =>
      cb(null, [{ address: "93.184.216.34", family: 4 }]),
    );
    const single = await new Promise((resolve) =>
      publicOnlyLookup("public.exemple", {}, (err, address, family) =>
        resolve({ err, address, family }),
      ),
    );
    expect(single).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    const all = await new Promise((resolve) =>
      publicOnlyLookup("public.exemple", { all: true }, (err, list) =>
        resolve(list),
      ),
    );
    expect(all).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });
});

describe("hôtes d'où importer une photo", () => {
  it.each([
    GOOGLE_PHOTO,
    "https://avatars.githubusercontent.com/u/1?v=4",
    "https://profil.newbi.test/user/photo.jpg",
    "https://pub-abc.r2.dev/photo.png",
  ])("accepte %s", (url) => {
    expect(isImportablePhotoUrl(url)).toBe(true);
  });

  it.each([
    "http://lh3.googleusercontent.com/a/photo",
    "https://exemple.invalid/photo.png",
    "https://googleusercontent.com.exemple.invalid/photo.png",
    "https://127.0.0.1/photo.png",
    "pas une adresse",
  ])("refuse %s", (url) => {
    expect(isImportablePhotoUrl(url)).toBe(false);
  });
});

describe("importSignatureImage", () => {
  it.each([
    "http://169.254.169.254/openstack/latest/meta_data.json",
    "https://169.254.169.254/latest/meta-data/",
    "http://127.0.0.1:4000/",
    "https://127.0.0.1/photo.png",
    "https://[::1]/photo.png",
    "https://localhost/photo.png",
    "https://exemple.invalid/photo.png",
    "file:///etc/passwd",
  ])("refuse %s sans aucune requête", async (url) => {
    const get = fakeHttps([]);
    await expect(importPhoto(url)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });

  it("se connecte avec la vérification d'adresse, sans connexion partagée", async () => {
    const get = fakeHttps([{ body: pngPhoto }]);
    const result = await importPhoto(GOOGLE_PHOTO);
    expect(result.url).toMatch(/^https:\/\/signature\.newbi\.test\//);
    const options = get.mock.calls[0][1];
    expect(options.lookup).toBe(publicOnlyLookup);
    expect(options.agent).toBe(false);
    expect(options.headers["accept-encoding"]).toBe("identity");
  });

  it("refuse une redirection vers une adresse interne", async () => {
    const get = fakeHttps([
      {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data/" },
      },
    ]);
    await expect(importPhoto(GOOGLE_PHOTO)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refuse une redirection vers un hôte non autorisé", async () => {
    const get = fakeHttps([
      { status: 301, headers: { location: "https://exemple.invalid/x.png" } },
    ]);
    await expect(importPhoto(GOOGLE_PHOTO)).rejects.toThrow(/non autorisé/);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("suit une redirection vers un hôte autorisé", async () => {
    const get = fakeHttps([
      {
        status: 302,
        headers: { location: "https://lh4.googleusercontent.com/a/photo" },
      },
      { body: pngPhoto },
    ]);
    await expect(importPhoto(GOOGLE_PHOTO)).resolves.toMatchObject({
      key: expect.stringContaining("imgProfil"),
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("s'arrête au-delà de 3 redirections", async () => {
    const hop = {
      status: 302,
      headers: { location: "https://lh3.googleusercontent.com/a/encore" },
    };
    const get = fakeHttps([hop, hop, hop, hop, hop]);
    await expect(importPhoto(GOOGLE_PHOTO)).rejects.toThrow(
      /Trop de redirections/,
    );
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("coupe un contenu sans taille annoncée au-delà de 10 Mo", async () => {
    const mega = Buffer.alloc(1024 * 1024, 1);
    const chunks = Array.from(
      { length: MAX_IMAGE_BYTES / mega.length + 2 },
      () => mega,
    );
    fakeHttps([{ chunks }]);
    await expect(importPhoto(GOOGLE_PHOTO)).rejects.toThrow(/trop lourd/);
    expect(r2.uploadSignatureImage).not.toHaveBeenCalled();
  });

  it("refuse une taille annoncée au-delà de 10 Mo", async () => {
    fakeHttps([{ headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } }]);
    await expect(importPhoto(GOOGLE_PHOTO)).rejects.toThrow(/trop lourd/);
  });

  it("refuse un contenu compressé", async () => {
    fakeHttps([{ headers: { "content-encoding": "gzip" }, body: pngPhoto }]);
    await expect(importPhoto(GOOGLE_PHOTO)).rejects.toThrow(/compressé/);
  });
});
