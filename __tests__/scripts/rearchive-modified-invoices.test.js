import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";
import Invoice from "../../src/models/Invoice.js";
import {
  rearchiveModifiedInvoices,
  restoreOldPdf,
} from "../../scripts/rearchive-modified-invoices.js";
import { readBackup, restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const silent = () => {};
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "rearchivage-"));

const ARCHIVED_AT = new Date("2026-09-10T08:00:00.000Z");
const EDITED_AT = new Date("2026-09-12T15:30:00.000Z");
const OLD_PDF = Buffer.from("%PDF-1.7 ancienne version");

let sequence = 0;

/** Facture émise, archivée le 10/09 puis modifiée le 12/09 (par défaut). */
const insertInvoice = async (overrides = {}) => {
  sequence += 1;
  const id = `${sequence}`.padStart(4, "0");
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-202609-",
    number: id,
    status: "PENDING",
    archivedPdfKey: `invoices/${organizationId}/2026/09/${id}_newbi_facture.pdf`,
    archivedPdfStoredAt: ARCHIVED_AT,
    archivedPdfSource: "NEWBI",
    facturXData: { xmlGenerated: true, profile: "EN16931" },
    eInvoiceStatus: "NOT_SENT",
    createdAt: ARCHIVED_AT,
    updatedAt: EDITED_AT,
    ...overrides,
  });
  return insertedId;
};

const stored = (id) => Invoice.collection.findOne({ _id: id });

/**
 * Archivage simulé, comme archiveInvoiceFacturX : nouvelle clé (ou la même
 * avec `sameKey`) et Invoice.updateOne, qui touche updatedAt (timestamps).
 */
const fakeArchive = ({ sameKey = false, calls = [] } = {}) => {
  const archive = async (invoice, workspaceId) => {
    calls.push({ id: String(invoice._id), workspaceId });
    await Invoice.updateOne(
      { _id: invoice._id },
      {
        $set: {
          archivedPdfKey: sameKey
            ? invoice.archivedPdfKey
            : invoice.archivedPdfKey.replace("/2026/09/", "/2026/10/"),
          archivedPdfUrl: null,
          archivedPdfStoredAt: new Date(),
          archivedPdfSource: "NEWBI",
        },
      },
    );
  };
  archive.calls = calls;
  return archive;
};

const run = (options = {}) =>
  rearchiveModifiedInvoices({
    log: silent,
    backupDir,
    delayMs: 0,
    fetchArchivedPdf: async () => OLD_PDF,
    ...options,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
  fs.rmSync(backupDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearMongo();
});

describe("rearchiveModifiedInvoices", () => {
  it("liste en aperçu les factures modifiées après leur archivage, sans rien écrire", async () => {
    const edited = await insertInvoice();
    // Archivage qui touche updatedAt quelques millisecondes après : ignoré
    await insertInvoice({
      updatedAt: new Date(ARCHIVED_AT.getTime() + 15),
    });
    await insertInvoice({ status: "DRAFT" });
    await insertInvoice({ archivedPdfSource: "SUPERPDP" });
    await insertInvoice({ archivedPdfKey: null });
    const lines = [];

    const stats = await run({ log: (line) => lines.push(line) });

    expect(stats).toMatchObject({
      scanned: 1,
      candidates: 1,
      transmitted: 0,
      rearchived: 0,
      backupFile: null,
    });
    expect(lines.join("\n")).toContain(String(edited));
    expect((await stored(edited)).archivedPdfStoredAt).toEqual(ARCHIVED_AT);
  });

  it("ne réarchive jamais une facture transmise en e-facturation", async () => {
    const deposited = await insertInvoice({ superPdpInvoiceId: "spdp-1" });
    const sent = await insertInvoice({ eInvoiceStatus: "SENT_TO_RECIPIENT" });
    const refused = await insertInvoice({ eInvoiceStatus: "ERROR" });
    const archive = fakeArchive();

    const stats = await run({ apply: true, archive });

    expect(stats).toMatchObject({
      transmitted: 2,
      candidates: 1,
      rearchived: 1,
    });
    expect(archive.calls.map((call) => call.id)).toEqual([String(refused)]);
    for (const id of [deposited, sent]) {
      expect((await stored(id)).archivedPdfStoredAt).toEqual(ARCHIVED_AT);
    }
  });

  it("réarchive, garde updatedAt et sauvegarde l'ancienne archive et son PDF", async () => {
    const id = await insertInvoice();
    const archive = fakeArchive();

    const stats = await run({ apply: true, archive });

    expect(stats).toMatchObject({ candidates: 1, rearchived: 1, failed: 0 });
    expect(archive.calls).toEqual([
      { id: String(id), workspaceId: String(organizationId) },
    ]);
    const invoice = await stored(id);
    expect(invoice.archivedPdfKey).toContain("/2026/10/");
    expect(invoice.archivedPdfStoredAt.getTime()).toBeGreaterThan(
      ARCHIVED_AT.getTime(),
    );
    // Le réarchivage n'est pas une modification de la facture
    expect(invoice.updatedAt).toEqual(EDITED_AT);

    const backup = readBackup(stats.backupFile);
    const [entry] = backup.entries;
    expect(entry.before).toMatchObject({
      archivedPdfStoredAt: ARCHIVED_AT,
      archivedPdfSource: "NEWBI",
    });
    expect(entry.before.archivedPdfKey).toContain("/2026/09/");
    expect(entry.after.archivedPdfKey).toBe(invoice.archivedPdfKey);
    const pdf = path.join(path.dirname(stats.backupFile), entry.oldPdfFile);
    expect(fs.readFileSync(pdf)).toEqual(OLD_PDF);
  });

  it("est idempotent : une facture réarchivée n'est plus sélectionnée", async () => {
    await insertInvoice();
    await insertInvoice();

    const first = await run({ apply: true, archive: fakeArchive() });
    const second = await run({ apply: true, archive: fakeArchive() });

    expect(first.rearchived).toBe(2);
    expect(second).toMatchObject({ scanned: 0, candidates: 0 });
    expect(second.backupFile).toBeNull();
  });

  it("compte un échec quand l'archive n'a pas été régénérée", async () => {
    const id = await insertInvoice();
    const failing = async () => {
      throw new Error("Request failed with status code 401");
    };
    // Service qui rend la main sans rien archiver (INTERNAL_API_SECRET absent)
    const silentNoop = async () => {};

    const errors = await run({ apply: true, archive: failing });
    const noop = await run({ apply: true, archive: silentNoop });

    expect(errors).toMatchObject({ rearchived: 0, failed: 1 });
    expect(noop).toMatchObject({ rearchived: 0, failed: 1 });
    const invoice = await stored(id);
    expect(invoice.archivedPdfStoredAt).toEqual(ARCHIVED_AT);
    expect(invoice.updatedAt).toEqual(EDITED_AT);
    // Rien à remettre : la sauvegarde ne porte pas d'état « après »
    const restored = await restoreBackup(errors.backupFile, {
      apply: true,
      log: silent,
    });
    expect(restored).toMatchObject({ restored: 0, skipped: 1 });
  });

  it("respecte --marge, --avant, --depuis, --workspace et --limit", async () => {
    await insertInvoice({
      updatedAt: new Date("2026-10-05T00:00:00.000Z"),
    });
    await insertInvoice({
      updatedAt: new Date(ARCHIVED_AT.getTime() + 30 * 60 * 1000),
    });
    await insertInvoice({ workspaceId: buildOrganizationId() });

    const margin = await run({ marginSeconds: 3600 });
    const before = await run({ before: new Date("2026-10-01") });
    const since = await run({ since: new Date("2026-10-01") });
    const workspace = await run({ workspaceId: organizationId.toString() });
    const limited = await run({ limit: 1 });

    // Marge d'une heure : la facture modifiée 30 min après l'archivage sort
    expect(margin.candidates).toBe(2);
    // Avant le 01/10 : la facture modifiée le 05/10 sort
    expect(before.candidates).toBe(2);
    expect(since.candidates).toBe(1);
    expect(workspace.candidates).toBe(2);
    expect(limited.scanned).toBe(1);
  });

  it("le retour arrière remet l'ancienne archive et son PDF écrasé", async () => {
    const id = await insertInvoice();
    const { backupFile } = await run({
      apply: true,
      archive: fakeArchive({ sameKey: true }),
    });
    const rearchived = await stored(id);
    const uploads = [];

    const restored = await restoreBackup(backupFile, {
      apply: true,
      log: silent,
      afterRestore: restoreOldPdf(
        async (key, buffer) => uploads.push({ key, buffer }),
        silent,
      ),
    });

    expect(restored.restored).toBe(1);
    const invoice = await stored(id);
    expect(invoice.archivedPdfKey).toBe(rearchived.archivedPdfKey);
    expect(invoice.archivedPdfStoredAt).toEqual(ARCHIVED_AT);
    expect(invoice.facturXData).toEqual({
      xmlGenerated: true,
      profile: "EN16931",
    });
    expect(invoice.updatedAt).toEqual(EDITED_AT);
    // Même clé R2 : la copie locale de l'ancien PDF y est remise
    expect(uploads).toEqual([
      { key: rearchived.archivedPdfKey, buffer: OLD_PDF },
    ]);
  });

  it("le retour arrière laisse une facture réarchivée depuis par l'appli", async () => {
    const id = await insertInvoice();
    const { backupFile } = await run({ apply: true, archive: fakeArchive() });
    // Modification dans l'appli : nouvelle archive posée par l'API
    await Invoice.collection.updateOne(
      { _id: id },
      { $set: { archivedPdfStoredAt: new Date("2026-10-20T00:00:00.000Z") } },
    );

    const restored = await restoreBackup(backupFile, {
      apply: true,
      log: silent,
    });

    expect(restored).toMatchObject({ restored: 0, skipped: 1 });
    expect((await stored(id)).archivedPdfStoredAt).toEqual(
      new Date("2026-10-20T00:00:00.000Z"),
    );
  });
});
