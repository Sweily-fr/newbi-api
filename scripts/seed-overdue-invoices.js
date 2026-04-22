import { MongoClient, ObjectId } from "mongodb";

const MONGODB_URI = "mongodb://localhost:27017/invoice-app";
const DB_NAME = "invoice-app";
const WORKSPACE_ID = "68dda81e814240de4cc86e75";

const services = [
  {
    desc: "Développement application web",
    price: 2500,
    unit: "forfait",
    vat: 20,
  },
  {
    desc: "Audit sécurité informatique",
    price: 1200,
    unit: "forfait",
    vat: 20,
  },
  { desc: "Consultation stratégique", price: 150, unit: "heure", vat: 20 },
  { desc: "Formation équipe technique", price: 800, unit: "jour", vat: 20 },
  { desc: "Migration base de données", price: 1800, unit: "forfait", vat: 20 },
];

const overdueDays = [45, 30, 18, 9, 3];

async function main() {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db(DB_NAME);
  const wsId = new ObjectId(WORKSPACE_ID);

  console.log("→ Connexion MongoDB OK");

  const sample = await db.collection("invoices").findOne({ workspaceId: wsId });
  if (!sample)
    throw new Error("Aucune facture existante pour cloner companyInfo");
  const { companyInfo, bankDetails, appearance, createdBy } = sample;

  const allClients = await db
    .collection("clients")
    .find({ workspaceId: wsId })
    .limit(5)
    .toArray();
  if (allClients.length < 5)
    throw new Error(`Seulement ${allClients.length} clients disponibles`);

  console.log(`→ ${allClients.length} clients sélectionnés`);

  const existingNumbers = new Set(
    (
      await db
        .collection("invoices")
        .find(
          { workspaceId: wsId, prefix: "F-DEMO", issueYear: 2026 },
          { projection: { number: 1 } },
        )
        .toArray()
    ).map((i) => i.number),
  );

  let nextNum = 1;
  const pickNumber = () => {
    while (existingNumbers.has(String(nextNum).padStart(4, "0"))) nextNum++;
    const n = String(nextNum).padStart(4, "0");
    existingNumbers.add(n);
    nextNum++;
    return n;
  };

  const now = new Date();
  const invoices = [];

  for (let i = 0; i < 5; i++) {
    const service = services[i];
    const days = overdueDays[i];
    const cli = allClients[i];

    const quantity = Math.floor(Math.random() * 4) + 1;
    const totalHT = service.price * quantity;
    const totalVAT = (totalHT * service.vat) / 100;
    const finalTotalTTC = totalHT + totalVAT;

    const issueDate = new Date(now.getTime() - (days + 30) * 86400000);
    const dueDate = new Date(now.getTime() - days * 86400000);

    invoices.push({
      _id: new ObjectId(),
      prefix: "F-DEMO",
      number: pickNumber(),
      issueDate,
      dueDate,
      isDeposit: false,
      invoiceType: "standard",
      situationNumber: 1,
      depositAmount: 0,
      items: [
        {
          description: service.desc,
          quantity,
          unitPrice: service.price,
          vatRate: service.vat,
          vatExemptionText: "",
          unit: service.unit,
          discount: 0,
          discountType: "PERCENTAGE",
          details: `Prestation - ${service.desc}`,
          progressPercentage: 100,
          _id: new ObjectId(),
        },
      ],
      companyInfo,
      client: {
        id: cli._id.toString(),
        type: cli.type || "COMPANY",
        firstName: cli.firstName || "",
        lastName: cli.lastName || "",
        name: cli.name || cli.email || "Client",
        email: cli.email || "",
        address: cli.address || {
          street: "",
          city: "",
          postalCode: "",
          country: "France",
        },
        hasDifferentShippingAddress: false,
        isInternational: false,
        siret: cli.siret || "",
        vatNumber: cli.vatNumber || "",
        _id: new ObjectId(),
      },
      status: "PENDING",
      paymentMethod: "BANK_TRANSFER",
      headerNotes: "",
      footerNotes: "Merci de régler dans les meilleurs délais.",
      termsAndConditions: "",
      purchaseOrderNumber: "",
      contractTotal: 0,
      discount: 0,
      discountType: "PERCENTAGE",
      customFields: [],
      showBankDetails: true,
      bankDetails: bankDetails || companyInfo?.bankDetails,
      totalHT: parseFloat(totalHT.toFixed(2)),
      totalTTC: parseFloat(finalTotalTTC.toFixed(2)),
      totalVAT: parseFloat(totalVAT.toFixed(2)),
      finalTotalHT: parseFloat(totalHT.toFixed(2)),
      finalTotalVAT: parseFloat(totalVAT.toFixed(2)),
      finalTotalTTC: parseFloat(finalTotalTTC.toFixed(2)),
      emailTracking: { emailOpenCount: 0, emailClickCount: 0 },
      workspaceId: wsId,
      createdBy,
      appearance: appearance || {
        textColor: "#000000",
        headerTextColor: "#FFFFFF",
        headerBgColor: "#5B4FFF",
      },
      shipping: {
        billShipping: false,
        shippingAddress: null,
        shippingAmountHT: 0,
        shippingVatRate: 20,
        _id: new ObjectId(),
      },
      isReverseCharge: false,
      clientPositionRight: false,
      retenueGarantie: 0,
      escompte: 0,
      operationType: null,
      linkedTransactionId: null,
      pennylaneSyncStatus: "NOT_SYNCED",
      eInvoiceStatus: "NOT_SENT",
      facturXData: { xmlGenerated: false, profile: "EN16931" },
      eInvoiceFlowType: "NONE",
      issueYear: issueDate.getFullYear(),
      createdAt: issueDate,
      updatedAt: issueDate,
      __v: 0,
    });
  }

  const res = await db.collection("invoices").insertMany(invoices);
  console.log(`✅ ${res.insertedCount} factures en retard créées`);
  invoices.forEach((inv) => {
    const days = Math.round((now - inv.dueDate) / 86400000);
    console.log(
      `  · ${inv.prefix}-${inv.number} | ${inv.client.name.substring(0, 30).padEnd(30)} | ${inv.finalTotalTTC.toFixed(2)}€ | retard ${days}j`,
    );
  });

  await client.close();
}

main().catch((err) => {
  console.error("❌ Erreur:", err);
  process.exit(1);
});
