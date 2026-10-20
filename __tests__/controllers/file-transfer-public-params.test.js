import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";

vi.mock("stripe", () => {
  function StripeMock() {
    return { checkout: { sessions: { retrieve: vi.fn() } } };
  }
  return { default: StripeMock };
});

process.env.STRIPE_SECRET_KEY = "sk_test_dummy";

import FileTransfer from "../../src/models/FileTransfer.js";
import {
  downloadFile,
  downloadAllFiles,
} from "../../src/controllers/fileTransferController.js";
import { stripOperatorKeys } from "../../src/middlewares/strip-mongo-operators.js";

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  await FileTransfer.create({
    userId: new mongoose.Types.ObjectId(),
    shareLink: "lien-d-un-autre",
    accessKey: "cle-d-un-autre",
    files: [
      {
        originalName: "f.txt",
        fileName: "f.txt",
        filePath: "/tmp/f.txt",
        mimeType: "text/plain",
        size: 1,
      },
    ],
    expiryDate: new Date(Date.now() + 86_400_000),
    totalSize: 1,
    status: "active",
  });
});

const buildRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn();
  return res;
};

// Paramètres tels que l'analyseur d'Express les reconstruit pour
// `?link[$ne]=x&key[$ne]=y` : des objets, pas des chaînes.
const operatorQuery = (extra = {}) => ({
  link: { $ne: "absent" },
  key: { $ne: "absent" },
  ...extra,
});

describe("Transferts : routes publiques de téléchargement", () => {
  it("download-file : un lien ou une clé qui ne sont pas du texte ne trouvent rien", async () => {
    const res = buildRes();
    await downloadFile(
      {
        query: operatorQuery({ fileId: "000000000000000000000000" }),
        headers: {},
      },
      res,
    );
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Transfert non trouvé ou expiré" }),
    );
  });

  it("download-all : un lien ou une clé qui ne sont pas du texte ne trouvent rien", async () => {
    const res = buildRes();
    await downloadAllFiles({ query: operatorQuery(), headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Transfert non trouvé ou expiré" }),
    );
  });

  it("après le nettoyage des entrées, la requête ne trouve rien non plus", async () => {
    const res = buildRes();
    const query = stripOperatorKeys(operatorQuery());
    expect(query).toEqual({ link: {}, key: {} });
    await downloadAllFiles({ query, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("paramètres absents : toujours « manquants »", async () => {
    const res = buildRes();
    await downloadAllFiles({ query: {}, headers: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
