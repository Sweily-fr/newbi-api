/**
 * Jeu d'essai : propositions de facture d'achat en attente de confirmation.
 *
 * Crée deux transactions de dépense dans le workspace local, chacune avec un
 * justificatif portant une proposition :
 *  - « Confirmation simple » : aucune facture existante ne lui ressemble ;
 *  - « Doublon suspecté » : une facture existante porte le même numéro, le
 *    dialogue doit proposer « Rattacher » ou « Créer quand même ».
 *
 * Usage : node scripts/seed-propositions-facture-achat.cjs [--clean]
 */
const path = require("path");
require("dotenv").config();
const { MongoClient, ObjectId } = require(
  path.join(__dirname, "..", "node_modules", "mongodb"),
);

const WORKSPACE_ID = process.env.SEED_WORKSPACE_ID || "68dda81e814240de4cc86e75";
// createdBy est obligatoire sur PurchaseInvoice : sans lui, le document
// inséré au driver brut échappe à la validation mais devient invalide.
const USER_ID = process.env.SEED_USER_ID || "68777df3c13b90dd2991ed77";
const TAG = "SEED-PROPOSITION";

(async () => {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const transactions = db.collection("transactions");
  const purchaseInvoices = db.collection("purchaseinvoices");

  await transactions.deleteMany({ description: { $regex: `^${TAG}` } });
  await purchaseInvoices.deleteMany({ invoiceNumber: { $regex: `^${TAG}` } });
  if (process.argv.includes("--clean")) {
    console.log("🧹 Jeu d'essai supprimé");
    await client.close();
    return;
  }

  const existing = {
    _id: new ObjectId(),
    supplierName: "Mammouth AI",
    invoiceNumber: `${TAG}-DOUBLON-001`,
    issueDate: new Date("2026-09-10"),
    amountHT: 20,
    amountTVA: 4,
    vatRate: 20,
    amountTTC: 24,
    currency: "EUR",
    status: "PAID",
    category: "SUBSCRIPTIONS",
    subcategory: "subscriptions",
    source: "OCR",
    workspaceId: new ObjectId(WORKSPACE_ID),
    createdBy: new ObjectId(USER_ID),
    linkedTransactionIds: [],
    files: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await purchaseInvoices.insertOne(existing);

  const proposal = (values, duplicate = null) => ({
    values,
    meta: {
      ocrSucceeded: true,
      conversionNote: "",
      supplierSiret: null,
      supplierVatNumber: null,
      ocrData: null,
      ocrMetadata: { provider: "claude-vision", extractionQuality: "full" },
    },
    duplicateInvoiceId: duplicate ? duplicate._id : null,
    duplicateLinkTransaction: true,
    duplicateReason: duplicate ? "NUMBER" : null,
    proposedAt: new Date(),
  });

  const receipt = (filename, prop) => ({
    _id: new ObjectId(),
    url: "https://pub-09826f2ab5554995a33267f106c7b784.r2.dev/68dda81e814240de4cc86e75/ce2d4cd7-a070-4605-ac89-f6ec7f572103-receipt.pdf",
    key: "68dda81e814240de4cc86e75/ce2d4cd7-a070-4605-ac89-f6ec7f572103-receipt.pdf",
    filename,
    mimetype: "application/pdf",
    size: 4809,
    uploadedAt: new Date(),
    ocrProcessed: true,
    ocrClaimedAt: new Date(),
    purchaseInvoiceId: null,
    ocrProposal: prop,
  });

  const base = {
    provider: "bridge",
    type: "debit",
    status: "completed",
    currency: "EUR",
    workspaceId: WORKSPACE_ID,
    date: new Date("2026-09-20"),
    reconciliationStatus: "unmatched",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await transactions.insertMany([
    {
      ...base,
      externalId: `${TAG}-simple`,
      amount: -49.9,
      description: `${TAG} Confirmation simple`,
      receiptFiles: [
        receipt(
          "facture-OVH-2026-0912.pdf",
          proposal({
            supplierName: "OVH SAS",
            invoiceNumber: "FR78060686",
            issueDate: new Date("2026-09-18"),
            dueDate: null,
            amountHT: 41.58,
            amountTVA: 8.32,
            vatRate: 20,
            amountTTC: 49.9,
            currency: "EUR",
            category: "SUBSCRIPTIONS",
            subcategory: "subscriptions",
            paymentMethod: "CREDIT_CARD",
          }),
        ),
      ],
    },
    {
      ...base,
      externalId: `${TAG}-doublon`,
      amount: -24,
      description: `${TAG} Doublon suspecte`,
      receiptFiles: [
        receipt(
          "facture-Mammouth-2026-09.pdf",
          proposal(
            {
              supplierName: "Mammouth AI",
              invoiceNumber: `${TAG}-DOUBLON-001`,
              issueDate: new Date("2026-09-20"),
              dueDate: null,
              amountHT: 20,
              amountTVA: 4,
              vatRate: 20,
              amountTTC: 24,
              currency: "EUR",
              category: "SUBSCRIPTIONS",
              subcategory: "subscriptions",
              paymentMethod: "CREDIT_CARD",
            },
            existing,
          ),
        ),
      ],
    },
  ]);

  console.log(
    `✅ 2 transactions avec proposition créées (chercher « ${TAG} » dans Transactions) + 1 facture d'achat existante pour le cas doublon`,
  );
  await client.close();
})().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
