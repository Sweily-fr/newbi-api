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
});

// Session simulée : l'utilisateur renvoyé par le middleware d'authentification
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../../src/middlewares/better-auth-jwt.js", () => ({
  betterAuthJWTMiddleware: vi.fn(async () => auth.user),
}));

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import FileTransfer from "../../src/models/FileTransfer.js";
import DownloadEvent from "../../src/models/DownloadEvent.js";
import { createOwnerDownloadToken } from "../../src/utils/ownerDownloadToken.js";
import { getDownloadStats } from "../../src/controllers/fileTransferAuthController.js";

const SHARE_LINK = "c".repeat(32);
const ACCESS_KEY = "d".repeat(32);

function buildRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const callStats = async (transfer, { query = {}, headers = {} } = {}) => {
  const res = buildRes();
  await getDownloadStats(
    { params: { transferId: String(transfer._id) }, query, body: {}, headers },
    res,
  );
  return res;
};

let ownerId;
let workspaceId;
let transfer;

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  invalidateOrgCache();
  auth.user = null;
  ownerId = buildUserId();
  workspaceId = buildOrganizationId();
  await seedOrgMembership({ userId: ownerId, organizationId: workspaceId });
  transfer = await FileTransfer.create({
    userId: ownerId,
    workspaceId: workspaceId.toString(),
    files: [],
    totalSize: 0,
    shareLink: SHARE_LINK,
    accessKey: ACCESS_KEY,
    expiryDate: new Date(Date.now() + 86400000),
  });
  await DownloadEvent.create({
    transferId: transfer._id,
    fileId: buildUserId(),
    fileName: "photo.jpg",
    fileSize: 2048,
    buyerEmail: "destinataire@exemple.fr",
    buyerIp: "203.0.113.7",
    buyerUserAgent: "Navigateur",
    downloadUrl: "https://r2.example/photo.jpg?X-Amz-Signature=secret",
    status: "completed",
  });
});

describe("Statistiques d'un transfert", () => {
  it("refuse sans lien ni droit de propriétaire", async () => {
    const res = await callStats(transfer);
    expect(res.statusCode).toBe(403);
    expect(res.body.stats).toBeUndefined();
  });

  it("ne donne que les compteurs au détenteur du lien", async () => {
    const res = await callStats(transfer, {
      query: { link: SHARE_LINK, key: ACCESS_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.stats).toMatchObject({ total: 1, completed: 1 });
    expect(res.body.recentDownloads).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("203.0.113.7");
    expect(JSON.stringify(res.body)).not.toContain("destinataire@exemple.fr");
  });

  it("donne le détail au propriétaire muni de son jeton, sans URL signée", async () => {
    const res = await callStats(transfer, {
      query: {
        ownerToken: createOwnerDownloadToken(transfer._id, transfer.userId),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.recentDownloads).toHaveLength(1);
    expect(res.body.recentDownloads[0].buyerIp).toBe("203.0.113.7");
    expect(res.body.recentDownloads[0].downloadUrl).toBeUndefined();
  });

  it("refuse un jeton propriétaire d'un autre utilisateur", async () => {
    const res = await callStats(transfer, {
      query: {
        ownerToken: createOwnerDownloadToken(transfer._id, buildUserId()),
        link: SHARE_LINK,
        key: ACCESS_KEY,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.recentDownloads).toBeUndefined();
  });

  it("donne le détail à la session de l'auteur ayant la lecture des transferts", async () => {
    auth.user = { _id: ownerId, id: ownerId.toString() };
    const res = await callStats(transfer);
    expect(res.statusCode).toBe(200);
    expect(res.body.recentDownloads).toHaveLength(1);
  });

  it("refuse le détail à la session d'un autre membre de l'espace", async () => {
    const colleague = buildUserId();
    await seedOrgMembership({ userId: colleague, organizationId: workspaceId });
    auth.user = { _id: colleague, id: colleague.toString() };
    const res = await callStats(transfer, {
      query: { link: SHARE_LINK, key: ACCESS_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.recentDownloads).toBeUndefined();
  });

  it("refuse le détail à l'auteur qui a perdu la lecture des transferts", async () => {
    const otherWorkspace = buildOrganizationId();
    await FileTransfer.updateOne(
      { _id: transfer._id },
      { $set: { workspaceId: otherWorkspace.toString() } },
    );
    auth.user = { _id: ownerId, id: ownerId.toString() };
    const res = await callStats(transfer);
    expect(res.statusCode).toBe(403);
  });
});
