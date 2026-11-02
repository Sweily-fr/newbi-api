/**
 * Recalcul complet de l'espace de stockage utilisé par un espace, à partir
 * des métadonnées en base. Lecture seule sur les collections existantes :
 * les tailles manquantes sont lues sur R2 (liste par préfixe ou HEAD) puis
 * mémorisées dans la collection workspace_storage_objects.
 *
 * Chaque fichier est compté une fois (clé R2 unique), même s'il est
 * référencé par plusieurs documents (justificatif repris par une facture
 * d'achat, annexe partagée entre plusieurs devis).
 */
import mongoose from "mongoose";
import { HeadObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import logger from "../../utils/logger.js";
import cloudflareService from "../cloudflareService.js";
import WorkspaceStorageObject from "../../models/WorkspaceStorageObject.js";
// Modèles lus par le recalcul : importés pour que Mongoose fournisse le nom
// exact de leur collection
import "../../models/Invoice.js";
import "../../models/Quote.js";
import "../../models/CreditNote.js";
import "../../models/PurchaseOrder.js";
import "../../models/DeliveryNote.js";
import "../../models/DocumentEmailLog.js";
import "../../models/SignatureRequest.js";
import "../../models/SharedDocument.js";
import "../../models/kanban.js";
import "../../models/Transaction.js";
import "../../models/PurchaseInvoice.js";
import "../../models/OcrDocument.js";
import "../../models/Expense.js";
import "../../models/ImportedInvoice.js";
import "../../models/ImportedQuote.js";
import "../../models/ImportedPurchaseOrder.js";
import "../../models/Product.js";
import "../../models/EmailSignature.js";
import "../../models/EmailSignatureV2.js";
import "../../models/FileTransfer.js";

import {
  STORAGE_CATEGORIES,
  STORAGE_COMPUTE_VERSION,
  UNATTRIBUTED,
} from "./storageCategories.js";

export { STORAGE_CATEGORIES, STORAGE_COMPUTE_VERSION, UNATTRIBUTED };

const HEAD_CONCURRENCY = 8;
// Au-delà, on liste le préfixe de l'espace plutôt que de lire chaque objet
const LIST_THRESHOLD = 10;

// Collecteurs ajoutés par d'autres modules, pour
// compter leurs fichiers sans que le stockage dépende de leur code
const extraCollectors = new Map();

/**
 * Ajoute un collecteur de fichiers. `collect({ workspaceId, match })` renvoie
 * une liste d'entrées { key, bucket?, url?, size?, category, userId?,
 * listPrefix? }.
 */
export function registerStorageCollector(name, collect) {
  extraCollectors.set(name, collect);
}

export function unregisterStorageCollector(name) {
  extraCollectors.delete(name);
}

function workspaceValues(workspaceId) {
  const id = String(workspaceId);
  const values = [id];
  if (mongoose.Types.ObjectId.isValid(id)) {
    values.push(new mongoose.Types.ObjectId(id));
  }
  return values;
}

function idString(value) {
  if (!value) return null;
  const str = String(value);
  return str && str !== "system" ? str : null;
}

function collection(name) {
  return mongoose.connection.db.collection(name);
}

function modelCollection(modelName, fallbackName) {
  const model = mongoose.models[modelName];
  return model ? model.collection : collection(fallbackName);
}

/** Clé R2 à partir d'une clé ou d'une URL publique. */
export function toStorageRef(value) {
  if (!value || typeof value !== "string") return null;
  if (/^https?:\/\//i.test(value)) {
    const resolved = cloudflareService.resolveBucketAndKeyFromUrl(value);
    return resolved?.key ? resolved : null;
  }
  return { key: value.replace(/^\/+/, ""), bucket: null };
}

async function findAll(coll, filter, projection) {
  return coll.find(filter, { projection }).toArray();
}

// ---------------------------------------------------------------------------
// Collecteurs par type de fichier
// ---------------------------------------------------------------------------

const ARCHIVE_SOURCES = [
  ["Invoice", "invoices", "invoices", () => cloudflareService.invoicesBucketName],
  ["Quote", "quotes", "quotes", () => cloudflareService.documentBuckets.quote],
  [
    "CreditNote",
    "creditnotes",
    "creditNotes",
    () => cloudflareService.documentBuckets.creditNote,
  ],
  [
    "PurchaseOrder",
    "purchaseorders",
    "purchaseOrders",
    () => cloudflareService.documentBuckets.purchaseOrder,
  ],
  [
    "DeliveryNote",
    "deliverynotes",
    "deliveryNotes",
    () => cloudflareService.documentBuckets.deliveryNote,
  ],
];

async function collectBillingDocuments({ workspaceId, match }) {
  const entries = [];
  const annexBucket = cloudflareService.documentAnnexesBucketName;
  for (const [modelName, collName, prefix, bucketOf] of ARCHIVE_SOURCES) {
    const docs = await findAll(
      modelCollection(modelName, collName),
      {
        workspaceId: match,
        $or: [
          { archivedPdfKey: { $nin: [null, ""] } },
          { "annex.key": { $nin: [null, ""] } },
        ],
      },
      { archivedPdfKey: 1, annex: 1, createdBy: 1 },
    );
    for (const doc of docs) {
      const userId = idString(doc.createdBy);
      if (doc.archivedPdfKey) {
        entries.push({
          key: doc.archivedPdfKey,
          bucket: bucketOf(),
          category: "billingDocuments",
          userId,
          listPrefix: `${prefix}/${workspaceId}/`,
        });
      }
      if (doc.annex?.key) {
        entries.push({
          key: doc.annex.key,
          bucket: annexBucket,
          size: doc.annex.size,
          category: "billingDocuments",
          userId,
          listPrefix: `annexes/${workspaceId}/`,
        });
      }
    }
  }

  // Annexes par défaut de l'espace (organisation Better Auth)
  if (mongoose.Types.ObjectId.isValid(String(workspaceId))) {
    const org = await collection("organization").findOne(
      { _id: new mongoose.Types.ObjectId(String(workspaceId)) },
      { projection: { invoiceAnnex: 1, quoteAnnex: 1, purchaseOrderAnnex: 1 } },
    );
    for (const field of ["invoiceAnnex", "quoteAnnex", "purchaseOrderAnnex"]) {
      let annex = org?.[field];
      if (typeof annex === "string") {
        try {
          annex = JSON.parse(annex);
        } catch {
          annex = null;
        }
      }
      if (annex?.key) {
        entries.push({
          key: annex.key,
          bucket: annexBucket,
          size: annex.size,
          category: "billingDocuments",
          listPrefix: `annexes/${workspaceId}/`,
        });
      }
    }
  }

  // Pièces jointes conservées des e-mails de documents
  const logs = await findAll(
    modelCollection("DocumentEmailLog", "document_email_logs"),
    { workspaceId: match, "attachments.storageKey": { $nin: [null, ""] } },
    { attachments: 1 },
  );
  for (const log of logs) {
    for (const attachment of log.attachments || []) {
      if (!attachment?.storageKey || attachment.isDocument) continue;
      entries.push({
        key: attachment.storageKey,
        bucket: cloudflareService.emailAttachmentsBucketName,
        size: attachment.size,
        category: "billingDocuments",
      });
    }
  }

  // Documents signés et preuves de signature électronique
  const signatures = await findAll(
    modelCollection("SignatureRequest", "signaturerequests"),
    {
      $or: [{ workspaceId: match }, { organizationId: String(workspaceId) }],
      $and: [
        {
          $or: [
            { signedDocumentUrl: { $nin: [null, ""] } },
            { auditTrailUrl: { $nin: [null, ""] } },
          ],
        },
      ],
    },
    { signedDocumentUrl: 1, auditTrailUrl: 1, createdBy: 1 },
  );
  for (const request of signatures) {
    for (const url of [request.signedDocumentUrl, request.auditTrailUrl]) {
      const ref = toStorageRef(url);
      if (!ref) continue;
      entries.push({
        ...ref,
        category: "billingDocuments",
        userId: idString(request.createdBy),
        listPrefix: `esignature/${workspaceId}/`,
      });
    }
  }
  return entries;
}

async function collectSharedDocuments({ match }) {
  // Corbeille comprise : seuls les fichiers supprimés définitivement sortent
  const docs = await findAll(
    modelCollection("SharedDocument", "shareddocuments"),
    { workspaceId: match },
    { fileKey: 1, fileUrl: 1, fileSize: 1, uploadedBy: 1 },
  );
  return docs
    .map((doc) => {
      const ref = doc.fileKey
        ? { key: doc.fileKey, bucket: cloudflareService.sharedDocumentsBucketName }
        : toStorageRef(doc.fileUrl);
      if (!ref) return null;
      return {
        ...ref,
        size: doc.fileSize,
        category: "sharedDocuments",
        userId: idString(doc.uploadedBy),
      };
    })
    .filter(Boolean);
}

function kanbanUser(uploadedBy) {
  const value = idString(uploadedBy);
  return value && mongoose.Types.ObjectId.isValid(value) ? value : null;
}

async function collectKanban({ match }) {
  const tasks = await findAll(
    modelCollection("Task", "tasks"),
    {
      workspaceId: match,
      $or: [
        { "images.0": { $exists: true } },
        { "comments.images.0": { $exists: true } },
      ],
    },
    { "images.key": 1, "images.fileSize": 1, "images.uploadedBy": 1, "comments.images": 1 },
  );
  const entries = [];
  const bucket = cloudflareService.kanbanBucketName;
  for (const task of tasks) {
    const images = [
      ...(task.images || []),
      ...(task.comments || []).flatMap((c) => c?.images || []),
    ];
    for (const image of images) {
      if (!image?.key) continue;
      entries.push({
        key: image.key,
        bucket,
        size: image.fileSize,
        category: "kanban",
        userId: kanbanUser(image.uploadedBy),
      });
    }
  }
  return entries;
}

async function collectReceipts({ workspaceId, match }) {
  const transactions = await findAll(
    modelCollection("Transaction", "transactions"),
    { workspaceId: match, "receiptFiles.0": { $exists: true } },
    { receiptFiles: 1, userId: 1 },
  );
  const entries = [];
  for (const transaction of transactions) {
    for (const file of transaction.receiptFiles || []) {
      const ref = file?.key
        ? { key: file.key, bucket: cloudflareService.receiptsBucketName }
        : toStorageRef(file?.url);
      if (!ref) continue;
      entries.push({
        ...ref,
        size: file.size,
        category: "receipts",
        userId: idString(file.uploadedBy) || idString(transaction.userId),
        listPrefix: `${workspaceId}/`,
      });
    }
  }
  return entries;
}

async function collectPurchaseInvoices({ match }) {
  const entries = [];
  const invoices = await findAll(
    modelCollection("PurchaseInvoice", "purchaseinvoices"),
    { workspaceId: match, "files.0": { $exists: true } },
    { files: 1, createdBy: 1 },
  );
  for (const invoice of invoices) {
    for (const file of invoice.files || []) {
      const ref = toStorageRef(file?.url) || toStorageRef(file?.path);
      if (!ref) continue;
      entries.push({
        ...ref,
        size: file.size,
        category: "purchaseInvoices",
        userId: idString(invoice.createdBy),
      });
    }
  }

  const ocrDocs = await findAll(
    modelCollection("OcrDocument", "ocr_documents"),
    { workspaceId: match, cloudflareKey: { $nin: [null, ""] } },
    { cloudflareKey: 1, documentUrl: 1, fileSize: 1, userId: 1 },
  );
  for (const doc of ocrDocs) {
    const ref = toStorageRef(doc.documentUrl) || {
      key: doc.cloudflareKey,
      bucket: cloudflareService.ocrBucketName,
    };
    entries.push({
      ...ref,
      key: doc.cloudflareKey || ref.key,
      size: doc.fileSize,
      category: "purchaseInvoices",
      userId: idString(doc.userId),
    });
  }

  const expenses = await findAll(
    modelCollection("Expense", "expenses"),
    { workspaceId: match, "files.0": { $exists: true } },
    { files: 1, createdBy: 1 },
  );
  for (const expense of expenses) {
    for (const file of expense.files || []) {
      // Fichiers enregistrés sur le disque du serveur : hors R2
      if (!/^https?:\/\//i.test(file?.url || "")) continue;
      const ref = toStorageRef(file.url);
      if (!ref) continue;
      entries.push({
        ...ref,
        size: file.size > 1 ? file.size : undefined,
        category: "purchaseInvoices",
        userId: idString(expense.createdBy),
      });
    }
  }
  return entries;
}

async function collectImportedDocuments({ match }) {
  const entries = [];
  for (const [modelName, collName] of [
    ["ImportedInvoice", "imported_invoices"],
    ["ImportedQuote", "imported_quotes"],
    ["ImportedPurchaseOrder", "imported_purchase_orders"],
  ]) {
    const docs = await findAll(
      modelCollection(modelName, collName),
      { workspaceId: match, "file.cloudflareKey": { $nin: [null, ""] } },
      { file: 1, importedBy: 1 },
    );
    for (const doc of docs) {
      const fromUrl = toStorageRef(doc.file?.url);
      entries.push({
        key: doc.file.cloudflareKey,
        bucket: fromUrl?.bucket || cloudflareService.importedInvoicesBucketName,
        size: doc.file.fileSize,
        category: "importedDocuments",
        userId: idString(doc.importedBy),
      });
    }
  }
  return entries;
}

async function collectBranding({ workspaceId, match }) {
  const entries = [];
  const companyBucket = cloudflareService.companyImagesBucketName;
  if (mongoose.Types.ObjectId.isValid(String(workspaceId))) {
    const org = await collection("organization").findOne(
      { _id: new mongoose.Types.ObjectId(String(workspaceId)) },
      { projection: { logo: 1 } },
    );
    const ref = toStorageRef(org?.logo);
    if (ref && /^https?:\/\//i.test(org.logo)) {
      entries.push({ ...ref, category: "branding", listPrefix: `${workspaceId}/` });
    }
  }

  const products = await findAll(
    modelCollection("Product", "products"),
    { workspaceId: match, imageUrl: { $nin: [null, ""] } },
    { imageUrl: 1, createdBy: 1 },
  );
  for (const product of products) {
    const ref = toStorageRef(product.imageUrl);
    if (!ref || !/^https?:\/\//i.test(product.imageUrl)) continue;
    entries.push({
      ...ref,
      bucket: ref.bucket || companyBucket,
      category: "branding",
      userId: idString(product.createdBy),
      listPrefix: `${workspaceId}/`,
    });
  }

  const signatureBucket = cloudflareService.signatureBucketName;
  const signaturesV1 = await findAll(
    modelCollection("EmailSignature", "emailsignatures"),
    { workspaceId: match },
    { photoKey: 1, logoKey: 1, bannerKey: 1, createdBy: 1 },
  );
  for (const signature of signaturesV1) {
    for (const key of [signature.photoKey, signature.logoKey, signature.bannerKey]) {
      if (!key) continue;
      entries.push({
        key,
        bucket: signatureBucket,
        category: "branding",
        userId: idString(signature.createdBy),
      });
    }
  }

  const signaturesV2 = await findAll(
    modelCollection("EmailSignatureV2", "emailsignaturev2"),
    { workspaceId: match },
    { images: 1, createdBy: 1 },
  );
  for (const signature of signaturesV2) {
    for (const image of Object.values(signature.images || {})) {
      const ref = image?.key
        ? { key: image.key, bucket: signatureBucket }
        : toStorageRef(image?.url);
      if (!ref) continue;
      entries.push({
        ...ref,
        bucket: ref.bucket || signatureBucket,
        category: "branding",
        userId: idString(signature.createdBy),
      });
    }
  }
  return entries;
}

async function collectTransfers({ workspaceId }) {
  const now = new Date();
  const transfers = await findAll(
    modelCollection("FileTransfer", "filetransfers"),
    {
      workspaceId: String(workspaceId),
      status: "active",
      $or: [{ expiryDate: { $gt: now } }, { expiryDate: null }],
    },
    { files: 1, userId: 1 },
  );
  const entries = [];
  for (const transfer of transfers) {
    for (const file of transfer.files || []) {
      if (!file?.r2Key) continue;
      entries.push({
        key: file.r2Key,
        bucket: process.env.TRANSFER_BUCKET || "app-transfers-prod",
        size: file.size,
        category: "transfers",
        userId: idString(transfer.userId),
      });
    }
  }
  return entries;
}

const BUILTIN_COLLECTORS = [
  ["billingDocuments", collectBillingDocuments],
  ["sharedDocuments", collectSharedDocuments],
  ["kanban", collectKanban],
  // Justificatifs avant les factures d'achat : un justificatif repris par une
  // facture d'achat reste compté comme justificatif
  ["receipts", collectReceipts],
  ["purchaseInvoices", collectPurchaseInvoices],
  ["importedDocuments", collectImportedDocuments],
  ["branding", collectBranding],
  ["transfers", collectTransfers],
];

// ---------------------------------------------------------------------------
// Tailles manquantes : registre, puis R2
// ---------------------------------------------------------------------------

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Taille d'un objet R2 (HEAD), null si introuvable ou R2 injoignable. */
export async function headObjectSize(bucket, key) {
  if (!bucket || !key) return null;
  try {
    const result = await cloudflareService.client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return Number(result.ContentLength) || 0;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") {
      return 0;
    }
    return null;
  }
}

/** Tailles de tous les objets d'un préfixe, null si R2 injoignable. */
export async function listPrefixSizes(bucket, prefix) {
  const sizes = new Map();
  let continuationToken;
  try {
    do {
      const listed = await cloudflareService.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of listed.Contents || []) {
        sizes.set(object.Key, Number(object.Size) || 0);
      }
      continuationToken = listed.IsTruncated
        ? listed.NextContinuationToken
        : undefined;
    } while (continuationToken);
  } catch (error) {
    logger.warn(
      `[storage] Liste R2 impossible (${bucket}/${prefix}) : ${error.message}`,
    );
    return null;
  }
  return sizes;
}

async function resolveMissingSizes(entries, workspaceId, { deadline }) {
  const missing = entries.filter((e) => !(Number(e.size) > 0));
  if (missing.length === 0) return { unknown: 0 };

  // 1. Registre des tailles déjà connues
  const known = await WorkspaceStorageObject.find(
    {
      key: { $in: missing.map((e) => e.key) },
      // Un objet absent de R2 lu par HEAD garde 0 octet ; un envoi à 0 octet
      // n'apprend rien
      $or: [{ size: { $gt: 0 } }, { source: "head" }],
    },
    { key: 1, size: 1 },
  ).lean();
  const knownSizes = new Map(known.map((o) => [o.key, o.size]));
  const toRead = [];
  for (const entry of missing) {
    if (knownSizes.has(entry.key)) entry.size = knownSizes.get(entry.key);
    else toRead.push(entry);
  }

  // 2. R2 : liste du préfixe de l'espace quand il y a beaucoup d'objets,
  //    HEAD objet par objet sinon
  const learned = [];
  const groups = new Map();
  for (const entry of toRead) {
    if (!entry.bucket) continue;
    const groupKey = entry.listPrefix ? `${entry.bucket}|${entry.listPrefix}` : null;
    if (!groupKey) continue;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entry);
  }
  const listed = new Set();
  for (const [groupKey, group] of groups) {
    if (group.length < LIST_THRESHOLD || Date.now() > deadline) continue;
    const [bucket, prefix] = groupKey.split("|");
    const sizes = await listPrefixSizes(bucket, prefix);
    if (!sizes) continue;
    for (const entry of group) {
      entry.size = sizes.get(entry.key) ?? 0;
      listed.add(entry);
      learned.push(entry);
    }
  }

  let unknown = 0;
  const heads = toRead.filter((e) => !listed.has(e));
  await runWithConcurrency(heads, HEAD_CONCURRENCY, async (entry) => {
    if (Date.now() > deadline) {
      unknown += 1;
      return;
    }
    const size = await headObjectSize(entry.bucket, entry.key);
    if (size === null) {
      unknown += 1;
      return;
    }
    entry.size = size;
    learned.push(entry);
  });

  if (learned.length > 0) {
    await WorkspaceStorageObject.bulkWrite(
      learned.map((entry) => ({
        updateOne: {
          filter: { key: entry.key },
          update: {
            $setOnInsert: {
              key: entry.key,
              workspaceId: String(workspaceId),
              bucket: entry.bucket || null,
              size: Number(entry.size) || 0,
              category: entry.category,
              uploadedBy: entry.userId || null,
              source: "head",
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    ).catch((error) =>
      logger.warn(`[storage] Registre des tailles non mis à jour : ${error.message}`),
    );
  }
  return { unknown };
}

/**
 * Recalcule l'espace utilisé par un espace.
 * @param {string} workspaceId
 * @param {{ timeoutMs?: number }} [options] au-delà, les tailles encore
 *   inconnues comptent pour 0 (résultat marqué `unknownSizeCount`)
 */
export async function computeWorkspaceStorage(workspaceId, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  const match = { $in: workspaceValues(workspaceId) };
  const collectors = [
    ...BUILTIN_COLLECTORS,
    ...Array.from(extraCollectors.entries()),
  ];

  const seen = new Set();
  const entries = [];
  for (const [name, collect] of collectors) {
    let found = [];
    try {
      found = await collect({ workspaceId: String(workspaceId), match });
    } catch (error) {
      logger.warn(`[storage] Collecteur ${name} en échec : ${error.message}`);
      continue;
    }
    for (const entry of found || []) {
      if (!entry?.key || seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
    }
  }

  const { unknown } = await resolveMissingSizes(entries, workspaceId, {
    deadline,
  });

  // Auteur du dépôt : registre des envois, quand le document ne le dit pas
  const withoutUser = entries.filter((e) => !e.userId);
  if (withoutUser.length > 0) {
    const owners = await WorkspaceStorageObject.find(
      { key: { $in: withoutUser.map((e) => e.key) }, uploadedBy: { $ne: null } },
      { key: 1, uploadedBy: 1 },
    ).lean();
    const ownerByKey = new Map(owners.map((o) => [o.key, o.uploadedBy]));
    for (const entry of withoutUser) {
      entry.userId = ownerByKey.get(entry.key) || null;
    }
  }

  const byCategory = {};
  const byUser = {};
  let totalBytes = 0;
  for (const entry of entries) {
    const size = Math.max(0, Number(entry.size) || 0);
    totalBytes += size;
    const category = STORAGE_CATEGORIES[entry.category] ? entry.category : "other";
    byCategory[category] = (byCategory[category] || 0) + size;
    const user = entry.userId || UNATTRIBUTED;
    byUser[user] = (byUser[user] || 0) + size;
  }

  return {
    totalBytes,
    byCategory,
    byUser,
    fileCount: entries.length,
    unknownSizeCount: unknown,
  };
}
