#!/usr/bin/env node

/**
 * Doublons laissés dans Documents partagés par les automatisations (signalé
 * le 13/11/2026).
 *
 * Contexte : jusqu'au correctif, une automatisation ne retenait que ses
 * propres copies. Supprimée puis recréée, ou doublée d'une seconde
 * automatisation vers le même dossier, elle recopiait tous les documents
 * déjà classés : le même document Newbi se retrouve deux fois (ou plus) dans
 * le même dossier.
 *
 * Un doublon = plusieurs copies, hors corbeille, du MÊME document Newbi dans
 * le MÊME dossier. Le document d'origine d'une copie est lu sur la copie
 * (copies récentes) ou dans le journal des automatisations. Une copie sans
 * origine connue (automatisation supprimée avant le correctif) n'est rangée
 * avec un groupe que si elle porte exactement le même nom qu'une copie
 * d'origine connue dans ce dossier. Des copies sans origine connue qui
 * portent seulement le même nom sont listées « à vérifier », jamais touchées
 * (deux factures différentes peuvent s'appeler « facture.pdf »).
 *
 * Dans chaque groupe, la copie gardée est celle qui a le plus de
 * commentaires, puis la plus ancienne. Les autres partent dans la CORBEILLE
 * des documents partagés (rien n'est supprimé, l'utilisateur peut les
 * restaurer depuis l'appli) ; le journal des automatisations qui les
 * désignait est reporté sur la copie gardée (sinon le prochain lancement les
 * ressortirait de la corbeille).
 *
 * Aperçu par défaut. Avec --apply, les valeurs touchées sont sauvegardées
 * (backups/remise-en-etat/dedoublonner-copies-automatisations-<date>.json)
 * avant la première écriture ; --restore remet chaque document qui n'a pas
 * changé depuis.
 *
 * Usage (depuis la racine de l'API) :
 *   NODE_ENV=production node scripts/dedoublonner-copies-automatisations.js
 *   NODE_ENV=production node scripts/dedoublonner-copies-automatisations.js --apply
 *   NODE_ENV=production node scripts/dedoublonner-copies-automatisations.js --restore <sauvegarde.json> [--apply]
 *
 * Options :
 *   --apply              met les doublons à la corbeille (sans : aperçu)
 *   --workspace <id>     limite à une organisation
 *   --restore <fichier>  remet l'état d'avant (aperçu sans --apply)
 */

import mongoose from "mongoose";
import {
  applyEntry,
  connectFromEnv,
  createBackup,
  isCliEntry,
  parseArgs,
  restoreBackup,
  toObjectId,
} from "./lib/remise-en-etat.js";

const SCRIPT = "dedoublonner-copies-automatisations";
const CHUNK = 1000;

const key = (...parts) => parts.map((p) => (p ? String(p) : "null")).join("|");

function chunks(list, size = CHUNK) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Copie gardée : la plus commentée, puis la plus ancienne. */
function pickKept(copies) {
  return [...copies].sort(
    (a, b) =>
      (b.comments?.length || 0) - (a.comments?.length || 0) ||
      new Date(a.createdAt || 0) - new Date(b.createdAt || 0) ||
      String(a._id).localeCompare(String(b._id)),
  )[0];
}

/**
 * Groupes de doublons, sans rien écrire.
 * @returns {Promise<{groups: Array, toReview: Array, copies: number}>}
 *   groups : { workspaceId, folderId, sourceId, kept, duplicates[] }
 *   toReview : copies sans origine connue portant le même nom
 */
export async function findDuplicateCopies({
  db = mongoose.connection.db,
  workspaceId = null,
} = {}) {
  const filter = { uploadedByName: "Automatisation", trashedAt: null };
  if (workspaceId) filter.workspaceId = toObjectId(workspaceId);
  const copies = await db
    .collection("shareddocuments")
    .find(filter, {
      projection: {
        workspaceId: 1,
        folderId: 1,
        name: 1,
        createdAt: 1,
        comments: 1,
        sourceDocumentId: 1,
      },
    })
    .toArray();

  // Origine lue dans le journal pour les copies non marquées
  const sourceOf = new Map();
  for (const copy of copies) {
    if (copy.sourceDocumentId) {
      sourceOf.set(String(copy._id), String(copy.sourceDocumentId));
    }
  }
  const unmarked = copies.filter((c) => !c.sourceDocumentId).map((c) => c._id);
  for (const ids of chunks(unmarked)) {
    const logs = await db
      .collection("documentautomationlogs")
      .find(
        { sharedDocumentId: { $in: ids }, status: "SUCCESS" },
        { projection: { sharedDocumentId: 1, sourceDocumentId: 1 } },
      )
      .toArray();
    for (const log of logs) {
      sourceOf.set(String(log.sharedDocumentId), String(log.sourceDocumentId));
    }
  }

  // Copies d'origine connue, par dossier et document
  const bySource = new Map();
  // Nom → document d'origine, par dossier (pour rattacher les copies sans origine)
  const sourceByName = new Map();
  const unknown = [];
  for (const copy of copies) {
    const sourceId = sourceOf.get(String(copy._id));
    if (!sourceId) {
      unknown.push(copy);
      continue;
    }
    const groupKey = key(copy.workspaceId, copy.folderId, sourceId);
    if (!bySource.has(groupKey)) bySource.set(groupKey, []);
    bySource.get(groupKey).push(copy);
    const nameKey = key(copy.workspaceId, copy.folderId, copy.name);
    if (!sourceByName.has(nameKey)) sourceByName.set(nameKey, new Set());
    sourceByName.get(nameKey).add(sourceId);
  }

  const toReviewByName = new Map();
  for (const copy of unknown) {
    const nameKey = key(copy.workspaceId, copy.folderId, copy.name);
    const sources = sourceByName.get(nameKey);
    // Même nom qu'une seule copie d'origine connue : même document
    if (sources?.size === 1) {
      const [sourceId] = sources;
      bySource.get(key(copy.workspaceId, copy.folderId, sourceId)).push(copy);
    } else {
      if (!toReviewByName.has(nameKey)) toReviewByName.set(nameKey, []);
      toReviewByName.get(nameKey).push(copy);
    }
  }

  const groups = [];
  for (const [groupKey, list] of bySource) {
    if (list.length < 2) continue;
    const kept = pickKept(list);
    const [, , sourceId] = groupKey.split("|");
    groups.push({
      workspaceId: list[0].workspaceId,
      folderId: list[0].folderId || null,
      sourceId,
      kept,
      duplicates: list.filter((c) => String(c._id) !== String(kept._id)),
    });
  }
  const toReview = [...toReviewByName.values()].filter((l) => l.length > 1);

  return { groups, toReview, copies: copies.length };
}

/**
 * Met les doublons à la corbeille (avec --apply) et reporte le journal sur
 * la copie gardée.
 */
export async function dedupeCopies({
  apply = false,
  workspaceId = null,
  db = mongoose.connection.db,
  log = console.log,
  backupDir,
} = {}) {
  const { groups, toReview, copies } = await findDuplicateCopies({
    db,
    workspaceId,
  });
  const stats = {
    copies,
    groups: groups.length,
    duplicates: groups.reduce((n, g) => n + g.duplicates.length, 0),
    trashed: 0,
    logsMoved: 0,
    unchanged: 0,
    toReview: toReview.length,
    backupFile: null,
  };

  // Libellés lisibles : organisation et dossier
  const orgIds = [...new Set(groups.map((g) => String(g.workspaceId)))];
  const folderIds = [
    ...new Set(
      groups
        .map((g) => g.folderId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const orgs = await db
    .collection("organization")
    .find(
      { _id: { $in: orgIds.map((id) => toObjectId(id)) } },
      { projection: { name: 1 } },
    )
    .toArray();
  const folders = await db
    .collection("sharedfolders")
    .find(
      { _id: { $in: folderIds.map((id) => toObjectId(id)) } },
      { projection: { name: 1 } },
    )
    .toArray();
  const orgName = new Map(orgs.map((o) => [String(o._id), o.name]));
  const folderName = new Map(folders.map((f) => [String(f._id), f.name]));
  const where = (g) =>
    `${orgName.get(String(g.workspaceId)) || g.workspaceId} / ${
      g.folderId
        ? folderName.get(String(g.folderId)) || g.folderId
        : "Documents à classer"
    }`;

  for (const g of groups) {
    log(
      `· ${where(g)} : « ${g.kept.name} » ×${g.duplicates.length + 1}, ${g.duplicates.length} à mettre à la corbeille`,
    );
  }
  for (const list of toReview) {
    log(
      `? à vérifier (origine inconnue, même nom) : « ${list[0].name} » ×${list.length} dans ${list[0].workspaceId} / ${list[0].folderId || "Documents à classer"}`,
    );
  }
  if (!apply || groups.length === 0) return stats;

  const backup = createBackup({
    name: SCRIPT,
    ...(backupDir ? { dir: backupDir } : {}),
    meta: { workspaceId: workspaceId || null },
  });
  stats.backupFile = backup.file;
  const now = new Date();

  for (const g of groups) {
    for (const dup of g.duplicates) {
      const current = await db
        .collection("shareddocuments")
        .findOne(
          { _id: dup._id },
          { projection: { trashedAt: 1, originalFolderId: 1, folderId: 1 } },
        );
      const docEntry = {
        collection: "shareddocuments",
        _id: dup._id,
        label: `${where(g)} « ${dup.name} » (${dup._id})`,
        before: {
          trashedAt: current?.trashedAt || null,
          originalFolderId: current?.originalFolderId || null,
        },
        after: { trashedAt: now, originalFolderId: current?.folderId || null },
      };
      backup.entries.push({ ...docEntry, after: null });
      backup.save();
      if (await applyEntry(docEntry, db)) {
        backup.entries[backup.entries.length - 1].after = docEntry.after;
        stats.trashed += 1;
      } else {
        stats.unchanged += 1;
        continue;
      }
      backup.save();

      // Journal reporté sur la copie gardée
      const logs = await db
        .collection("documentautomationlogs")
        .find({ sharedDocumentId: dup._id }, { projection: { _id: 1 } })
        .toArray();
      for (const entryLog of logs) {
        const logEntry = {
          collection: "documentautomationlogs",
          _id: entryLog._id,
          label: `journal ${entryLog._id} → copie gardée ${g.kept._id}`,
          before: { sharedDocumentId: dup._id },
          after: { sharedDocumentId: g.kept._id },
        };
        backup.entries.push({ ...logEntry, after: null });
        backup.save();
        if (await applyEntry(logEntry, db)) {
          backup.entries[backup.entries.length - 1].after = logEntry.after;
          stats.logsMoved += 1;
          backup.save();
        }
      }
    }
  }
  return stats;
}

async function main() {
  const args = parseArgs();
  const database = await connectFromEnv();
  console.log(
    `Base : ${database}${args.apply ? " (ÉCRITURE)" : " (aperçu, aucune écriture)"}`,
  );

  try {
    if (args.restore) {
      const stats = await restoreBackup(args.restore, { apply: args.apply });
      console.log(
        `\n${stats.entries} entrée(s) : ${args.apply ? `${stats.restored} remise(s) en état` : `${stats.restorable} à remettre`}, ${stats.skipped} laissée(s) telle(s) quelle(s).`,
      );
      return;
    }

    const stats = await dedupeCopies({
      apply: args.apply,
      workspaceId: args.workspaceId,
    });
    console.log(
      `\n${stats.copies} copie(s) d'automatisation, ${stats.groups} document(s) en double, ` +
        `${stats.duplicates} copie(s) en trop, ${stats.toReview} nom(s) à vérifier à la main.`,
    );
    if (args.apply) {
      console.log(
        `${stats.trashed} copie(s) mise(s) à la corbeille, ${stats.logsMoved} ligne(s) de journal reportée(s), ` +
          `${stats.unchanged} modifiée(s) entre-temps et laissée(s).` +
          (stats.backupFile ? `\nSauvegarde : ${stats.backupFile}` : ""),
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
      console.error("Erreur :", error);
      process.exit(1);
    });
}
