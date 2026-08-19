import mongoose from "mongoose";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import logger from "../utils/logger.js";
import {
  openBackupWriter,
  backupCollection,
  moveR2PrefixToTrash,
  moveR2KeyToTrash,
  saveBackupMeta,
  TRASH_PREFIX,
} from "./backofficeBackupService.js";
import cloudflareService from "./cloudflareService.js";
import cloudflareTransferService from "./cloudflareTransferService.js";
import stripe from "../utils/stripe.js";
import { BridgeProvider } from "./banking/providers/BridgeProvider.js";
import {
  invalidateOrgCache,
  invalidateSubCache,
  invalidateTrialCache,
} from "../middlewares/rbac.js";

/**
 * ========================================
 * SERVICE BACK-OFFICE — Purge totale d'un utilisateur
 * ========================================
 *
 * Outil interne de nettoyage de comptes de test : contrairement au service
 * RGPD (rgpd.js) qui anonymise les pièces comptables, ce service supprime
 * TOUT : documents Mongo, fichiers R2, abonnement Stripe, utilisateur Bridge.
 * À réserver aux comptes de test, pas aux vrais clients (pas de rétention
 * comptable 10 ans ici).
 *
 * Stratégie de suppression Mongo : balayage GÉNÉRIQUE de toutes les
 * collections (db.listCollections) avec un filtre $or sur les champs de
 * liaison connus, en matchant chaque id sous ses deux formes (ObjectId et
 * String) car les modèles sont incohérents sur ce point (ex :
 * Transaction.workspaceId est String, Invoice.workspaceId est ObjectId).
 * Cela évite la liste de collections en dur du service RGPD, dont les noms
 * erronés no-opaient silencieusement.
 *
 * Garde-fou organisations partagées : si l'utilisateur appartient à une
 * organisation qui a d'autres membres, les données de cette organisation ne
 * sont PAS touchées (clause $nor) ; seuls son compte, ses sessions et son
 * adhésion sont supprimés.
 */

// Champs qui lient un document à un utilisateur.
// NE PAS ajouter "referredBy" : il pointe depuis le compte d'AUTRES
// utilisateurs vers celui-ci, les supprimer détruirait leurs comptes.
const USER_LINK_FIELDS = [
  "userId",
  "createdBy",
  "buyerId",
  "inviterId",
  "partnerId",
];

// Champs qui lient un document à une organisation/workspace.
// "referenceId" : utilisé par Better Auth pour subscription.referenceId (= org id).
const ORG_LINK_FIELDS = ["workspaceId", "organizationId", "referenceId"];

// Collections traitées explicitement, exclues du balayage générique.
const EXPLICIT_COLLECTIONS = new Set([
  "user",
  "organization",
  "member",
  "verification",
]);

/** Retourne les variantes ObjectId + String d'un id. */
function idVariants(id) {
  const str = String(id);
  const variants = [str];
  if (mongoose.Types.ObjectId.isValid(str)) {
    variants.push(new mongoose.Types.ObjectId(str));
  }
  return variants;
}

function flatVariants(ids) {
  return ids.flatMap(idVariants);
}

/**
 * Résout l'utilisateur cible et son contexte d'organisations.
 * @param {string} userIdOrEmail
 */
export async function resolveUserContext(userIdOrEmail) {
  const db = mongoose.connection.db;

  const query = mongoose.Types.ObjectId.isValid(userIdOrEmail)
    ? { _id: new mongoose.Types.ObjectId(userIdOrEmail) }
    : { email: String(userIdOrEmail).toLowerCase().trim() };

  const user = await db.collection("user").findOne(query);
  if (!user) return null;

  const userIdStr = String(user._id);

  const memberships = await db
    .collection("member")
    .find({ userId: { $in: idVariants(userIdStr) } })
    .toArray();

  const orgs = [];
  for (const membership of memberships) {
    const orgIdStr = String(membership.organizationId);
    const org = await db
      .collection("organization")
      .findOne({ _id: { $in: idVariants(orgIdStr) } });
    const otherMembers = await db.collection("member").countDocuments({
      organizationId: { $in: idVariants(orgIdStr) },
      userId: { $nin: idVariants(userIdStr) },
    });
    orgs.push({
      organizationId: orgIdStr,
      name: org?.name || "(organisation introuvable)",
      role: membership.role,
      otherMembers,
      // Purge complète seulement si l'utilisateur est le seul membre
      fullPurge: otherMembers === 0,
    });
  }

  return {
    user,
    userIdStr,
    orgs,
    purgeOrgIds: orgs.filter((o) => o.fullPurge).map((o) => o.organizationId),
    sharedOrgIds: orgs.filter((o) => !o.fullPurge).map((o) => o.organizationId),
  };
}

/**
 * Construit le filtre de balayage générique pour une purge.
 */
function buildSweepFilter({ userIdStr, purgeOrgIds, sharedOrgIds }) {
  const userVariants = idVariants(userIdStr);
  const orgVariants = flatVariants(purgeOrgIds);

  const or = USER_LINK_FIELDS.map((f) => ({ [f]: { $in: userVariants } }));
  if (orgVariants.length > 0) {
    or.push(...ORG_LINK_FIELDS.map((f) => ({ [f]: { $in: orgVariants } })));
  }

  const filter = { $or: or };

  // Ne jamais toucher aux documents des organisations partagées, même
  // créés par l'utilisateur purgé (ils appartiennent à l'organisation).
  if (sharedOrgIds.length > 0) {
    const sharedVariants = flatVariants(sharedOrgIds);
    filter.$nor = ["workspaceId", "organizationId"].map((f) => ({
      [f]: { $in: sharedVariants },
    }));
  }

  return filter;
}

/** Liste les collections réelles (hors vues et collections système). */
async function listDataCollections(db) {
  const collections = await db
    .listCollections({}, { nameOnly: false })
    .toArray();
  return collections
    .filter(
      (c) =>
        c.type !== "view" &&
        !c.name.startsWith("system.") &&
        // Collections internes du back-office (sauvegardes GridFS, audit) :
        // jamais balayées ni sauvegardées
        !c.name.startsWith("backoffice_"),
    )
    .map((c) => c.name);
}

/** Compte les objets R2 sous un préfixe (pour l'aperçu). */
async function countR2Prefix(client, bucket, prefix) {
  let count = 0;
  let continuationToken;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    count += (listed.Contents || []).length;
    continuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (continuationToken);
  return count;
}

/**
 * Construit la liste {bucket, prefix} de tous les emplacements R2 liés à
 * l'utilisateur et à ses organisations purgées.
 */
function buildR2Targets({ userIdStr, purgeOrgIds }) {
  const cf = cloudflareService;
  const targets = [];

  // Buckets préfixés par userId
  for (const prefix of [
    `${userIdStr}/`,
    `signatures/${userIdStr}/`,
    `temp/${userIdStr}/`,
    `documents/${userIdStr}/`,
  ]) {
    targets.push({ bucket: cf.bucketName, prefix });
  }
  targets.push({ bucket: cf.profileBucketName, prefix: `${userIdStr}/` });
  targets.push({ bucket: cf.signatureBucketName, prefix: `${userIdStr}/` });

  // Buckets préfixés par organizationId/workspaceId
  for (const orgId of purgeOrgIds) {
    targets.push({ bucket: cf.companyImagesBucketName, prefix: `${orgId}/` });
    targets.push({ bucket: cf.ocrBucketName, prefix: `${orgId}/` });
    targets.push({ bucket: cf.receiptsBucketName, prefix: `${orgId}/` });
    targets.push({
      bucket: cf.importedInvoicesBucketName,
      prefix: `${orgId}/`,
    });
    targets.push({
      bucket: cf.sharedDocumentsBucketName,
      prefix: `shared-documents/${orgId}/`,
    });
    targets.push({
      bucket: cf.invoicesBucketName,
      prefix: `invoices/${orgId}/`,
    });
    targets.push({
      bucket: cf.documentBuckets.quote,
      prefix: `quotes/${orgId}/`,
    });
    targets.push({
      bucket: cf.documentBuckets.creditNote,
      prefix: `creditNotes/${orgId}/`,
    });
    targets.push({
      bucket: cf.documentBuckets.purchaseOrder,
      prefix: `purchaseOrders/${orgId}/`,
    });
  }

  // Dédupliquer (certains buckets peuvent partager la même valeur d'env)
  const seen = new Set();
  return targets.filter(({ bucket, prefix }) => {
    if (!bucket) return false;
    const key = `${bucket}|${prefix}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Collecte les cibles R2 SANS préfixe user/org, à résoudre via les documents
 * Mongo avant leur suppression :
 * - transferts de fichiers (clés datées prod/yyyy/mm/dd/t_xxx/...)
 * - images kanban (préfixe = taskId)
 */
async function collectDocBasedR2Targets(context) {
  const db = mongoose.connection.db;
  const { userIdStr, purgeOrgIds, sharedOrgIds } = context;

  // Transferts appartenant à l'utilisateur, hors organisations partagées
  const transferFilter = {
    userId: { $in: idVariants(userIdStr) },
  };
  if (sharedOrgIds.length > 0) {
    transferFilter.workspaceId = { $nin: flatVariants(sharedOrgIds) };
  }
  const transfers = await db
    .collection("filetransfers")
    .find(transferFilter)
    .project({ _id: 1, files: 1 })
    .toArray();

  const transferKeys = [];
  const transferIds = [];
  for (const transfer of transfers) {
    transferIds.push(String(transfer._id));
    for (const file of transfer.files || []) {
      if (file.r2Key) transferKeys.push(file.r2Key);
    }
  }

  // Tâches kanban des organisations purgées (bucket kanban préfixé par taskId)
  const kanbanPrefixes = [];
  if (purgeOrgIds.length > 0) {
    const tasks = await db
      .collection("tasks")
      .find({ workspaceId: { $in: flatVariants(purgeOrgIds) } })
      .project({ _id: 1 })
      .toArray();
    for (const task of tasks) {
      kanbanPrefixes.push(`${String(task._id)}/`);
    }
  }

  return { transferKeys, transferIds, kanbanPrefixes };
}

/**
 * Aperçu (dry-run) : ce qui serait supprimé, sans rien toucher.
 * @param {string} userIdOrEmail
 */
export async function previewUserPurge(userIdOrEmail) {
  const context = await resolveUserContext(userIdOrEmail);
  if (!context) return null;

  const db = mongoose.connection.db;
  const { user, userIdStr, orgs, purgeOrgIds } = context;

  const sweepFilter = buildSweepFilter(context);

  let docTargets = { transferKeys: [], transferIds: [], kanbanPrefixes: [] };
  let docTargetsError = null;
  try {
    docTargets = await collectDocBasedR2Targets(context);
    if (docTargets.transferIds.length > 0) {
      sweepFilter.$or.push({
        transferId: { $in: flatVariants(docTargets.transferIds) },
      });
    }
  } catch (err) {
    docTargetsError = err.message;
  }

  const collections = await listDataCollections(db);

  const mongoCounts = {};
  for (const name of collections) {
    if (EXPLICIT_COLLECTIONS.has(name)) continue;
    try {
      const count = await db.collection(name).countDocuments(sweepFilter);
      if (count > 0) mongoCounts[name] = count;
    } catch (err) {
      logger.warn(
        `[BACKOFFICE] Aperçu: comptage ${name} impossible: ${err.message}`,
      );
    }
  }
  mongoCounts.user = 1;
  mongoCounts.member = orgs.length;
  if (purgeOrgIds.length > 0) mongoCounts.organization = purgeOrgIds.length;

  // Fichiers R2 (comptage best-effort)
  const r2Counts = {};
  let r2Error = docTargetsError;
  try {
    const targets = buildR2Targets(context);
    for (const { bucket, prefix } of targets) {
      const count = await countR2Prefix(
        cloudflareService.client,
        bucket,
        prefix,
      );
      if (count > 0) r2Counts[bucket] = (r2Counts[bucket] || 0) + count;
    }
    if (docTargets.transferKeys.length > 0) {
      r2Counts[cloudflareTransferService.bucketName] =
        (r2Counts[cloudflareTransferService.bucketName] || 0) +
        docTargets.transferKeys.length;
    }
    for (const prefix of docTargets.kanbanPrefixes) {
      const count = await countR2Prefix(
        cloudflareService.client,
        cloudflareService.kanbanBucketName,
        prefix,
      );
      if (count > 0) {
        r2Counts[cloudflareService.kanbanBucketName] =
          (r2Counts[cloudflareService.kanbanBucketName] || 0) + count;
      }
    }
  } catch (err) {
    r2Error = err.message;
    logger.warn(`[BACKOFFICE] Aperçu R2 impossible: ${err.message}`);
  }

  // Ressources externes
  const subscriptions = await db
    .collection("subscription")
    .find({ referenceId: { $in: flatVariants(purgeOrgIds) } })
    .toArray();

  const warnings = [];
  for (const org of orgs.filter((o) => !o.fullPurge)) {
    warnings.push(
      `L'organisation "${org.name}" a ${org.otherMembers} autre(s) membre(s) : ses données ne seront pas supprimées, seulement l'adhésion de l'utilisateur.`,
    );
  }
  if (r2Error) {
    warnings.push(`Comptage R2 indisponible: ${r2Error}`);
  }

  return {
    user: {
      id: userIdStr,
      email: user.email,
      name: user.name || null,
      createdAt: user.createdAt || null,
      stripeCustomerId:
        user.stripeCustomerId || user.subscription?.stripeCustomerId || null,
      bridgeWorkspaceId: user.bridgeWorkspaceId || null,
    },
    organizations: orgs,
    mongo: mongoCounts,
    r2: r2Counts,
    external: {
      stripeSubscriptions: subscriptions.map((s) => ({
        plan: s.plan,
        status: s.status,
        stripeSubscriptionId: s.stripeSubscriptionId || null,
        stripeCustomerId: s.stripeCustomerId || null,
      })),
      bridge: purgeOrgIds.length > 0 || Boolean(user.bridgeWorkspaceId),
    },
    warnings,
  };
}

/** Annule/supprime les ressources Stripe liées (best-effort). */
async function purgeStripe(context, summary) {
  const db = mongoose.connection.db;
  const { user, purgeOrgIds } = context;

  const subscriptions = await db
    .collection("subscription")
    .find({ referenceId: { $in: flatVariants(purgeOrgIds) } })
    .toArray();

  const customerIds = new Set();
  if (user.stripeCustomerId) customerIds.add(user.stripeCustomerId);
  if (user.subscription?.stripeCustomerId) {
    customerIds.add(user.subscription.stripeCustomerId);
  }

  for (const sub of subscriptions) {
    if (sub.stripeCustomerId) customerIds.add(sub.stripeCustomerId);
    if (sub.stripeSubscriptionId) {
      try {
        await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
        summary.stripe.subscriptionsCancelled++;
      } catch (err) {
        if (err.code !== "resource_missing") {
          summary.errors.push(
            `Stripe: annulation abonnement ${sub.stripeSubscriptionId}: ${err.message}`,
          );
        }
      }
    }
  }

  // Supprimer les customers (annule aussi tout abonnement restant)
  for (const customerId of customerIds) {
    try {
      await stripe.customers.del(customerId);
      summary.stripe.customersDeleted++;
    } catch (err) {
      if (err.code !== "resource_missing") {
        summary.errors.push(
          `Stripe: suppression customer ${customerId}: ${err.message}`,
        );
      }
    }
  }

  // Comptes Stripe Connect (peut échouer si solde non nul : best-effort)
  const connectAccounts = await db
    .collection("stripeconnectaccounts")
    .find({
      $or: [
        { organizationId: { $in: flatVariants(purgeOrgIds) } },
        { userId: { $in: idVariants(context.userIdStr) } },
      ],
    })
    .toArray();
  for (const account of connectAccounts) {
    if (!account.accountId) continue;
    try {
      await stripe.accounts.del(account.accountId);
      summary.stripe.connectAccountsDeleted++;
    } catch (err) {
      summary.errors.push(
        `Stripe Connect: suppression ${account.accountId}: ${err.message}`,
      );
    }
  }
}

/** Supprime les utilisateurs Bridge des organisations purgées (best-effort). */
async function purgeBridge(context, summary) {
  const { user, purgeOrgIds } = context;

  const bridgeWorkspaceIds = new Set(purgeOrgIds.map(String));
  if (user.bridgeWorkspaceId)
    bridgeWorkspaceIds.add(String(user.bridgeWorkspaceId));
  if (bridgeWorkspaceIds.size === 0) return;

  const provider = new BridgeProvider();
  if (!provider.validateConfig()) {
    summary.errors.push("Bridge: configuration absente, suppression ignorée");
    return;
  }

  for (const workspaceId of bridgeWorkspaceIds) {
    try {
      await provider.deleteBridgeUser(workspaceId);
      summary.bridge.usersDeleted++;
    } catch (err) {
      // "non trouvé" = rien à supprimer, ce n'est pas une erreur
      if (!/non trouvé|not found/i.test(err.message || "")) {
        summary.errors.push(`Bridge: workspace ${workspaceId}: ${err.message}`);
      }
    }
  }
}

/**
 * Purge TOTALE d'un utilisateur : Mongo + R2 + Stripe + Bridge.
 *
 * @param {string} userIdOrEmail - id ou email de l'utilisateur cible
 * @param {Object} adminUser - utilisateur admin qui déclenche la purge (audit)
 * @returns {Object} résumé détaillé de la purge
 */
export async function purgeUser(userIdOrEmail, adminUser) {
  const context = await resolveUserContext(userIdOrEmail);
  if (!context) {
    throw new Error("Utilisateur introuvable");
  }

  const db = mongoose.connection.db;
  const { user, userIdStr, orgs, purgeOrgIds } = context;

  logger.info(
    `[BACKOFFICE] Purge de ${user.email} (${userIdStr}) par ${adminUser?.email || "?"} - orgs purgées: [${purgeOrgIds.join(", ")}]`,
  );

  const summary = {
    user: { id: userIdStr, email: user.email },
    organizations: orgs,
    backupId: null,
    backup: { mongoCount: 0, r2Count: 0 },
    mongo: {},
    r2: {},
    stripe: {
      subscriptionsCancelled: 0,
      customersDeleted: 0,
      connectAccountsDeleted: 0,
    },
    bridge: { usersDeleted: 0 },
    errors: [],
  };

  // 1. Collecter les cibles R2 dépendantes des documents AVANT toute
  //    suppression (clés de transferts, taskIds kanban). Fatal si échec :
  //    sans elles la sauvegarde serait incomplète.
  const docTargets = await collectDocBasedR2Targets(context);

  // 2. Filtre de balayage générique (avec les liens par transfert :
  //    AccessGrant, DownloadEvent)
  const sweepFilter = buildSweepFilter(context);
  if (docTargets.transferIds.length > 0) {
    sweepFilter.$or.push({
      transferId: { $in: flatVariants(docTargets.transferIds) },
    });
  }

  const collections = await listDataCollections(db);

  // 3. SAUVEGARDE Mongo avant toute suppression. Fatal si échec :
  //    pas de sauvegarde, pas de purge.
  const backupId = new mongoose.Types.ObjectId();
  const writer = openBackupWriter(backupId, {
    targetEmail: user.email,
    targetUserId: userIdStr,
  });
  let backupMongoCount = 0;
  try {
    for (const name of collections) {
      if (EXPLICIT_COLLECTIONS.has(name)) continue;
      backupMongoCount += await backupCollection(writer, name, sweepFilter);
    }
    backupMongoCount += await backupCollection(writer, "member", {
      userId: { $in: idVariants(userIdStr) },
    });
    if (purgeOrgIds.length > 0) {
      backupMongoCount += await backupCollection(writer, "organization", {
        _id: { $in: flatVariants(purgeOrgIds) },
      });
    }
    if (user.email) {
      const escaped = user.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      backupMongoCount += await backupCollection(writer, "verification", {
        identifier: { $regex: escaped, $options: "i" },
      });
    }
    backupMongoCount += await backupCollection(writer, "user", {
      _id: user._id,
    });
  } catch (err) {
    await writer.abort();
    throw new Error(`Sauvegarde impossible, purge annulée : ${err.message}`);
  }

  // 4. Fichiers R2 : déplacement vers la corbeille de sauvegarde
  //    (_backoffice_trash/<backupId>/...). Le déplacement vaut suppression ;
  //    une erreur sur un fichier le laisse en place (direction sûre).
  let backupR2Count = 0;
  try {
    const targets = buildR2Targets(context);
    for (const { bucket, prefix } of targets) {
      try {
        const moved = await moveR2PrefixToTrash(
          writer,
          backupId,
          bucket,
          prefix,
        );
        if (moved > 0) {
          summary.r2[bucket] = (summary.r2[bucket] || 0) + moved;
          backupR2Count += moved;
        }
      } catch (err) {
        summary.errors.push(`R2 ${bucket}/${prefix}: ${err.message}`);
      }
    }

    // Transferts (clés explicites, bucket daté sans préfixe user)
    const transferBucket = cloudflareTransferService.bucketName;
    for (const key of docTargets.transferKeys) {
      try {
        await moveR2KeyToTrash(writer, backupId, transferBucket, key);
        summary.r2[transferBucket] = (summary.r2[transferBucket] || 0) + 1;
        backupR2Count++;
      } catch (err) {
        summary.errors.push(`R2 transfert ${key}: ${err.message}`);
      }
    }

    // Images kanban (préfixe = taskId)
    for (const prefix of docTargets.kanbanPrefixes) {
      try {
        const moved = await moveR2PrefixToTrash(
          writer,
          backupId,
          cloudflareService.kanbanBucketName,
          prefix,
        );
        if (moved > 0) {
          summary.r2[cloudflareService.kanbanBucketName] =
            (summary.r2[cloudflareService.kanbanBucketName] || 0) + moved;
          backupR2Count += moved;
        }
      } catch (err) {
        summary.errors.push(`R2 kanban ${prefix}: ${err.message}`);
      }
    }
  } catch (err) {
    summary.errors.push(`R2: ${err.message}`);
  }

  // 5. Finaliser la sauvegarde AVANT les suppressions Mongo. Fatal si échec.
  try {
    await writer.close();
    await saveBackupMeta(backupId, {
      fileId: writer.fileId,
      targetEmail: user.email,
      targetUserId: userIdStr,
      adminEmail: adminUser?.email || null,
      mongoCount: backupMongoCount,
      r2Count: backupR2Count,
    });
    summary.backupId = String(backupId);
    summary.backup = { mongoCount: backupMongoCount, r2Count: backupR2Count };
  } catch (err) {
    throw new Error(
      `Finalisation de la sauvegarde impossible, purge Mongo annulée. ` +
        `Les fichiers R2 déjà déplacés sont récupérables sous ` +
        `${TRASH_PREFIX}/${backupId}/ dans leurs buckets. Détail : ${err.message}`,
    );
  }

  // 6. Ressources externes (Stripe, Bridge) tant que les documents existent.
  //    NON RESTAURABLES : un abonnement annulé ne se réactive pas.
  try {
    await purgeStripe(context, summary);
  } catch (err) {
    summary.errors.push(`Stripe: ${err.message}`);
  }
  try {
    await purgeBridge(context, summary);
  } catch (err) {
    summary.errors.push(`Bridge: ${err.message}`);
  }

  // 7. Suppression Mongo : balayage générique puis collections explicites
  for (const name of collections) {
    if (EXPLICIT_COLLECTIONS.has(name)) continue;
    try {
      const result = await db.collection(name).deleteMany(sweepFilter);
      if (result.deletedCount > 0) {
        summary.mongo[name] = result.deletedCount;
      }
    } catch (err) {
      summary.errors.push(`Mongo ${name}: ${err.message}`);
    }
  }

  try {
    // Adhésions (y compris dans les organisations partagées)
    const memberResult = await db
      .collection("member")
      .deleteMany({ userId: { $in: idVariants(userIdStr) } });
    if (memberResult.deletedCount > 0) {
      summary.mongo.member = memberResult.deletedCount;
    }

    // Organisations dont l'utilisateur était le seul membre
    if (purgeOrgIds.length > 0) {
      const orgResult = await db
        .collection("organization")
        .deleteMany({ _id: { $in: flatVariants(purgeOrgIds) } });
      summary.mongo.organization = orgResult.deletedCount;
    }

    // Jetons de vérification (identifiés par email)
    if (user.email) {
      const escaped = user.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const verifResult = await db
        .collection("verification")
        .deleteMany({ identifier: { $regex: escaped, $options: "i" } });
      if (verifResult.deletedCount > 0) {
        summary.mongo.verification = verifResult.deletedCount;
      }
    }

    // Le compte utilisateur lui-même, en dernier
    const userResult = await db.collection("user").deleteOne({ _id: user._id });
    summary.mongo.user = userResult.deletedCount;
  } catch (err) {
    summary.errors.push(`Mongo (collections explicites): ${err.message}`);
  }

  // 8. Invalidation des caches Redis (best-effort)
  try {
    invalidateOrgCache(userIdStr);
    for (const orgId of purgeOrgIds) {
      invalidateSubCache(orgId);
      invalidateTrialCache(orgId);
    }
  } catch (err) {
    summary.errors.push(`Redis: ${err.message}`);
  }

  // 9. Journal d'audit
  try {
    await db.collection("backoffice_audit_log").insertOne({
      action: "purge_user",
      targetUserId: userIdStr,
      targetEmail: user.email,
      backupId: String(backupId),
      adminUserId: adminUser?.id ? String(adminUser.id) : null,
      adminEmail: adminUser?.email || null,
      summary,
      createdAt: new Date(),
    });
  } catch (err) {
    logger.error(
      `[BACKOFFICE] Écriture du journal d'audit impossible: ${err.message}`,
    );
  }

  logger.info(
    `[BACKOFFICE] Purge de ${user.email} terminée (${summary.errors.length} erreur(s))`,
    summary,
  );

  return summary;
}
