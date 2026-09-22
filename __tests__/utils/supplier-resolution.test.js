import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";

import { startMongo, stopMongo, clearMongo } from "../helpers/mongo.js";
import Supplier from "../../src/models/Supplier.js";
import PurchaseInvoice from "../../src/models/PurchaseInvoice.js";
import Transaction from "../../src/models/Transaction.js";
// Implémentation réelle : à importer, pas à ré-écrire.
import {
  resolveSupplier,
  normalizeBankDescriptor,
  normalizeSupplierName,
} from "../../src/utils/supplierResolution.js";

/**
 * Fournisseur d'une facture d'achat : identifiants, récurrence bancaire,
 * puis nom. Cas d'origine (22/09/2026) : « Canva » lu sur certains PDF et
 * « Canva Pty. Ltd. » sur d'autres donnaient deux fiches fournisseur.
 */

const workspaceId = new mongoose.Types.ObjectId();
const otherWorkspace = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();

const makeSupplier = (name, extra = {}) =>
  Supplier.create({
    name,
    workspaceId,
    createdBy: userId,
    defaultCategory: "OTHER",
    ...extra,
  });

let seq = 0;
const makeInvoice = (supplier, extra = {}) =>
  PurchaseInvoice.create({
    supplierName: supplier.name,
    supplierId: supplier._id,
    issueDate: new Date("2026-01-01"),
    amountHT: 10,
    amountTVA: 0,
    amountTTC: 10,
    currency: "EUR",
    status: "PAID",
    category: "SUBSCRIPTIONS",
    source: "OCR",
    workspaceId,
    createdBy: userId,
    invoiceNumber: `INV-${++seq}`,
    ...extra,
  });

const makeTransaction = ({ description, linkedTo = [], ws = workspaceId }) =>
  Transaction.create({
    externalId: `tx-${++seq}`,
    provider: "bridge",
    type: "debit",
    status: "completed",
    amount: -11.99,
    currency: "EUR",
    workspaceId: String(ws),
    date: new Date("2026-01-25"),
    description,
    metadata: { bridgeCleanDescription: description },
    linkedPurchaseInvoiceIds: linkedTo,
  });

beforeAll(async () => {
  await startMongo();
});

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearMongo();
  seq = 0;
});

describe("normalisations", () => {
  it("nom : casse, accents, ponctuation", () => {
    expect(normalizeSupplierName("Canva Pty. Ltd.")).toBe("canva pty ltd");
    expect(normalizeSupplierName("  Société  Générale ")).toBe(
      "societe generale",
    );
  });

  it("libellé bancaire : sans * ni groupes chiffrés", () => {
    expect(normalizeBankDescriptor("CANVA* I04497-23160027")).toBe("canva");
    expect(normalizeBankDescriptor("Canva*")).toBe("canva");
    expect(normalizeBankDescriptor("PRLV SEPA OVH SAS 2026-01")).toBe(
      "prlv sepa ovh sas",
    );
  });
});

describe("resolveSupplier", () => {
  it("nom identique (casse ignorée) : réutilise la fiche, sans en créer", async () => {
    const canva = await makeSupplier("Canva Pty. Ltd.");
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "canva pty. ltd.",
      userId,
    });
    expect(matchedBy).toBe("name");
    expect(supplier._id.toString()).toBe(canva._id.toString());

    // À la ponctuation près : même fiche, via la règle de préfixe
    const loose = await resolveSupplier({
      workspaceId,
      name: "canva pty ltd",
      userId,
    });
    expect(loose.matchedBy).toBe("prefix");
    expect(loose.supplier._id.toString()).toBe(canva._id.toString());
    expect(supplier._id.toString()).toBe(canva._id.toString());
    expect(await Supplier.countDocuments()).toBe(1);
  });

  it("SIRET identique prime sur un nom différent, et enrichit la fiche du n° TVA", async () => {
    const ovh = await makeSupplier("OVHcloud", { siret: "424 761 419 00045" });
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "OVH SAS",
      siret: "42476141900045",
      vatNumber: "FR22424761419",
      userId,
    });
    expect(matchedBy).toBe("identifier");
    expect(supplier._id.toString()).toBe(ovh._id.toString());
    const saved = await Supplier.findById(ovh._id);
    expect(saved.vatNumber).toBe("FR22424761419");
  });

  it("n° TVA connu seulement via les factures passées : retrouve la fiche", async () => {
    const canva = await makeSupplier("Canva Pty. Ltd.");
    await makeInvoice(canva, {
      ocrMetadata: { supplierVatNumber: "EU372042198" },
    });
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Canva",
      vatNumber: "EU 372 042 198",
      userId,
    });
    expect(matchedBy).toBe("identifier");
    expect(supplier._id.toString()).toBe(canva._id.toString());
  });

  it("récurrence bancaire : même libellé déjà rapproché → même fournisseur (cas Canva)", async () => {
    const canva = await makeSupplier("Canva Pty. Ltd.");
    const junk = await makeSupplier("Canva*");
    // Deux fiches commencent par « Canva » : le préfixe seul ne tranche pas,
    // la récurrence bancaire oui.
    const inv1 = await makeInvoice(canva);
    const inv2 = await makeInvoice(canva);
    await makeTransaction({ description: "Canva*", linkedTo: [inv1._id] });
    await makeTransaction({
      description: "CANVA* I04497-23160027",
      linkedTo: [inv2._id],
    });
    const current = await makeTransaction({ description: "Canva*" });

    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Canva",
      transaction: current,
      userId,
    });
    expect(matchedBy).toBe("recurrence");
    expect(supplier._id.toString()).toBe(canva._id.toString());
    expect(supplier._id.toString()).not.toBe(junk._id.toString());
  });

  it("récurrence bancaire refusée si le fournisseur récurrent n'a aucun mot en commun avec le nom lu", async () => {
    const seller = await makeSupplier("Librairie Dupont");
    const inv = await makeInvoice(seller);
    await makeTransaction({
      description: "PAYPAL *ACHAT",
      linkedTo: [inv._id],
    });
    const current = await makeTransaction({ description: "PAYPAL *ACHAT" });

    const { matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Garage Martin",
      transaction: current,
      userId,
    });
    expect(matchedBy).toBe("created");
  });

  it("récurrence bancaire ignore les transactions d'un autre workspace", async () => {
    const canva = await makeSupplier("Canva Pty. Ltd.");
    const inv = await makeInvoice(canva);
    await makeTransaction({
      description: "Canva*",
      linkedTo: [inv._id],
      ws: otherWorkspace,
    });
    const current = await makeTransaction({ description: "Canva*" });

    const { matchedBy } = await resolveSupplier({
      workspaceId: otherWorkspace,
      name: "Canva",
      transaction: current,
      userId,
    });
    // Rien dans cet autre workspace : création
    expect(matchedBy).toBe("created");
  });

  it("nom lu = début du nom d'une seule fiche : réutilise la fiche", async () => {
    const canva = await makeSupplier("Canva Pty. Ltd.");
    await makeSupplier("Canvas Design Studio");
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Canva",
      userId,
    });
    expect(matchedBy).toBe("prefix");
    expect(supplier._id.toString()).toBe(canva._id.toString());
  });

  it("préfixe ambigu : tranche par la fiche nettement dominante en factures", async () => {
    const canva = await makeSupplier("Canva Pty. Ltd.");
    await makeSupplier("Canva*");
    await makeInvoice(canva);
    await makeInvoice(canva);
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Canva",
      userId,
    });
    expect(matchedBy).toBe("prefix");
    expect(supplier._id.toString()).toBe(canva._id.toString());
  });

  it("préfixe ambigu sans dominante : crée plutôt que deviner", async () => {
    await makeSupplier("Canva Pty. Ltd.");
    await makeSupplier("Canva*");
    const { matchedBy, supplier } = await resolveSupplier({
      workspaceId,
      name: "Canva",
      userId,
    });
    expect(matchedBy).toBe("created");
    expect(supplier.name).toBe("Canva");
  });

  it("create: false ne crée rien", async () => {
    const { supplier, matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Inconnu SAS",
      userId,
      create: false,
    });
    expect(supplier).toBeNull();
    expect(matchedBy).toBe("none");
    expect(await Supplier.countDocuments()).toBe(0);
  });

  it("ne mélange jamais deux workspaces", async () => {
    await Supplier.create({
      name: "Canva Pty. Ltd.",
      workspaceId: otherWorkspace,
      createdBy: userId,
      defaultCategory: "OTHER",
    });
    const { matchedBy } = await resolveSupplier({
      workspaceId,
      name: "Canva Pty. Ltd.",
      userId,
    });
    expect(matchedBy).toBe("created");
  });
});
