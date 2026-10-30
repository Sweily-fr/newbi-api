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
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { startMongo, stopMongo, clearMongo } from "../../helpers/mongo.js";
import { buildOrganizationId } from "../../factories/index.js";

vi.mock("../../../src/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import SocialPostMedia from "../../../src/models/SocialPostMedia.js";
import storage from "../../../src/services/social/socialMediaStorage.js";
import {
  MAX_PROCESSING_ATTEMPTS,
  VIDEO_PROCESSING_FAILED_MESSAGE,
  VIDEO_TOO_SLOW_MESSAGE,
  VIDEO_UNREADABLE_MESSAGE,
  VIDEO_UPLOAD_ABANDONED_MESSAGE,
  analyzeProbe,
  buildRemuxArgs,
  buildTranscodeArgs,
  canRemux,
  maintainSocialVideos,
  prepareVideoFile,
  processSocialVideo,
  targetDimensions,
  targetFps,
  videoTools,
} from "../../../src/services/social/socialVideoProcessing.js";

const organizationId = buildOrganizationId();
const NOW = new Date("2026-11-02T08:00:00.000Z");

// Sortie de ffprobe d'une vidéo d'iPhone : HEVC 10 bits, portrait (rotation)
const iphoneProbe = {
  streams: [
    {
      codec_type: "video",
      codec_name: "hevc",
      width: 3840,
      height: 2160,
      pix_fmt: "yuv420p10le",
      avg_frame_rate: "30000/1001",
      r_frame_rate: "30/1",
      sample_aspect_ratio: "1:1",
      side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }],
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "44100",
      channels: 2,
    },
    { codec_type: "data", codec_name: "none" },
  ],
  format: { duration: "12.345", bit_rate: "45000000", size: "69000000" },
};

// Vidéo déjà au bon format (H.264 1080p, AAC)
const h264Probe = (fields = {}, format = {}) => ({
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      avg_frame_rate: "30/1",
      ...fields,
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "48000",
      channels: 2,
    },
  ],
  format: { duration: "20.0", bit_rate: "8000000", ...format },
});

describe("analyse de la vidéo (ffprobe)", () => {
  it("vidéo d'iPhone : rotation appliquée aux dimensions, images/s, débit", () => {
    expect(analyzeProbe(iphoneProbe)).toMatchObject({
      durationMs: 12345,
      displayWidth: 2160,
      displayHeight: 3840,
      rotation: 270,
      videoCodec: "hevc",
      pixFmt: "yuv420p10le",
      hasAudio: true,
      audioCodec: "aac",
      bitRate: 45000000,
    });
    expect(analyzeProbe(iphoneProbe).fps).toBeCloseTo(29.97, 2);
  });

  it("pas de piste vidéo (ou seulement une pochette) : null", () => {
    expect(
      analyzeProbe({
        streams: [
          { codec_type: "audio", codec_name: "mp3" },
          {
            codec_type: "video",
            codec_name: "mjpeg",
            width: 600,
            height: 600,
            disposition: { attached_pic: 1 },
          },
        ],
        format: { duration: "180" },
      }),
    ).toBeNull();
  });

  it("chemin rapide seulement si H.264 yuv420p, AAC, 1920 px, 23 à 60 i/s, 25 Mb/s, sans rotation", () => {
    expect(canRemux(analyzeProbe(h264Probe()))).toBe(true);
    expect(canRemux(analyzeProbe(iphoneProbe))).toBe(false);
    expect(
      canRemux(analyzeProbe(h264Probe({ width: 3840, height: 2160 }))),
    ).toBe(false);
    expect(canRemux(analyzeProbe(h264Probe({ avg_frame_rate: "120/1" })))).toBe(
      false,
    );
    expect(
      canRemux(analyzeProbe(h264Probe({}, { bit_rate: "40000000" }))),
    ).toBe(false);
    expect(
      canRemux(
        analyzeProbe(
          h264Probe({
            side_data_list: [
              { side_data_type: "Display Matrix", rotation: 90 },
            ],
          }),
        ),
      ),
    ).toBe(false);
    const withOpus = h264Probe();
    withOpus.streams[1].codec_name = "opus";
    expect(canRemux(analyzeProbe(withOpus))).toBe(false);
    const silent = h264Probe();
    silent.streams.pop();
    expect(canRemux(analyzeProbe(silent))).toBe(true);
  });

  it("transcodage : 1920 px au plus (dimensions paires), 24 à 60 i/s, libx264 + AAC 48 kHz", () => {
    const info = analyzeProbe(iphoneProbe);
    expect(targetDimensions(info)).toEqual({ width: 1080, height: 1920 });
    expect(targetFps(info)).toBeNull();
    expect(targetFps({ fps: 120 })).toBe(60);
    expect(targetFps({ fps: 15 })).toBe(24);
    expect(
      targetDimensions({ displayWidth: 1001, displayHeight: 333 }),
    ).toEqual({ width: 1000, height: 332 });

    const args = buildTranscodeArgs("in.mov", "out.mp4", info);
    const joined = args.join(" ");
    expect(joined).toContain("-vf scale=1080:1920,setsar=1");
    expect(joined).toContain(
      "-c:v libx264 -preset veryfast -crf 23 -maxrate 6M -bufsize 12M -profile:v high -pix_fmt yuv420p",
    );
    expect(joined).toContain("-c:a aac -b:a 128k -ar 48000 -ac 2");
    expect(joined).toContain("-movflags +faststart");
    expect(joined).toContain("-threads 2");
    // Métadonnées retirées (lieu de tournage)
    expect(joined).toContain("-map_metadata -1");

    const remux = buildRemuxArgs("in.mov", "out.mp4").join(" ");
    expect(remux).toContain("-c copy -movflags +faststart");
  });
});

describe("préparation d'un fichier (ffmpeg et ffprobe simulés)", () => {
  let dir;
  let probes;
  let ffmpegCalls;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-test-"));
    probes = [];
    ffmpegCalls = [];
    vi.spyOn(videoTools, "probe").mockImplementation(async () => {
      const next = probes.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    vi.spyOn(videoTools, "ffmpeg").mockImplementation(async (args) => {
      ffmpegCalls.push(args);
      const output = args[args.length - 1];
      await fs.promises.writeFile(output, Buffer.alloc(2048));
      return { stdout: "", stderr: "" };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it("vidéo déjà au bon format : conteneur réécrit sans transcodage", async () => {
    probes.push(h264Probe(), h264Probe());
    const result = await prepareVideoFile(path.join(dir, "in"), dir);
    expect(result).toMatchObject({
      remuxed: true,
      width: 1920,
      height: 1080,
      durationMs: 20000,
      size: 2048,
    });
    expect(ffmpegCalls[0]).toContain("copy");
    // Vignette à 1 s
    expect(ffmpegCalls[1].join(" ")).toContain("-ss 1.000");
    expect(result.thumbnail).toMatch(/thumbnail\.jpg$/);
  });

  it("vidéo d'iPhone : transcodée en H.264, dimensions après rotation", async () => {
    probes.push(
      iphoneProbe,
      h264Probe({ width: 1080, height: 1920 }, { duration: "12.345" }),
    );
    const result = await prepareVideoFile(path.join(dir, "in"), dir);
    expect(result).toMatchObject({
      remuxed: false,
      width: 1080,
      height: 1920,
      durationMs: 12345,
    });
    expect(ffmpegCalls[0]).toContain("libx264");
  });

  it("réécriture impossible : transcodage en repli", async () => {
    probes.push(h264Probe(), h264Probe());
    videoTools.ffmpeg.mockRejectedValueOnce(
      Object.assign(new Error("muxer"), { code: "EXIT" }),
    );
    const result = await prepareVideoFile(path.join(dir, "in"), dir);
    expect(result.remuxed).toBe(false);
    expect(ffmpegCalls[0]).toContain("libx264");
  });

  it("refus en français : trop courte, trop longue, illisible, trop lente", async () => {
    probes.push(h264Probe({}, { duration: "2.5" }));
    await expect(prepareVideoFile("in", dir)).rejects.toThrow(
      "Vidéo trop courte (3 secondes minimum).",
    );
    probes.push(h264Probe({}, { duration: "601" }));
    await expect(prepareVideoFile("in", dir)).rejects.toThrow(
      "Vidéo trop longue (10 minutes maximum).",
    );
    probes.push(Object.assign(new Error("Invalid data"), { code: "EXIT" }));
    await expect(prepareVideoFile("in", dir)).rejects.toThrow(
      VIDEO_UNREADABLE_MESSAGE,
    );
    probes.push(iphoneProbe);
    videoTools.ffmpeg.mockRejectedValueOnce(
      Object.assign(new Error("délai"), { code: "TIMEOUT" }),
    );
    await expect(prepareVideoFile("in", dir)).rejects.toThrow(
      VIDEO_TOO_SLOW_MESSAGE,
    );
  });
});

describe("préparation d'un média (bail, stockage)", () => {
  beforeAll(async () => {
    await startMongo();
  });
  afterAll(async () => {
    await stopMongo();
  });

  beforeEach(async () => {
    await clearMongo();
    process.env.NEXT_PUBLIC_API_URL = "https://api.newbi.test";
    vi.spyOn(storage, "downloadToFile").mockImplementation(async (key, file) =>
      fs.promises.writeFile(file, "original"),
    );
    vi.spyOn(storage, "storeVideoFile").mockImplementation(async ({ id }) => ({
      url: `https://api.newbi.test/social-media/${id}.mp4`,
      key: `social/${id}.mp4`,
      size: 4096,
    }));
    vi.spyOn(storage, "storeImage").mockImplementation(async ({ id }) => ({
      url: `https://api.newbi.test/social-media/${id}.jpg`,
      key: `social/${id}.jpg`,
    }));
    vi.spyOn(storage, "deleteObject").mockResolvedValue();
    vi.spyOn(storage, "abortVideoUpload").mockResolvedValue();
    vi.spyOn(videoTools, "probe").mockResolvedValue(h264Probe());
    vi.spyOn(videoTools, "ffmpeg").mockImplementation(async (args) => {
      const output = args[args.length - 1];
      if (output.endsWith(".jpg")) {
        // Vraie image : la vignette passe par la normalisation (sharp)
        const sharp = (await import("sharp")).default;
        await sharp({
          create: { width: 32, height: 18, channels: 3, background: "#f00" },
        })
          .jpeg()
          .toFile(output);
      } else {
        await fs.promises.writeFile(output, Buffer.alloc(4096));
      }
      return { stdout: "", stderr: "" };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createVideo = (fields = {}) =>
    SocialPostMedia.create({
      workspaceId: organizationId,
      provider: "newbi",
      kind: "video",
      status: "processing",
      url: "",
      size: 5000,
      upload: { key: "social/uploads/abc", uploadId: "up_1", chunkCount: 1 },
      ...fields,
    });

  it("prête : MP4 et vignette déposés, original supprimé, champs remplis", async () => {
    const media = await createVideo();
    expect(await processSocialVideo(media._id, { now: NOW })).toBe("ready");
    const saved = await SocialPostMedia.findById(media._id).lean();
    expect(saved).toMatchObject({
      status: "ready",
      contentType: "video/mp4",
      width: 1920,
      height: 1080,
      durationMs: 20000,
      size: 4096,
      processingLockedUntil: null,
      processingAttempts: 1,
    });
    const id = saved.url.match(/social-media\/(.+)\.mp4$/)[1];
    expect(saved.thumbnailUrl).toBe(
      `https://api.newbi.test/social-media/${id}.jpg`,
    );
    expect(storage.deleteObject).toHaveBeenCalledWith("social/uploads/abc");
  });

  it("bail : une seule préparation à la fois, déjà prête = rien à faire", async () => {
    const media = await createVideo({
      processingLockedUntil: new Date(NOW.getTime() + 60 * 1000),
    });
    expect(await processSocialVideo(media._id, { now: NOW })).toBe("busy");
    expect(storage.downloadToFile).not.toHaveBeenCalled();
  });

  it("refus définitif : échec avec le message, sans nouvel essai", async () => {
    videoTools.probe.mockResolvedValue(h264Probe({}, { duration: "1" }));
    const media = await createVideo();
    expect(await processSocialVideo(media._id, { now: NOW })).toBe("failed");
    const saved = await SocialPostMedia.findById(media._id).lean();
    expect(saved).toMatchObject({
      status: "failed",
      errorMessage: "Vidéo trop courte (3 secondes minimum).",
    });
  });

  it("erreur passagère : reprise par le cron, 2 essais au plus puis échec", async () => {
    storage.downloadToFile.mockRejectedValue(new Error("R2 injoignable"));
    const media = await createVideo();
    expect(await processSocialVideo(media._id, { now: NOW })).toBe("retry");
    let saved = await SocialPostMedia.findById(media._id).lean();
    expect(saved.status).toBe("processing");
    expect(saved.processingAttempts).toBe(1);

    const later = new Date(saved.processingLockedUntil.getTime() + 1000);
    expect(await processSocialVideo(media._id, { now: later })).toBe("failed");
    saved = await SocialPostMedia.findById(media._id).lean();
    expect(saved).toMatchObject({
      status: "failed",
      errorMessage: VIDEO_PROCESSING_FAILED_MESSAGE,
      processingAttempts: MAX_PROCESSING_ATTEMPTS,
    });
  });

  it("cron : préparation interrompue aux essais épuisés en échec, envoi abandonné annulé", async () => {
    const stuck = await createVideo({
      processingAttempts: MAX_PROCESSING_ATTEMPTS,
      processingLockedUntil: new Date(NOW.getTime() - 1000),
    });
    const abandoned = await createVideo({ status: "uploading" });
    await SocialPostMedia.collection.updateOne(
      { _id: abandoned._id },
      { $set: { createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) } },
    );
    const recent = await createVideo({ status: "uploading" });
    await SocialPostMedia.collection.updateOne(
      { _id: recent._id },
      { $set: { createdAt: NOW } },
    );

    const stats = await maintainSocialVideos({ now: NOW });
    expect(stats).toMatchObject({ failed: 1, abandoned: 1 });
    expect((await SocialPostMedia.findById(stuck._id)).status).toBe("failed");
    expect(await SocialPostMedia.findById(abandoned._id).lean()).toMatchObject({
      status: "failed",
      errorMessage: VIDEO_UPLOAD_ABANDONED_MESSAGE,
    });
    expect(storage.abortVideoUpload).toHaveBeenCalledWith(
      expect.objectContaining({ key: "social/uploads/abc", uploadId: "up_1" }),
    );
    expect((await SocialPostMedia.findById(recent._id)).status).toBe(
      "uploading",
    );
  });
});

// ── Vraie préparation (ffmpeg et ffprobe des paquets npm) ──────────────────

const ffmpeg = videoTools.ffmpegPath();
const ffprobe = videoTools.ffprobePath();
const hasBinaries = Boolean(ffmpeg && ffprobe);
const encoders = hasBinaries
  ? execFileSync(ffmpeg, ["-hide_banner", "-encoders"], {
      encoding: "utf8",
    })
  : "";
const sourceCodec = /\blibx265\b/.test(encoders)
  ? {
      args: [
        "-c:v",
        "libx265",
        "-x265-params",
        "log-level=error",
        "-tag:v",
        "hvc1",
      ],
      ext: "mov",
      name: "hevc",
    }
  : /\blibvpx-vp9\b/.test(encoders)
    ? { args: ["-c:v", "libvpx-vp9", "-b:v", "500k"], ext: "webm", name: "vp9" }
    : null;

describe.skipIf(!hasBinaries || !sourceCodec)(
  "préparation réelle de bout en bout",
  () => {
    let dir;
    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "video-e2e-"));
    });
    afterEach(async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    it(`vidéo ${sourceCodec?.name} de 4 s → MP4 H.264 yuv420p + AAC, vignette`, async () => {
      const source = path.join(dir, `source.${sourceCodec.ext}`);
      execFileSync(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=30:duration=4",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=4",
        ...sourceCodec.args,
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        sourceCodec.ext === "webm" ? "libopus" : "aac",
        "-shortest",
        source,
      ]);
      // Rotation d'un téléphone tenu en portrait (si ce ffmpeg sait l'écrire)
      let input = source;
      let rotated = false;
      try {
        const turned = path.join(dir, `turned.${sourceCodec.ext}`);
        execFileSync(ffmpeg, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-display_rotation",
          "90",
          "-i",
          source,
          "-c",
          "copy",
          turned,
        ]);
        rotated = analyzeProbe(await videoTools.probe(turned)).rotation !== 0;
        if (rotated) input = turned;
      } catch {
        // Option absente de ce ffmpeg : vidéo sans rotation
      }

      const result = await prepareVideoFile(input, dir);
      expect(result.remuxed).toBe(false);
      const output = analyzeProbe(await videoTools.probe(result.output));
      expect(output).toMatchObject({
        videoCodec: "h264",
        pixFmt: "yuv420p",
        rotation: 0,
        hasAudio: true,
        audioCodec: "aac",
        audioSampleRate: 48000,
        audioChannels: 2,
      });
      expect(output.durationMs).toBeGreaterThan(3500);
      expect(output.durationMs).toBeLessThan(4500);
      expect([output.width, output.height]).toEqual(
        rotated ? [360, 640] : [640, 360],
      );
      expect(result).toMatchObject({
        width: output.width,
        height: output.height,
      });
      expect((await fs.promises.stat(result.thumbnail)).size).toBeGreaterThan(
        0,
      );
    }, 120000);
  },
);
