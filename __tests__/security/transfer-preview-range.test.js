import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { Readable, Writable } from "stream";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

// R2 simulé : renvoie la plage demandée d'un contenu connu, comme GetObject
const CONTENT = Buffer.from("0123456789abcdefghij");
const s3 = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    S3Client: class {
      send(command) {
        return s3.send(command);
      }
    },
  };
});

vi.mock("../../src/utils/mailer.js", () => ({
  sendDownloadNotificationEmail: vi.fn().mockResolvedValue(true),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserId } from "../factories/index.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import { createOwnerDownloadToken } from "../../src/utils/ownerDownloadToken.js";
import { createTransferAccessToken } from "../../src/utils/transferAccessToken.js";
import fileDownloadRouter, {
  parseByteRange,
} from "../../src/routes/fileDownload.js";

const SHARE_LINK = "g".repeat(32);
const ACCESS_KEY = "h".repeat(32);

const preview = fileDownloadRouter.stack.find(
  (layer) => layer.route?.path === "/preview/:transferId/:fileId",
).route.stack[0].handle;

function r2Get(command) {
  const rangeHeader = command.input.Range;
  if (!rangeHeader) {
    return {
      Body: Readable.from([CONTENT]),
      ContentLength: CONTENT.length,
    };
  }
  const [, start, end] = /bytes=(\d+)-(\d+)/.exec(rangeHeader).map(Number);
  return {
    Body: Readable.from([CONTENT.subarray(start, end + 1)]),
    ContentLength: end - start + 1,
    ContentRange: `bytes ${start}-${end}/${CONTENT.length}`,
  };
}

// Réponse Express minimale, réellement écrite par le flux R2
class TestResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.body = undefined;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  removeHeader(name) {
    delete this.headers[name.toLowerCase()];
  }

  json(payload) {
    this.body = payload;
    this.end();
    return this;
  }

  get text() {
    return Buffer.concat(this.chunks).toString();
  }
}

async function callPreview(transfer, { range, query = {} } = {}) {
  const res = new TestResponse();
  const finished = new Promise((resolve) => res.on("finish", resolve));
  await preview(
    {
      params: {
        transferId: transfer._id.toString(),
        fileId: transfer.files[0]._id.toString(),
      },
      query: { link: SHARE_LINK, key: ACCESS_KEY, ...query },
      body: {},
      headers: range ? { range } : {},
      ip: "1.2.3.4",
    },
    res,
  );
  await finished;
  return res;
}

const createVideoTransfer = (overrides = {}) =>
  FileTransfer.create({
    userId: buildUserId(),
    files: [
      {
        originalName: "clip.mp4",
        displayName: "clip.mp4",
        fileName: "f_1_clip.mp4",
        filePath: "https://pub-bucket.r2.dev/prod/2026/10/11/t_x/f_1_clip.mp4",
        r2Key: "prod/2026/10/11/t_x/f_1_clip.mp4",
        mimeType: "video/mp4",
        size: CONTENT.length,
        storageType: "r2",
        fileId: "id-clip",
      },
    ],
    totalSize: CONTENT.length,
    shareLink: SHARE_LINK,
    accessKey: ACCESS_KEY,
    expiryDate: new Date(Date.now() + 86400000),
    ...overrides,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  s3.send.mockReset();
  s3.send.mockImplementation(async (command) => r2Get(command));
});

describe("parseByteRange", () => {
  it("lit une plage simple, ouverte ou suffixe", () => {
    expect(parseByteRange("bytes=0-1", 20)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange("bytes=15-", 20)).toEqual({ start: 15, end: 19 });
    expect(parseByteRange("bytes=-5", 20)).toEqual({ start: 15, end: 19 });
    expect(parseByteRange("bytes=10-999", 20)).toEqual({ start: 10, end: 19 });
  });

  it("signale une plage hors du fichier ou à l'envers", () => {
    expect(parseByteRange("bytes=20-", 20)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=5-2", 20)).toBe("unsatisfiable");
    expect(parseByteRange("bytes=-0", 20)).toBe("unsatisfiable");
  });

  it("ignore plusieurs plages, une autre unité ou une taille inconnue", () => {
    expect(parseByteRange("bytes=0-1,4-5", 20)).toBeNull();
    expect(parseByteRange("items=0-1", 20)).toBeNull();
    expect(parseByteRange("bytes=-", 20)).toBeNull();
    expect(parseByteRange("bytes=0-1", Number.NaN)).toBeNull();
  });
});

describe("/api/files/preview : requêtes partielles", () => {
  it("répond 200 avec le fichier entier sans en-tête Range", async () => {
    const transfer = await createVideoTransfer();
    const res = await callPreview(transfer);
    expect(res.statusCode).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(CONTENT.length);
    expect(res.text).toBe(CONTENT.toString());
    expect(s3.send.mock.calls[0][0].input.Range).toBeUndefined();
  });

  it("répond 206 avec la plage demandée, transmise à R2", async () => {
    const transfer = await createVideoTransfer();
    const res = await callPreview(transfer, { range: "bytes=0-1" });
    expect(res.statusCode).toBe(206);
    expect(s3.send.mock.calls[0][0].input.Range).toBe("bytes=0-1");
    expect(res.headers["content-range"]).toBe(`bytes 0-1/${CONTENT.length}`);
    expect(res.headers["content-length"]).toBe(2);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.text).toBe("01");
  });

  it("gère une plage ouverte et une plage suffixe", async () => {
    const transfer = await createVideoTransfer();
    const open = await callPreview(transfer, { range: "bytes=15-" });
    expect(open.statusCode).toBe(206);
    expect(open.text).toBe("fghij");
    const suffix = await callPreview(transfer, { range: "bytes=-3" });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe(
      `bytes 17-19/${CONTENT.length}`,
    );
    expect(suffix.text).toBe("hij");
  });

  it("répond 416 à une plage hors du fichier, sans appeler R2", async () => {
    const transfer = await createVideoTransfer();
    const res = await callPreview(transfer, { range: "bytes=500-" });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${CONTENT.length}`);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("répond 416 quand R2 refuse la plage (taille enregistrée erronée)", async () => {
    const transfer = await createVideoTransfer();
    s3.send.mockRejectedValueOnce(
      Object.assign(new Error("InvalidRange"), { name: "InvalidRange" }),
    );
    const res = await callPreview(transfer, { range: "bytes=10-" });
    expect(res.statusCode).toBe(416);
  });

  it("garde le mot de passe : 401 sans jeton, 206 avec", async () => {
    const transfer = await createVideoTransfer({
      passwordProtected: true,
      password: "MotDePasse!2026",
    });
    const denied = await callPreview(transfer, { range: "bytes=0-1" });
    expect(denied.statusCode).toBe(401);
    expect(s3.send).not.toHaveBeenCalled();

    const { token } = createTransferAccessToken(transfer);
    const allowed = await callPreview(transfer, {
      range: "bytes=0-1",
      query: { accessToken: token },
    });
    expect(allowed.statusCode).toBe(206);
  });

  it("garde le paiement et laisse passer le propriétaire", async () => {
    const transfer = await createVideoTransfer({
      isPaymentRequired: true,
      paymentAmount: 10,
      isPaid: false,
    });
    const denied = await callPreview(transfer, { range: "bytes=0-1" });
    expect(denied.statusCode).toBe(402);
    expect(s3.send).not.toHaveBeenCalled();

    const owner = await callPreview(transfer, {
      range: "bytes=0-1",
      query: {
        ownerToken: createOwnerDownloadToken(transfer._id, transfer.userId),
      },
    });
    expect(owner.statusCode).toBe(206);
  });

  it("refuse sans le secret de partage, même avec une plage", async () => {
    const transfer = await createVideoTransfer();
    const res = await callPreview(transfer, {
      range: "bytes=0-1",
      query: { key: "x".repeat(32) },
    });
    expect(res.statusCode).toBe(403);
    expect(s3.send).not.toHaveBeenCalled();
  });
});
