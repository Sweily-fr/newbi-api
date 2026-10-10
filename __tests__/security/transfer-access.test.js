import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

vi.mock("../../src/utils/mailer.js", () => ({
  sendDownloadNotificationEmail: vi.fn().mockResolvedValue(true),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildUserId } from "../factories/index.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import {
  createTransferAccessToken,
  verifyTransferAccessToken,
} from "../../src/utils/transferAccessToken.js";
import { createOwnerDownloadToken } from "../../src/utils/ownerDownloadToken.js";
import { checkTransferRecipientAccess } from "../../src/utils/transferAccess.js";
import {
  downloadAllFiles,
  downloadFile,
  verifyTransferPassword,
} from "../../src/controllers/fileTransferController.js";
import { authorizeDownload } from "../../src/controllers/fileTransferAuthController.js";
import fileDownloadRouter from "../../src/routes/fileDownload.js";
import fileTransferResolvers from "../../src/resolvers/fileTransfer.js";

const SHARE_LINK = "a".repeat(32);
const ACCESS_KEY = "b".repeat(32);
const PASSWORD = "MotDePasse!2026";

const r2File = (name) => ({
  originalName: name,
  displayName: name,
  fileName: `f_123_${name}`,
  filePath: `https://pub-bucket.r2.dev/prod/2026/10/10/t_x/f_123_${name}`,
  r2Key: `prod/2026/10/10/t_x/f_123_${name}`,
  mimeType: "image/jpeg",
  size: 2048,
  storageType: "r2",
  fileId: `id-${name}`,
});

async function createTransfer(overrides = {}) {
  return FileTransfer.create({
    userId: buildUserId(),
    files: [],
    totalSize: 0,
    shareLink: SHARE_LINK,
    accessKey: ACCESS_KEY,
    expiryDate: new Date(Date.now() + 86400000),
    message: "Message de l'expéditeur",
    ...overrides,
  });
}

function buildRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    headers: {},
    headersSent: false,
    redirectedTo: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    removeHeader() {},
    redirect(url) {
      this.redirectedTo = url;
      this.headersSent = true;
    },
  };
  return res;
}

function buildReq({ query = {}, body = {}, params = {}, headers = {} } = {}) {
  return {
    query,
    body,
    params,
    headers: { "user-agent": "vitest", ...headers },
    ip: "1.2.3.4",
  };
}

const ownerTokenFor = (transfer) =>
  createOwnerDownloadToken(transfer._id, transfer.userId);

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
});

describe("Jeton d'accès mot de passe", () => {
  it("n'est valable que pour son transfert et son mot de passe", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    const other = await createTransfer({
      shareLink: "c".repeat(32),
      passwordProtected: true,
      password: PASSWORD,
    });
    const { token } = createTransferAccessToken(transfer);

    expect(verifyTransferAccessToken(token, transfer)).toBe(true);
    expect(verifyTransferAccessToken(token, other)).toBe(false);

    // Mot de passe changé : les jetons déjà remis ne valent plus
    transfer.password = "AutreMotDePasse";
    await transfer.save();
    expect(verifyTransferAccessToken(token, transfer)).toBe(false);
  });

  it("expire", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    const { token } = createTransferAccessToken(transfer, -1000);
    expect(verifyTransferAccessToken(token, transfer)).toBe(false);
  });

  it("n'accepte pas un jeton propriétaire à sa place", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    expect(verifyTransferAccessToken(ownerTokenFor(transfer), transfer)).toBe(
      false,
    );
  });
});

describe("checkTransferRecipientAccess", () => {
  it("exige le jeton mot de passe d'un destinataire", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    const { token } = createTransferAccessToken(transfer);

    expect(checkTransferRecipientAccess(transfer, buildReq())?.status).toBe(
      401,
    );
    expect(
      checkTransferRecipientAccess(
        transfer,
        buildReq({ query: { accessToken: token } }),
      ),
    ).toBeNull();
    expect(
      checkTransferRecipientAccess(
        transfer,
        buildReq({ headers: { "x-transfer-access-token": token } }),
      ),
    ).toBeNull();
  });

  it("bloque le téléchargement d'un transfert avec filigrane, pas l'aperçu", async () => {
    const transfer = await createTransfer({ hasWatermark: true });

    expect(checkTransferRecipientAccess(transfer, buildReq())?.status).toBe(
      403,
    );
    expect(
      checkTransferRecipientAccess(transfer, buildReq(), { usage: "preview" }),
    ).toBeNull();
  });

  it("exige le paiement sauf si la route le gère elle-même", async () => {
    const transfer = await createTransfer({
      isPaymentRequired: true,
      paymentAmount: 10,
    });

    expect(checkTransferRecipientAccess(transfer, buildReq())?.status).toBe(
      402,
    );
    expect(
      checkTransferRecipientAccess(transfer, buildReq(), { payment: false }),
    ).toBeNull();
  });

  it("laisse passer le propriétaire (ownerToken)", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      hasWatermark: true,
      isPaymentRequired: true,
      paymentAmount: 10,
    });
    expect(
      checkTransferRecipientAccess(
        transfer,
        buildReq({ query: { ownerToken: ownerTokenFor(transfer) } }),
      ),
    ).toBeNull();
  });
});

describe("ZIP /file-transfer/download-all", () => {
  // Transfert sans fichier : une fois les contrôles passés, la route répond
  // 404 « Aucun fichier » sans toucher au stockage
  const callZip = async (transfer, query = {}) => {
    const res = buildRes();
    await downloadAllFiles(
      buildReq({ query: { link: SHARE_LINK, key: ACCESS_KEY, ...query } }),
      res,
    );
    return res;
  };

  it("exige le mot de passe d'un transfert protégé", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    expect((await callZip(transfer)).statusCode).toBe(401);

    const { token } = createTransferAccessToken(transfer);
    expect((await callZip(transfer, { accessToken: token })).statusCode).toBe(
      404,
    );
  });

  it("refuse un transfert avec filigrane à un destinataire", async () => {
    const transfer = await createTransfer({ hasWatermark: true });
    expect((await callZip(transfer)).statusCode).toBe(403);
  });

  it("refuse un transfert payant non réglé", async () => {
    const transfer = await createTransfer({
      isPaymentRequired: true,
      paymentAmount: 10,
    });
    expect((await callZip(transfer)).statusCode).toBe(402);
  });

  it("laisse le propriétaire télécharger son transfert protégé", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      hasWatermark: true,
    });
    const res = await callZip(transfer, {
      ownerToken: ownerTokenFor(transfer),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("Téléchargement unitaire", () => {
  it("/file-transfer/download-file exige le mot de passe", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });
    const res = buildRes();
    await downloadFile(
      buildReq({
        query: {
          link: SHARE_LINK,
          key: ACCESS_KEY,
          fileId: transfer.files[0]._id.toString(),
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(res.redirectedTo).toBeNull();
  });

  const routeHandler = (path) =>
    fileDownloadRouter.stack.find((layer) => layer.route?.path === path).route
      .stack[0].handle;

  it("/api/files/download exige le mot de passe et respecte le filigrane", async () => {
    const download = routeHandler("/download/:transferId/:fileId");
    const protectedTransfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });
    const watermarked = await createTransfer({
      shareLink: "d".repeat(32),
      hasWatermark: true,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });

    const res1 = buildRes();
    await download(
      buildReq({
        params: {
          transferId: protectedTransfer._id.toString(),
          fileId: protectedTransfer.files[0]._id.toString(),
        },
        query: { link: SHARE_LINK, key: ACCESS_KEY },
      }),
      res1,
    );
    expect(res1.statusCode).toBe(401);

    const res2 = buildRes();
    await download(
      buildReq({
        params: {
          transferId: watermarked._id.toString(),
          fileId: watermarked.files[0]._id.toString(),
        },
        query: { link: "d".repeat(32), key: ACCESS_KEY },
      }),
      res2,
    );
    expect(res2.statusCode).toBe(403);
  });

  it("/api/files/preview exige le mot de passe", async () => {
    const preview = routeHandler("/preview/:transferId/:fileId");
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });
    const res = buildRes();
    await preview(
      buildReq({
        params: {
          transferId: transfer._id.toString(),
          fileId: transfer.files[0]._id.toString(),
        },
        query: { link: SHARE_LINK, key: ACCESS_KEY },
      }),
      res,
    );
    expect(res.statusCode).toBe(401);
  });

  it("/api/transfers/:id/authorize ne signe pas d'URL sans mot de passe", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });
    const res = buildRes();
    await authorizeDownload(
      buildReq({
        params: { transferId: transfer._id.toString() },
        body: { link: SHARE_LINK, key: ACCESS_KEY, email: "x@newbi.fr" },
      }),
      res,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body?.downloads).toBeUndefined();
  });
});

describe("/api/transfers/verify-password", () => {
  const verify = async (body) => {
    const res = buildRes();
    await verifyTransferPassword(buildReq({ body }), res);
    return res;
  };

  it("exige le secret de partage", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    const res = await verify({
      transferId: transfer._id.toString(),
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuse un mauvais mot de passe", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
    });
    const res = await verify({
      transferId: transfer._id.toString(),
      password: "faux",
      link: SHARE_LINK,
      key: ACCESS_KEY,
    });
    expect(res.statusCode).toBe(401);
    expect(res.body.accessToken).toBeUndefined();
  });

  it("remet un jeton valide, la liste des fichiers et le message", async () => {
    const transfer = await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });
    const res = await verify({
      transferId: transfer._id.toString(),
      password: PASSWORD,
      link: SHARE_LINK,
      key: ACCESS_KEY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(verifyTransferAccessToken(res.body.accessToken, transfer)).toBe(
      true,
    );
    expect(res.body.transferMessage).toBe("Message de l'expéditeur");
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0]).toMatchObject({
      originalName: "photo.jpg",
      filePath: "",
      downloadUrl: null,
      r2Key: null,
    });
  });
});

describe("getFileTransferByLink (requête publique)", () => {
  const query = (shareLink = SHARE_LINK) =>
    fileTransferResolvers.Query.getFileTransferByLink(
      {},
      { shareLink, accessKey: ACCESS_KEY },
    );

  it("n'expose jamais l'adresse de stockage des fichiers", async () => {
    await createTransfer({
      files: [r2File("photo.jpg")],
      totalSize: 2048,
      hasWatermark: true,
    });
    const { fileTransfer } = await query();
    expect(fileTransfer.files).toHaveLength(1);
    expect(fileTransfer.files[0].filePath).toBe("");
    expect(fileTransfer.files[0].downloadUrl).toBeNull();
    expect(fileTransfer.files[0].r2Key).toBeNull();
    expect(fileTransfer.hasWatermark).toBe(true);
  });

  it("ne liste ni fichiers ni message avant le mot de passe", async () => {
    await createTransfer({
      passwordProtected: true,
      password: PASSWORD,
      files: [r2File("photo.jpg")],
      totalSize: 2048,
    });
    const { fileTransfer } = await query();
    expect(fileTransfer.passwordProtected).toBe(true);
    expect(fileTransfer.files).toEqual([]);
    expect(fileTransfer.message).toBeNull();
  });
});
