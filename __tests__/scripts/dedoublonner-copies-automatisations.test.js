/**
 * Script dedoublonner-copies-automatisations : copies en double du même
 * document Newbi dans le même dossier, laissées par les automatisations avant
 * le correctif du 13/11/2026. Aperçu sans écriture, doublons à la corbeille
 * avec --apply (journal reporté sur la copie gardée), retour arrière.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  dedupeCopies,
  findDuplicateCopies,
} from "../../scripts/dedoublonner-copies-automatisations.js";
import { restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const { ObjectId } = mongoose.Types;
const workspaceId = new ObjectId();
const folder = new ObjectId();
const otherFolder = new ObjectId();
let backupDir;
const db = () => mongoose.connection.db;
const silent = () => {};

let minutes = 0;
async function copy(fields) {
  const _id = new ObjectId();
  minutes += 1;
  await db()
    .collection("shareddocuments")
    .insertOne({
      _id,
      workspaceId,
      folderId: folder,
      uploadedByName: "Automatisation",
      trashedAt: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, minutes)),
      comments: [],
      ...fields,
    });
  return _id;
}

async function journal(sharedDocumentId, sourceDocumentId, automationId) {
  const { insertedId } = await db()
    .collection("documentautomationlogs")
    .insertOne({
      automationId: automationId || new ObjectId(),
      workspaceId,
      sourceDocumentType: "purchaseInvoice",
      sourceDocumentId,
      sharedDocumentId,
      status: "SUCCESS",
    });
  return insertedId;
}

const doc = (id) => db().collection("shareddocuments").findOne({ _id: id });

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "dedoublonner-"));
});

describe("repérage des doublons", () => {
  it("deux automatisations, même document, même dossier : une copie en trop", async () => {
    const source = new ObjectId();
    const first = await copy({ name: "canva.pdf" });
    const second = await copy({ name: "canva.pdf" });
    await journal(first, source);
    await journal(second, source);

    const { groups } = await findDuplicateCopies({ db: db() });

    expect(groups).toHaveLength(1);
    expect(String(groups[0].kept._id)).toBe(String(first));
    expect(groups[0].duplicates.map((d) => String(d._id))).toEqual([
      String(second),
    ]);
  });

  it("copie d'une automatisation supprimée (sans origine) : rangée par son nom", async () => {
    const source = new ObjectId();
    const ancienne = await copy({ name: "facture-12.pdf" });
    const nouvelle = await copy({
      name: "facture-12.pdf",
      sourceDocumentType: "purchaseInvoice",
      sourceDocumentId: source,
    });

    const { groups } = await findDuplicateCopies({ db: db() });

    expect(groups).toHaveLength(1);
    expect(String(groups[0].kept._id)).toBe(String(ancienne));
    expect(String(groups[0].duplicates[0]._id)).toBe(String(nouvelle));
  });

  it("même nom sans origine connue : à vérifier, jamais touché", async () => {
    await copy({ name: "facture.pdf" });
    await copy({ name: "facture.pdf" });

    const { groups, toReview } = await findDuplicateCopies({ db: db() });

    expect(groups).toEqual([]);
    expect(toReview).toHaveLength(1);
  });

  it("même document dans deux dossiers : pas un doublon", async () => {
    const source = new ObjectId();
    await journal(await copy({ name: "a.pdf" }), source);
    await journal(await copy({ name: "a.pdf", folderId: otherFolder }), source);

    const { groups } = await findDuplicateCopies({ db: db() });

    expect(groups).toEqual([]);
  });

  it("copie commentée gardée de préférence à la plus ancienne", async () => {
    const source = new ObjectId();
    const ancienne = await copy({ name: "a.pdf" });
    const commentee = await copy({
      name: "a.pdf",
      comments: [{ text: "vu par le comptable" }],
    });
    await journal(ancienne, source);
    await journal(commentee, source);

    const { groups } = await findDuplicateCopies({ db: db() });

    expect(String(groups[0].kept._id)).toBe(String(commentee));
  });
});

describe("aperçu, application, retour arrière", () => {
  it("aperçu : aucune écriture", async () => {
    const source = new ObjectId();
    const first = await copy({ name: "a.pdf" });
    const second = await copy({ name: "a.pdf" });
    await journal(first, source);
    await journal(second, source);

    const stats = await dedupeCopies({ db: db(), log: silent, backupDir });

    expect(stats).toMatchObject({ groups: 1, duplicates: 1, trashed: 0 });
    expect((await doc(second)).trashedAt).toBeNull();
    expect(stats.backupFile).toBeNull();
  });

  it("--apply : copie en trop à la corbeille, journal reporté, puis retour arrière", async () => {
    const source = new ObjectId();
    const kept = await copy({ name: "a.pdf" });
    const dup = await copy({ name: "a.pdf" });
    await journal(kept, source);
    const movedLog = await journal(dup, source);

    const stats = await dedupeCopies({
      db: db(),
      apply: true,
      log: silent,
      backupDir,
    });

    expect(stats).toMatchObject({ trashed: 1, logsMoved: 1 });
    const trashed = await doc(dup);
    expect(trashed.trashedAt).toBeInstanceOf(Date);
    expect(String(trashed.originalFolderId)).toBe(String(folder));
    expect((await doc(kept)).trashedAt).toBeNull();
    const log = await db()
      .collection("documentautomationlogs")
      .findOne({ _id: movedLog });
    expect(String(log.sharedDocumentId)).toBe(String(kept));

    await restoreBackup(stats.backupFile, {
      apply: true,
      db: db(),
      log: silent,
    });

    const restored = await doc(dup);
    expect(restored.trashedAt ?? null).toBeNull();
    expect(restored.originalFolderId ?? null).toBeNull();
    const logBack = await db()
      .collection("documentautomationlogs")
      .findOne({ _id: movedLog });
    expect(String(logBack.sharedDocumentId)).toBe(String(dup));
  });

  it("copie restaurée depuis l'appli entre-temps : le retour arrière la laisse", async () => {
    const source = new ObjectId();
    await journal(await copy({ name: "a.pdf" }), source);
    const dup = await copy({ name: "a.pdf" });
    await journal(dup, source);
    const stats = await dedupeCopies({
      db: db(),
      apply: true,
      log: silent,
      backupDir,
    });
    // L'utilisateur la ressort de la corbeille et la renomme
    await db()
      .collection("shareddocuments")
      .updateOne(
        { _id: dup },
        {
          $set: { trashedAt: null, name: "gardée.pdf" },
          $unset: { originalFolderId: "" },
        },
      );

    const result = await restoreBackup(stats.backupFile, {
      apply: true,
      db: db(),
      log: silent,
    });

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect((await doc(dup)).name).toBe("gardée.pdf");
  });
});
