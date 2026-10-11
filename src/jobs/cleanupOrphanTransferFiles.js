/**
 * Job de nettoyage des fichiers de transfert orphelins sur Cloudflare R2.
 *
 * Un fichier envoyé (multipart, ou chunks reconstruits) est finalisé sous
 * prod/AAAA/MM/JJ/t_<transferId>/f_<fileId>_<nom> AVANT la création du
 * transfert, qui n'a lieu qu'une fois tout le lot envoyé. Si le lot est
 * annulé ou abandonné (onglet fermé, appli tuée, réseau perdu), les fichiers
 * déjà finalisés ne sont rattachés à aucun transfert : ni l'expiration des
 * transferts ni le nettoyage des chunks (temp/) ne les supprime. Les envois
 * multipart jamais terminés laissent aussi leurs parts stockées.
 *
 * Toutes les 6 h, sur l'instance PM2 #0 (scheduler.js), ce job supprime :
 *   - les fichiers de prod/ finalisés depuis plus de 24 h, posés par un
 *     envoi (métadonnées R2 fileId/transferId écrites au démarrage de
 *     l'envoi) et rattachés à aucun transfert ;
 *   - les envois multipart démarrés depuis plus de 24 h et jamais terminés.
 *
 * Garde-fous (un fichier rattaché à un transfert n'est jamais touché) :
 *   - référence cherchée par clé R2 ET par fileId dans tous les transferts,
 *     quel que soit leur statut (l'expiration a son propre nettoyage) ;
 *   - fichier sans métadonnée fileId (origine inconnue) : conservé ;
 *   - métadonnées d'envoi encore en cache (filetransfer:meta:<fileId>,
 *     24 h) : transfert encore possible, fichier conservé ;
 *   - références revérifiées juste avant la suppression ;
 *   - Redis indisponible : rien n'est supprimé ;
 *   - seuls les préfixes datés prod/AAAA/MM/JJ/ des derniers jours sont
 *     parcourus (jamais _backoffice_trash/ ni temp/).
 */

import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
} from "@aws-sdk/client-s3";
import cloudflareTransferService from "../services/cloudflareTransferService.js";
import FileTransfer from "../models/FileTransfer.js";
import { cacheGet, getCacheClient } from "../config/redis.js";
import logger from "../utils/logger.js";

export const ORPHAN_MIN_AGE_HOURS = 24;
// Jours parcourus (préfixes datés) : le job tourne toutes les 6 h, chaque
// jour est donc examiné plusieurs fois après ses 24 h
export const ORPHAN_LOOKBACK_DAYS = 7;
const BATCH_SIZE = 500;

// Clés du cache des métadonnées d'envoi (resolvers/chunkUploadR2.js)
const fileMetaKey = (fileId) => `filetransfer:meta:${fileId}`;
const multipartMetaKey = (uploadId) =>
  `filetransfer:meta:multipart:${uploadId}`;

/**
 * Préfixes datés des fichiers finalisés, dans le même fuseau que
 * generateR2Path (heure locale du serveur).
 */
export function datedPrefixes(now, lookbackDays) {
  const prefixes = [];
  for (let d = 0; d <= lookbackDays; d += 1) {
    const day = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    const year = day.getFullYear();
    const month = String(day.getMonth() + 1).padStart(2, "0");
    const date = String(day.getDate()).padStart(2, "0");
    prefixes.push(`prod/${year}/${month}/${date}/`);
  }
  return [...new Set(prefixes)];
}

async function referencedKeys(keys) {
  if (keys.length === 0) return new Set();
  const found = await FileTransfer.distinct("files.r2Key", {
    "files.r2Key": { $in: keys },
  });
  return new Set(found);
}

async function headMetadata(service, key) {
  try {
    const head = await service.client.send(
      new HeadObjectCommand({ Bucket: service.bucketName, Key: key }),
    );
    return head.Metadata || {};
  } catch (error) {
    if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404)
      return null;
    throw error;
  }
}

// Envoi de fichier encore en attente de la création de son transfert
async function hasPendingUploadMeta(fileId, key) {
  const entry = await cacheGet(fileMetaKey(fileId));
  return Boolean(entry && (!entry.r2Key || entry.r2Key === key));
}

async function cleanupFinalizedOrphans(service, options, stats) {
  const { now, cutoff, lookbackDays, dryRun } = options;

  for (const prefix of datedPrefixes(now, lookbackDays)) {
    const objects = await service.listObjects(prefix);
    stats.scanned += objects.length;
    const old = objects.filter(
      (o) => o.lastModified && new Date(o.lastModified) < cutoff,
    );

    for (let i = 0; i < old.length; i += BATCH_SIZE) {
      const batch = old.slice(i, i + BATCH_SIZE);
      const referenced = await referencedKeys(batch.map((o) => o.key));
      const toDelete = [];

      for (const object of batch) {
        if (referenced.has(object.key)) {
          stats.referenced += 1;
          continue;
        }

        const metadata = await headMetadata(service, object.key);
        if (!metadata) continue; // déjà supprimé entre-temps
        const fileId = metadata.fileid || metadata.fileId;
        if (!fileId) {
          stats.unknownOrigin += 1;
          continue;
        }

        const uploadedAt = Date.parse(
          metadata.uploadedat || metadata.uploadedAt || "",
        );
        if (Number.isFinite(uploadedAt) && uploadedAt > cutoff.getTime()) {
          stats.pending += 1;
          continue;
        }

        if (
          await FileTransfer.exists({
            $or: [{ "files.r2Key": object.key }, { "files.fileId": fileId }],
          })
        ) {
          stats.referenced += 1;
          continue;
        }

        if (await hasPendingUploadMeta(fileId, object.key)) {
          stats.pending += 1;
          continue;
        }

        toDelete.push(object);
      }

      // Dernière vérification juste avant la suppression
      const lateReferences = await referencedKeys(toDelete.map((o) => o.key));
      const orphans = toDelete.filter((o) => !lateReferences.has(o.key));
      stats.referenced += toDelete.length - orphans.length;
      if (orphans.length === 0) continue;

      stats.orphans += orphans.length;
      stats.freedBytes += orphans.reduce((acc, o) => acc + (o.size || 0), 0);
      if (dryRun) {
        stats.keys.push(...orphans.map((o) => o.key));
        continue;
      }
      const result = await service.deleteFiles(orphans.map((o) => o.key));
      stats.deleted += result.deleted;
      stats.errors += result.errors;
    }
  }
}

async function abortStaleMultipartUploads(service, options, stats) {
  const { cutoff, dryRun } = options;
  let keyMarker;
  let uploadIdMarker;

  do {
    const response = await service.client.send(
      new ListMultipartUploadsCommand({
        Bucket: service.bucketName,
        Prefix: "prod/",
        KeyMarker: keyMarker,
        UploadIdMarker: uploadIdMarker,
      }),
    );

    for (const upload of response.Uploads || []) {
      if (!upload.Initiated || new Date(upload.Initiated) >= cutoff) continue;
      // Envoi encore connu (métadonnées de démarrage en cache) : conservé
      if (await cacheGet(multipartMetaKey(upload.UploadId))) {
        stats.pending += 1;
        continue;
      }
      stats.staleUploads += 1;
      if (dryRun) continue;
      try {
        await service.abortMultipartUpload(upload.UploadId, upload.Key);
        stats.abortedUploads += 1;
      } catch (error) {
        stats.errors += 1;
        logger.warn(
          `Annulation de l'envoi multipart ${upload.UploadId} impossible : ${error.message}`,
        );
      }
    }

    keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined;
    uploadIdMarker = response.IsTruncated
      ? response.NextUploadIdMarker
      : undefined;
  } while (keyMarker);
}

/**
 * @param {object} [options]
 * @param {number} [options.minAgeHours=24]
 * @param {number} [options.lookbackDays=7]
 * @param {boolean} [options.dryRun=false] - liste sans supprimer
 * @param {Date} [options.now]
 * @param {object} [options.service] - service R2 (tests)
 */
export async function cleanupOrphanTransferFiles({
  minAgeHours = ORPHAN_MIN_AGE_HOURS,
  lookbackDays = ORPHAN_LOOKBACK_DAYS,
  dryRun = false,
  now = new Date(),
  service = cloudflareTransferService,
} = {}) {
  const cutoff = new Date(now.getTime() - minAgeHours * 60 * 60 * 1000);
  const options = { now, cutoff, lookbackDays, dryRun };
  const stats = {
    scanned: 0,
    referenced: 0,
    pending: 0,
    unknownOrigin: 0,
    orphans: 0,
    deleted: 0,
    staleUploads: 0,
    abortedUploads: 0,
    errors: 0,
    freedBytes: 0,
    keys: [],
  };

  // Sans Redis, impossible de savoir si un envoi attend encore la création
  // de son transfert : rien n'est supprimé (prochain passage dans 6 h)
  if (!getCacheClient()) {
    logger.warn(
      "Nettoyage des fichiers de transfert orphelins reporté : Redis indisponible",
    );
    return { ...stats, skipped: true };
  }

  logger.info(
    `🧹 Nettoyage des fichiers de transfert orphelins (> ${minAgeHours} h${dryRun ? ", simulation" : ""})`,
  );
  await cleanupFinalizedOrphans(service, options, stats);
  await abortStaleMultipartUploads(service, options, stats);
  logger.info(
    `✅ Fichiers de transfert orphelins : ${stats.orphans} trouvé(s), ${stats.deleted} supprimé(s) ` +
      `(${(stats.freedBytes / 1024 / 1024).toFixed(2)} Mo), ${stats.abortedUploads} envoi(s) multipart annulé(s), ` +
      `${stats.referenced} rattaché(s), ${stats.pending} en cours, ${stats.unknownOrigin} d'origine inconnue, ${stats.errors} erreur(s)`,
  );
  return stats;
}
