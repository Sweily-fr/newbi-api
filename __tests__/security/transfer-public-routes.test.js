/**
 * Routes publiques des transferts : matrice d'accès, et identifiants mal
 * formés.
 *
 * /api/files/download, /api/files/preview et /api/transfers/:id/authorize
 * refusent avant tout accès à R2 : sans le lien et la clé (403), protégé par
 * mot de passe sans jeton (401), payant non réglé (402), filigrane au
 * téléchargement (403), expiré ou supprimé (410). Un identifiant mal formé
 * donne 404 (findById levait une CastError, attrapée en 500).
 * R2 est simulé et ne doit jamais être appelé ici.
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
import express from "express";
import mongoose from "mongoose";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET =
    process.env.BETTER_AUTH_SECRET || "secret-de-test";
  process.env.STRIPE_SECRET_KEY =
    process.env.STRIPE_SECRET_KEY || "sk_test_dummy";
});

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
import FileTransfer from "../../src/models/FileTransfer.js";
import fileDownloadRouter from "../../src/routes/fileDownload.js";
import fileTransferAuthRouter from "../../src/routes/fileTransferAuth.js";
import { createTransferAccessToken } from "../../src/utils/transferAccessToken.js";

const LINK = "l".repeat(32);
const KEY = "k".repeat(32);

let server;
let base;

beforeAll(async () => {
  await startMongo();
  const app = express();
  app.use(express.json());
  app.use("/api/files", fileDownloadRouter);
  app.use("/api/transfers", fileTransferAuthRouter);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  s3.send.mockReset();
  s3.send.mockRejectedValue(new Error("R2 ne doit pas être appelé"));
});

const transfert = (extra = {}) =>
  FileTransfer.create({
    userId: new mongoose.Types.ObjectId(),
    shareLink: LINK,
    accessKey: KEY,
    files: [
      {
        originalName: "plan.pdf",
        fileName: "plan.pdf",
        filePath: "https://transferts.example/plan.pdf",
        r2Key: "prod/2026/10/10/t_x/f_1_plan.pdf",
        mimeType: "application/pdf",
        size: 10,
        storageType: "r2",
        fileId: "f1",
      },
    ],
    totalSize: 10,
    expiryDate: new Date(Date.now() + 86_400_000),
    status: "active",
    ...extra,
  });

const get = (path, query = {}) =>
  fetch(`${base}${path}?${new URLSearchParams(query)}`);
const post = (path, body = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const download = (t, query) => get(`/api/files/download/${t._id}/f1`, query);
const preview = (t, query) => get(`/api/files/preview/${t._id}/f1`, query);
const avecCle = { link: LINK, key: KEY };

describe("Téléchargement et aperçu : refus avant R2", () => {
  it("sans lien ni clé : 403", async () => {
    const t = await transfert();
    expect((await download(t, {})).status).toBe(403);
    expect((await preview(t, {})).status).toBe(403);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("mauvaise clé : 403", async () => {
    const t = await transfert();
    expect((await download(t, { link: LINK, key: "x".repeat(32) })).status).toBe(403);
  });

  it("protégé par mot de passe, sans jeton : 401", async () => {
    const t = await transfert({ passwordProtected: true, password: "hash" });
    expect((await download(t, avecCle)).status).toBe(401);
    expect((await preview(t, avecCle)).status).toBe(401);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("jeton de mot de passe d'un autre transfert : 401", async () => {
    const autre = await transfert({
      shareLink: "a".repeat(32),
      passwordProtected: true,
      password: "hash-a",
    });
    const t = await transfert({ passwordProtected: true, password: "hash-b" });
    const jeton = createTransferAccessToken(autre);
    expect((await download(t, { ...avecCle, accessToken: jeton })).status).toBe(401);
  });

  it("payant non réglé : 402", async () => {
    const t = await transfert({ isPaymentRequired: true, paymentAmount: 10 });
    expect((await download(t, avecCle)).status).toBe(402);
    expect((await preview(t, avecCle)).status).toBe(402);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("filigrane : téléchargement 403", async () => {
    const t = await transfert({ hasWatermark: true });
    const res = await download(t, avecCle);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/filigrane/);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it("expiré : 410", async () => {
    const t = await transfert({ expiryDate: new Date(Date.now() - 1000) });
    expect((await download(t, avecCle)).status).toBe(410);
    expect((await preview(t, avecCle)).status).toBe(410);
  });

  it("supprimé : 410", async () => {
    const t = await transfert({ status: "deleted" });
    expect((await download(t, avecCle)).status).toBe(410);
  });
});

describe("Autorisation de téléchargement (/api/transfers/:id/authorize)", () => {
  it("sans clé : refusé, aucun événement enregistré", async () => {
    const t = await transfert();
    const res = await post(`/api/transfers/${t._id}/authorize`, { fileId: "f1" });
    expect(res.status).toBe(403);
    expect(await mongoose.connection.db.collection("downloadevents").countDocuments()).toBe(0);
  });

  it("payant non réglé, avec la clé : 402", async () => {
    const t = await transfert({ isPaymentRequired: true, paymentAmount: 10 });
    const res = await post(`/api/transfers/${t._id}/authorize`, {
      fileId: "f1",
      link: LINK,
      key: KEY,
    });
    expect(res.status).toBe(402);
  });
});

describe("Identifiant mal formé : 404, jamais 500", () => {
  it.each([
    ["GET", "/api/files/download/abc/def"],
    ["GET", "/api/files/preview/abc/def"],
    ["POST", "/api/transfers/abc/authorize"],
    ["POST", "/api/transfers/download-event/abc/complete"],
  ])("%s %s", async (method, path) => {
    const res =
      method === "GET" ? await get(path, avecCle) : await post(path, { fileId: "def" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error || body.message).toBeTruthy();
  });
});
