/* eslint-disable no-undef -- script mongosh : db, print, ObjectId sont des globales du shell MongoDB, pas Node */
/* global db, print, ObjectId */
/**
 * ============================================================================
 *  SEED DÉMO — demo@newbi.fr  (Transactions / Ventes / Pilotage)
 * ============================================================================
 *
 *  À COLLER DANS LE SHELL MONGOSH DE MONGODB COMPASS  (onglet `>_ MONGOSH` en bas).
 *
 *  ⚠️ AVANT DE COLLER : sélectionne la bonne base de données dans Compass
 *     (clique sur la DB Newbi à gauche, ou tape `use <nom_de_la_base>` dans le shell).
 *
 *  Ce que fait le script :
 *    1. Résout l'utilisateur demo@newbi.fr → son organisation (workspaceId).
 *    2. SUPPRIME les données démo existantes de ce workspace :
 *         - factures (invoices)
 *         - transactions (transactions)
 *         - compte bancaire mock (accounts_bankings, provider "mock")
 *         - clients (clients)
 *       (ne touche PAS aux devis, factures d'achat, dépenses, signatures, etc.)
 *    3. Recrée : 1 compte bancaire mock + des clients + des factures + des
 *       transactions cohérentes, du 23/06/2025 au 23/06/2026.
 *
 *  Le "Pilotage" (Vue d'ensemble / Prévision / Analytiques) n'a pas de collection
 *  propre : il est dérivé des factures (CA) et des transactions (encaissements /
 *  dépenses). En remplissant ces deux collections de façon cohérente, les 3 pages
 *  de pilotage se peuplent automatiquement.
 * ============================================================================
 */

(async () => {
  // ----- Paramètres ---------------------------------------------------------
  const DEMO_EMAIL = "demo@newbi.fr";
  const PERIOD_START = new Date("2025-06-23T00:00:00.000Z");
  const PERIOD_END = new Date("2026-06-23T23:59:59.999Z");
  const TODAY = new Date("2026-06-23T12:00:00.000Z"); // "maintenant" pour statuts
  const STARTING_BALANCE = 5000; // solde de départ du compte
  const MONTHLY_GROWTH = 0.05; // croissance du CA ~+5%/mois (activité en hausse → prévisionnel ascendant)

  // ----- Helpers ------------------------------------------------------------
  const rand = (min, max) => Math.random() * (max - min) + min;
  const randInt = (min, max) => Math.floor(rand(min, max + 1));
  const pick = (arr) => arr[randInt(0, arr.length - 1)];
  const round2 = (n) => Math.round(n * 100) / 100;
  const pad = (n, len) => String(n).padStart(len, "0");
  const clampDate = (d) =>
    d < PERIOD_START
      ? new Date(PERIOD_START)
      : d > PERIOD_END
        ? new Date(PERIOD_END)
        : d;
  const addDays = (d, n) => {
    const r = new Date(d);
    r.setUTCDate(r.getUTCDate() + n);
    return r;
  };
  const dayInMonth = (year, month, day) =>
    new Date(
      Date.UTC(
        year,
        month,
        Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()),
        11,
        0,
        0,
      ),
    );
  // Index du mois depuis juin 2025 (0 = juin 2025) et facteur de croissance associé
  const monthIndexOf = (year, month) => (year - 2025) * 12 + (month - 5);
  const growthOf = (year, month) =>
    Math.pow(1 + MONTHLY_GROWTH, Math.max(0, monthIndexOf(year, month)));

  // ----- 1. Résolution user → organisation ----------------------------------
  const user = await db.getCollection("user").findOne({ email: DEMO_EMAIL });
  if (!user) {
    print(
      `❌ Utilisateur ${DEMO_EMAIL} introuvable dans la collection "user". Sélectionne la bonne base.`,
    );
    return;
  }
  const userId = user._id;

  let member = await db
    .getCollection("member")
    .findOne({ userId, role: "owner" });
  if (!member)
    member = await db
      .getCollection("member")
      .findOne({ userId, role: "admin" });
  if (!member) member = await db.getCollection("member").findOne({ userId });
  if (!member) {
    print(
      `❌ Aucune organisation (collection "member") trouvée pour ${DEMO_EMAIL}.`,
    );
    return;
  }
  const orgId = member.organizationId; // ObjectId
  const orgIdStr = orgId.toString(); // String (transactions / comptes)
  const org = await db.getCollection("organization").findOne({ _id: orgId });

  print("============================================================");
  print(`✅ User      : ${user.email}  (${userId})`);
  print(`✅ Workspace : ${org ? org.name : "?"}  (${orgIdStr})`);
  print("============================================================");

  // ----- 2. Suppression de l'existant ---------------------------------------
  const delInv = await db
    .getCollection("invoices")
    .deleteMany({ workspaceId: orgId });
  const delTxn = await db
    .getCollection("transactions")
    .deleteMany({ workspaceId: orgIdStr });
  const delAcc = await db
    .getCollection("accounts_bankings")
    .deleteMany({ workspaceId: orgIdStr, provider: "mock" });
  const delCli = await db
    .getCollection("clients")
    .deleteMany({ workspaceId: orgId });
  const delQuo = await db
    .getCollection("quotes")
    .deleteMany({ workspaceId: orgId });
  const delPur = await db
    .getCollection("purchaseinvoices")
    .deleteMany({ workspaceId: orgId });
  const delExp = await db
    .getCollection("expenses")
    .deleteMany({ workspaceId: orgId });
  const delCsh = await db
    .getCollection("manualcashflowentries")
    .deleteMany({ workspaceId: orgId });
  const delPo = await db
    .getCollection("purchaseorders")
    .deleteMany({ workspaceId: orgId });
  const delCn = await db
    .getCollection("creditnotes")
    .deleteMany({ workspaceId: orgId });
  const delEvt = await db
    .getCollection("events")
    .deleteMany({ workspaceId: orgId, source: "newbi" });
  const delTsk = await db
    .getCollection("tasks")
    .deleteMany({ workspaceId: orgId });
  const delCol = await db
    .getCollection("columns")
    .deleteMany({ workspaceId: orgId });
  const delBrd = await db
    .getCollection("boards")
    .deleteMany({ workspaceId: orgId });
  const delFt = await db
    .getCollection("filetransfers")
    .deleteMany({ workspaceId: orgIdStr });
  const delSd = await db
    .getCollection("shareddocuments")
    .deleteMany({ workspaceId: orgId });
  const delSig = await db
    .getCollection("emailsignatures")
    .deleteMany({ createdBy: userId });
  const delNot = await db
    .getCollection("notifications")
    .deleteMany({ workspaceId: orgId });
  const delPrd = await db
    .getCollection("products")
    .deleteMany({ workspaceId: orgId });
  const delSup = await db
    .getCollection("suppliers")
    .deleteMany({ workspaceId: orgId });
  const delCll = await db
    .getCollection("clientlists")
    .deleteMany({ workspaceId: orgId });
  const delCsg = await db
    .getCollection("clientsegments")
    .deleteMany({ workspaceId: orgId });
  print(
    `🗑️  Supprimé : ${delInv.deletedCount} factures, ${delTxn.deletedCount} transactions, ` +
      `${delAcc.deletedCount} compte(s) mock, ${delCli.deletedCount} clients,`,
  );
  print(
    `             ${delQuo.deletedCount} devis, ${delPur.deletedCount} factures d'achat, ` +
      `${delExp.deletedCount} dépenses, ${delCsh.deletedCount} entrées de prévision,`,
  );
  print(
    `             ${delPo.deletedCount} bons de commande, ${delCn.deletedCount} avoirs,`,
  );
  print(
    `             ${delEvt.deletedCount} événements, ${delBrd.deletedCount} tableaux / ` +
      `${delCol.deletedCount} colonnes / ${delTsk.deletedCount} tâches,`,
  );
  print(
    `             ${delFt.deletedCount} transferts, ${delSd.deletedCount} documents partagés, ` +
      `${delSig.deletedCount} signatures, ${delNot.deletedCount} notifications,`,
  );
  print(
    `             ${delPrd.deletedCount} produits, ${delSup.deletedCount} fournisseurs, ` +
      `${delCll.deletedCount} listes, ${delCsg.deletedCount} segments.`,
  );

  // ----- 3a. Compte bancaire mock -------------------------------------------
  const accountExternalId = `mock-demo-${orgIdStr.slice(-8)}`;
  const accountDoc = {
    externalId: accountExternalId,
    provider: "mock",
    name: "Compte Pro — Démo",
    type: "business",
    status: "active",
    balance: STARTING_BALANCE, // recalculé en fin de script
    currency: "EUR",
    iban: "FR7630006000011234567890189",
    institutionName: "Banque Démo",
    institutionLogo: null,
    workspaceId: orgIdStr,
    userId: userId,
    lastSyncAt: TODAY,
    transactionSync: {
      lastSyncAt: TODAY,
      status: "complete",
      totalTransactions: 0,
      oldestTransactionDate: PERIOD_START,
      newestTransactionDate: PERIOD_END,
      lastError: null,
      history: [],
    },
    createdAt: PERIOD_START,
    updatedAt: TODAY,
  };
  const accRes = await db
    .getCollection("accounts_bankings")
    .insertOne(accountDoc);
  const accountId = accRes.insertedId;
  print(`🏦 Compte courant mock créé  : ${accountExternalId}`);

  // Compte d'épargne secondaire (pour les virements internes)
  const savingsExternalId = `mock-demo-sav-${orgIdStr.slice(-8)}`;
  const SAVINGS_STARTING = 0;
  const savingsDoc = {
    externalId: savingsExternalId,
    provider: "mock",
    name: "Compte Épargne — Démo",
    type: "savings",
    status: "active",
    balance: SAVINGS_STARTING, // recalculé en fin de script
    currency: "EUR",
    iban: "FR7630006000017654321098765",
    institutionName: "Banque Démo",
    institutionLogo: null,
    workspaceId: orgIdStr,
    userId: userId,
    lastSyncAt: TODAY,
    transactionSync: {
      lastSyncAt: TODAY,
      status: "complete",
      totalTransactions: 0,
      oldestTransactionDate: PERIOD_START,
      newestTransactionDate: PERIOD_END,
      lastError: null,
      history: [],
    },
    createdAt: PERIOD_START,
    updatedAt: TODAY,
  };
  const savRes = await db
    .getCollection("accounts_bankings")
    .insertOne(savingsDoc);
  const savingsAccountId = savRes.insertedId;
  print(`🏦 Compte épargne mock créé  : ${savingsExternalId}`);

  // ----- 3b. Clients ---------------------------------------------------------
  const CLIENTS = [
    {
      type: "COMPANY",
      name: "Studio Lumière SARL",
      email: "contact@studiolumiere.fr",
      siret: "81234567800012",
      vat: "FR81812345678",
      city: "Lyon",
      cp: "69002",
      street: "12 rue de la République",
    },
    {
      type: "COMPANY",
      name: "Atelier Boréal",
      email: "hello@atelierboreal.fr",
      siret: "79234567800021",
      vat: "FR79792345678",
      city: "Nantes",
      cp: "44000",
      street: "8 quai de la Fosse",
    },
    {
      type: "COMPANY",
      name: "Greentech Solutions",
      email: "facturation@greentech.fr",
      siret: "84234567800033",
      vat: "FR84842345678",
      city: "Bordeaux",
      cp: "33000",
      street: "25 cours de l'Intendance",
    },
    {
      type: "COMPANY",
      name: "Maison Dupont & Fils",
      email: "compta@maisondupont.fr",
      siret: "75234567800045",
      vat: "FR75752345678",
      city: "Lille",
      cp: "59000",
      street: "3 place du Théâtre",
    },
    {
      type: "COMPANY",
      name: "Novacom Agency",
      email: "admin@novacom.fr",
      siret: "82234567800056",
      vat: "FR82822345678",
      city: "Toulouse",
      cp: "31000",
      street: "14 allées Jean Jaurès",
    },
    {
      type: "COMPANY",
      name: "Le Comptoir Digital",
      email: "contact@comptoirdigital.fr",
      siret: "80234567800067",
      vat: "FR80802345678",
      city: "Paris",
      cp: "75011",
      street: "47 rue Oberkampf",
    },
    {
      type: "COMPANY",
      name: "Horizon Conseil",
      email: "info@horizonconseil.fr",
      siret: "83234567800078",
      vat: "FR83832345678",
      city: "Strasbourg",
      cp: "67000",
      street: "5 rue du Dôme",
    },
    {
      type: "COMPANY",
      name: "Pixel & Co",
      email: "facture@pixelandco.fr",
      siret: "85234567800089",
      vat: "FR85852345678",
      city: "Montpellier",
      cp: "34000",
      street: "10 rue Foch",
    },
    {
      type: "INDIVIDUAL",
      firstName: "Camille",
      lastName: "Moreau",
      email: "camille.moreau@gmail.com",
      city: "Rennes",
      cp: "35000",
      street: "22 rue de Brest",
    },
    {
      type: "INDIVIDUAL",
      firstName: "Julien",
      lastName: "Petit",
      email: "julien.petit@outlook.fr",
      city: "Nice",
      cp: "06000",
      street: "6 promenade des Anglais",
    },
  ];

  const clientDocs = CLIENTS.map((c) => {
    const name = c.type === "COMPANY" ? c.name : `${c.firstName} ${c.lastName}`;
    return {
      name,
      email: c.email,
      phone: `0${randInt(1, 7)}${pad(randInt(0, 99999999), 8)}`,
      address: {
        street: c.street,
        city: c.city,
        postalCode: c.cp,
        country: "France",
      },
      hasDifferentShippingAddress: false,
      type: c.type,
      ...(c.type === "COMPANY"
        ? { siret: c.siret, vatNumber: c.vat }
        : { firstName: c.firstName, lastName: c.lastName }),
      isInternational: false,
      createdBy: userId,
      workspaceId: orgId,
      assignedMembers: [],
      isBlocked: false,
      notes: [],
      contacts: [],
      customFields: [],
      activity: [],
      createdAt: PERIOD_START,
      updatedAt: PERIOD_START,
    };
  });
  const cliRes = await db.getCollection("clients").insertMany(clientDocs);
  const clientIds = Object.values(cliRes.insertedIds);
  const clients = clientDocs.map((c, i) => ({ ...c, _id: clientIds[i] }));
  print(`👥 ${clients.length} clients créés.`);

  // ----- 3c. Génération des factures + transactions d'encaissement ----------
  const SERVICES = [
    {
      label: "Développement application web",
      unit: "forfait",
      price: [2500, 6000],
      vat: 20,
    },
    {
      label: "Intégration maquette responsive",
      unit: "jour",
      price: [450, 650],
      vat: 20,
    },
    {
      label: "Maintenance mensuelle",
      unit: "mois",
      price: [250, 600],
      vat: 20,
    },
    {
      label: "Audit SEO & recommandations",
      unit: "forfait",
      price: [800, 1800],
      vat: 20,
    },
    {
      label: "Création identité visuelle",
      unit: "forfait",
      price: [1200, 3500],
      vat: 20,
    },
    { label: "Rédaction de contenu", unit: "jour", price: [350, 500], vat: 20 },
    {
      label: "Hébergement & infogérance annuelle",
      unit: "an",
      price: [600, 1200],
      vat: 20,
    },
    {
      label: "Formation utilisateurs",
      unit: "jour",
      price: [700, 950],
      vat: 20,
    },
    {
      label: "Consulting stratégie digitale",
      unit: "jour",
      price: [600, 900],
      vat: 20,
    },
    {
      label: "Campagne publicitaire (gestion)",
      unit: "mois",
      price: [400, 1000],
      vat: 20,
    },
  ];

  const invoiceDocs = [];
  const transactionDocs = [];
  const seqByYear = {};
  let txnCounter = 0;
  const newTxn = (date, amount, base) => {
    txnCounter += 1;
    transactionDocs.push({
      externalId: `mock-txn-${orgIdStr.slice(-6)}-${pad(txnCounter, 5)}`,
      provider: "mock",
      currency: "EUR",
      workspaceId: orgIdStr,
      userId: userId,
      fromAccount: accountExternalId,
      toAccount: accountExternalId,
      date: date,
      processedAt: date,
      amount: round2(amount),
      reconciliationStatus: "unmatched",
      receiptRequired: false,
      receiptFiles: [],
      deletedAt: null,
      createdAt: date,
      updatedAt: date,
      ...base,
    });
  };

  // Itère mois par mois de juin 2025 à juin 2026
  const months = [];
  for (let y = 2025, m = 5; !(y === 2026 && m === 6); ) {
    months.push({ year: y, month: m });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }

  for (const { year, month } of months) {
    const nbInvoices = randInt(3, 5);
    for (let i = 0; i < nbInvoices; i++) {
      const issueDate = clampDate(dayInMonth(year, month, randInt(2, 27)));
      if (issueDate < PERIOD_START || issueDate > PERIOD_END) continue;

      const issueYear = issueDate.getUTCFullYear();
      seqByYear[issueYear] = (seqByYear[issueYear] || 0) + 1;
      const seq = seqByYear[issueYear];
      const prefix = `F-${issueYear}${pad(month + 1, 2)}`;
      const number = `${issueYear}-${pad(seq, 4)}`;

      const client = pick(clients);
      const growth = growthOf(year, month); // facteur de croissance du mois
      const nbItems = randInt(1, 3);
      const items = [];
      let totalHT = 0;
      let totalVAT = 0;
      for (let k = 0; k < nbItems; k++) {
        const svc = pick(SERVICES);
        const quantity =
          svc.unit === "forfait" || svc.unit === "an" ? 1 : randInt(1, 8);
        const unitPrice = round2(rand(svc.price[0], svc.price[1]) * growth);
        const lineHT = round2(quantity * unitPrice);
        const lineVAT = round2(lineHT * (svc.vat / 100));
        totalHT += lineHT;
        totalVAT += lineVAT;
        items.push({
          description: svc.label,
          quantity,
          unitPrice,
          vatRate: svc.vat,
          unit: svc.unit,
          discount: 0,
          discountType: "PERCENTAGE",
          details: "",
        });
      }
      totalHT = round2(totalHT);
      totalVAT = round2(totalVAT);
      const totalTTC = round2(totalHT + totalVAT);

      const dueDate = addDays(issueDate, 30);

      // Statut selon l'ancienneté
      let status,
        paymentDate = null;
      const ageDays = (TODAY - issueDate) / 86400000;
      const r = Math.random();
      if (ageDays < 12) {
        status = r < 0.15 ? "DRAFT" : "PENDING";
      } else if (ageDays < 40) {
        status = r < 0.7 ? "COMPLETED" : r < 0.9 ? "PENDING" : "OVERDUE";
      } else {
        status = r < 0.88 ? "COMPLETED" : "OVERDUE";
      }
      if (status === "COMPLETED")
        paymentDate = clampDate(addDays(issueDate, randInt(3, 28)));

      const invoiceId = new ObjectId();
      const clientEmbed = {
        id: client._id.toString(),
        type: client.type,
        name: client.name,
        email: client.email,
        address: client.address,
        hasDifferentShippingAddress: false,
        isInternational: false,
        ...(client.type === "COMPANY"
          ? { siret: client.siret, vatNumber: client.vatNumber }
          : { firstName: client.firstName, lastName: client.lastName }),
      };

      let linkedTransactionId = null;
      // Transaction d'encaissement pour les factures payées
      if (status === "COMPLETED" && paymentDate) {
        const txnId = new ObjectId();
        linkedTransactionId = txnId;
        transactionDocs.push({
          _id: txnId,
          externalId: `mock-txn-${orgIdStr.slice(-6)}-pay-${pad(++txnCounter, 5)}`,
          provider: "mock",
          type: "payment",
          status: "completed",
          currency: "EUR",
          workspaceId: orgIdStr,
          userId: userId,
          fromAccount: accountExternalId,
          toAccount: accountExternalId,
          date: paymentDate,
          processedAt: paymentDate,
          amount: totalTTC,
          description: `VIR ${client.name.toUpperCase()} - FACTURE ${number}`,
          category: "Encaissement client",
          linkedInvoiceId: invoiceId,
          reconciliationStatus: "matched",
          reconciliationDate: paymentDate,
          receiptRequired: false,
          receiptFiles: [],
          pcgAccount: {
            numero: "706",
            intitule: "Prestations de services",
            confidence: "high",
            isManual: false,
            manuallySetAt: null,
            manuallySetBy: null,
          },
          deletedAt: null,
          createdAt: paymentDate,
          updatedAt: paymentDate,
        });
      }

      invoiceDocs.push({
        _id: invoiceId,
        prefix,
        number,
        issueDate,
        dueDate,
        issueYear,
        isDeposit: false,
        invoiceType: "standard",
        items,
        client: clientEmbed,
        status,
        paymentMethod: "BANK_TRANSFER",
        ...(paymentDate ? { paymentDate } : {}),
        discount: 0,
        discountType: "FIXED",
        customFields: [],
        showBankDetails: false,
        totalHT,
        totalTTC,
        totalVAT,
        finalTotalHT: totalHT,
        finalTotalVAT: totalVAT,
        finalTotalTTC: totalTTC,
        shipping: {
          billShipping: false,
          shippingAmountHT: 0,
          shippingVatRate: 20,
        },
        isReverseCharge: false,
        clientPositionRight: false,
        retenueGarantie: 0,
        escompte: 0,
        appearance: {
          textColor: "#000000",
          headerTextColor: "#ffffff",
          headerBgColor: "#1d1d1b",
        },
        workspaceId: orgId,
        createdBy: userId,
        linkedTransactionId,
        eInvoiceStatus: "NOT_SENT",
        eInvoiceFlowType: "NONE",
        eReportingStatus: "NOT_REPORTED",
        eReportingPaymentStatus: "NOT_APPLICABLE",
        pennylaneSyncStatus: "NOT_SYNCED",
        createdAt: issueDate,
        updatedAt: paymentDate || issueDate,
      });
    }

    // ----- 3d. Dépenses récurrentes du mois --------------------------------
    const recurring = [
      {
        day: 5,
        label: "PRLV LOYER BUREAUX SCI",
        amount: [620, 720],
        cat: "RENT",
        pcg: ["6132", "Locations immobilières"],
      },
      {
        day: 3,
        label: "CB ABONNEMENT SUITE LOGICIELLE",
        amount: [49, 119],
        cat: "SUBSCRIPTIONS",
        pcg: ["6063", "Fournitures et logiciels"],
      },
      {
        day: 8,
        label: "PRLV FREE PRO TELECOM",
        amount: [29, 55],
        cat: "UTILITIES",
        pcg: ["6262", "Télécommunications"],
      },
      {
        day: 15,
        label: "PRLV URSSAF COTISATIONS",
        amount: [380, 920],
        cat: "TAXES",
        pcg: ["646", "Cotisations sociales exploitant"],
      },
      {
        day: 28,
        label: "FRAIS TENUE DE COMPTE",
        amount: [9, 16],
        cat: "SERVICES",
        pcg: ["627", "Services bancaires"],
      },
    ];
    for (const e of recurring) {
      const date = clampDate(dayInMonth(year, month, e.day));
      if (date < PERIOD_START || date > PERIOD_END) continue;
      newTxn(date, -round2(rand(e.amount[0], e.amount[1])), {
        type: "debit",
        status: "completed",
        description: e.label,
        category: e.label.split(" ").slice(1, 3).join(" "),
        expenseCategory: e.cat,
        pcgAccount: {
          numero: e.pcg[0],
          intitule: e.pcg[1],
          confidence: "high",
          isManual: false,
          manuallySetAt: null,
          manuallySetBy: null,
        },
      });
    }

    // Dépenses ponctuelles (0 à 3 par mois)
    const occasional = [
      {
        label: "CB RESTAURANT CLIENT",
        amount: [18, 65],
        cat: "MEALS",
        pcg: ["6256", "Missions et réceptions"],
      },
      {
        label: "SNCF BILLET TRAIN",
        amount: [40, 160],
        cat: "TRAVEL",
        pcg: ["6251", "Voyages et déplacements"],
      },
      {
        label: "CB FOURNITURES BUREAU",
        amount: [15, 90],
        cat: "OFFICE_SUPPLIES",
        pcg: ["6064", "Fournitures administratives"],
      },
      {
        label: "CB CAMPAGNE ADS",
        amount: [80, 400],
        cat: "MARKETING",
        pcg: ["6231", "Annonces et insertions"],
      },
      {
        label: "CB MATERIEL INFORMATIQUE",
        amount: [120, 900],
        cat: "HARDWARE",
        pcg: ["2183", "Matériel de bureau et informatique"],
      },
    ];
    const nbOcc = randInt(0, 3);
    for (let o = 0; o < nbOcc; o++) {
      const e = pick(occasional);
      const date = clampDate(dayInMonth(year, month, randInt(2, 27)));
      if (date < PERIOD_START || date > PERIOD_END) continue;
      newTxn(date, -round2(rand(e.amount[0], e.amount[1])), {
        type: "debit",
        status: "completed",
        description: e.label,
        category: e.label.split(" ").slice(1).join(" "),
        expenseCategory: e.cat,
        pcgAccount: {
          numero: e.pcg[0],
          intitule: e.pcg[1],
          confidence: "medium",
          isManual: false,
          manuallySetAt: null,
          manuallySetBy: null,
        },
      });
    }
  }

  // ----- 3e. Devis ----------------------------------------------------------
  // Calcul des totaux d'un jeu d'items (remise globale ignorée → final = total)
  const computeTotals = (items) => {
    let ht = 0,
      vat = 0;
    for (const it of items) {
      const lineHT = round2(it.quantity * it.unitPrice);
      ht += lineHT;
      vat += round2(lineHT * (it.vatRate / 100));
    }
    ht = round2(ht);
    vat = round2(vat);
    return { totalHT: ht, totalVAT: vat, totalTTC: round2(ht + vat) };
  };
  const buildItems = () => {
    const n = randInt(1, 3);
    const arr = [];
    for (let k = 0; k < n; k++) {
      const svc = pick(SERVICES);
      const quantity =
        svc.unit === "forfait" || svc.unit === "an" ? 1 : randInt(1, 8);
      arr.push({
        description: svc.label,
        quantity,
        unitPrice: round2(rand(svc.price[0], svc.price[1])),
        vatRate: svc.vat,
        unit: svc.unit,
        discount: 0,
        discountType: "PERCENTAGE",
        details: "",
      });
    }
    return arr;
  };
  const clientEmbedOf = (client) => ({
    id: client._id.toString(),
    type: client.type,
    name: client.name,
    email: client.email,
    address: client.address,
    hasDifferentShippingAddress: false,
    isInternational: false,
    ...(client.type === "COMPANY"
      ? { siret: client.siret, vatNumber: client.vatNumber }
      : { firstName: client.firstName, lastName: client.lastName }),
  });

  const quoteDocs = [];
  const seqQuoteByYear = {};
  for (const { year, month } of months) {
    const nb = randInt(1, 2);
    for (let i = 0; i < nb; i++) {
      const issueDate = clampDate(dayInMonth(year, month, randInt(2, 26)));
      if (issueDate < PERIOD_START || issueDate > PERIOD_END) continue;
      const issueYear = issueDate.getUTCFullYear();
      seqQuoteByYear[issueYear] = (seqQuoteByYear[issueYear] || 0) + 1;
      const seq = seqQuoteByYear[issueYear];
      const client = pick(clients);
      const items = buildItems();
      const t = computeTotals(items);
      const ageDays = (TODAY - issueDate) / 86400000;
      const r = Math.random();
      let status;
      if (ageDays < 12) status = r < 0.2 ? "DRAFT" : "PENDING";
      else status = r < 0.4 ? "COMPLETED" : r < 0.75 ? "PENDING" : "CANCELED";
      quoteDocs.push({
        prefix: `D-${issueYear}${pad(month + 1, 2)}`,
        number: `Q${issueYear}-${pad(seq, 4)}`,
        issueDate,
        validUntil: addDays(issueDate, 30),
        issueYear,
        client: {
          id: client._id.toString(),
          type: client.type,
          name: client.name,
          email: client.email,
          address: client.address,
          hasDifferentShippingAddress: false,
          isInternational: false,
          ...(client.type === "COMPANY"
            ? { siret: client.siret, vatNumber: client.vatNumber }
            : { firstName: client.firstName, lastName: client.lastName }),
        },
        items,
        status,
        discount: 0,
        discountType: "FIXED",
        discountAmount: 0,
        customFields: [],
        totalHT: t.totalHT,
        totalVAT: t.totalVAT,
        totalTTC: t.totalTTC,
        finalTotalHT: t.totalHT,
        finalTotalVAT: t.totalVAT,
        finalTotalTTC: t.totalTTC,
        shipping: {
          billShipping: false,
          shippingAmountHT: 0,
          shippingVatRate: 20,
        },
        isReverseCharge: false,
        clientPositionRight: false,
        retenueGarantie: 0,
        escompte: 0,
        appearance: {
          textColor: "#000000",
          headerTextColor: "#ffffff",
          headerBgColor: "#1d1d1b",
        },
        linkedInvoices: [],
        workspaceId: orgId,
        createdBy: userId,
        pennylaneSyncStatus: "NOT_SYNCED",
        createdAt: issueDate,
        updatedAt: issueDate,
      });
    }
  }

  // ----- 3f. Factures d'achat (fournisseurs) --------------------------------
  const SUPPLIERS = [
    { name: "OVHcloud", code: "OVH", cat: "SERVICES", amount: [15, 45] },
    {
      name: "Google Workspace",
      code: "GW",
      cat: "SUBSCRIPTIONS",
      amount: [12, 28],
    },
    { name: "Adobe Systems", code: "ADB", cat: "SOFTWARE", amount: [60, 75] },
    {
      name: "Free Pro",
      code: "FREE",
      cat: "TELECOMMUNICATIONS",
      amount: [29, 45],
    },
    {
      name: "Cabinet Comptable Léa",
      code: "EC",
      cat: "SERVICES",
      amount: [140, 180],
    },
    { name: "Gerflor Coworking", code: "COW", cat: "RENT", amount: [620, 700] },
  ];
  const purchaseDocs = [];
  let purchaseSeq = 0;
  for (const { year, month } of months) {
    for (const s of SUPPLIERS) {
      const issueDate = clampDate(dayInMonth(year, month, randInt(2, 10)));
      if (issueDate < PERIOD_START || issueDate > PERIOD_END) continue;
      purchaseSeq += 1;
      const ttc = round2(rand(s.amount[0], s.amount[1]));
      const ht = round2(ttc / 1.2);
      const tva = round2(ttc - ht);
      const ageDays = (TODAY - issueDate) / 86400000;
      const r = Math.random();
      let status,
        paymentDate = null;
      if (ageDays < 15) status = r < 0.5 ? "TO_PROCESS" : "TO_PAY";
      else status = r < 0.85 ? "PAID" : "OVERDUE";
      if (status === "PAID")
        paymentDate = clampDate(addDays(issueDate, randInt(2, 20)));
      purchaseDocs.push({
        supplierName: s.name,
        supplierId: null,
        invoiceNumber: `${s.code}-${issueDate.getUTCFullYear()}${pad(month + 1, 2)}-${pad(purchaseSeq, 4)}`,
        issueDate,
        dueDate: addDays(issueDate, 30),
        amountHT: ht,
        amountTVA: tva,
        vatRate: 20,
        amountTTC: ttc,
        currency: "EUR",
        status,
        category: s.cat,
        tags: [],
        files: [],
        ocrMetadata: {},
        ...(paymentDate ? { paymentDate, paymentMethod: "BANK_TRANSFER" } : {}),
        linkedTransactionIds: [],
        isReconciled: false,
        source: "MANUAL",
        eInvoiceStatus: "NOT_APPLICABLE",
        eInvoicePaymentReportStatus: "NOT_APPLICABLE",
        pennylaneSyncStatus: "NOT_SYNCED",
        workspaceId: orgId,
        createdBy: userId,
        createdAt: issueDate,
        updatedAt: paymentDate || issueDate,
      });
    }
  }

  // ----- 3g. Dépenses / notes de frais --------------------------------------
  const EXPENSE_TPL = [
    {
      title: "Restaurant client",
      vendor: "Le Bistrot",
      cat: "MEALS",
      amount: [18, 70],
    },
    {
      title: "Carburant",
      vendor: "TotalEnergies",
      cat: "TRAVEL",
      amount: [40, 90],
    },
    {
      title: "Billet de train",
      vendor: "SNCF",
      cat: "TRAVEL",
      amount: [35, 160],
    },
    {
      title: "Fournitures de bureau",
      vendor: "Bureau Vallée",
      cat: "OFFICE_SUPPLIES",
      amount: [12, 80],
    },
    {
      title: "Abonnement outil SaaS",
      vendor: "Notion",
      cat: "SUBSCRIPTIONS",
      amount: [8, 30],
    },
    {
      title: "Parking & péage",
      vendor: "Vinci Autoroutes",
      cat: "TRAVEL",
      amount: [6, 35],
    },
    {
      title: "Petit matériel",
      vendor: "Amazon",
      cat: "HARDWARE",
      amount: [25, 200],
    },
  ];
  const expenseDocs = [];
  for (const { year, month } of months) {
    const nb = randInt(2, 4);
    for (let i = 0; i < nb; i++) {
      const e = pick(EXPENSE_TPL);
      const date = clampDate(dayInMonth(year, month, randInt(2, 27)));
      if (date < PERIOD_START || date > PERIOD_END) continue;
      const ttc = round2(rand(e.amount[0], e.amount[1]));
      const ht = round2(ttc / 1.2);
      const ageDays = (TODAY - date) / 86400000;
      const status =
        ageDays < 10 ? "PENDING" : Math.random() < 0.85 ? "PAID" : "APPROVED";
      expenseDocs.push({
        title: e.title,
        amount: ttc,
        currency: "EUR",
        category: e.cat,
        date,
        vendor: e.vendor,
        vatAmount: round2(ttc - ht),
        vatRate: 20,
        isVatDeductible: true,
        status,
        paymentMethod: "CREDIT_CARD",
        ...(status === "PAID" ? { paymentDate: date } : {}),
        files: [],
        ocrMetadata: {},
        tags: [],
        expenseType: "ORGANIZATION",
        source: "MANUAL",
        pennylaneSyncStatus: "NOT_SYNCED",
        isReconciled: false,
        workspaceId: orgId,
        createdBy: userId,
        createdAt: date,
        updatedAt: date,
      });
    }
  }

  // ----- 3h. Entrées de prévision manuelles (page Prévision) ----------------
  const cashflowRaw = [
    // Revenu récurrent CROISSANT : +200 €/mois à chaque occurrence → prévisionnel ascendant
    {
      name: "Abonnements clients récurrents (SaaS)",
      type: "INCOME",
      category: "SALES",
      amount: 1800,
      start: "2025-07-01",
      freq: "MONTHLY",
      delta: 200,
      deltaType: "AMOUNT",
    },
    // Nouveau contrat-cadre qui monte en charge : +8 %/mois (composé)
    {
      name: "Contrat-cadre récurrent",
      type: "INCOME",
      category: "SALES",
      amount: 900,
      start: "2025-10-01",
      freq: "MONTHLY",
      delta: 8,
      deltaType: "PERCENT",
    },
    {
      name: "Prime exceptionnelle client",
      type: "INCOME",
      category: "OTHER_INCOME",
      amount: 3000,
      start: "2026-03-15",
      freq: "ONCE",
    },
    {
      name: "Loyer bureaux",
      type: "EXPENSE",
      category: "RENT",
      amount: 680,
      start: "2025-07-01",
      freq: "MONTHLY",
    },
    {
      name: "Salaire alternant",
      type: "EXPENSE",
      category: "SALARIES",
      amount: 1250,
      start: "2025-09-01",
      freq: "MONTHLY",
    },
    {
      name: "Abonnements SaaS (outils)",
      type: "EXPENSE",
      category: "SUBSCRIPTIONS",
      amount: 160,
      start: "2025-07-01",
      freq: "MONTHLY",
    },
    {
      name: "Acompte TVA",
      type: "EXPENSE",
      category: "TAXES",
      amount: 900,
      start: "2025-10-01",
      freq: "QUARTERLY",
    },
    {
      name: "Assurance RC Pro",
      type: "EXPENSE",
      category: "INSURANCE",
      amount: 540,
      start: "2025-12-01",
      freq: "ANNUAL",
    },
  ];
  const cashflowDocs = cashflowRaw.map((c) => ({
    workspaceId: orgId,
    name: c.name,
    type: c.type,
    category: c.category,
    amount: c.amount,
    amountDelta: c.delta || 0,
    amountDeltaType: c.deltaType || "AMOUNT",
    startDate: new Date(c.start + "T00:00:00.000Z"),
    endDate: null,
    frequency: c.freq,
    createdBy: userId,
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
  }));

  // ----- 3i. Virements internes vers le compte épargne ----------------------
  let transferCount = 0;
  for (let mi = 0; mi < months.length; mi++) {
    if (mi % 3 !== 1) continue; // ~tous les 3 mois
    const { year, month } = months[mi];
    const date = clampDate(dayInMonth(year, month, 20));
    if (date < PERIOD_START || date > PERIOD_END) continue;
    const amount = round2(rand(800, 1500));
    transferCount += 1;
    // Débit du compte courant
    transactionDocs.push({
      externalId: `mock-trf-${orgIdStr.slice(-6)}-out-${pad(++txnCounter, 5)}`,
      provider: "mock",
      type: "transfer",
      status: "completed",
      currency: "EUR",
      workspaceId: orgIdStr,
      userId,
      fromAccount: accountExternalId,
      toAccount: savingsExternalId,
      date,
      processedAt: date,
      amount: -amount,
      description: "VIR INTERNE VERS COMPTE EPARGNE",
      category: "Virement interne",
      reconciliationStatus: "matched",
      reconciliationDate: date,
      receiptRequired: false,
      receiptFiles: [],
      deletedAt: null,
      createdAt: date,
      updatedAt: date,
    });
    // Crédit du compte épargne (fromAccount = épargne pour le calcul de solde par compte)
    transactionDocs.push({
      externalId: `mock-trf-${orgIdStr.slice(-6)}-in-${pad(++txnCounter, 5)}`,
      provider: "mock",
      type: "transfer",
      status: "completed",
      currency: "EUR",
      workspaceId: orgIdStr,
      userId,
      fromAccount: savingsExternalId,
      toAccount: savingsExternalId,
      date,
      processedAt: date,
      amount: amount,
      description: "VIR INTERNE DEPUIS COMPTE COURANT",
      category: "Virement interne",
      reconciliationStatus: "matched",
      reconciliationDate: date,
      receiptRequired: false,
      receiptFiles: [],
      deletedAt: null,
      createdAt: date,
      updatedAt: date,
    });
  }

  // ----- 3j. Bons de commande -----------------------------------------------
  const purchaseOrderDocs = [];
  const seqPoByYear = {};
  for (const { year, month } of months) {
    if (Math.random() < 0.4) continue; // pas tous les mois
    const issueDate = clampDate(dayInMonth(year, month, randInt(2, 25)));
    if (issueDate < PERIOD_START || issueDate > PERIOD_END) continue;
    const issueYear = issueDate.getUTCFullYear();
    seqPoByYear[issueYear] = (seqPoByYear[issueYear] || 0) + 1;
    const seq = seqPoByYear[issueYear];
    const client = pick(clients);
    const items = buildItems();
    const t = computeTotals(items);
    const ageDays = (TODAY - issueDate) / 86400000;
    const r = Math.random();
    let status;
    if (ageDays < 15) status = r < 0.4 ? "DRAFT" : "CONFIRMED";
    else
      status =
        r < 0.5
          ? "DELIVERED"
          : r < 0.75
            ? "VALIDATED"
            : r < 0.9
              ? "IN_PROGRESS"
              : "CANCELED";
    purchaseOrderDocs.push({
      prefix: `BC-${issueYear}${pad(month + 1, 2)}`,
      number: `BC${issueYear}-${pad(seq, 4)}`,
      issueDate,
      validUntil: addDays(issueDate, 45),
      deliveryDate: addDays(issueDate, 30),
      issueYear,
      client: clientEmbedOf(client),
      items,
      status,
      discount: 0,
      discountType: "FIXED",
      discountAmount: 0,
      customFields: [],
      showBankDetails: false,
      totalHT: t.totalHT,
      totalVAT: t.totalVAT,
      totalTTC: t.totalTTC,
      finalTotalHT: t.totalHT,
      finalTotalVAT: t.totalVAT,
      finalTotalTTC: t.totalTTC,
      shipping: {
        billShipping: false,
        shippingAmountHT: 0,
        shippingVatRate: 20,
      },
      isReverseCharge: false,
      clientPositionRight: false,
      retenueGarantie: 0,
      escompte: 0,
      appearance: {
        textColor: "#000000",
        headerTextColor: "#ffffff",
        headerBgColor: "#1d1d1b",
      },
      linkedInvoices: [],
      workspaceId: orgId,
      createdBy: userId,
      createdAt: issueDate,
      updatedAt: issueDate,
    });
  }

  // ----- 3k. Avoirs (sur factures payées) -----------------------------------
  const sellerCompany = {
    name: org && org.name ? org.name : "Newbi Démo",
    address: {
      street: "10 rue de la Paix",
      city: "Paris",
      postalCode: "75002",
      country: "France",
    },
    email: "demo@newbi.fr",
    phone: "0145000000",
    siret: "90123456700018",
    vatNumber: "FR90901234567",
    companyStatus: "AUTO_ENTREPRENEUR",
    transactionCategory: "SERVICES",
    vatPaymentCondition: "DEBITS",
  };
  const creditTypes = [
    "CORRECTION",
    "COMMERCIAL_GESTURE",
    "REFUND",
    "STOCK_SHORTAGE",
  ];
  const completedInvoices = invoiceDocs.filter((d) => d.status === "COMPLETED");
  const creditNoteDocs = [];
  const seqCnByYear = {};
  for (const inv of completedInvoices) {
    if (Math.random() > 0.12) continue; // ~12% des factures payées
    const issueDate = clampDate(
      addDays(inv.paymentDate || inv.issueDate, randInt(3, 20)),
    );
    const issueYear = issueDate.getUTCFullYear();
    seqCnByYear[issueYear] = (seqCnByYear[issueYear] || 0) + 1;
    const seq = seqCnByYear[issueYear];
    const ratio = rand(0.2, 0.6);
    const creditHT = -round2(inv.totalHT * ratio);
    const creditVAT = -round2(inv.totalVAT * ratio);
    const creditTTC = round2(creditHT + creditVAT);
    creditNoteDocs.push({
      prefix: `AV-${issueYear}${pad(issueDate.getUTCMonth() + 1, 2)}`,
      number: `AV${issueYear}-${pad(seq, 4)}`,
      originalInvoice: inv._id,
      originalInvoiceNumber: inv.number,
      creditType: pick(creditTypes),
      reason: "Geste commercial / correction",
      issueDate,
      issueYear,
      items: [
        {
          description: "Avoir sur prestation",
          quantity: 1,
          unitPrice: creditHT, // négatif
          vatRate: 20,
          unit: "unité",
          discount: 0,
          discountType: "PERCENTAGE",
        },
      ],
      companyInfo: sellerCompany,
      client: inv.client,
      status: "CREATED",
      refundMethod: "NEXT_INVOICE",
      discount: 0,
      discountType: "FIXED",
      customFields: [],
      showBankDetails: false,
      isReverseCharge: false,
      totalHT: creditHT,
      totalVAT: creditVAT,
      totalTTC: creditTTC,
      finalTotalHT: creditHT,
      finalTotalVAT: creditVAT,
      finalTotalTTC: creditTTC,
      appearance: {
        textColor: "#000000",
        headerTextColor: "#ffffff",
        headerBgColor: "#1d1d1b",
      },
      clientPositionRight: false,
      retenueGarantie: 0,
      escompte: 0,
      workspaceId: orgId,
      createdBy: userId,
      createdAt: issueDate,
      updatedAt: issueDate,
    });
  }

  // ----- 3l. Événements du calendrier ---------------------------------------
  const eventColors = ["sky", "violet", "emerald", "amber", "rose", "orange"];
  const meetingTitles = [
    "Réunion de cadrage",
    "Point d'avancement",
    "Présentation maquette",
    "Appel découverte",
    "Atelier de travail",
    "Revue de livrable",
    "Rendez-vous client",
  ];
  const eventReminder = {
    enabled: false,
    anticipation: null,
    echeance: null,
    sentAt: null,
    status: "pending",
  };
  const eventDocs = [];

  // Échéances de factures (hors brouillon / annulée)
  for (const inv of invoiceDocs) {
    if (inv.status === "DRAFT" || inv.status === "CANCELED") continue;
    eventDocs.push({
      title: `Échéance facture ${inv.prefix}${inv.number}`,
      description: `Facture ${inv.prefix}${inv.number} - ${inv.client.name} - ${inv.finalTotalTTC}€`,
      start: inv.dueDate,
      end: inv.dueDate,
      allDay: true,
      color: inv.status === "COMPLETED" ? "emerald" : "amber",
      type: "INVOICE_DUE",
      source: "newbi",
      visibility: "workspace",
      isReadOnly: false,
      invoiceId: inv._id,
      clientId: inv.client.id ? new ObjectId(inv.client.id) : null,
      workspaceId: orgId,
      userId,
      emailReminder: eventReminder,
      createdAt: inv.issueDate,
      updatedAt: inv.issueDate,
    });
  }

  // Réunions, rappels, deadlines
  for (const { year, month } of months) {
    const nb = randInt(1, 3);
    for (let i = 0; i < nb; i++) {
      const base = dayInMonth(year, month, randInt(2, 27));
      const start = new Date(base);
      start.setUTCHours(randInt(9, 16), pick([0, 30]), 0, 0);
      if (start < PERIOD_START || start > PERIOD_END) continue;
      const end = new Date(start);
      end.setUTCHours(start.getUTCHours() + 1);
      const client = pick(clients);
      const roll = Math.random();
      const kind =
        roll < 0.2 ? "REMINDER" : roll < 0.32 ? "DEADLINE" : "MEETING";
      eventDocs.push({
        title:
          kind === "REMINDER"
            ? `Relance ${client.name}`
            : kind === "DEADLINE"
              ? `Deadline livrable — ${client.name}`
              : `${pick(meetingTitles)} — ${client.name}`,
        description:
          kind === "REMINDER"
            ? "Relancer le client concernant le devis en cours."
            : "",
        start,
        end,
        allDay: kind === "DEADLINE",
        color:
          kind === "REMINDER"
            ? "rose"
            : kind === "DEADLINE"
              ? "orange"
              : pick(eventColors),
        location:
          kind === "MEETING"
            ? pick(["Visioconférence", "Bureau", "Chez le client", "Téléphone"])
            : "",
        type: kind,
        source: "newbi",
        visibility: "workspace",
        isReadOnly: false,
        clientId: client._id,
        workspaceId: orgId,
        userId,
        emailReminder: eventReminder,
        createdAt: start,
        updatedAt: start,
      });
    }
  }

  // ----- 3m. Kanban (tableaux, colonnes, tâches) ----------------------------
  const userIdStr = userId.toString();
  const userName = user.name || user.email || "Démo";
  const startedByObj = { userId: userIdStr, userName, userImage: null };
  const companiesK = clients.filter((c) => c.type === "COMPANY");
  const boardsRaw = [
    {
      title: "Projets clients",
      description: "Suivi global des projets clients en cours",
      emoji: "📁",
      color: "#5b50ff",
      category: "Projets",
      linkClient: null,
      monthStart: 6,
    },
    {
      title: `Refonte site — ${companiesK[0] ? companiesK[0].name : "Client"}`,
      description: "Refonte complète du site vitrine et de l'identité.",
      emoji: "🎨",
      color: "#f59e0b",
      category: "Web",
      linkClient: 0,
      monthStart: 7,
    },
    {
      title: `Développement app — ${companiesK[2] ? companiesK[2].name : "Client"}`,
      description: "Application web de suivi et tableau de bord.",
      emoji: "🛠️",
      color: "#10b981",
      category: "Tech",
      linkClient: 2,
      monthStart: 9,
    },
    {
      title: `Campagne acquisition — ${companiesK[4] ? companiesK[4].name : "Client"}`,
      description: "Campagne marketing multicanale et landing pages.",
      emoji: "📣",
      color: "#ec4899",
      category: "Marketing",
      linkClient: 4,
      monthStart: 12,
    },
    {
      title: "Backlog & amélioration continue",
      description: "Tâches internes, idées et dette technique.",
      emoji: "💡",
      color: "#0ea5e9",
      category: "Interne",
      linkClient: null,
      monthStart: 6,
    },
  ];
  const defaultColumns = [
    { title: "À faire", color: "#8E8E93", order: 0 },
    { title: "En cours", color: "#f59e0b", order: 1 },
    { title: "En attente", color: "#8b5cf6", order: 2 },
    { title: "Terminées", color: "#10b981", order: 3 },
  ];
  const taskTitles = [
    "Maquette page d'accueil",
    "Intégration responsive",
    "Configuration hébergement",
    "Rédaction des contenus",
    "Optimisation SEO",
    "Tests & recette",
    "Mise en ligne",
    "Formation client",
    "Correctifs retours client",
    "Création du logo",
    "Paramétrage analytics",
    "Migration des données",
    "Atelier de cadrage",
    "Wireframes parcours utilisateur",
    "Développement API",
    "Authentification & comptes",
    "Tableau de bord",
    "Notifications email",
    "Intégration paiement",
    "Mise en place CI/CD",
    "Audit accessibilité",
    "Recette client",
    "Rédaction documentation",
    "Préparation démo",
    "Gestion des bugs",
    "Optimisation performances",
    "Maquettes réseaux sociaux",
    "Plan de campagne",
    "Création des visuels",
    "Configuration tracking",
  ];
  const taskDescriptions = [
    "Suivre les retours du client et ajuster en conséquence.",
    "Prévoir une revue avec l'équipe avant livraison.",
    "Vérifier la compatibilité mobile et les performances.",
    "Documenter les choix techniques retenus.",
    "Découper en sous-tâches si nécessaire.",
    "",
    "",
  ];
  const commentTexts = [
    "J'ai avancé sur cette partie, reste la validation.",
    "Le client a confirmé la direction, on continue.",
    "Attention au délai, échéance la semaine prochaine.",
    "Beau travail, on peut passer à l'étape suivante.",
    "Il manque encore les assets définitifs.",
    "Revue faite, quelques ajustements demandés.",
  ];
  const taskTags = [
    {
      name: "Design",
      className: "",
      bg: "#eef2ff",
      text: "#4338ca",
      border: "#c7d2fe",
    },
    {
      name: "Dev",
      className: "",
      bg: "#ecfdf5",
      text: "#047857",
      border: "#a7f3d0",
    },
    {
      name: "SEO",
      className: "",
      bg: "#fff7ed",
      text: "#c2410c",
      border: "#fed7aa",
    },
    {
      name: "Urgent",
      className: "",
      bg: "#fef2f2",
      text: "#b91c1c",
      border: "#fecaca",
    },
    {
      name: "Marketing",
      className: "",
      bg: "#fdf4ff",
      text: "#a21caf",
      border: "#f5d0fe",
    },
    {
      name: "Client",
      className: "",
      bg: "#eff6ff",
      text: "#1d4ed8",
      border: "#bfdbfe",
    },
    {
      name: "Bug",
      className: "",
      bg: "#fef2f2",
      text: "#dc2626",
      border: "#fecaca",
    },
  ];
  const boardDocs = [];
  const columnDocs = [];
  const taskDocs = [];
  for (const b of boardsRaw) {
    const boardId = new ObjectId();
    const createdAt = clampDate(
      dayInMonth(2025, b.monthStart - 1, randInt(2, 10)),
    );
    const boardClient =
      b.linkClient !== null && companiesK[b.linkClient]
        ? companiesK[b.linkClient]
        : null;
    boardDocs.push({
      _id: boardId,
      title: b.title,
      description: b.description,
      clientId: boardClient ? boardClient._id : null,
      workspaceId: orgId,
      userId,
      templateId: null,
      templateName: null,
      priority: pick(["", "low", "medium", "high"]),
      dueDate:
        Math.random() < 0.5 ? addDays(createdAt, randInt(60, 200)) : null,
      members: [userIdStr],
      category: b.category,
      emoji: b.emoji,
      color: b.color,
      status: null,
      favoritedBy: Math.random() < 0.4 ? [userIdStr] : [],
      createdAt,
      updatedAt: createdAt,
    });
    const cols = defaultColumns.map((c) => {
      const colId = new ObjectId();
      columnDocs.push({
        _id: colId,
        title: c.title,
        color: c.color,
        boardId,
        order: c.order,
        workspaceId: orgId,
        userId,
        createdAt,
        updatedAt: createdAt,
      });
      return colId;
    });
    const nbTasks = randInt(11, 18);
    const posByCol = {};
    for (let i = 0; i < nbTasks; i++) {
      const colIdx = randInt(0, cols.length - 1);
      const colIdStr = cols[colIdx].toString();
      posByCol[colIdStr] = posByCol[colIdStr] || 0;
      const start = clampDate(addDays(createdAt, randInt(0, 120)));
      const due = addDays(start, randInt(5, 45));
      const isDone = colIdx === 3;
      const inProgress = colIdx === 1;
      const client =
        boardClient || (Math.random() < 0.5 ? pick(clients) : null);

      // Checklist (0 à 5 items)
      const checklist = [];
      const nbCheck = randInt(0, 5);
      const checkLabels = [
        "Préparer les éléments",
        "Valider avec le client",
        "Faire la revue interne",
        "Mettre à jour la doc",
        "Tester le rendu",
        "Déployer",
      ];
      for (let k = 0; k < nbCheck; k++) {
        checklist.push({
          _id: new ObjectId(),
          text: checkLabels[k],
          completed: isDone || Math.random() < 0.5,
        });
      }

      // Commentaires (0 à 3)
      const comments = [];
      const nbComments = isDone || inProgress ? randInt(0, 3) : randInt(0, 1);
      for (let k = 0; k < nbComments; k++) {
        const cAt = clampDate(addDays(start, randInt(1, 20)));
        comments.push({
          _id: new ObjectId(),
          userId: userIdStr,
          content: pick(commentTexts),
          mentions: [],
          images: [],
          isExternal: false,
          createdAt: cAt,
          updatedAt: cAt,
        });
      }

      // Suivi du temps (entrées réelles pour les tâches en cours / terminées)
      const entries = [];
      let totalSeconds = 0;
      if (isDone || inProgress) {
        const nbEntries = randInt(1, 4);
        for (let k = 0; k < nbEntries; k++) {
          const st = clampDate(addDays(start, randInt(0, 25)));
          const dur = randInt(1800, 21600); // 30 min à 6 h
          totalSeconds += dur;
          entries.push({
            _id: new ObjectId(),
            startTime: st,
            endTime: new Date(st.getTime() + dur * 1000),
            duration: dur,
            isManual: Math.random() < 0.3,
          });
        }
      }

      // Historique d'activité
      const activity = [
        {
          _id: new ObjectId(),
          userId: userIdStr,
          type: "created",
          description: "Tâche créée",
          createdAt: start,
        },
      ];
      if (colIdx > 0) {
        const mAt = clampDate(addDays(start, randInt(1, 15)));
        activity.push({
          _id: new ObjectId(),
          userId: userIdStr,
          type: "moved",
          field: "columnId",
          oldValue: cols[0].toString(),
          newValue: colIdStr,
          description: `Déplacée vers « ${defaultColumns[colIdx].title} »`,
          createdAt: mAt,
        });
      }

      const tags = [];
      const nbTags = randInt(0, 2);
      const tagPool = [...taskTags];
      for (let k = 0; k < nbTags; k++)
        tags.push(tagPool.splice(randInt(0, tagPool.length - 1), 1)[0]);

      const lastUpdate = comments.length
        ? comments[comments.length - 1].createdAt
        : start;
      taskDocs.push({
        title: pick(taskTitles),
        description: pick(taskDescriptions),
        status: colIdStr, // convention app : status === columnId
        priority: pick(["low", "medium", "high", "", "medium", "high"]),
        tags,
        startDate: start,
        dueDate: due,
        boardId,
        columnId: colIdStr,
        position: posByCol[colIdStr]++,
        checklist,
        clientId: client ? client._id : null,
        assignedMembers: Math.random() < 0.75 ? [userIdStr] : [],
        images: [],
        comments,
        activity,
        timeTracking: {
          totalSeconds,
          isRunning: false,
          currentStartTime: null,
          startedBy: entries.length ? startedByObj : null,
          entries,
          hourlyRate: Math.random() < 0.5 ? pick([50, 60, 75, 90]) : undefined,
          roundingOption: "none",
        },
        workspaceId: orgId,
        userId,
        createdAt: start,
        updatedAt: lastUpdate,
      });
    }
  }

  // ----- 3n. Enrichissement de l'activité CRM des clients -------------------
  const invByClient = {};
  for (const inv of invoiceDocs) {
    const cid = inv.client.id;
    if (!cid) continue;
    (invByClient[cid] = invByClient[cid] || []).push(inv);
  }
  const clientUpdates = clients.map((c) => {
    const cid = c._id.toString();
    const activity = [
      {
        id: new ObjectId().toString(),
        type: "created",
        description: "Client créé",
        userId,
        userName,
        userImage: null,
        createdAt: c.createdAt,
      },
    ];
    for (const inv of invByClient[cid] || []) {
      const docNum = `${inv.prefix}${inv.number}`;
      activity.push({
        id: new ObjectId().toString(),
        type: "invoice_created",
        description: `Facture ${docNum} créée`,
        userId,
        userName,
        userImage: null,
        metadata: {
          documentType: "invoice",
          documentId: inv._id.toString(),
          documentNumber: docNum,
          status: inv.status,
        },
        createdAt: inv.issueDate,
      });
      if (inv.status === "COMPLETED") {
        activity.push({
          id: new ObjectId().toString(),
          type: "invoice_status_changed",
          description: `Facture ${docNum} payée`,
          userId,
          userName,
          userImage: null,
          metadata: {
            documentType: "invoice",
            documentId: inv._id.toString(),
            documentNumber: docNum,
            status: "COMPLETED",
          },
          createdAt: inv.paymentDate || inv.issueDate,
        });
      }
    }
    activity.sort((a, b) => a.createdAt - b.createdAt);
    return { _id: c._id, activity };
  });

  // ----- 3o. Transferts de fichiers -----------------------------------------
  const hex = (n) => {
    let s = "";
    for (let i = 0; i < n; i++)
      s += Math.floor(Math.random() * 16).toString(16);
    return s;
  };
  const transferTitles = [
    "Livrables maquettes",
    "Exports HD logo",
    "Photos du shooting",
    "Documents contractuels",
    "Sources du projet",
    "Vidéo promotionnelle",
    "Archives du site",
  ];
  const fileTransferDocs = [];
  let ftSeq = 0;
  for (const { year, month } of months) {
    if (Math.random() < 0.45) continue; // pas tous les mois
    const createdAt = clampDate(dayInMonth(year, month, randInt(2, 26)));
    if (createdAt < PERIOD_START || createdAt > PERIOD_END) continue;
    ftSeq += 1;
    const client = pick(clients);
    const nbFiles = randInt(1, 3);
    const files = [];
    let totalSize = 0;
    for (let f = 0; f < nbFiles; f++) {
      const size = randInt(120000, 18000000);
      totalSize += size;
      const ext = pick(["pdf", "zip", "png", "jpg", "mp4"]);
      files.push({
        originalName: `${pick(["livrable", "export", "source", "visuel", "doc"])}-${f + 1}.${ext}`,
        displayName: null,
        fileName: `${hex(16)}.${ext}`,
        filePath: `transfers/${orgIdStr}/${hex(8)}.${ext}`,
        r2Key: `transfers/${orgIdStr}/${hex(8)}.${ext}`,
        mimeType:
          ext === "pdf"
            ? "application/pdf"
            : ext === "zip"
              ? "application/zip"
              : ext === "mp4"
                ? "video/mp4"
                : `image/${ext}`,
        size,
        storageType: "r2",
        fileId: hex(12),
        uploadedAt: createdAt,
      });
    }
    const expiryDate = addDays(createdAt, randInt(7, 30));
    const expired = expiryDate < TODAY;
    fileTransferDocs.push({
      userId,
      workspaceId: orgIdStr,
      title: pick(transferTitles),
      files,
      totalSize,
      shareLink: `${hex(24)}-${ftSeq}`,
      downloadLink: `${hex(24)}-${ftSeq}`,
      accessKey: hex(20),
      expiryDate,
      downloadCount: expired ? randInt(0, 8) : randInt(0, 3),
      lastDownloadDate: expired ? addDays(createdAt, randInt(1, 6)) : null,
      isPaymentRequired: false,
      paymentAmount: 0,
      paymentCurrency: "EUR",
      isPaid: false,
      status: expired ? "expired" : "active",
      recipientEmail: client.email,
      notificationSent: true,
      notifyOnDownload: Math.random() < 0.5,
      passwordProtected: false,
      allowPreview: true,
      uploadMethod: "direct",
      message: "Bonjour, voici les fichiers convenus. Bonne réception !",
      hasWatermark: false,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // ----- 3p. Documents partagés (avec le comptable) -------------------------
  const sharedDocsRaw = [
    { name: "Relevé bancaire", tag: "banque", status: "classified" },
    { name: "Facture EDF", tag: "énergie", status: "classified" },
    { name: "Contrat de bail bureaux", tag: "juridique", status: "classified" },
    { name: "Attestation URSSAF", tag: "social", status: "pending" },
    { name: "Note de frais déplacement", tag: "frais", status: "pending" },
    {
      name: "Police d'assurance RC Pro",
      tag: "assurance",
      status: "classified",
    },
    { name: "Justificatif achat matériel", tag: "achats", status: "pending" },
    { name: "Bulletin de paie alternant", tag: "paie", status: "archived" },
  ];
  const sharedDocumentDocs = [];
  let sdIdx = 0;
  for (const { year, month } of months) {
    if (Math.random() < 0.4) continue;
    const createdAt = clampDate(dayInMonth(year, month, randInt(2, 26)));
    if (createdAt < PERIOD_START || createdAt > PERIOD_END) continue;
    const tpl = sharedDocsRaw[sdIdx % sharedDocsRaw.length];
    sdIdx += 1;
    const mois = createdAt.toLocaleDateString("fr-FR", {
      month: "long",
      year: "numeric",
    });
    const key = `shared/${orgIdStr}/${hex(12)}.pdf`;
    sharedDocumentDocs.push({
      name: `${tpl.name} — ${mois}`,
      originalName: `${tpl.name.toLowerCase().replace(/[^a-z]/g, "-")}.pdf`,
      description: "",
      fileUrl: `https://files.newbi.fr/${key}`,
      fileKey: key,
      mimeType: "application/pdf",
      fileSize: randInt(80000, 2500000),
      fileExtension: "pdf",
      fileHash: hex(64),
      workspaceId: orgId,
      folderId: null,
      uploadedBy: userId,
      uploadedByName: userName,
      status: tpl.status,
      isSharedWithAccountant: true,
      tags: [tpl.tag],
      comments: [],
      ...(tpl.status === "archived"
        ? { archivedAt: addDays(createdAt, 20) }
        : {}),
      trashedAt: null,
      originalFolderId: null,
      createdAt,
      updatedAt: createdAt,
    });
  }

  // ----- 3q. Signatures email -----------------------------------------------
  const [demoFirst, ...demoRest] = (user.name || "Démo Newbi").split(" ");
  const demoLast = demoRest.join(" ") || "Newbi";
  const orgName = org && org.name ? org.name : "Newbi Démo";
  const baseSignature = (name, isDefault, position, primaryColor) => ({
    signatureName: name,
    isDefault,
    firstName: demoFirst,
    lastName: demoLast,
    position,
    email: user.email,
    phone: "01 45 00 00 00",
    mobile: "06 12 34 56 78",
    website: "https://www.newbi.fr",
    address: "10 rue de la Paix, 75002 Paris",
    companyName: orgName,
    socialNetworks: {
      linkedin: "https://linkedin.com/company/newbi",
      instagram: "",
      facebook: "",
      x: "",
      github: "",
      youtube: "",
    },
    primaryColor,
    layout: "horizontal",
    orientation: "vertical",
    templateId: "template1",
    workspaceId: orgId,
    createdBy: userId,
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
  });
  const emailSignatureDocs = [
    baseSignature("Signature professionnelle", true, "Gérant", "#5b50ff"),
    baseSignature(
      "Signature commerciale",
      false,
      "Responsable commercial",
      "#10b981",
    ),
  ];

  // ----- 3r. Notifications ---------------------------------------------------
  const notificationDocs = [];
  const board0 = boardDocs[0];
  const notifSeeds = [
    {
      type: "TASK_ASSIGNED",
      title: "Nouvelle tâche assignée",
      message: `${userName} vous a assigné à la tâche "${pick(taskTitles)}"`,
      data: {
        taskTitle: pick(taskTitles),
        boardId: board0 ? board0._id : null,
        boardName: board0 ? board0.title : null,
        columnName: "En cours",
        actorId: userId,
        actorName: userName,
        url: "/dashboard/outils/kanban",
      },
    },
    {
      type: "TASK_DUE_SOON",
      title: "Tâche bientôt due",
      message: `La tâche "${pick(taskTitles)}" arrive à échéance.`,
      data: {
        taskTitle: pick(taskTitles),
        boardId: board0 ? board0._id : null,
        boardName: board0 ? board0.title : null,
        url: "/dashboard/outils/kanban",
      },
    },
    {
      type: "TASK_OVERDUE",
      title: "Tâche en retard",
      message: `La tâche "${pick(taskTitles)}" est en retard.`,
      data: {
        taskTitle: pick(taskTitles),
        boardId: board0 ? board0._id : null,
        boardName: board0 ? board0.title : null,
        url: "/dashboard/outils/kanban",
      },
    },
    {
      type: "TASK_COMMENT",
      title: "Nouveau commentaire",
      message: `${userName} a commenté une tâche.`,
      data: {
        taskTitle: pick(taskTitles),
        boardId: board0 ? board0._id : null,
        boardName: board0 ? board0.title : null,
        actorId: userId,
        actorName: userName,
        url: "/dashboard/outils/kanban",
      },
    },
    {
      type: "DOCUMENT_SHARED",
      title: "Document partagé",
      message: "Un nouveau document a été partagé avec le comptable.",
      data: { url: "/dashboard/outils/documents-partages" },
    },
  ];
  // Notifications de factures d'achat reçues (à partir des fournisseurs)
  for (const pi of purchaseDocs.slice(0, 3)) {
    notifSeeds.push({
      type: "PURCHASE_INVOICE_RECEIVED",
      title: "Nouvelle facture reçue",
      message: `${pi.supplierName} vous a transmis la facture ${pi.invoiceNumber}`,
      data: {
        purchaseInvoiceId: pi.invoiceNumber,
        supplierName: pi.supplierName,
        amountTTC: pi.amountTTC,
        url: "/dashboard/outils/factures-achat",
      },
    });
  }
  notifSeeds.forEach((n, i) => {
    const createdAt = clampDate(addDays(TODAY, -randInt(0, 50)));
    const read = i % 3 === 0;
    notificationDocs.push({
      userId,
      workspaceId: orgId,
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data,
      read,
      ...(read ? { readAt: addDays(createdAt, 1) } : {}),
      createdAt,
      updatedAt: createdAt,
    });
  });

  // ----- 3s. Catalogue produits / services ----------------------------------
  const productCategoryOf = (label) => {
    const l = label.toLowerCase();
    if (l.includes("développement") || l.includes("intégration"))
      return "Développement";
    if (l.includes("identité") || l.includes("logo") || l.includes("maquette"))
      return "Design";
    if (
      l.includes("seo") ||
      l.includes("contenu") ||
      l.includes("publicitaire")
    )
      return "Marketing";
    if (l.includes("hébergement") || l.includes("infogérance"))
      return "Hébergement";
    return "Conseil";
  };
  const productDocs = SERVICES.map((s, i) => ({
    name: s.label,
    description: `Prestation : ${s.label.toLowerCase()}.`,
    unitPrice: round2((s.price[0] + s.price[1]) / 2),
    vatRate: s.vat,
    unit: s.unit,
    category: productCategoryOf(s.label),
    reference: `SRV-${pad(i + 1, 3)}`,
    workspaceId: orgId,
    createdBy: userId,
    customFields: [],
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
  }));

  // ----- 3t. Fournisseurs (reliés aux factures d'achat) ---------------------
  const supplierDocs = [];
  const supplierIdByName = {};
  for (const s of SUPPLIERS) {
    const _id = new ObjectId();
    supplierIdByName[s.name] = _id;
    const slug = s.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    supplierDocs.push({
      _id,
      name: s.name,
      email: `contact@${slug}.com`,
      phone: `0${randInt(1, 7)}${pad(randInt(0, 99999999), 8)}`,
      siret: `${randInt(10000, 99999)}${randInt(100000000, 999999999)}`,
      vatNumber: `FR${randInt(10, 99)}${randInt(100000000, 999999999)}`,
      address: {
        street: "1 rue des Fournisseurs",
        city: "Paris",
        postalCode: "75001",
        country: "France",
      },
      iban: "",
      bic: "",
      defaultCategory: s.cat,
      notes: "",
      workspaceId: orgId,
      createdBy: userId,
      createdAt: PERIOD_START,
      updatedAt: PERIOD_START,
    });
  }
  // Backfill : relier chaque facture d'achat à son fournisseur
  for (const pi of purchaseDocs) {
    if (supplierIdByName[pi.supplierName])
      pi.supplierId = supplierIdByName[pi.supplierName];
  }

  // ----- 3u. Listes de clients ----------------------------------------------
  const companies = clients.filter((c) => c.type === "COMPANY");
  const individuals = clients.filter((c) => c.type === "INDIVIDUAL");
  const clientListDocs = [
    {
      name: "Clients VIP",
      description: "Comptes prioritaires",
      color: "#F59E0B",
      icon: "Star",
      clients: companies.slice(0, 3).map((c) => c._id),
    },
    {
      name: "Grands comptes",
      description: "Clients à fort volume",
      color: "#5B50FF",
      icon: "Building",
      clients: companies.slice(3, 6).map((c) => c._id),
    },
    {
      name: "Prospects",
      description: "Contacts à convertir",
      color: "#10B981",
      icon: "UserPlus",
      clients: individuals.map((c) => c._id),
    },
  ].map((l) => ({
    ...l,
    isDefault: false,
    workspaceId: orgId,
    createdBy: userId,
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
  }));

  // ----- 3v. Segments dynamiques de clients ---------------------------------
  const clientSegmentDocs = [
    {
      name: "Entreprises",
      description: "Tous les clients entreprises",
      color: "#8B5CF6",
      icon: "Building2",
      rules: [{ field: "type", operator: "equals", value: "COMPANY" }],
    },
    {
      name: "Particuliers",
      description: "Tous les clients particuliers",
      color: "#EC4899",
      icon: "User",
      rules: [{ field: "type", operator: "equals", value: "INDIVIDUAL" }],
    },
    {
      name: "Clients parisiens",
      description: "Clients situés à Paris",
      color: "#0EA5E9",
      icon: "MapPin",
      rules: [{ field: "address.city", operator: "equals", value: "Paris" }],
    },
    {
      name: "Ajoutés cette année",
      description: "Clients créés sur les 365 derniers jours",
      color: "#22C55E",
      icon: "CalendarClock",
      rules: [{ field: "createdAt", operator: "in_last_days", value: 365 }],
    },
  ].map((s) => ({
    ...s,
    matchType: "all",
    workspaceId: orgId,
    createdBy: userId,
    createdAt: PERIOD_START,
    updatedAt: PERIOD_START,
  }));

  // ----- 4. Insertion -------------------------------------------------------
  if (invoiceDocs.length)
    await db.getCollection("invoices").insertMany(invoiceDocs);
  if (transactionDocs.length)
    await db.getCollection("transactions").insertMany(transactionDocs);
  if (quoteDocs.length) await db.getCollection("quotes").insertMany(quoteDocs);
  if (purchaseDocs.length)
    await db.getCollection("purchaseinvoices").insertMany(purchaseDocs);
  if (expenseDocs.length)
    await db.getCollection("expenses").insertMany(expenseDocs);
  if (cashflowDocs.length)
    await db.getCollection("manualcashflowentries").insertMany(cashflowDocs);
  if (purchaseOrderDocs.length)
    await db.getCollection("purchaseorders").insertMany(purchaseOrderDocs);
  if (creditNoteDocs.length)
    await db.getCollection("creditnotes").insertMany(creditNoteDocs);
  if (eventDocs.length) await db.getCollection("events").insertMany(eventDocs);
  if (boardDocs.length) await db.getCollection("boards").insertMany(boardDocs);
  if (columnDocs.length)
    await db.getCollection("columns").insertMany(columnDocs);
  if (taskDocs.length) await db.getCollection("tasks").insertMany(taskDocs);
  for (const u of clientUpdates) {
    await db
      .getCollection("clients")
      .updateOne({ _id: u._id }, { $set: { activity: u.activity } });
  }
  if (fileTransferDocs.length)
    await db.getCollection("filetransfers").insertMany(fileTransferDocs);
  if (sharedDocumentDocs.length)
    await db.getCollection("shareddocuments").insertMany(sharedDocumentDocs);
  if (emailSignatureDocs.length)
    await db.getCollection("emailsignatures").insertMany(emailSignatureDocs);
  if (notificationDocs.length)
    await db.getCollection("notifications").insertMany(notificationDocs);
  if (productDocs.length)
    await db.getCollection("products").insertMany(productDocs);
  if (supplierDocs.length)
    await db.getCollection("suppliers").insertMany(supplierDocs);
  if (clientListDocs.length)
    await db.getCollection("clientlists").insertMany(clientListDocs);
  if (clientSegmentDocs.length)
    await db.getCollection("clientsegments").insertMany(clientSegmentDocs);

  // ----- 5. Recalcul des soldes par compte ---------------------------------
  const mainTxns = transactionDocs.filter(
    (t) => t.fromAccount === accountExternalId,
  );
  const savTxns = transactionDocs.filter(
    (t) => t.fromAccount === savingsExternalId,
  );
  const finalBalance = round2(
    STARTING_BALANCE + mainTxns.reduce((s, t) => s + t.amount, 0),
  );
  const savBalance = round2(
    SAVINGS_STARTING + savTxns.reduce((s, t) => s + t.amount, 0),
  );
  await db
    .getCollection("accounts_bankings")
    .updateOne(
      { _id: accountId },
      {
        $set: {
          balance: finalBalance,
          "transactionSync.totalTransactions": mainTxns.length,
        },
      },
    );
  await db
    .getCollection("accounts_bankings")
    .updateOne(
      { _id: savingsAccountId },
      {
        $set: {
          balance: savBalance,
          "transactionSync.totalTransactions": savTxns.length,
        },
      },
    );

  // ----- 6. Résumé ----------------------------------------------------------
  const caFactures = invoiceDocs
    .filter((d) => ["PENDING", "OVERDUE", "COMPLETED"].includes(d.status))
    .reduce((s, d) => s + d.finalTotalTTC, 0);
  const nbByStatus = invoiceDocs.reduce(
    (acc, d) => ((acc[d.status] = (acc[d.status] || 0) + 1), acc),
    {},
  );
  const totalIn = transactionDocs
    .filter((t) => t.amount > 0)
    .reduce((s, t) => s + t.amount, 0);
  const totalOut = transactionDocs
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + t.amount, 0);

  const quoteByStatus = quoteDocs.reduce(
    (acc, d) => ((acc[d.status] = (acc[d.status] || 0) + 1), acc),
    {},
  );
  const purchaseByStatus = purchaseDocs.reduce(
    (acc, d) => ((acc[d.status] = (acc[d.status] || 0) + 1), acc),
    {},
  );
  const pendingPayables = purchaseDocs
    .filter((d) => ["TO_PAY", "PENDING", "OVERDUE"].includes(d.status))
    .reduce((s, d) => s + d.amountTTC, 0);

  print("============================================================");
  print(
    `📄 Factures créées      : ${invoiceDocs.length}  ${JSON.stringify(nbByStatus)}`,
  );
  print(
    `💶 CA TTC (hors DRAFT)   : ${round2(caFactures).toLocaleString("fr-FR")} €`,
  );
  print(`💳 Transactions créées   : ${transactionDocs.length}`);
  print(
    `   ↳ Encaissements       : +${round2(totalIn).toLocaleString("fr-FR")} €`,
  );
  print(
    `   ↳ Dépenses            : ${round2(totalOut).toLocaleString("fr-FR")} €`,
  );
  const poByStatus = purchaseOrderDocs.reduce(
    (acc, d) => ((acc[d.status] = (acc[d.status] || 0) + 1), acc),
    {},
  );
  const totalAvoirs = creditNoteDocs.reduce((s, d) => s + d.finalTotalTTC, 0);

  print(`🏦 Solde compte courant  : ${finalBalance.toLocaleString("fr-FR")} €`);
  print(
    `🏦 Solde compte épargne  : ${savBalance.toLocaleString("fr-FR")} €  (${transferCount} virements internes)`,
  );
  print(
    `📝 Devis créés           : ${quoteDocs.length}  ${JSON.stringify(quoteByStatus)}`,
  );
  print(
    `🧾 Factures d'achat      : ${purchaseDocs.length}  ${JSON.stringify(purchaseByStatus)}`,
  );
  print(
    `   ↳ Restant à payer     : ${round2(pendingPayables).toLocaleString("fr-FR")} €`,
  );
  print(`💸 Dépenses créées       : ${expenseDocs.length}`);
  print(`🔮 Entrées prévision     : ${cashflowDocs.length}`);
  print(
    `📋 Bons de commande      : ${purchaseOrderDocs.length}  ${JSON.stringify(poByStatus)}`,
  );
  print(
    `↩️  Avoirs créés          : ${creditNoteDocs.length}  (${round2(totalAvoirs).toLocaleString("fr-FR")} € TTC)`,
  );
  const evtByType = eventDocs.reduce(
    (acc, d) => ((acc[d.type] = (acc[d.type] || 0) + 1), acc),
    {},
  );
  print(
    `📅 Événements créés      : ${eventDocs.length}  ${JSON.stringify(evtByType)}`,
  );
  print(
    `📌 Kanban                : ${boardDocs.length} tableaux / ${columnDocs.length} colonnes / ${taskDocs.length} tâches`,
  );
  print(
    `👤 Activité CRM          : ${clientUpdates.reduce((s, u) => s + u.activity.length, 0)} entrées sur ${clientUpdates.length} clients`,
  );
  const unreadNotif = notificationDocs.filter((n) => !n.read).length;
  print(`📤 Transferts de fichiers: ${fileTransferDocs.length}`);
  print(`📎 Documents partagés    : ${sharedDocumentDocs.length}`);
  print(`✍️  Signatures email      : ${emailSignatureDocs.length}`);
  print(
    `🔔 Notifications         : ${notificationDocs.length}  (${unreadNotif} non lues)`,
  );
  print(`📦 Produits / services   : ${productDocs.length}`);
  print(
    `🏭 Fournisseurs          : ${supplierDocs.length}  (factures d'achat reliées)`,
  );
  print(`📑 Listes clients        : ${clientListDocs.length}`);
  print(`🔎 Segments clients      : ${clientSegmentDocs.length}`);
  print("============================================================");
  print("✅ Seed démo terminé.");
})();
