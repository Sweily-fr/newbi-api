import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import { seedOrgMembership, buildContext } from "../helpers/auth.js";
import { buildOrganizationId, buildUserId } from "../factories/index.js";

// Effets de bord de updateInvoice (test « mêmes totaux que l'API »)
vi.mock("../../src/services/notificationService.js", () => ({
  default: {
    createAndSendNotification: vi.fn().mockResolvedValue(undefined),
    sendDocumentNotification: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/pennylaneSyncHelper.js", () => ({
  syncInvoiceIfNeeded: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../src/services/superPdpService.js", () => ({
  default: { sendInvoice: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/services/eInvoicingSettingsService.js", () => ({
  default: { getSettings: vi.fn().mockResolvedValue(null) },
}));
vi.mock("../../src/utils/eInvoiceRoutingHelper.js", () => ({
  evaluateAndRouteInvoice: vi.fn().mockResolvedValue(undefined),
  reportPaymentIfNeeded: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../src/services/documentAutomationService.js", () => ({
  default: { executeAutomations: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../../src/resolvers/clientAutomation.js", () => ({
  automationService: {
    executeAutomations: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/services/invoiceFacturXArchiveService.js", () => ({
  triggerInvoiceFacturXArchive: vi.fn(),
}));
vi.mock("../../src/services/calendar/CalendarSyncService.js", () => ({
  autoPushEventToConnections: vi.fn().mockResolvedValue(undefined),
  updateEventInExternalCalendars: vi.fn().mockResolvedValue(undefined),
  deleteEventFromExternalCalendars: vi.fn().mockResolvedValue(undefined),
  pushEventToCalendar: vi.fn().mockResolvedValue(undefined),
  syncConnection: vi.fn().mockResolvedValue(undefined),
  syncAllForUser: vi.fn().mockResolvedValue(undefined),
  disconnectCalendar: vi.fn().mockResolvedValue(undefined),
}));

import { invalidateOrgCache } from "../../src/middlewares/rbac.js";
import CreditNote from "../../src/models/CreditNote.js";
import Invoice from "../../src/models/Invoice.js";
import Transaction from "../../src/models/Transaction.js";
import invoiceResolvers, {
  calculateInvoiceTotals,
} from "../../src/resolvers/invoice.js";
import {
  INVOICE_TOTAL_FIELDS,
  recomputeInvoiceTotals,
  resumeRearchive,
} from "../../scripts/recompute-invoice-totals.js";
import { restoreOldPdf } from "../../scripts/rearchive-modified-invoices.js";
import { readBackup, restoreBackup } from "../../scripts/lib/remise-en-etat.js";

const userId = buildUserId();
const organizationId = buildOrganizationId();
const silent = () => {};
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "factures-totaux-"));

const ARCHIVED_AT = new Date("2026-09-10T08:00:00.000Z");
const UPDATED_AT = new Date("2026-09-20T10:00:00.000Z");
const OLD_PDF = Buffer.from("%PDF-1.7 ancienne version");

// 100 € HT à 20 % + 10 € de port HT à 20 %, remise globale de 10 %.
// Ancien calcul (remise aussi sur le port) : 99 HT, 19,80 TVA, 118,80 TTC.
// Calcul actuel (port jamais remisé) : 90 + 10 = 100 HT, 18 + 2 = 20 TVA.
const OLD_TOTALS = {
  totalHT: 110,
  totalVAT: 22,
  totalTTC: 132,
  finalTotalHT: 99,
  finalTotalVAT: 19.8,
  finalTotalTTC: 118.8,
};

const ITEMS = [
  {
    description: "Prestation",
    quantity: 1,
    unitPrice: 100,
    vatRate: 20,
    discount: 0,
    discountType: "PERCENTAGE",
  },
];
const SHIPPING = {
  billShipping: true,
  shippingAmountHT: 10,
  shippingVatRate: 20,
  shippingAddress: {
    fullName: "Jean Dupont",
    street: "3 rue de la Livraison",
    city: "Lyon",
    postalCode: "69001",
    country: "France",
  },
};
const NO_SHIPPING = {
  billShipping: false,
  shippingAmountHT: 0,
  shippingVatRate: 20,
};

let sequence = 0;

/** Facture émise, archivée le 10/09, aux totaux de l'ancien calcul. */
const insertInvoice = async (overrides = {}) => {
  sequence += 1;
  const number = String(sequence).padStart(4, "0");
  const { insertedId } = await Invoice.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    prefix: "F-202609-",
    number,
    status: "PENDING",
    issueDate: new Date("2026-09-05T00:00:00.000Z"),
    client: {
      id: "client-1",
      name: "Acme",
      email: "client@test.fr",
      address: {
        street: "1 rue Test",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
    },
    items: ITEMS,
    discount: 10,
    discountType: "PERCENTAGE",
    shipping: SHIPPING,
    isReverseCharge: false,
    ...OLD_TOTALS,
    eInvoiceStatus: "NOT_SENT",
    archivedPdfKey: `invoices/${organizationId}/2026/09/${number}_newbi_facture.pdf`,
    archivedPdfStoredAt: ARCHIVED_AT,
    archivedPdfSource: "NEWBI",
    facturXData: { xmlGenerated: true, profile: "EN16931" },
    linkedTransactionIds: [],
    createdAt: ARCHIVED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  });
  return insertedId;
};

/** Transaction bancaire rapprochée des factures (liens des deux côtés). */
const insertTransaction = async (invoiceIds, amount) => {
  const { insertedId } = await Transaction.collection.insertOne({
    externalId: `tx-${new mongoose.Types.ObjectId()}`,
    provider: "bridge",
    type: "credit",
    status: "completed",
    amount,
    currency: "EUR",
    workspaceId: String(organizationId),
    date: new Date("2026-09-15T00:00:00.000Z"),
    linkedInvoiceIds: invoiceIds,
    reconciliationStatus: "matched",
    deletedAt: null,
  });
  await Invoice.collection.updateMany(
    { _id: { $in: invoiceIds } },
    { $addToSet: { linkedTransactionIds: insertedId } },
  );
  return insertedId;
};

const insertCreditNote = async (invoiceId, finalTotalTTC) => {
  sequence += 1;
  const { insertedId } = await CreditNote.collection.insertOne({
    workspaceId: organizationId,
    createdBy: userId,
    originalInvoice: invoiceId,
    prefix: "AV-202609-",
    number: String(sequence).padStart(4, "0"),
    status: "CREATED",
    items: [],
    finalTotalTTC,
  });
  return insertedId;
};

const stored = (id) => Invoice.collection.findOne({ _id: id });
const totalsOf = (doc) =>
  Object.fromEntries(INVOICE_TOTAL_FIELDS.map((field) => [field, doc[field]]));

/**
 * Archivage simulé, comme archiveInvoiceFacturX : nouvelle clé (ou la même
 * avec `sameKey`) et Invoice.updateOne, qui touche updatedAt (timestamps).
 * Note le TTC enregistré au moment de la génération (lu par NewbiV2).
 */
const fakeArchive = ({ sameKey = false } = {}) => {
  const calls = [];
  const archive = async (invoice, workspaceId) => {
    const current = await stored(invoice._id);
    calls.push({
      id: String(invoice._id),
      workspaceId,
      finalTotalTTC: current.finalTotalTTC,
    });
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
          facturXData: {
            xmlGenerated: true,
            profile: "EN16931",
            generatedAt: new Date(),
          },
        },
      },
    );
  };
  archive.calls = calls;
  return archive;
};

const run = (options = {}) =>
  recomputeInvoiceTotals({
    log: silent,
    backupDir,
    delayMs: 0,
    fetchArchivedPdf: async () => OLD_PDF,
    ...options,
  });

const resume = (file, options = {}) =>
  resumeRearchive(file, {
    log: silent,
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
  invalidateOrgCache();
  await seedOrgMembership({ userId, organizationId, role: "owner" });
});

describe("recomputeInvoiceTotals", () => {
  it("n'écrit rien sans --apply et liste la facture : totaux, écart, raison, liens", async () => {
    const id = await insertInvoice();
    const lines = [];

    const stats = await run({ log: (line) => lines.push(line) });

    expect(stats).toMatchObject({
      scanned: 1,
      toFix: 1,
      toRearchive: 1,
      updated: 0,
      backupFile: null,
    });
    expect(await stored(id)).toMatchObject(OLD_TOTALS);
    const output = lines.join("\n");
    expect(output).toContain(
      `Facture F-202609-0001 (${id}, PENDING, espace ${organizationId})`,
    );
    expect(output).toContain("HT 99.00 → 100.00");
    expect(output).toContain("TVA 19.80 → 20.00");
    expect(output).toContain("TTC 118.80 → 120.00");
    expect(output).toContain("écart TTC +1.20");
    expect(output).toContain("[port + remise globale en %]");
    expect(output).toContain("paiement : aucun paiement enregistré");
    expect(output).toContain("avoirs : aucun");
    expect(output).toMatch(
      /archive : PDF Factur-X archivé, à régénérer.*--rearchive/,
    );
  });

  it("corrige avec le calcul de l'API, sans toucher updatedAt ni l'archive", async () => {
    const id = await insertInvoice();

    const stats = await run({ apply: true });

    expect(stats).toMatchObject({ updated: 1, changedSince: 0, rearchived: 0 });
    const invoice = await stored(id);
    const doc = Invoice.hydrate(invoice);
    const expected = calculateInvoiceTotals(
      doc.items,
      doc.discount,
      doc.discountType,
      doc.shipping,
      doc.isReverseCharge,
    );
    for (const field of INVOICE_TOTAL_FIELDS) {
      expect(invoice[field]).toBe(expected[field]);
    }
    expect(invoice.finalTotalHT).toBeCloseTo(100, 10);
    expect(invoice.finalTotalVAT).toBeCloseTo(20, 10);
    expect(invoice.finalTotalTTC).toBeCloseTo(120, 10);
    // discountAmount n'est pas un champ du modèle Invoice
    expect(invoice).not.toHaveProperty("discountAmount");
    expect(invoice.updatedAt).toEqual(UPDATED_AT);
    expect(invoice.archivedPdfStoredAt).toEqual(ARCHIVED_AT);

    const [entry] = readBackup(stats.backupFile).entries;
    expect(entry.before).toEqual(OLD_TOTALS);
    expect(entry.after.finalTotalTTC).toBeCloseTo(120, 10);
    expect(entry.reasons).toEqual(["port + remise globale en %"]);
  });

  it("écrit exactement les totaux qu'enregistre updateInvoice", async () => {
    const id = await insertInvoice();
    // Brouillon : une facture émise ne change plus de montant par updateInvoice
    const twin = await insertInvoice({ status: "DRAFT" });
    // Même facture enregistrée par le vrai resolver (calcul actuel)
    await invoiceResolvers.Mutation.updateInvoice(
      null,
      {
        id: twin.toString(),
        input: {
          items: ITEMS,
          discount: 10,
          discountType: "PERCENTAGE",
          shipping: SHIPPING,
        },
      },
      buildContext({
        userId,
        organizationId,
        extra: { userRole: "owner" },
      }),
    );
    // Puis émise, comme la facture à corriger
    await Invoice.collection.updateOne(
      { _id: twin },
      { $set: { status: "PENDING" } },
    );

    const stats = await run({ apply: true });

    // La facture passée par le resolver est déjà juste
    expect(stats).toMatchObject({ scanned: 2, unchanged: 1, updated: 1 });
    const viaResolver = totalsOf(await stored(twin));
    expect(viaResolver.finalTotalTTC).toBeCloseTo(120, 10);
    expect(totalsOf(await stored(id))).toEqual(viaResolver);
  });

  it("est idempotent : une seconde exécution ne trouve plus rien", async () => {
    await insertInvoice();
    await insertInvoice({ status: "COMPLETED" });

    const first = await run({ apply: true });
    const second = await run({ apply: true });

    expect(first.updated).toBe(2);
    expect(second).toMatchObject({ scanned: 2, unchanged: 2, toFix: 0 });
    expect(second.backupFile).toBeNull();
  });

  it("ne modifie ni ne réarchive jamais une facture transmise, la liste à part", async () => {
    const deposited = await insertInvoice({ superPdpInvoiceId: "spdp-123" });
    const sent = await insertInvoice({ eInvoiceStatus: "SENT_TO_RECIPIENT" });
    // Envoi refusé avant dépôt : pas transmise, corrigée
    const refused = await insertInvoice({ eInvoiceStatus: "ERROR" });
    const archive = fakeArchive();
    const lines = [];

    const stats = await run({
      apply: true,
      rearchive: true,
      archive,
      log: (line) => lines.push(line),
    });

    expect(stats).toMatchObject({
      locked: 2,
      toFix: 1,
      updated: 1,
      rearchived: 1,
    });
    for (const id of [deposited, sent]) {
      const invoice = await stored(id);
      expect(invoice).toMatchObject(OLD_TOTALS);
      expect(invoice.archivedPdfStoredAt).toEqual(ARCHIVED_AT);
    }
    expect((await stored(refused)).finalTotalTTC).toBeCloseTo(120, 10);
    expect(archive.calls.map((call) => call.id)).toEqual([String(refused)]);
    const locked = lines.filter((line) => line.includes("🔒"));
    expect(locked).toHaveLength(2);
    expect(locked[0]).toContain("à corriger par un avoir");
    expect(locked[0]).toContain("TTC 118.80 → 120.00");
  });

  it("corrige aussi les brouillons : le pre-save ne recalcule pas les totaux", async () => {
    const draft = await insertInvoice({
      status: "DRAFT",
      archivedPdfKey: null,
      archivedPdfStoredAt: null,
      archivedPdfSource: null,
    });
    // Un enregistrement par le modèle (changeInvoiceStatus) garde les totaux faux
    const doc = await Invoice.findById(draft);
    doc.headerNotes = "Relance";
    await doc.save({ validateBeforeSave: false });
    expect((await stored(draft)).finalTotalTTC).toBe(118.8);
    const lines = [];

    const stats = await run({
      apply: true,
      rearchive: true,
      archive: fakeArchive(),
      log: (line) => lines.push(line),
    });

    expect(stats).toMatchObject({
      toFix: 1,
      drafts: 1,
      updated: 1,
      toRearchive: 0,
      rearchived: 0,
    });
    expect((await stored(draft)).finalTotalTTC).toBeCloseTo(120, 10);
    expect(lines.join("\n")).toContain("archive : aucune (brouillon)");
  });

  it("ignore une facture déjà juste (écart d'arrondi flottant) ou sans ligne", async () => {
    await insertInvoice({
      totalVAT: 22.000000000000004,
      finalTotalHT: 100,
      finalTotalVAT: 20.000000000000004,
      finalTotalTTC: 120.00000000000001,
    });
    await insertInvoice({ items: [] });

    const stats = await run({ apply: true });

    expect(stats).toMatchObject({
      scanned: 2,
      unchanged: 1,
      withoutItems: 1,
      toFix: 0,
    });
    expect(stats.backupFile).toBeNull();
  });

  it("respecte --workspace, --limit et --port-remise", async () => {
    const otherOrg = buildOrganizationId();
    const mine = await insertInvoice();
    const other = await insertInvoice({ workspaceId: otherOrg });
    // Écart d'une autre cause : ni port ni remise, totaux faux
    const otherCause = await insertInvoice({
      discount: 0,
      shipping: NO_SHIPPING,
    });
    const lines = [];

    const limited = await run({ limit: 1 });
    const portOnly = await run({
      apply: true,
      shippingDiscountOnly: true,
      workspaceId: organizationId.toString(),
      log: (line) => lines.push(line),
    });

    expect(limited.scanned).toBe(1);
    expect(portOnly).toMatchObject({
      scanned: 2,
      toFix: 1,
      otherSkipped: 1,
      updated: 1,
    });
    expect((await stored(mine)).finalTotalTTC).toBeCloseTo(120, 10);
    expect(await stored(other)).toMatchObject(OLD_TOTALS);
    expect(await stored(otherCause)).toMatchObject(OLD_TOTALS);
    expect(lines.find((line) => line.includes("⏸"))).toContain("[autre]");

    // Sans --port-remise, l'autre cause est corrigée aussi (100 HT, 120 TTC)
    const all = await run({ apply: true });
    expect(all).toMatchObject({ toFix: 2, updated: 2 });
    expect((await stored(otherCause)).finalTotalTTC).toBeCloseTo(120, 10);
  });

  it("signale les paiements qui deviendraient partiels, sans les modifier", async () => {
    // Virement du total enregistré (ancien calcul) : deviendrait partiel
    const paidStored = await insertInvoice({ status: "COMPLETED" });
    const transaction = await insertTransaction([paidStored], 118.8);
    // Virement du montant du PDF : redevient exactement payée, pas d'alerte
    const paidPdf = await insertInvoice({ status: "COMPLETED" });
    await insertTransaction([paidPdf], 120);
    // Carte Stripe : débitée du total enregistré alors
    await insertInvoice({ status: "COMPLETED", stripePaymentStatus: "paid" });
    // Marquée payée à la main : pas de montant à comparer
    await insertInvoice({ status: "COMPLETED" });
    const lines = [];

    const stats = await run({ apply: true, log: (line) => lines.push(line) });

    expect(stats).toMatchObject({ toFix: 4, updated: 4, paymentWarnings: 2 });
    const output = lines.join("\n");
    expect(output).toContain(
      "⚠️ paiement : « payée » → « partiellement payée » (reste 1.20 à encaisser), statut de la facture COMPLETED",
    );
    expect(output).toContain(
      "ancien total : payée avec trop-perçu, nouveau total : payée",
    );
    expect(output).toContain("paiement carte Stripe du total enregistré alors");
    expect(output).toContain("marquée payée sans montant enregistré");
    // Paiements et rapprochements jamais modifiés
    const invoice = await stored(paidStored);
    expect(invoice.status).toBe("COMPLETED");
    expect(invoice.linkedTransactionIds).toEqual([transaction]);
    expect(
      (await Transaction.collection.findOne({ _id: transaction })).amount,
    ).toBe(118.8);
  });

  it("signale les avoirs qui ne couvriraient plus la facture ou la dépasseraient", async () => {
    // Avoir total au montant enregistré : ne couvrirait plus toute la facture
    const credited = await insertInvoice();
    await insertCreditNote(credited, -118.8);
    // Avoir partiel avant et après : rien à signaler
    const partial = await insertInvoice();
    await insertCreditNote(partial, -50);
    // Total enregistré trop haut (autre cause) : les avoirs dépasseraient
    const over = await insertInvoice({
      totalHT: 110,
      totalVAT: 22,
      totalTTC: 132,
      finalTotalHT: 105,
      finalTotalVAT: 21,
      finalTotalTTC: 126,
    });
    await insertCreditNote(over, -125);
    const lines = [];

    const stats = await run({ log: (line) => lines.push(line) });

    expect(stats).toMatchObject({ toFix: 3, creditNoteWarnings: 2 });
    const output = lines.join("\n");
    expect(output).toContain(
      "⚠️ avoirs : « entièrement couverte par ses avoirs » → « partiellement couverte par ses avoirs » (reste 1.20 non couvert)",
    );
    expect(output).toContain(
      "⚠️ avoirs : somme 125.00 > nouveau TTC 120.00, le plafond « somme des avoirs ≤ facture » ne serait plus respecté",
    );
    expect(output).toMatch(/avoirs : AV-202609-\d+ \(-50\.00\), somme 50\.00/);
  });

  it("--rearchive régénère l'archive des factures émises corrigées, après la correction", async () => {
    const pending = await insertInvoice();
    const archive = fakeArchive();

    const stats = await run({ apply: true, rearchive: true, archive });

    expect(stats).toMatchObject({
      updated: 1,
      rearchived: 1,
      rearchiveFailed: 0,
    });
    // Généré sur les totaux corrigés (NewbiV2 lit la facture enregistrée)
    expect(archive.calls).toEqual([
      {
        id: String(pending),
        workspaceId: String(organizationId),
        finalTotalTTC: expect.closeTo(120, 10),
      },
    ]);
    const invoice = await stored(pending);
    expect(invoice.archivedPdfKey).toContain("/2026/10/");
    expect(invoice.archivedPdfStoredAt.getTime()).toBeGreaterThan(
      ARCHIVED_AT.getTime(),
    );
    // Ni la correction ni le réarchivage ne sont des modifications
    expect(invoice.updatedAt).toEqual(UPDATED_AT);

    const [entry] = readBackup(stats.backupFile).entries;
    expect(entry.before).toMatchObject({
      ...OLD_TOTALS,
      archivedPdfStoredAt: ARCHIVED_AT,
      archivedPdfSource: "NEWBI",
    });
    expect(entry.after.archivedPdfKey).toBe(invoice.archivedPdfKey);
    const pdf = path.join(path.dirname(stats.backupFile), entry.oldPdfFile);
    expect(fs.readFileSync(pdf)).toEqual(OLD_PDF);
  });

  it("le retour arrière remet les totaux, l'archive et l'ancien PDF écrasé", async () => {
    const id = await insertInvoice();
    const { backupFile } = await run({
      apply: true,
      rearchive: true,
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
    expect(invoice).toMatchObject(OLD_TOTALS);
    expect(invoice.archivedPdfStoredAt).toEqual(ARCHIVED_AT);
    expect(invoice.facturXData).toEqual({
      xmlGenerated: true,
      profile: "EN16931",
    });
    expect(invoice.updatedAt).toEqual(UPDATED_AT);
    // Même clé R2 : la copie locale de l'ancien PDF y est remise
    expect(uploads).toEqual([
      { key: rearchived.archivedPdfKey, buffer: OLD_PDF },
    ]);
  });

  it("le retour arrière remet les totaux, sauf facture modifiée depuis", async () => {
    const kept = await insertInvoice();
    const editedSince = await insertInvoice();
    const { backupFile } = await run({ apply: true });
    // Facture modifiée dans l'appli après le script
    await Invoice.collection.updateOne(
      { _id: editedSince },
      { $set: { finalTotalTTC: 240 } },
    );
    const uploads = [];

    const preview = await restoreBackup(backupFile, { log: silent });
    expect(preview).toMatchObject({ restorable: 1, skipped: 1 });
    expect((await stored(kept)).finalTotalTTC).toBeCloseTo(120, 10);

    const restored = await restoreBackup(backupFile, {
      apply: true,
      log: silent,
      afterRestore: restoreOldPdf(
        async (key, buffer) => uploads.push({ key, buffer }),
        silent,
      ),
    });

    expect(restored).toMatchObject({ restored: 1, skipped: 1 });
    const invoice = await stored(kept);
    expect(invoice).toMatchObject(OLD_TOTALS);
    expect(invoice.updatedAt).toEqual(UPDATED_AT);
    expect((await stored(editedSince)).finalTotalTTC).toBe(240);
    // Pas de réarchivage : aucun PDF à remettre
    expect(uploads).toEqual([]);
  });

  it("--reprendre régénère plus tard les archives oubliées ou en échec, une seule fois", async () => {
    const id = await insertInvoice();
    const editedSince = await insertInvoice();
    // Correction sans --rearchive
    const first = await run({ apply: true });
    expect(first).toMatchObject({ updated: 2, toRearchive: 2 });
    // Facture modifiée dans l'appli depuis : l'API l'a réarchivée elle-même
    await Invoice.collection.updateOne(
      { _id: editedSince },
      { $set: { archivedPdfStoredAt: new Date("2026-10-20T00:00:00.000Z") } },
    );

    const preview = await resume(first.backupFile);
    expect(preview).toMatchObject({ pending: 2, ready: 1, changedSince: 1 });

    const failing = await resume(first.backupFile, {
      apply: true,
      archive: async () => {
        throw new Error("Request failed with status code 401");
      },
    });
    expect(failing).toMatchObject({ failed: 1, rearchived: 0 });
    expect((await stored(id)).archivedPdfStoredAt).toEqual(ARCHIVED_AT);

    const archive = fakeArchive();
    const resumed = await resume(first.backupFile, { apply: true, archive });
    const again = await resume(first.backupFile, { apply: true, archive });

    expect(resumed).toMatchObject({ pending: 2, rearchived: 1 });
    expect(archive.calls.map((call) => call.id)).toEqual([String(id)]);
    expect(again).toMatchObject({ pending: 1, ready: 0, rearchived: 0 });
    const invoice = await stored(id);
    expect(invoice.archivedPdfKey).toContain("/2026/10/");
    expect(invoice.updatedAt).toEqual(UPDATED_AT);

    // Sauvegarde complétée sur place : le retour arrière remet aussi l'archive
    const entry = readBackup(first.backupFile).entries.find(
      (candidate) => String(candidate._id) === String(id),
    );
    expect(entry.after.archivedPdfKey).toBe(invoice.archivedPdfKey);
    expect(entry.oldPdfFile).toBeTruthy();
    await restoreBackup(first.backupFile, { apply: true, log: silent });
    expect(await stored(id)).toMatchObject({
      ...OLD_TOTALS,
      archivedPdfStoredAt: ARCHIVED_AT,
    });
  });

  it("refuse une sauvegarde d'un autre script", async () => {
    const file = path.join(backupDir, "avoirs-totaux-test.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ script: "avoirs-totaux", entries: [] }),
    );

    await expect(resume(file)).rejects.toThrow("attendu factures-totaux");
  });
});
