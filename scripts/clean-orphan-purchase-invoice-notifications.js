#!/usr/bin/env node

/**
 * Suppression des notifications « Nouvelle facture reçue » orphelines
 * (incident SuperPDP du 01/09/2026).
 *
 * Contexte : le compte SuperPDP de Sweily est mandataire pour tous les
 * clients. Avant les correctifs #464/#466, chaque workspace importait toutes
 * les factures reçues sur ce compte, y compris celles adressées à un autre
 * client, et créait une notification PURCHASE_INVOICE_RECEIVED pour chacune.
 * Les factures en trop ont été supprimées ensuite (cleanup-*-superpdp.cjs sur
 * le VPS), pas leurs notifications : elles restent visibles dans l'onglet
 * Activité de l'autre organisation et pointent vers une facture disparue.
 *
 * Une notification est supprimée quand sa facture d'achat n'existe plus, ou
 * appartient à un autre workspace que la notification. Les notifications
 * sans purchaseInvoiceId sont listées, jamais supprimées.
 *
 * En lecture seule, le script liste aussi les factures SuperPDP rangées dans
 * un workspace sans SIREN : avant le correctif « destinataire strict », la
 * comparaison était impossible et la facture était importée quand même. Le
 * SIREN de l'acheteur n'étant pas enregistré sur la facture, le tri se fait à
 * la main (rien n'est modifié).
 *
 * Aperçu par défaut. Avec --apply, les notifications complètes sont
 * sauvegardées (backups/remise-en-etat/notifications-factures-orphelines-<date>.json)
 * avant toute suppression ; --restore les réinsère (celles qui n'existent pas
 * déjà).
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/clean-orphan-purchase-invoice-notifications.js
 *   NODE_ENV=production node scripts/clean-orphan-purchase-invoice-notifications.js --apply
 *   NODE_ENV=production node scripts/clean-orphan-purchase-invoice-notifications.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              supprime (sans cette option : aperçu, aucune écriture)
 *   --workspace <id>     limite à une organisation
 *   --restore <fichier>  réinsère les notifications d'une sauvegarde (aperçu sans --apply)
 */

import mongoose from "mongoose";
import {
  connectFromEnv,
  createBackup,
  formatDate,
  isCliEntry,
  parseArgs,
  readBackup,
  toObjectId,
} from "./lib/remise-en-etat.js";

const NOTIFICATION_TYPE = "PURCHASE_INVOICE_RECEIVED";

const digits = (v) => String(v || "").replace(/\D/g, "");

/** SIREN de l'organisation, mêmes champs que invoiceIsAddressedToOrganization. */
export const organizationSiren = (organization) => {
  const siren = digits(
    organization?.siret ||
      organization?.siren ||
      organization?.companyInfo?.siret,
  ).substring(0, 9);
  return siren.length === 9 ? siren : null;
};

const toObjectIdOrNull = (id) =>
  id && mongoose.Types.ObjectId.isValid(String(id))
    ? new mongoose.Types.ObjectId(String(id))
    : null;

/**
 * Classe chaque notification : "missing" (facture supprimée), "otherWorkspace"
 * (facture d'un autre workspace), "noInvoiceId" (rien à vérifier) ou "ok".
 */
export async function findOrphanNotifications({
  workspaceId,
  db = mongoose.connection.db,
} = {}) {
  const filter = { type: NOTIFICATION_TYPE };
  if (workspaceId) filter.workspaceId = toObjectId(workspaceId);

  const notifications = await db
    .collection("notifications")
    .find(filter)
    .sort({ createdAt: 1 })
    .toArray();

  const invoiceIds = notifications
    .map((n) => toObjectIdOrNull(n.data?.purchaseInvoiceId))
    .filter(Boolean);
  const invoices = await db
    .collection("purchaseinvoices")
    .find({ _id: { $in: invoiceIds } }, { projection: { workspaceId: 1 } })
    .toArray();
  const invoiceWorkspace = new Map(
    invoices.map((i) => [String(i._id), String(i.workspaceId)]),
  );

  const result = {
    scanned: notifications.length,
    orphans: [],
    noInvoiceId: [],
  };
  for (const notification of notifications) {
    const invoiceId = toObjectIdOrNull(notification.data?.purchaseInvoiceId);
    if (!invoiceId) {
      result.noInvoiceId.push(notification);
      continue;
    }
    const owner = invoiceWorkspace.get(String(invoiceId));
    if (!owner) {
      result.orphans.push({ notification, reason: "facture supprimée" });
    } else if (owner !== String(notification.workspaceId)) {
      result.orphans.push({
        notification,
        reason: `facture d'un autre espace (${owner})`,
      });
    }
  }
  return result;
}

/** Factures SuperPDP rangées dans un workspace sans SIREN (lecture seule). */
export async function findSuperPdpInvoicesWithoutSiren({
  workspaceId,
  db = mongoose.connection.db,
} = {}) {
  const filter = { superPdpInvoiceId: { $exists: true, $nin: [null, ""] } };
  if (workspaceId) filter.workspaceId = toObjectId(workspaceId);

  const byWorkspace = await db
    .collection("purchaseinvoices")
    .aggregate([
      { $match: filter },
      { $group: { _id: "$workspaceId", count: { $sum: 1 } } },
    ])
    .toArray();
  if (byWorkspace.length === 0) return [];

  const organizations = await db
    .collection("organization")
    .find(
      { _id: { $in: byWorkspace.map((w) => w._id) } },
      { projection: { name: 1, siret: 1, siren: 1, companyInfo: 1 } },
    )
    .toArray();
  const orgById = new Map(organizations.map((o) => [String(o._id), o]));

  return byWorkspace
    .map((w) => ({ ...w, organization: orgById.get(String(w._id)) || null }))
    .filter((w) => !organizationSiren(w.organization));
}

const label = (n) =>
  `${formatDate(n.createdAt)} espace ${n.workspaceId} : « ${n.message} »`;

export async function cleanOrphanNotifications({
  apply = false,
  workspaceId,
  log = console.log,
  db = mongoose.connection.db,
  backupDir,
} = {}) {
  const { scanned, orphans, noInvoiceId } = await findOrphanNotifications({
    workspaceId,
    db,
  });

  log(`\n${scanned} notification(s) « Nouvelle facture reçue » examinée(s).`);
  for (const { notification, reason } of orphans) {
    log(`  × ${label(notification)} : ${reason}`);
  }
  for (const notification of noInvoiceId) {
    log(`  ? ${label(notification)} : sans facture liée, laissée telle quelle`);
  }

  const suspects = await findSuperPdpInvoicesWithoutSiren({ workspaceId, db });
  if (suspects.length) {
    log(
      `\nFactures SuperPDP dans un espace sans SIREN (à vérifier à la main, rien n'est modifié) :`,
    );
    for (const s of suspects) {
      log(
        `  ! espace ${s._id} (${s.organization?.name || "organisation introuvable"}) : ${s.count} facture(s)`,
      );
    }
  }

  const stats = {
    scanned,
    orphans: orphans.length,
    noInvoiceId: noInvoiceId.length,
    suspectWorkspaces: suspects.length,
    deleted: 0,
    backupFile: null,
  };
  if (!apply || orphans.length === 0) return stats;

  // Sauvegarde complète AVANT la première suppression
  const backup = createBackup({
    name: "notifications-factures-orphelines",
    ...(backupDir ? { dir: backupDir } : {}),
    meta: { workspaceId: workspaceId || null },
  });
  for (const { notification, reason } of orphans) {
    backup.entries.push({
      collection: "notifications",
      _id: notification._id,
      label: label(notification),
      reason,
      document: notification,
    });
  }
  stats.backupFile = backup.save();

  const result = await db
    .collection("notifications")
    .deleteMany({ _id: { $in: orphans.map((o) => o.notification._id) } });
  stats.deleted = result.deletedCount;
  return stats;
}

/** Réinsère les notifications d'une sauvegarde (celles qui manquent encore). */
export async function restoreNotifications(
  file,
  { apply = false, log = console.log, db = mongoose.connection.db } = {},
) {
  const entries = readBackup(file).entries || [];
  const collection = db.collection("notifications");
  const stats = { entries: entries.length, restored: 0, present: 0 };
  for (const entry of entries) {
    if (await collection.countDocuments({ _id: entry._id }, { limit: 1 })) {
      stats.present += 1;
      log(`  - ${entry.label} : déjà présente`);
      continue;
    }
    if (apply) await collection.insertOne(entry.document);
    stats.restored += 1;
    log(
      `  ${apply ? "✓" : "·"} ${entry.label} : ${apply ? "réinsérée" : "serait réinsérée"}`,
    );
  }
  return stats;
}

async function main() {
  const args = parseArgs();
  const database = await connectFromEnv();
  console.log(
    `✅ Connecté à la base ${database} (${args.apply ? "écriture" : "aperçu, aucune écriture : --apply pour écrire"})`,
  );

  try {
    if (args.restore) {
      const stats = await restoreNotifications(args.restore, {
        apply: args.apply,
      });
      console.log(
        `\n${stats.entries} notification(s) dans la sauvegarde : ${args.apply ? `${stats.restored} réinsérée(s)` : `${stats.restored} à réinsérer`}, ${stats.present} déjà présente(s).`,
      );
      return;
    }

    const stats = await cleanOrphanNotifications({
      apply: args.apply,
      workspaceId: args.workspaceId,
    });
    console.log(
      `\n${stats.orphans} notification(s) orpheline(s), ${stats.noInvoiceId} sans facture liée, ` +
        `${stats.suspectWorkspaces} espace(s) sans SIREN avec des factures SuperPDP.`,
    );
    if (args.apply) {
      console.log(
        `${stats.deleted} notification(s) supprimée(s).` +
          (stats.backupFile ? `\n💾 Sauvegarde : ${stats.backupFile}` : ""),
      );
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (isCliEntry(import.meta.url)) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Erreur:", error);
      process.exit(1);
    });
}
