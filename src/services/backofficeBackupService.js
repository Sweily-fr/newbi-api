import mongoose from "mongoose";
import zlib from "zlib";
import readline from "readline";
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { EJSON } from "bson";
import logger from "../utils/logger.js";
import cloudflareService from "./cloudflareService.js";

/**
 * ========================================
 * SERVICE BACK-OFFICE — Sauvegarde / restauration des purges
 * ========================================
 *
 * Chaque purge crée une sauvegarde AVANT toute suppression :
 * - Documents Mongo : archivés en NDJSON gzippé dans GridFS (bucket
 *   "backoffice_backups"), sérialisés en EJSON strict pour préserver les
 *   types (ObjectId, Date, ...). Une ligne par document :
 *     {"type":"doc","collection":"<nom>","doc":{...EJSON...}}
 * - Fichiers R2 : DÉPLACÉS dans une corbeille du même bucket
 *   (_backoffice_trash/<backupId>/<clé d'origine>) au lieu d'être supprimés.
 *   Une ligne de manifeste par fichier :
 *     {"type":"r2","bucket":"<bucket>","key":"<clé>","trashKey":"<corbeille>"}
 *
 * La restauration réinsère les documents (les doublons sont ignorés) et
 * recopie les fichiers R2 depuis la corbeille (qui est CONSERVÉE : une
 * sauvegarde reste restaurable plusieurs fois, jusqu'à sa suppression
 * définitive qui vide la corbeille).
 *
 * Non restaurable : Stripe (abonnements annulés, customers supprimés) et
 * Bridge (utilisateur distant supprimé).
 */

const GRIDFS_BUCKET = "backoffice_backups";
const META_COLLECTION = "backoffice_purge_backups";
export const TRASH_PREFIX = "_backoffice_trash";

function getGridBucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: GRIDFS_BUCKET,
  });
}

/** Encode une clé S3 pour CopySource (les / restent des séparateurs). */
function encodeCopySource(bucket, key) {
  return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

/**
 * Ouvre un writer de sauvegarde (flux NDJSON gzippé vers GridFS).
 */
export function openBackupWriter(backupId, meta) {
  const grid = getGridBucket();
  const uploadStream = grid.openUploadStream(`purge-${backupId}.ndjson.gz`, {
    metadata: meta,
  });
  const gzip = zlib.createGzip();
  gzip.pipe(uploadStream);

  let streamError = null;
  gzip.on("error", (err) => {
    streamError = err;
  });
  uploadStream.on("error", (err) => {
    streamError = err;
  });

  return {
    fileId: uploadStream.id,
    async writeLine(obj) {
      if (streamError) throw streamError;
      const line = JSON.stringify(obj) + "\n";
      if (!gzip.write(line)) {
        await new Promise((resolve, reject) => {
          gzip.once("drain", resolve);
          gzip.once("error", reject);
        });
      }
    },
    async close() {
      await new Promise((resolve, reject) => {
        uploadStream.on("finish", resolve);
        uploadStream.on("error", reject);
        gzip.end();
      });
      if (streamError) throw streamError;
    },
    async abort() {
      try {
        gzip.destroy();
        uploadStream.destroy();
        await grid.delete(uploadStream.id);
      } catch {
        // le fichier partiel peut ne pas exister, tant pis
      }
    },
  };
}

/**
 * Archive dans la sauvegarde tous les documents d'une collection matchant
 * le filtre (streaming, pas de chargement en mémoire).
 * @returns {Promise<number>} nombre de documents archivés
 */
export async function backupCollection(writer, collectionName, filter) {
  const db = mongoose.connection.db;
  const cursor = db.collection(collectionName).find(filter);
  let count = 0;
  for await (const doc of cursor) {
    await writer.writeLine({
      type: "doc",
      collection: collectionName,
      doc: EJSON.serialize(doc, { relaxed: false }),
    });
    count++;
  }
  return count;
}

/**
 * Déplace tous les objets R2 d'un préfixe vers la corbeille de sauvegarde
 * (copie + suppression), en enregistrant le manifeste dans le writer.
 * @returns {Promise<number>} nombre d'objets déplacés
 */
export async function moveR2PrefixToTrash(writer, backupId, bucket, prefix) {
  const client = cloudflareService.client;
  let moved = 0;
  let continuationToken;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (listed.Contents || []).map((o) => o.Key);
    for (const key of keys) {
      await moveR2KeyToTrash(writer, backupId, bucket, key);
      moved++;
    }
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return moved;
}

/**
 * Déplace un objet R2 vers la corbeille de sauvegarde (copie + suppression).
 */
export async function moveR2KeyToTrash(writer, backupId, bucket, key) {
  const client = cloudflareService.client;
  const trashKey = `${TRASH_PREFIX}/${backupId}/${key}`;
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      Key: trashKey,
      CopySource: encodeCopySource(bucket, key),
    }),
  );
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: [{ Key: key }], Quiet: true },
    }),
  );
  await writer.writeLine({ type: "r2", bucket, key, trashKey });
}

/** Insère les métadonnées de la sauvegarde une fois le fichier finalisé. */
export async function saveBackupMeta(backupId, meta) {
  const db = mongoose.connection.db;
  await db.collection(META_COLLECTION).insertOne({
    _id: backupId,
    status: "available",
    createdAt: new Date(),
    ...meta,
  });
}

/** Liste les sauvegardes (les plus récentes d'abord). */
export async function listBackups(limit = 50) {
  const db = mongoose.connection.db;
  const backups = await db
    .collection(META_COLLECTION)
    .find({ status: { $ne: "deleted" } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return backups.map((b) => ({
    id: String(b._id),
    targetEmail: b.targetEmail,
    targetUserId: b.targetUserId,
    adminEmail: b.adminEmail,
    createdAt: b.createdAt,
    mongoCount: b.mongoCount || 0,
    r2Count: b.r2Count || 0,
    status: b.status,
    restoredAt: b.restoredAt || null,
  }));
}

/** Itère les lignes NDJSON d'une sauvegarde GridFS. */
async function* readBackupLines(fileId) {
  const grid = getGridBucket();
  const stream = grid.openDownloadStream(fileId).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) yield JSON.parse(line);
  }
}

/**
 * Restaure une sauvegarde : réinsère les documents Mongo (doublons ignorés)
 * et recopie les fichiers R2 depuis la corbeille (conservée).
 * Ne restaure PAS : Stripe, Bridge.
 */
export async function restoreBackup(backupId, adminUser) {
  const db = mongoose.connection.db;
  const meta = await db
    .collection(META_COLLECTION)
    .findOne({ _id: backupId, status: { $ne: "deleted" } });
  if (!meta) return null;

  const summary = {
    mongoRestored: {},
    mongoSkipped: 0,
    r2Restored: 0,
    errors: [],
  };
  const client = cloudflareService.client;

  // Réinsertion par lots, groupée par collection
  const pending = new Map();
  const flush = async (collectionName) => {
    const docs = pending.get(collectionName);
    if (!docs?.length) return;
    pending.set(collectionName, []);
    try {
      const result = await db
        .collection(collectionName)
        .insertMany(docs, { ordered: false });
      summary.mongoRestored[collectionName] =
        (summary.mongoRestored[collectionName] || 0) + result.insertedCount;
    } catch (err) {
      // Doublons (déjà présents) : comptabiliser ce qui est passé
      const inserted = err.result?.insertedCount ?? err.insertedCount ?? 0;
      if (inserted > 0) {
        summary.mongoRestored[collectionName] =
          (summary.mongoRestored[collectionName] || 0) + inserted;
      }
      const writeErrors = err.writeErrors || [];
      const duplicates = writeErrors.filter((e) => e.code === 11000).length;
      summary.mongoSkipped += duplicates;
      const others = writeErrors.filter((e) => e.code !== 11000);
      if (others.length > 0 || (!writeErrors.length && err.code !== 11000)) {
        summary.errors.push(`Mongo ${collectionName}: ${err.message}`);
      }
    }
  };

  for await (const line of readBackupLines(meta.fileId)) {
    if (line.type === "doc") {
      const doc = EJSON.deserialize(line.doc, { relaxed: false });
      if (!pending.has(line.collection)) pending.set(line.collection, []);
      pending.get(line.collection).push(doc);
      if (pending.get(line.collection).length >= 500) {
        await flush(line.collection);
      }
    } else if (line.type === "r2") {
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: line.bucket,
            Key: line.key,
            CopySource: encodeCopySource(line.bucket, line.trashKey),
          }),
        );
        summary.r2Restored++;
      } catch (err) {
        summary.errors.push(`R2 ${line.bucket}/${line.key}: ${err.message}`);
      }
    }
  }
  for (const collectionName of pending.keys()) {
    await flush(collectionName);
  }

  await db.collection(META_COLLECTION).updateOne(
    { _id: backupId },
    {
      $set: {
        status: "restored",
        restoredAt: new Date(),
        restoredBy: adminUser?.email || null,
      },
    },
  );

  await db.collection("backoffice_audit_log").insertOne({
    action: "restore_backup",
    backupId: String(backupId),
    targetEmail: meta.targetEmail,
    adminUserId: adminUser?.id || null,
    adminEmail: adminUser?.email || null,
    summary,
    createdAt: new Date(),
  });

  logger.info(
    `[BACKOFFICE] Restauration ${backupId} (${meta.targetEmail}) terminée (${summary.errors.length} erreur(s))`,
  );
  return summary;
}

/**
 * Supprime définitivement une sauvegarde : vide sa corbeille R2 puis
 * supprime le fichier GridFS et marque les métadonnées.
 */
export async function deleteBackup(backupId, adminUser) {
  const db = mongoose.connection.db;
  const meta = await db
    .collection(META_COLLECTION)
    .findOne({ _id: backupId, status: { $ne: "deleted" } });
  if (!meta) return null;

  const summary = { r2TrashDeleted: 0, errors: [] };
  const client = cloudflareService.client;

  // Vider la corbeille R2 (groupé par bucket)
  const trashByBucket = new Map();
  try {
    for await (const line of readBackupLines(meta.fileId)) {
      if (line.type === "r2") {
        if (!trashByBucket.has(line.bucket)) trashByBucket.set(line.bucket, []);
        trashByBucket.get(line.bucket).push({ Key: line.trashKey });
      }
    }
  } catch (err) {
    summary.errors.push(`Lecture de la sauvegarde: ${err.message}`);
  }
  for (const [bucket, keys] of trashByBucket) {
    for (let i = 0; i < keys.length; i += 1000) {
      try {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.slice(i, i + 1000), Quiet: true },
          }),
        );
        summary.r2TrashDeleted += Math.min(1000, keys.length - i);
      } catch (err) {
        summary.errors.push(`R2 corbeille ${bucket}: ${err.message}`);
      }
    }
  }

  try {
    await getGridBucket().delete(meta.fileId);
  } catch (err) {
    summary.errors.push(`GridFS: ${err.message}`);
  }

  await db
    .collection(META_COLLECTION)
    .updateOne({ _id: backupId }, { $set: { status: "deleted" } });

  await db.collection("backoffice_audit_log").insertOne({
    action: "delete_backup",
    backupId: String(backupId),
    targetEmail: meta.targetEmail,
    adminUserId: adminUser?.id || null,
    adminEmail: adminUser?.email || null,
    summary,
    createdAt: new Date(),
  });

  return summary;
}
