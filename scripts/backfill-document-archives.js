import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";

/**
 * Rattrapage des archives PDF manquantes sur Cloudflare R2.
 *
 * Contexte : l'env PM2 de prod contenait des noms de buckets corrompus
 * (guillemets + virgule collés depuis du JS) → 100 % des archivages
 * échouaient en InvalidBucketName depuis la mise en place de la
 * fonctionnalité. Ce script régénère le PDF de chaque document finalisé
 * sans archivedPdfKey (via les endpoints NewbiV2 serveur-à-serveur) et
 * l'uploade sur le bucket R2 dédié, comme le feraient les services
 * invoiceFacturXArchiveService / creditNoteFacturXArchiveService.
 *
 * Usage (depuis la racine de l'API, avec .env.production à côté) :
 *   node scripts/backfill-document-archives.js --dry-run
 *   node scripts/backfill-document-archives.js --type invoice --limit 2
 *   node scripts/backfill-document-archives.js            # tout rattraper
 *
 * Options :
 *   --dry-run       liste ce qui serait archivé, sans rien générer/uploader
 *   --type <t>      invoice | quote | creditNote | purchaseOrder (défaut : tous)
 *   --limit <n>     limite le nombre de documents traités par type
 *   --delay <ms>    pause entre deux documents (défaut 1000 ms)
 *   --env <fichier> fichier d'env à charger (défaut .env.production)
 */

const args = process.argv.slice(2);
const getOpt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
};
const DRY_RUN = args.includes("--dry-run");
const ONLY_TYPE = getOpt("type");
const LIMIT = Number(getOpt("limit")) || 0;
const DELAY_MS = Number(getOpt("delay")) || 1000;
const ENV_FILE = getOpt("env") || ".env.production";

dotenv.config({ path: ENV_FILE });

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error(`MONGODB_URI manquant (fichier d'env chargé : ${ENV_FILE})`);
  process.exit(1);
}
if (!process.env.INTERNAL_API_SECRET) {
  console.error("INTERNAL_API_SECRET manquant : génération PDF impossible.");
  process.exit(1);
}

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";
const PDF_TIMEOUT = Number(process.env.PDF_GENERATION_TIMEOUT_MS) || 120000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(
    `✅ Connecté à MongoDB (${DRY_RUN ? "DRY-RUN" : "exécution réelle"})`,
  );

  // Import APRÈS dotenv : cloudflareService lit l'env à la construction.
  const { default: cloudflareService } =
    await import("../src/services/cloudflareService.js");
  const { archiveInvoiceFacturX } =
    await import("../src/services/invoiceFacturXArchiveService.js");
  const { archiveCreditNoteFacturX } =
    await import("../src/services/creditNoteFacturXArchiveService.js");

  const db = mongoose.connection.db;

  // Génère le PDF d'un devis/BC via NewbiV2 puis l'archive sur R2
  // (équivalent serveur de la mutation archiveDocumentPdf du client desktop).
  async function archiveGenericDocument(docType, endpoint, idField, doc) {
    const docId = doc._id.toString();
    const response = await axios.post(
      `${FRONTEND_URL}${endpoint}`,
      { [idField]: docId },
      {
        timeout: PDF_TIMEOUT,
        responseType: "arraybuffer",
        headers: { "x-internal-secret": process.env.INTERNAL_API_SECRET },
      },
    );
    const pdfBuffer = Buffer.from(response.data);
    if (!pdfBuffer?.length) {
      throw new Error("réponse PDF vide");
    }

    const fileName = `${docType}_${doc.prefix || ""}${doc.number || docId}.pdf`;
    const { key } = await cloudflareService.uploadDocumentPdf(
      docType,
      pdfBuffer,
      String(doc.workspaceId),
      docId,
      { fileName },
    );

    await db
      .collection(docType === "quote" ? "quotes" : "purchaseorders")
      .updateOne(
        { _id: doc._id },
        {
          $set: {
            archivedPdfKey: key,
            archivedPdfStoredAt: new Date(),
            archivedPdfSource: "NEWBI",
          },
        },
      );
    return key;
  }

  const TYPES = [
    {
      type: "invoice",
      collection: "invoices",
      filter: { status: { $ne: "DRAFT" } },
      archive: (doc) => archiveInvoiceFacturX(doc, String(doc.workspaceId)),
    },
    {
      type: "quote",
      collection: "quotes",
      filter: { status: { $ne: "DRAFT" } },
      archive: (doc) =>
        archiveGenericDocument(
          "quote",
          "/api/quotes/generate-pdf",
          "quoteId",
          doc,
        ),
    },
    {
      type: "creditNote",
      collection: "creditnotes",
      filter: {},
      archive: (doc) => archiveCreditNoteFacturX(doc, String(doc.workspaceId)),
    },
    {
      type: "purchaseOrder",
      collection: "purchaseorders",
      filter: { status: { $ne: "DRAFT" } },
      archive: (doc) =>
        archiveGenericDocument(
          "purchaseOrder",
          "/api/purchase-orders/generate-pdf",
          "purchaseOrderId",
          doc,
        ),
    },
  ];

  const summary = [];

  for (const spec of TYPES) {
    if (ONLY_TYPE && spec.type !== ONLY_TYPE) continue;

    const filter = {
      ...spec.filter,
      workspaceId: { $ne: null },
      archivedPdfKey: { $in: [null, ""] },
    };
    let cursor = db
      .collection(spec.collection)
      .find(filter)
      .sort({ createdAt: 1 });
    if (LIMIT) cursor = cursor.limit(LIMIT);
    const docs = await cursor.toArray();

    console.log(`\n📂 ${spec.type} : ${docs.length} document(s) à archiver`);
    let ok = 0;
    const failures = [];

    for (const doc of docs) {
      const label = `${spec.type} ${doc.prefix || ""}${doc.number || doc._id}`;
      if (DRY_RUN) {
        console.log(`  [dry-run] ${label} (${doc._id})`);
        continue;
      }
      try {
        await spec.archive(doc);
        ok++;
        console.log(`  ✅ ${label} (${ok}/${docs.length})`);
      } catch (err) {
        failures.push({ id: doc._id.toString(), label, error: err.message });
        console.log(`  ❌ ${label} : ${err.message}`);
      }
      await sleep(DELAY_MS);
    }

    summary.push({ type: spec.type, total: docs.length, ok, failures });
  }

  console.log("\n========== RÉSUMÉ ==========");
  for (const s of summary) {
    console.log(
      `${s.type} : ${DRY_RUN ? `${s.total} à archiver (dry-run)` : `${s.ok}/${s.total} archivés, ${s.failures.length} échec(s)`}`,
    );
    for (const f of s.failures) {
      console.log(`   ❌ ${f.label} (${f.id}) : ${f.error}`);
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
