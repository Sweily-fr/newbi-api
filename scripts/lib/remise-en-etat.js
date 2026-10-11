/**
 * Outils communs aux scripts de remise en état des données (octobre 2026) :
 * options de la ligne de commande, comparaison des montants au centime,
 * sauvegarde des valeurs avant modification et retour arrière.
 *
 * Sauvegarde : un fichier EJSON (dates et ObjectId conservés) écrit dans
 * backups/remise-en-etat/ AVANT la première écriture en base. Chaque entrée
 * décrit un document :
 *   { collection, _id, label, before, after, restoreMatch? }
 * `before` : valeurs enregistrées avant le script ; `after` : valeurs écrites
 * par le script (null tant que rien n'est écrit). Le retour arrière remet
 * `before` seulement si le document porte encore `after` (ou `restoreMatch`) :
 * une modification faite depuis dans l'appli n'est jamais écrasée.
 *
 * Les écritures passent directement par la collection MongoDB : ni hooks
 * Mongoose, ni `updatedAt` modifié (rattrapage technique).
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import mongoose from "mongoose";

const { EJSON } = mongoose.mongo.BSON;

/** Dossier des sauvegardes, relatif au dossier de lancement (racine de l'API). */
export const defaultBackupDir = () =>
  path.resolve(process.cwd(), "backups", "remise-en-etat");

/** Options communes : --apply, --workspace <id>, --limit <n>, --restore <fichier>. */
export function parseArgs(argv = process.argv.slice(2)) {
  const value = (name) => {
    const i = argv.indexOf(name);
    const next = i >= 0 ? argv[i + 1] : null;
    return next && !next.startsWith("--") ? next : null;
  };
  return {
    apply: argv.includes("--apply"),
    workspaceId: value("--workspace"),
    limit: Number(value("--limit")) || 0,
    restore: value("--restore"),
    flag: (name) => argv.includes(name),
    value,
  };
}

/** ObjectId d'une organisation passée en option, erreur lisible sinon. */
export function toObjectId(id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) {
    throw new Error(`Identifiant invalide : ${id}`);
  }
  return new mongoose.Types.ObjectId(String(id));
}

const isMissing = (value) =>
  value === undefined || value === null || Number.isNaN(Number(value));

export const toCents = (value) => Math.round((Number(value) || 0) * 100);

/** Vrai si le montant enregistré manque ou diffère du calcul au centime près. */
export const amountDiffers = (stored, computed) =>
  isMissing(stored) || toCents(stored) !== toCents(computed);

export const formatAmount = (value) =>
  isMissing(value) ? "absent" : Number(value).toFixed(2);

export const formatDate = (value) =>
  value ? new Date(value).toISOString().replace("T", " ").slice(0, 19) : "-";

/** « TTC -120.00 → -132.00, HT … » pour les champs qui changent. */
export function describeChanges(before, after, fields, labels = {}) {
  return fields
    .map(
      (field) =>
        `${labels[field] || field} ${formatAmount(before[field])} → ${formatAmount(after[field])}`,
    )
    .join(", ");
}

/** Numéro lisible d'un document (préfixe + numéro), sinon son identifiant. */
export const documentNumber = (doc) =>
  `${doc?.prefix || ""}${doc?.number || ""}` || `(sans numéro) ${doc?._id}`;

/** Valeurs de `fields` lues sur un document, null pour un champ absent. */
export const pickValues = (doc, fields) =>
  Object.fromEntries(fields.map((field) => [field, doc?.[field] ?? null]));

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof mongoose.Types.ObjectId);

/**
 * Filtre « le document porte encore ces valeurs ». null couvre aussi le champ
 * absent. Les sous-documents ne servent pas de filtre (l'égalité MongoDB d'un
 * objet dépend de l'ordre de ses clés) : passer un `restoreMatch` explicite.
 */
export function valuesFilter(values = {}) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => !isPlainObject(value)),
  );
}

/** $set des valeurs renseignées, $unset des valeurs nulles. */
export function setOrUnset(values = {}) {
  const $set = {};
  const $unset = {};
  for (const [field, value] of Object.entries(values)) {
    if (value === null || value === undefined) $unset[field] = "";
    else $set[field] = value;
  }
  return {
    ...(Object.keys($set).length ? { $set } : {}),
    ...(Object.keys($unset).length ? { $unset } : {}),
  };
}

/**
 * Sauvegarde d'une exécution. `save()` réécrit le fichier : un script long
 * l'appelle après chaque document pour que le fichier reste exact même s'il
 * est interrompu.
 */
export function createBackup({ name, dir = defaultBackupDir(), meta = {} }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${name}-${stamp}.json`);
  const content = { script: name, createdAt: new Date(), ...meta, entries: [] };
  return {
    file,
    entries: content.entries,
    save() {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, EJSON.stringify(content, null, 2));
      return file;
    },
  };
}

export function readBackup(file) {
  return EJSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Écrit `after` si le document porte encore `before` (il a pu être modifié
 * dans l'appli entre l'aperçu et l'écriture : il est alors laissé tel quel).
 * @returns {Promise<boolean>} vrai si le document a été mis à jour
 */
export async function applyEntry(entry, db = mongoose.connection.db) {
  const result = await db
    .collection(entry.collection)
    .updateOne(
      { _id: entry._id, ...(entry.applyMatch || valuesFilter(entry.before)) },
      setOrUnset(entry.after),
    );
  return result.modifiedCount === 1;
}

/**
 * Retour arrière depuis une sauvegarde : remet `before` sur chaque document
 * qui porte encore `after`. Aperçu sans `apply`.
 * @param {string} file - fichier de sauvegarde
 * @param {Object} [options]
 * @param {boolean} [options.apply=false]
 * @param {Function} [options.log]
 * @param {Function} [options.afterRestore] - appelé après chaque document
 *   remis en état (entry, file), par exemple pour remettre un fichier R2
 * @returns {Promise<{entries: number, restorable: number, restored: number, skipped: number}>}
 */
export async function restoreBackup(
  file,
  {
    apply = false,
    log = console.log,
    db = mongoose.connection.db,
    afterRestore,
  } = {},
) {
  const content = readBackup(file);
  const entries = content.entries || [];
  const stats = {
    entries: entries.length,
    restorable: 0,
    restored: 0,
    skipped: 0,
  };
  log(
    `Sauvegarde ${path.basename(file)} (${content.script}, ${formatDate(content.createdAt)}) : ${entries.length} document(s).`,
  );

  for (const entry of entries) {
    if (!entry.after) {
      stats.skipped += 1;
      log(`  - ${entry.label} : jamais modifié par le script, ignoré`);
      continue;
    }
    const filter = {
      _id: entry._id,
      ...(entry.restoreMatch || valuesFilter(entry.after)),
    };
    const collection = db.collection(entry.collection);

    if (!apply) {
      if (await collection.countDocuments(filter, { limit: 1 })) {
        stats.restorable += 1;
        log(`  · ${entry.label} : serait remis à l'état d'avant`);
      } else {
        stats.skipped += 1;
        log(`  - ${entry.label} : modifié depuis le script, laissé tel quel`);
      }
      continue;
    }

    const result = await collection.updateOne(filter, setOrUnset(entry.before));
    if (result.matchedCount === 1) {
      stats.restorable += 1;
      stats.restored += 1;
      if (afterRestore) await afterRestore(entry, file);
      log(`  ✓ ${entry.label} : remis à l'état d'avant`);
    } else {
      stats.skipped += 1;
      log(`  - ${entry.label} : modifié depuis le script, laissé tel quel`);
    }
  }

  return stats;
}

/**
 * Connexion à la base de l'environnement (NODE_ENV=production charge
 * .env.production). Le nom de la base est affiché pour vérification.
 */
export async function connectFromEnv() {
  await import("../../src/config/env.js");
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI manquant : lancer depuis la racine de l'API avec NODE_ENV=production",
    );
  }
  await mongoose.connect(uri);
  return mongoose.connection.db.databaseName;
}

/** Vrai quand le module est lancé en ligne de commande (pas importé). */
export function isCliEntry(moduleUrl) {
  if (!process.argv[1]) return false;
  return moduleUrl === pathToFileURL(path.resolve(process.argv[1])).href;
}
