#!/usr/bin/env node

/**
 * Nettoyage : SIRET / n° de TVA de l'organisation enregistrés comme ceux d'un
 * fournisseur. Les factures étrangères impriment le n° de TVA du client
 * (autoliquidation) et l'OCR le prenait pour celui de l'émetteur ; la
 * résolution du fournisseur rattachait alors toutes ces factures à la fiche
 * qui le portait (ticket du 11/10/2026 : Hostinger et MongoDB enregistrées
 * « Celonis Inc. » chez Sweily). Le code ignore désormais ces identifiants
 * (cf. withoutOwnIdentifiers dans src/utils/supplierResolution.js) ; ce
 * script retire ceux déjà enregistrés :
 *   1. fiches fournisseur : `siret` / `vatNumber` de l'organisation retirés ;
 *   2. factures d'achat : `ocrMetadata.supplierSiret` / `supplierVatNumber`
 *      de l'organisation retirés.
 *
 * Il liste aussi les factures probablement rattachées à tort (fiche qui
 * portait ces identifiants, nom lu par l'OCR sans mot commun avec celui de
 * la fiche), sans les modifier : le fournisseur se corrige depuis la facture,
 * le nom saisi n'étant plus remplacé.
 *
 * Une sauvegarde JSON des valeurs retirées est écrite AVANT toute écriture.
 *
 * Usage :
 *   NODE_ENV=production node scripts/clean-own-identifiers-suppliers.js [--apply]
 *   NODE_ENV=production node scripts/clean-own-identifiers-suppliers.js --restore <backup.json>
 *
 *   Sans --apply : aperçu, aucune modification.
 */

import "../src/config/env.js";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { EJSON } from "bson";
import Supplier from "../src/models/Supplier.js";
import PurchaseInvoice from "../src/models/PurchaseInvoice.js";
import Transaction from "../src/models/Transaction.js";
import { loadOwnCompany } from "../src/utils/clientMatching.js";
import {
  normalizeSupplierName,
  withoutOwnIdentifiers,
} from "../src/utils/supplierResolution.js";

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const RESTORE_FILE = argValue("--restore");

const BACKUP_DIR = path.resolve(process.cwd(), "backups");

const MODELS = { suppliers: Supplier, purchaseinvoices: PurchaseInvoice };

// Mots communs aux deux noms, formes juridiques comprises : on ne signale
// que les rattachements sans aucun rapport (« Hostinger » → « Celonis Inc. »).
const shareWord = (a, b) => {
  const wa = normalizeSupplierName(a)
    .split(" ")
    .filter((w) => w.length >= 3);
  const wb = new Set(normalizeSupplierName(b).split(" "));
  return wa.some((w) => wb.has(w));
};

async function restore(file) {
  const { changes } = EJSON.parse(fs.readFileSync(file, "utf8"));
  for (const { collection, _id, field, value } of changes) {
    await MODELS[collection].collection.updateOne(
      { _id },
      { $set: { [field]: value } },
    );
  }
  console.log(`✅ ${changes.length} valeur(s) restaurée(s) depuis ${file}`);
}

async function collectChanges() {
  const orgs = await mongoose.connection.db
    .collection("organization")
    .find({
      $or: [
        { vatNumber: { $nin: [null, ""] } },
        { siret: { $nin: [null, ""] } },
        { siren: { $nin: [null, ""] } },
      ],
    })
    .project({ _id: 1, name: 1 })
    .toArray();

  const changes = [];
  const suspects = [];

  for (const org of orgs) {
    const own = await loadOwnCompany(org._id);
    if (!own?.siren && !own?.vat) continue;
    const isOwn = (siret, vatNumber) =>
      withoutOwnIdentifiers({ siret, vatNumber }, own);

    // 1. Fiches fournisseur
    const suppliers = await Supplier.find({
      workspaceId: org._id,
      $or: [
        { siret: { $nin: [null, ""] } },
        { vatNumber: { $nin: [null, ""] } },
      ],
    })
      .select("name siret vatNumber")
      .lean();
    const taintedSupplierIds = [];
    for (const s of suppliers) {
      const kept = isOwn(s.siret || null, s.vatNumber || null);
      if (s.siret && !kept.siret)
        changes.push({
          collection: "suppliers",
          _id: s._id,
          field: "siret",
          value: s.siret,
          label: `${org.name} · fiche « ${s.name} »`,
        });
      if (s.vatNumber && !kept.vatNumber)
        changes.push({
          collection: "suppliers",
          _id: s._id,
          field: "vatNumber",
          value: s.vatNumber,
          label: `${org.name} · fiche « ${s.name} »`,
        });
      if ((s.siret && !kept.siret) || (s.vatNumber && !kept.vatNumber)) {
        taintedSupplierIds.push(s._id);
      }
    }

    // 2. Factures d'achat
    const invoices = await PurchaseInvoice.find({
      workspaceId: org._id,
      $or: [
        { "ocrMetadata.supplierSiret": { $nin: [null, ""] } },
        { "ocrMetadata.supplierVatNumber": { $nin: [null, ""] } },
      ],
    })
      .select(
        "supplierName ocrMetadata.supplierSiret ocrMetadata.supplierVatNumber",
      )
      .lean();
    for (const inv of invoices) {
      const meta = inv.ocrMetadata || {};
      const kept = isOwn(
        meta.supplierSiret || null,
        meta.supplierVatNumber || null,
      );
      const label = `${org.name} · facture ${inv._id} « ${inv.supplierName} »`;
      if (meta.supplierSiret && !kept.siret)
        changes.push({
          collection: "purchaseinvoices",
          _id: inv._id,
          field: "ocrMetadata.supplierSiret",
          value: meta.supplierSiret,
          label,
        });
      if (meta.supplierVatNumber && !kept.vatNumber)
        changes.push({
          collection: "purchaseinvoices",
          _id: inv._id,
          field: "ocrMetadata.supplierVatNumber",
          value: meta.supplierVatNumber,
          label,
        });
    }

    // 3. Rattachements suspects : fiche touchée, nom lu sans rapport
    if (taintedSupplierIds.length) {
      const linked = await PurchaseInvoice.find({
        workspaceId: org._id,
        supplierId: { $in: taintedSupplierIds },
      })
        .select("supplierName ocrMetadata.supplierName linkedTransactionIds")
        .lean();
      for (const inv of linked) {
        const read = inv.ocrMetadata?.supplierName;
        if (read && shareWord(read, inv.supplierName)) continue;
        const tx = inv.linkedTransactionIds?.length
          ? await Transaction.findOne({
              _id: { $in: inv.linkedTransactionIds },
            })
              .select("description")
              .lean()
          : null;
        suspects.push(
          `${org.name} · facture ${inv._id} enregistrée « ${inv.supplierName} », lu « ${read || "?"} », transaction « ${tx?.description || "?"} »`,
        );
      }
    }
  }

  return { changes, suspects };
}

async function main() {
  await mongoose.connect(MONGODB_URI);

  if (RESTORE_FILE) {
    await restore(RESTORE_FILE);
    return;
  }

  const { changes, suspects } = await collectChanges();

  console.log(
    `\n${changes.length} identifiant(s) de l'organisation à retirer :`,
  );
  for (const c of changes) console.log(`  - ${c.label} : ${c.field}`);
  console.log(
    `\n${suspects.length} facture(s) probablement rattachée(s) au mauvais fournisseur (à corriger depuis la facture) :`,
  );
  for (const s of suspects) console.log(`  - ${s}`);

  if (!APPLY) {
    console.log("\nAperçu seulement : relancer avec --apply pour écrire.");
    return;
  }
  if (changes.length === 0) return;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `own-identifiers-${stamp}.json`);
  fs.writeFileSync(file, EJSON.stringify({ createdAt: new Date(), changes }));
  console.log(`\n💾 Sauvegarde : ${file}`);

  for (const { collection, _id, field } of changes) {
    await MODELS[collection].collection.updateOne(
      { _id },
      { $unset: { [field]: "" } },
    );
  }
  console.log(`✅ ${changes.length} identifiant(s) retiré(s)`);
}

main()
  .catch((error) => {
    console.error("❌", error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
