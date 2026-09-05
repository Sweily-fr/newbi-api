import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import FileTransfer from "../../src/models/FileTransfer.js";

// Un lot de photos exportées avec le même horodatage arrive avec 10 noms
// identiques : dans le ZIP livré au destinataire, ces entrées s'écrasent à
// l'extraction (macOS ne garde que la dernière). Le modèle suffixe donc les
// doublons dès l'enregistrement.

const file = (originalName, extra = {}) => ({
  originalName,
  fileName: `f_${Math.random().toString(16).slice(2)}_${originalName}`,
  filePath: "https://r2.example/x",
  r2Key: "prod/x",
  mimeType: "image/jpeg",
  size: 1000,
  storageType: "r2",
  ...extra,
});

const baseTransfer = (files) => ({
  userId: new mongoose.Types.ObjectId(),
  files,
  totalSize: files.length * 1000,
  shareLink: `share-${Math.random().toString(36).slice(2)}`,
  accessKey: `key-${Math.random().toString(36).slice(2)}`,
  expiryDate: new Date(Date.now() + 86400000),
  status: "active",
});

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
});

describe("FileTransfer - noms de fichiers uniques", () => {
  it("suffixe les doublons à la création", async () => {
    const name = "photo-20260904-124718.jpeg";
    const doc = await FileTransfer.create(
      baseTransfer([file(name), file(name), file(name), file("autre.png")]),
    );
    const saved = await FileTransfer.findById(doc._id).lean();
    expect(saved.files.map((f) => f.originalName)).toEqual([
      name,
      "photo-20260904-124718 (2).jpeg",
      "photo-20260904-124718 (3).jpeg",
      "autre.png",
    ]);
    expect(saved.files[1].displayName).toBe("photo-20260904-124718 (2).jpeg");
  });

  it("ne modifie pas des noms déjà uniques ni un displayName personnalisé", async () => {
    const doc = await FileTransfer.create(
      baseTransfer([file("a.jpg", { displayName: "Ma photo" }), file("b.jpg")]),
    );
    const saved = await FileTransfer.findById(doc._id).lean();
    expect(saved.files.map((f) => f.originalName)).toEqual(["a.jpg", "b.jpg"]);
    expect(saved.files[0].displayName).toBe("Ma photo");
  });

  it("reste stable lors d'un enregistrement ultérieur sans changement de fichiers", async () => {
    const doc = await FileTransfer.create(
      baseTransfer([file("x.pdf"), file("x.pdf")]),
    );
    doc.title = "Renommé";
    await doc.save();
    const saved = await FileTransfer.findById(doc._id).lean();
    expect(saved.files.map((f) => f.originalName)).toEqual([
      "x.pdf",
      "x (2).pdf",
    ]);
  });
});
