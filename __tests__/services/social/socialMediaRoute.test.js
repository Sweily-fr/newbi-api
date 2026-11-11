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
import express from "express";
import { Readable } from "stream";

vi.mock("../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import socialMediaRoutes, {
  parseRange,
} from "../../../src/routes/social-media.js";
import storage from "../../../src/services/social/socialMediaStorage.js";

const ID = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
const VIDEO = Buffer.from("0123456789abcdefghij"); // 20 octets
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use("/social-media", socialMediaRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}/social-media`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.spyOn(storage, "isConfigured").mockReturnValue(true);
  vi.spyOn(storage, "videoSize").mockImplementation(async (id) =>
    id === ID ? VIDEO.length : null,
  );
  vi.spyOn(storage, "readVideo").mockImplementation(
    async (id, { start = null, end = null } = {}) => {
      const bytes =
        start === null
          ? VIDEO
          : VIDEO.subarray(start, (end ?? VIDEO.length - 1) + 1);
      return { body: Readable.from([bytes]), contentLength: bytes.length };
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("plages d'octets", () => {
  it("formes acceptées, plage impossible, plusieurs plages = fichier entier", () => {
    expect(parseRange(undefined, 20)).toBeNull();
    expect(parseRange("bytes=0-", 20)).toEqual({ start: 0, end: 19 });
    expect(parseRange("bytes=5-9", 20)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=5-100", 20)).toEqual({ start: 5, end: 19 });
    expect(parseRange("bytes=-4", 20)).toEqual({ start: 16, end: 19 });
    expect(parseRange("bytes=20-", 20)).toBe("invalid");
    expect(parseRange("bytes=9-5", 20)).toBe("invalid");
    expect(parseRange("bytes=0-1,4-5", 20)).toBeNull();
  });
});

describe("GET /social-media/<id>.mp4", () => {
  it("fichier entier : 200, video/mp4, Accept-Ranges, mêmes en-têtes que les images", async () => {
    const response = await fetch(`${baseUrl}/${ID}.mp4`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("20");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(
      VIDEO.toString(),
    );
  });

  it("plage : 206 + Content-Range, plage transmise à R2", async () => {
    const response = await fetch(`${baseUrl}/${ID}.mp4`, {
      headers: { Range: "bytes=10-14" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 10-14/20");
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("abcde");
    expect(storage.readVideo).toHaveBeenCalledWith(ID, { start: 10, end: 14 });
  });

  it("plage impossible : 416 avec la taille", async () => {
    const response = await fetch(`${baseUrl}/${ID}.mp4`, {
      headers: { Range: "bytes=50-" },
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */20");
    expect(storage.readVideo).not.toHaveBeenCalled();
  });

  it("HEAD : en-têtes seulement, sans lecture du fichier", async () => {
    const response = await fetch(`${baseUrl}/${ID}.mp4`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("20");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(storage.readVideo).not.toHaveBeenCalled();
  });

  it("vidéo inconnue, identifiant invalide : 404, jamais de redirection", async () => {
    const unknown = await fetch(
      `${baseUrl}/2b4e28ba-2fa1-11d2-883f-0016d3cca427.mp4`,
      { redirect: "manual" },
    );
    expect(unknown.status).toBe(404);
    expect((await fetch(`${baseUrl}/pas-un-id.mp4`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/${ID}.mov`)).status).toBe(404);
  });

  it("images toujours servies", async () => {
    vi.spyOn(storage, "readImage").mockResolvedValue({
      body: Readable.from([Buffer.from("jpeg")]),
      contentType: "image/jpeg",
      contentLength: 4,
    });
    const response = await fetch(`${baseUrl}/${ID}.jpg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(await response.text()).toBe("jpeg");
  });
});
