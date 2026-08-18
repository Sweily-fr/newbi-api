import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";

/**
 * Régénération des PDF archivés flous (capture 192 DPI) sur Cloudflare R2.
 *
 * Contexte : jusqu'au 18/08/2026 (~09:20 UTC, NewbiV2 PR #1045 + #1046), les
 * PDF de documents étaient des captures JPEG du DOM à scale 2 (~192 DPI),
 * visiblement floues en preview, au zoom et à l'impression. Les PDF archivés
 * sur R2 sont figés à la finalisation : ce script régénère ceux produits avant
 * le correctif, via les mêmes services que la finalisation (Factur-X inclus
 * pour factures/avoirs), et supprime l'ancien objet R2 si la clé a changé
 * (la clé contient année/mois de l'upload).
 *
 * Ne touche que les archives archivedPdfSource="NEWBI" : les PDF importés ou
 * servis par SuperPDP ne sont jamais régénérés.
 *
 * Usage (depuis la racine de l'API, avec .env.production à côté) :
 *   node scripts/regenerate-archived-pdfs.js --dry-run
 *   node scripts/regenerate-archived-pdfs.js --type invoice --limit 5
 *   node scripts/regenerate-archived-pdfs.js --since 2026-06-01
 *   node scripts/regenerate-archived-pdfs.js            # tout régénérer
 *
 * Options :
 *   --dry-run       liste ce qui serait régénéré, sans rien générer/uploader
 *   --type <t>      invoice | quote | creditNote | purchaseOrder (défaut : tous)
 *   --limit <n>     limite le nombre de documents traités par type
 *   --since <date>  ne traite que les archives créées après cette date
 *   --before <date> borne haute (défaut : 2026-08-18T09:20:00Z, deploy du fix)
 *   --delay <ms>    pause entre deux documents (défaut 2000 ms : chaque
 *                   génération lance un Puppeteer côté NewbiV2)
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
const DELAY_MS = Number(getOpt("delay")) || 2000;
const ENV_FILE = getOpt("env") || ".env.production";

// Deploy du correctif scale 3 (merge PR #1046 : 2026-08-18T09:18:55Z) : toute
// archive antérieure a été capturée à 192 DPI.
const BEFORE = new Date(getOpt("before") || "2026-08-18T09:20:00Z");
const SINCE = getOpt("since") ? new Date(getOpt("since")) : null;
if (
  Number.isNaN(BEFORE.getTime()) ||
  (SINCE && Number.isNaN(SINCE.getTime()))
) {
  console.error("Date --before/--since invalide");
  process.exit(1);
}

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
  console.log(
    `   Fenêtre : archives ${SINCE ? `du ${SINCE.toISOString()} ` : ""}au ${BEFORE.toISOString()}`,
  );

  // Imports APRÈS dotenv : cloudflareService lit l'env à la construction.
  const { default: cloudflareService } =
    await import("../src/services/cloudflareService.js");
  const { archiveInvoiceFacturX } =
    await import("../src/services/invoiceFacturXArchiveService.js");
  const { archiveCreditNoteFacturX } =
    await import("../src/services/creditNoteFacturXArchiveService.js");

  const db = mongoose.connection.db;

  // Génère le PDF d'un devis/BC via NewbiV2 puis remplace l'archive R2
  // (même flux que backfill-document-archives.js).
  async function regenerateGenericDocument(spec, doc) {
    const docId = doc._id.toString();
    const response = await axios.post(
      `${FRONTEND_URL}${spec.endpoint}`,
      { [spec.idField]: docId },
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

    const fileName = `${spec.type}_${doc.prefix || ""}${doc.number || docId}.pdf`;
    const { key } = await cloudflareService.uploadDocumentPdf(
      spec.type,
      pdfBuffer,
      String(doc.workspaceId),
      docId,
      { fileName },
    );

    await db.collection(spec.collection).updateOne(
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

  // Supprime l'ancien objet R2 si la régénération a produit une clé différente
  // (la clé contient année/mois : un doc archivé un autre mois change de clé).
  async function deleteOldObject(spec, doc) {
    const fresh = await db
      .collection(spec.collection)
      .findOne({ _id: doc._id }, { projection: { archivedPdfKey: 1 } });
    const newKey = fresh?.archivedPdfKey;
    const oldKey = doc.archivedPdfKey;
    if (!newKey || !oldKey || newKey === oldKey) return;
    const bucket =
      spec.type === "invoice"
        ? cloudflareService.invoicesBucketName
        : cloudflareService.documentBuckets[spec.type];
    try {
      await cloudflareService.deleteImage(oldKey, bucket);
    } catch (err) {
      // Orphelin R2 sans gravité : la nouvelle archive est déjà en place.
      console.log(
        `     ⚠️ ancien objet non supprimé (${oldKey}) : ${err.message}`,
      );
    }
  }

  const TYPES = [
    {
      type: "invoice",
      collection: "invoices",
      filter: { status: { $ne: "DRAFT" } },
      regenerate: (doc) => archiveInvoiceFacturX(doc, String(doc.workspaceId)),
    },
    {
      type: "quote",
      collection: "quotes",
      filter: { status: { $ne: "DRAFT" } },
      endpoint: "/api/quotes/generate-pdf",
      idField: "quoteId",
    },
    {
      type: "creditNote",
      collection: "creditnotes",
      filter: {},
      regenerate: (doc) =>
        archiveCreditNoteFacturX(doc, String(doc.workspaceId)),
    },
    {
      type: "purchaseOrder",
      collection: "purchaseorders",
      filter: { status: { $ne: "DRAFT" } },
      endpoint: "/api/purchase-orders/generate-pdf",
      idField: "purchaseOrderId",
    },
  ];

  const summary = [];

  for (const spec of TYPES) {
    if (ONLY_TYPE && spec.type !== ONLY_TYPE) continue;

    const filter = {
      ...spec.filter,
      workspaceId: { $ne: null },
      archivedPdfKey: { $nin: [null, ""] },
      archivedPdfSource: "NEWBI",
      archivedPdfStoredAt: {
        $lt: BEFORE,
        ...(SINCE ? { $gte: SINCE } : {}),
      },
    };
    // Les plus récentes d'abord : ce sont celles que les utilisateurs ouvrent.
    let cursor = db
      .collection(spec.collection)
      .find(filter)
      .sort({ archivedPdfStoredAt: -1 });
    if (LIMIT) cursor = cursor.limit(LIMIT);
    const docs = await cursor.toArray();

    console.log(`\n📂 ${spec.type} : ${docs.length} archive(s) à régénérer`);
    let ok = 0;
    const failures = [];

    for (const doc of docs) {
      const label = `${spec.type} ${doc.prefix || ""}${doc.number || doc._id}`;
      if (DRY_RUN) {
        console.log(
          `  [dry-run] ${label} (${doc._id}, archivé le ${doc.archivedPdfStoredAt?.toISOString?.() || "?"})`,
        );
        continue;
      }
      try {
        if (spec.regenerate) {
          await spec.regenerate(doc);
        } else {
          await regenerateGenericDocument(spec, doc);
        }
        await deleteOldObject(spec, doc);
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
      `${s.type} : ${DRY_RUN ? `${s.total} à régénérer (dry-run)` : `${s.ok}/${s.total} régénérés, ${s.failures.length} échec(s)`}`,
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
