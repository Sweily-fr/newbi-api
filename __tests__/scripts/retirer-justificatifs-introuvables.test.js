/**
 * Script retirer-justificatifs-introuvables : justificatifs de factures
 * d'achat dont le fichier a disparu du stockage (relevé le 19/11/2026).
 * Aperçu sans écriture, retrait des seuls liens morts avec --apply,
 * sauvegarde et retour arrière.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import {
  findMissingFiles,
  removeMissingFiles,
} from "../../scripts/retirer-justificatifs-introuvables.js";
import { restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const { ObjectId } = mongoose.Types;
const workspaceId = new ObjectId();
const otherWorkspace = new ObjectId();
let backupDir;
const db = () => mongoose.connection.db;
const silent = () => {};

const MISSING = new Set([
  "https://r2.invalid/disparu-1.pdf",
  "https://r2.invalid/disparu-2.pdf",
  "https://r2.invalid/disparu-3.pdf",
]);
const UNKNOWN = "https://r2.invalid/reseau-en-panne.pdf";

/** Stockage simulé : introuvable, non vérifiable ou présent */
const checkFile = async (url) =>
  MISSING.has(url) ? "missing" : url === UNKNOWN ? "unknown" : "present";

const file = (name, url) => ({
  _id: new ObjectId(),
  filename: name,
  originalFilename: name,
  mimetype: "application/pdf",
  url,
  size: 10,
  createdAt: new Date("2026-09-23T18:00:00Z"),
});

async function invoice(files, ws = workspaceId) {
  const _id = new ObjectId();
  await db()
    .collection("purchaseinvoices")
    .insertOne({
      _id,
      workspaceId: ws,
      supplierName: "Fournisseur",
      invoiceNumber: "F-1",
      status: "PAID",
      files,
      updatedAt: new Date("2026-09-24T00:00:00Z"),
    });
  return _id;
}

const urlsOf = async (id) =>
  (await db().collection("purchaseinvoices").findOne({ _id: id })).files.map(
    (f) => f.url,
  );

beforeAll(async () => {
  await startMongo();
});
afterAll(async () => {
  await stopMongo();
});
beforeEach(async () => {
  await clearMongo();
  backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "justificatifs-"));
});

describe("retirer-justificatifs-introuvables", () => {
  it("aperçu : liste les liens morts sans rien écrire", async () => {
    const id = await invoice([
      file("present.pdf", "https://r2.invalid/present.pdf"),
      file("disparu.pdf", "https://r2.invalid/disparu-1.pdf"),
    ]);

    const stats = await removeMissingFiles({
      checkFile,
      backupDir,
      log: silent,
    });

    expect(stats).toMatchObject({ checked: 2, invoices: 1, missing: 1 });
    expect(stats.backupFile).toBeNull();
    expect(await urlsOf(id)).toHaveLength(2);
    expect(fs.readdirSync(backupDir)).toHaveLength(0);
  });

  it("--apply : retire seulement les liens morts, garde les autres et updatedAt", async () => {
    const keep = await invoice([
      file("present.pdf", "https://r2.invalid/present.pdf"),
    ]);
    const mixed = await invoice([
      file("disparu.pdf", "https://r2.invalid/disparu-1.pdf"),
      file("present.pdf", "https://r2.invalid/present-2.pdf"),
      file("disparu-bis.pdf", "https://r2.invalid/disparu-2.pdf"),
    ]);
    const empty = await invoice([
      file("seul.pdf", "https://r2.invalid/disparu-3.pdf"),
    ]);

    const stats = await removeMissingFiles({
      apply: true,
      checkFile,
      backupDir,
      log: silent,
    });

    expect(stats).toMatchObject({
      invoices: 2,
      missing: 3,
      removed: 3,
      left: 1,
    });
    expect(await urlsOf(keep)).toEqual(["https://r2.invalid/present.pdf"]);
    expect(await urlsOf(mixed)).toEqual(["https://r2.invalid/present-2.pdf"]);
    expect(await urlsOf(empty)).toEqual([]);
    const doc = await db()
      .collection("purchaseinvoices")
      .findOne({ _id: mixed });
    expect(doc.updatedAt).toEqual(new Date("2026-09-24T00:00:00Z"));
    expect(fs.existsSync(stats.backupFile)).toBe(true);
  });

  it("fichier non vérifiable (réseau, droits) : jamais retiré", async () => {
    const id = await invoice([file("incertain.pdf", UNKNOWN)]);

    const stats = await removeMissingFiles({
      apply: true,
      checkFile,
      backupDir,
      log: silent,
    });

    expect(stats).toMatchObject({ missing: 0, unknown: 1, removed: 0 });
    expect(await urlsOf(id)).toEqual([UNKNOWN]);
  });

  it("--workspace : ne touche pas les autres espaces", async () => {
    const mine = await invoice([
      file("disparu.pdf", "https://r2.invalid/disparu-1.pdf"),
    ]);
    const other = await invoice(
      [file("disparu.pdf", "https://r2.invalid/disparu-2.pdf")],
      otherWorkspace,
    );

    await removeMissingFiles({
      apply: true,
      workspaceId: String(workspaceId),
      checkFile,
      backupDir,
      log: silent,
    });

    expect(await urlsOf(mine)).toEqual([]);
    expect(await urlsOf(other)).toHaveLength(1);
  });

  it("facture modifiée entre l'aperçu et l'écriture : laissée telle quelle", async () => {
    const id = await invoice([
      file("disparu.pdf", "https://r2.invalid/disparu-1.pdf"),
    ]);
    const found = await findMissingFiles({ checkFile });
    expect(found.invoices).toHaveLength(1);

    // Un justificatif ajouté pendant le contrôle : le nombre de fichiers change
    let added = false;
    const slowCheck = async (url) => {
      if (!added) {
        added = true;
        await db()
          .collection("purchaseinvoices")
          .updateOne(
            { _id: id },
            {
              $push: { files: file("nouveau.pdf", "https://r2.invalid/n.pdf") },
            },
          );
      }
      return checkFile(url);
    };
    const stats = await removeMissingFiles({
      apply: true,
      checkFile: slowCheck,
      backupDir,
      log: silent,
    });

    expect(stats).toMatchObject({ removed: 0, unchanged: 1 });
    expect(await urlsOf(id)).toEqual([
      "https://r2.invalid/disparu-1.pdf",
      "https://r2.invalid/n.pdf",
    ]);
  });

  it("--restore : remet les liens retirés, sauf sur une facture changée depuis", async () => {
    const restored = await invoice([
      file("present.pdf", "https://r2.invalid/present.pdf"),
      file("disparu.pdf", "https://r2.invalid/disparu-1.pdf"),
    ]);
    const changed = await invoice([
      file("disparu.pdf", "https://r2.invalid/disparu-2.pdf"),
    ]);
    const { backupFile } = await removeMissingFiles({
      apply: true,
      checkFile,
      backupDir,
      log: silent,
    });

    // Justificatif redéposé depuis sur la seconde facture
    await db()
      .collection("purchaseinvoices")
      .updateOne(
        { _id: changed },
        { $push: { files: file("redepose.pdf", "https://r2.invalid/r.pdf") } },
      );

    const preview = await restoreBackup(backupFile, { log: silent });
    expect(preview).toMatchObject({ restorable: 1, restored: 0, skipped: 1 });

    const stats = await restoreBackup(backupFile, { apply: true, log: silent });
    expect(stats).toMatchObject({ restored: 1, skipped: 1 });
    expect(await urlsOf(restored)).toEqual([
      "https://r2.invalid/present.pdf",
      "https://r2.invalid/disparu-1.pdf",
    ]);
    const back = await db()
      .collection("purchaseinvoices")
      .findOne({ _id: restored });
    expect(back.files[1]._id).toBeInstanceOf(ObjectId);
    expect(back.files[1].createdAt).toBeInstanceOf(Date);
    expect(await urlsOf(changed)).toEqual(["https://r2.invalid/r.pdf"]);
  });
});
