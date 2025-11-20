import { MongoClient, ObjectId } from 'mongodb';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration MongoDB
const MONGODB_URI = "mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin";
const DB_NAME = "newbi";

// Email de l'utilisateur démo
const DEMO_EMAIL = "demo@newbi.fr";

console.log('🚀 Démarrage du script d\'ajout de données de démonstration');
console.log('📧 Utilisateur cible:', DEMO_EMAIL);

let client;
let db;

async function connectToDatabase() {
  console.log('📋 Étape 1: Connexion à MongoDB...');
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    
    // Test de connexion simple
    await db.collection('user').findOne({}, { projection: { _id: 1 } });
    console.log('✅ Connexion MongoDB réussie');
    
    return true;
  } catch (error) {
    console.error('❌ Erreur de connexion MongoDB:', error.message);
    return false;
  }
}

async function findDemoUser() {
  console.log('📋 Étape 2: Recherche de l\'utilisateur démo...');
  
  try {
    // Chercher dans la collection 'user' (Better Auth)
    const user = await db.collection('user').findOne({ email: DEMO_EMAIL });
    
    if (!user) {
      console.error('❌ Utilisateur démo non trouvé dans la collection user');
      return null;
    }
    
    console.log('✅ Utilisateur démo trouvé:', user._id);
    
    // Chercher l'organisation associée
    const member = await db.collection('member').findOne({ userId: user._id });
    
    if (!member) {
      console.error('❌ Aucune relation member trouvée pour l\'utilisateur démo');
      return null;
    }
    
    console.log('✅ Relation member trouvée, organizationId:', member.organizationId);
    
    return {
      userId: user._id,
      workspaceId: member.organizationId,
      user: user
    };
    
  } catch (error) {
    console.error('❌ Erreur lors de la recherche de l\'utilisateur:', error.message);
    return null;
  }
}

async function findDemoClients(workspaceId) {
  console.log('📋 Étape 3: Recherche des clients existants...');
  
  try {
    const clients = await db.collection('clients').find({ 
      workspaceId: workspaceId 
    }).toArray();
    
    console.log(`✅ ${clients.length} clients trouvés pour l'organisation`);
    
    if (clients.length === 0) {
      console.log('⚠️  Aucun client trouvé. Création de clients de démonstration...');
      return await createDemoClients(workspaceId);
    }
    
    return clients;
    
  } catch (error) {
    console.error('❌ Erreur lors de la recherche des clients:', error.message);
    return [];
  }
}

async function createDemoClients(workspaceId) {
  const demoClients = [
    {
      _id: new ObjectId(),
      workspaceId: workspaceId,
      type: 'COMPANY',
      name: 'TechCorp Solutions',
      email: 'contact@techcorp-solutions.fr',
      siret: '12345678901234',
      vatNumber: 'FR12345678901',
      address: {
        street: '15 Avenue des Champs-Élysées',
        city: 'Paris',
        zipCode: '75008',
        country: 'France'
      },
      hasDifferentShippingAddress: false,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    {
      _id: new ObjectId(),
      workspaceId: workspaceId,
      type: 'INDIVIDUAL',
      firstName: 'Marie',
      lastName: 'Dubois',
      name: 'Marie Dubois',
      email: 'marie.dubois@email.fr',
      address: {
        street: '42 Rue de la République',
        city: 'Lyon',
        zipCode: '69002',
        country: 'France'
      },
      hasDifferentShippingAddress: false,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    {
      _id: new ObjectId(),
      workspaceId: workspaceId,
      type: 'COMPANY',
      name: 'Startup Innovante SAS',
      email: 'hello@startup-innovante.com',
      siret: '98765432109876',
      vatNumber: 'FR98765432109',
      address: {
        street: '123 Boulevard de la Tech',
        city: 'Toulouse',
        zipCode: '31000',
        country: 'France'
      },
      hasDifferentShippingAddress: false,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  ];
  
  try {
    await db.collection('clients').insertMany(demoClients);
    console.log('✅ Clients de démonstration créés avec succès');
    return demoClients;
  } catch (error) {
    console.error('❌ Erreur lors de la création des clients:', error.message);
    return [];
  }
}

async function createDemoInvoices(userInfo, clients) {
  console.log('📋 Étape 4: Création des 13 factures de démonstration...');
  
  const companyInfo = {
    name: 'Entreprise Démo SARL',
    email: 'contact@entreprise-demo.fr',
    phone: '01 23 45 67 89',
    website: 'https://entreprise-demo.fr',
    siret: '12345678901234',
    vatNumber: 'FR12345678901',
    logo: 'https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png',
    transactionCategory: 'SERVICES',
    vatPaymentCondition: 'DEBITS',
    companyStatus: 'SARL',
    capitalSocial: '10000',
    rcs: 'Paris B 123 456 789',
    address: {
      fullName: 'Entreprise Démo SARL',
      street: '123 Rue de la Démonstration',
      city: 'Paris',
      postalCode: '75001',
      country: 'France'
    },
    bankDetails: {
      bankName: 'Banque Démo',
      iban: 'FR1420041010050500013M02606',
      bic: 'PSSTFRPPPAR'
    }
  };
  
  const currentDate = new Date();
  const getRandomDate = (daysBack) => new Date(currentDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const getRandomClient = () => clients[Math.floor(Math.random() * clients.length)];
  
  // Services variés pour les factures
  const services = [
    { desc: 'Développement application web', price: 2500, unit: 'forfait', vat: 20 },
    { desc: 'Formation équipe technique', price: 800, unit: 'jour', vat: 20 },
    { desc: 'Consultation stratégique', price: 150, unit: 'heure', vat: 20 },
    { desc: 'Maintenance système', price: 200, unit: 'mois', vat: 20 },
    { desc: 'Audit sécurité informatique', price: 1200, unit: 'forfait', vat: 20 },
    { desc: 'Développement API REST', price: 1800, unit: 'forfait', vat: 20 },
    { desc: 'Migration base de données', price: 900, unit: 'forfait', vat: 20 },
    { desc: 'Support technique', price: 80, unit: 'heure', vat: 20 },
    { desc: 'Hébergement cloud', price: 120, unit: 'mois', vat: 20 },
    { desc: 'Optimisation performances', price: 600, unit: 'forfait', vat: 20 },
    { desc: 'Formation utilisateurs', price: 400, unit: 'jour', vat: 20 },
    { desc: 'Intégration système', price: 1500, unit: 'forfait', vat: 20 },
    { desc: 'Tests et validation', price: 350, unit: 'jour', vat: 20 }
  ];
  
  const statuses = ['COMPLETED', 'PENDING', 'DRAFT', 'CANCELED'];
  const statusWeights = [0.5, 0.3, 0.15, 0.05]; // 50% completed, 30% pending, 15% draft, 5% canceled
  
  const getRandomStatus = () => {
    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < statusWeights.length; i++) {
      cumulative += statusWeights[i];
      if (rand <= cumulative) return statuses[i];
    }
    return 'PENDING';
  };
  
  const demoInvoices = [];
  
  for (let i = 1; i <= 13; i++) {
    const service = services[Math.floor(Math.random() * services.length)];
    const quantity = Math.floor(Math.random() * 5) + 1;
    const discount = Math.random() > 0.7 ? Math.floor(Math.random() * 15) + 5 : 0;
    const status = getRandomStatus();
    const issueDate = getRandomDate(Math.floor(Math.random() * 90)); // 0-90 jours dans le passé
    const client = getRandomClient();
    
    const totalHT = service.price * quantity;
    const discountAmount = discount > 0 ? (totalHT * discount) / 100 : 0;
    const finalTotalHT = totalHT - discountAmount;
    const totalVAT = (finalTotalHT * service.vat) / 100;
    const finalTotalTTC = finalTotalHT + totalVAT;
    
    const invoice = {
      _id: new ObjectId(),
      prefix: 'F-202409',
      number: status === 'DRAFT' ? `DRAFT-${String(i).padStart(6, '0')}-${Date.now() + i}` : String(i).padStart(6, '0'),
      issueDate: issueDate,
      dueDate: new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000),
      executionDate: status === 'COMPLETED' ? new Date(issueDate.getTime() + Math.floor(Math.random() * 10) * 24 * 60 * 60 * 1000) : undefined,
      client: client,
      companyInfo: companyInfo,
      items: [
        {
          description: service.desc,
          quantity: quantity,
          unitPrice: service.price,
          vatRate: service.vat,
          unit: service.unit,
          discount: discount,
          discountType: 'PERCENTAGE',
          details: `Service ${service.desc.toLowerCase()} - Prestation de qualité`
        }
      ],
      status: status,
      paymentMethod: 'BANK_TRANSFER',
      paymentDate: status === 'COMPLETED' ? new Date(issueDate.getTime() + Math.floor(Math.random() * 20 + 5) * 24 * 60 * 60 * 1000) : undefined,
      headerNotes: status === 'DRAFT' ? 'Brouillon en cours de finalisation' : 'Merci pour votre confiance',
      footerNotes: status === 'COMPLETED' ? 'Paiement effectué - Merci !' : 
        status === 'PENDING' ? 'Merci de régler dans les délais impartis.' :
        status === 'CANCELED' ? 'Facture annulée' : 'Brouillon - À finaliser',
      termsAndConditions: 'Conditions générales de vente disponibles sur notre site web.',
      termsAndConditionsLinkTitle: 'Voir nos CGV',
      termsAndConditionsLink: 'https://entreprise-demo.fr/cgv',
      purchaseOrderNumber: Math.random() > 0.7 ? `BC-${String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0')}` : undefined,
      isDeposit: false,
      depositAmount: 0,
      discount: 0,
      discountType: 'FIXED',
      customFields: [],
      showBankDetails: status !== 'DRAFT',
      bankDetails: status !== 'DRAFT' ? companyInfo.bankDetails : undefined,
      totalHT: parseFloat(totalHT.toFixed(2)),
      totalVAT: parseFloat(totalVAT.toFixed(2)),
      totalTTC: parseFloat((totalHT + totalVAT).toFixed(2)),
      finalTotalHT: parseFloat(finalTotalHT.toFixed(2)),
      finalTotalTTC: parseFloat(finalTotalTTC.toFixed(2)),
      workspaceId: userInfo.workspaceId,
      createdBy: userInfo.userId,
      issueYear: issueDate.getFullYear(),
      appearance: {
        textColor: '#000000',
        headerTextColor: '#ffffff',
        headerBgColor: '#1d1d1b'
      },
      shipping: {
        billShipping: false,
        shippingAmountHT: 0,
        shippingVatRate: 20
      },
      createdAt: issueDate,
      updatedAt: issueDate
    };
    
    demoInvoices.push(invoice);
  }
  
  try {
    // Vérifier si des factures existent déjà
    const existingInvoices = await db.collection('invoices').countDocuments({
      workspaceId: userInfo.workspaceId
    });
    
    if (existingInvoices > 0) {
      console.log(`⚠️  ${existingInvoices} factures existent déjà. Suppression...`);
      await db.collection('invoices').deleteMany({
        workspaceId: userInfo.workspaceId
      });
    }
    
    await db.collection('invoices').insertMany(demoInvoices);
    console.log(`✅ ${demoInvoices.length} factures de démonstration créées avec succès`);
    return demoInvoices;
    
  } catch (error) {
    console.error('❌ Erreur lors de la création des factures:', error.message);
    return [];
  }
}

async function createDemoQuotes(userInfo, clients) {
  console.log('📋 Étape 5: Création des 10 devis de démonstration...');
  
  const companyInfo = {
    name: 'Entreprise Démo SARL',
    email: 'contact@entreprise-demo.fr',
    phone: '01 23 45 67 89',
    website: 'https://entreprise-demo.fr',
    siret: '12345678901234',
    vatNumber: 'FR12345678901',
    logo: 'https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png',
    transactionCategory: 'SERVICES',
    vatPaymentCondition: 'DEBITS',
    companyStatus: 'SARL',
    capitalSocial: '10000',
    rcs: 'Paris B 123 456 789',
    address: {
      fullName: 'Entreprise Démo SARL',
      street: '123 Rue de la Démonstration',
      city: 'Paris',
      postalCode: '75001',
      country: 'France'
    }
  };
  
  const currentDate = new Date();
  const getRandomDate = (daysBack) => new Date(currentDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const getRandomClient = () => clients[Math.floor(Math.random() * clients.length)];
  
  // Services variés pour les devis
  const quoteServices = [
    { desc: 'Refonte site web e-commerce', price: 5000, unit: 'forfait', vat: 20 },
    { desc: 'Application mobile iOS/Android', price: 8000, unit: 'forfait', vat: 20 },
    { desc: 'Système de gestion CRM', price: 3500, unit: 'forfait', vat: 20 },
    { desc: 'Plateforme e-learning', price: 6500, unit: 'forfait', vat: 20 },
    { desc: 'API de paiement sécurisé', price: 2800, unit: 'forfait', vat: 20 },
    { desc: 'Dashboard analytique', price: 4200, unit: 'forfait', vat: 20 },
    { desc: 'Système de réservation', price: 3800, unit: 'forfait', vat: 20 },
    { desc: 'Marketplace B2B', price: 9500, unit: 'forfait', vat: 20 },
    { desc: 'Solution IoT connectée', price: 7200, unit: 'forfait', vat: 20 },
    { desc: 'Audit et conseil digital', price: 1500, unit: 'forfait', vat: 20 }
  ];
  
  const quoteStatuses = ['COMPLETED', 'PENDING', 'CANCELED', 'DRAFT'];
  const statusWeights = [0.3, 0.5, 0.15, 0.05]; // 30% completed, 50% pending, 15% canceled, 5% draft
  
  const getRandomQuoteStatus = () => {
    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < statusWeights.length; i++) {
      cumulative += statusWeights[i];
      if (rand <= cumulative) return quoteStatuses[i];
    }
    return 'PENDING';
  };
  
  const demoQuotes = [];
  
  for (let i = 1; i <= 10; i++) {
    const service = quoteServices[Math.floor(Math.random() * quoteServices.length)];
    const quantity = 1; // Les devis sont généralement en forfait
    const discount = Math.random() > 0.6 ? Math.floor(Math.random() * 20) + 5 : 0;
    const status = getRandomQuoteStatus();
    const issueDate = getRandomDate(Math.floor(Math.random() * 60)); // 0-60 jours dans le passé
    const validUntil = new Date(issueDate.getTime() + 30 * 24 * 60 * 60 * 1000); // Valable 30 jours
    const client = getRandomClient();
    
    const totalHT = service.price * quantity;
    const discountAmount = discount > 0 ? (totalHT * discount) / 100 : 0;
    const finalTotalHT = totalHT - discountAmount;
    const totalVAT = (finalTotalHT * service.vat) / 100;
    const finalTotalTTC = finalTotalHT + totalVAT;
    
    const quote = {
      _id: new ObjectId(),
      prefix: 'D-202409',
      number: String(i).padStart(6, '0'),
      issueDate: issueDate,
      validUntil: validUntil,
      client: client,
      companyInfo: companyInfo,
      items: [
        {
          description: service.desc,
          quantity: quantity,
          unitPrice: service.price,
          vatRate: service.vat,
          unit: service.unit,
          discount: discount,
          discountType: 'PERCENTAGE',
          details: `Proposition ${service.desc.toLowerCase()} - Solution sur mesure`
        }
      ],
      status: status,
      headerNotes: status === 'COMPLETED' ? 'Devis accepté - Merci !' : 
        status === 'PENDING' ? 'Proposition commerciale' :
        status === 'CANCELED' ? 'Devis annulé' : 'Brouillon de devis',
      footerNotes: status === 'COMPLETED' ? 'Devis accepté - Merci pour votre confiance !' : 
        status === 'PENDING' ? 'En attente de votre retour.' :
        status === 'CANCELED' ? 'Devis annulé - Contactez-nous pour une nouvelle proposition.' : 'Brouillon en cours de finalisation.',
      termsAndConditions: 'Devis valable 30 jours. Conditions générales disponibles sur demande.',
      termsAndConditionsLinkTitle: 'Voir nos CGV',
      termsAndConditionsLink: 'https://entreprise-demo.fr/cgv',
      discount: 0,
      discountType: 'FIXED',
      customFields: [],
      totalHT: parseFloat(totalHT.toFixed(2)),
      totalVAT: parseFloat(totalVAT.toFixed(2)),
      totalTTC: parseFloat((totalHT + totalVAT).toFixed(2)),
      finalTotalHT: parseFloat(finalTotalHT.toFixed(2)),
      finalTotalTTC: parseFloat(finalTotalTTC.toFixed(2)),
      discountAmount: parseFloat(discountAmount.toFixed(2)),
      workspaceId: userInfo.workspaceId,
      createdBy: userInfo.userId,
      issueYear: issueDate.getFullYear(),
      appearance: {
        textColor: '#000000',
        headerTextColor: '#ffffff',
        headerBgColor: '#1d1d1b'
      },
      shipping: {
        billShipping: false,
        shippingAmountHT: 0,
        shippingVatRate: 20
      },
      createdAt: issueDate,
      updatedAt: issueDate
    };
    
    demoQuotes.push(quote);
  }
  
  try {
    // Vérifier si des devis existent déjà
    const existingQuotes = await db.collection('quotes').countDocuments({
      workspaceId: userInfo.workspaceId
    });
    
    if (existingQuotes > 0) {
      console.log(`⚠️  ${existingQuotes} devis existent déjà. Suppression...`);
      await db.collection('quotes').deleteMany({
        workspaceId: userInfo.workspaceId
      });
    }
    
    await db.collection('quotes').insertMany(demoQuotes);
    console.log(`✅ ${demoQuotes.length} devis de démonstration créés avec succès`);
    return demoQuotes;
    
  } catch (error) {
    console.error('❌ Erreur lors de la création des devis:', error.message);
    return [];
  }
}

async function createDemoCreditNotes(userInfo, clients, invoices) {
  console.log('📋 Étape 6: Création des 5 avoirs de démonstration...');
  
  if (invoices.length === 0) {
    console.log('⚠️  Aucune facture disponible pour créer des avoirs');
    return [];
  }
  
  const companyInfo = {
    name: 'Entreprise Démo SARL',
    email: 'contact@entreprise-demo.fr',
    phone: '01 23 45 67 89',
    website: 'https://entreprise-demo.fr',
    siret: '12345678901234',
    vatNumber: 'FR12345678901',
    logo: 'https://pub-866a54f5560d449cb224411e60410621.r2.dev/Logo_Texte_Black.png',
    transactionCategory: 'SERVICES',
    vatPaymentCondition: 'DEBITS',
    companyStatus: 'SARL',
    capitalSocial: '10000',
    rcs: 'Paris B 123 456 789',
    address: {
      fullName: 'Entreprise Démo SARL',
      street: '123 Rue de la Démonstration',
      city: 'Paris',
      postalCode: '75001',
      country: 'France'
    },
    bankDetails: {
      bankName: 'Banque Démo',
      iban: 'FR1420041010050500013M02606',
      bic: 'PSSTFRPPPAR'
    }
  };
  
  const currentDate = new Date();
  const getRandomDate = (daysBack) => new Date(currentDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
  
  // Types d'avoirs variés
  const creditTypes = ['COMMERCIAL_GESTURE', 'CORRECTION', 'REFUND', 'STOCK_SHORTAGE'];
  const refundMethods = ['NEXT_INVOICE', 'BANK_TRANSFER', 'CHECK', 'VOUCHER'];
  const creditReasons = [
    'Geste commercial suite à un léger retard de livraison',
    'Correction d\'erreur de facturation',
    'Remboursement partiel demandé par le client',
    'Produit non conforme aux spécifications',
    'Annulation partielle de commande'
  ];
  
  // Sélectionner les factures COMPLETED pour créer des avoirs
  const completedInvoices = invoices.filter(inv => inv.status === 'COMPLETED');
  const availableInvoices = completedInvoices.length > 0 ? completedInvoices : invoices.slice(0, 5);
  
  const demoCreditNotes = [];
  
  for (let i = 1; i <= 5; i++) {
    const originalInvoice = availableInvoices[Math.floor(Math.random() * availableInvoices.length)];
    const creditType = creditTypes[Math.floor(Math.random() * creditTypes.length)];
    const refundMethod = refundMethods[Math.floor(Math.random() * refundMethods.length)];
    const reason = creditReasons[Math.floor(Math.random() * creditReasons.length)];
    const issueDate = getRandomDate(Math.floor(Math.random() * 30)); // 0-30 jours dans le passé
    
    // Calculer un montant d'avoir entre 50€ et 500€
    const creditAmount = Math.floor(Math.random() * 450) + 50;
    const totalHT = -creditAmount; // Négatif pour un avoir
    const totalVAT = -(creditAmount * 0.2); // TVA à 20%
    const totalTTC = totalHT + totalVAT;
    
    const creditNote = {
      _id: new ObjectId(),
      prefix: 'AV-202409',
      number: String(i).padStart(6, '0'),
      originalInvoice: originalInvoice._id,
      originalInvoiceNumber: originalInvoice.number,
      creditType: creditType,
      reason: reason,
      issueDate: issueDate,
      executionDate: issueDate,
      client: originalInvoice.client,
      companyInfo: companyInfo,
      items: [
        {
          description: creditType === 'COMMERCIAL_GESTURE' ? 'Geste commercial' :
            creditType === 'CORRECTION' ? 'Correction de facturation' :
            creditType === 'REFUND' ? 'Remboursement' : 'Avoir produit',
          quantity: 1,
          unitPrice: totalHT, // Déjà négatif
          vatRate: 20,
          unit: 'forfait',
          discount: 0,
          discountType: 'PERCENTAGE',
          details: reason
        }
      ],
      status: 'CREATED',
      refundMethod: refundMethod,
      headerNotes: `Avoir n°${String(i).padStart(6, '0')} - ${creditType}`,
      footerNotes: refundMethod === 'NEXT_INVOICE' ? 'Montant à déduire de votre prochaine facture.' :
        refundMethod === 'BANK_TRANSFER' ? 'Remboursement par virement bancaire.' :
        refundMethod === 'CHECK' ? 'Remboursement par chèque.' : 'Avoir sous forme de bon d\'achat.',
      termsAndConditions: 'Cet avoir est valable selon nos conditions générales de vente.',
      termsAndConditionsLinkTitle: 'Voir nos CGV',
      termsAndConditionsLink: 'https://entreprise-demo.fr/cgv',
      discount: 0,
      discountType: 'FIXED',
      customFields: [],
      showBankDetails: refundMethod === 'BANK_TRANSFER',
      bankDetails: refundMethod === 'BANK_TRANSFER' ? companyInfo.bankDetails : undefined,
      shipping: {
        billShipping: false,
        shippingAmountHT: 0,
        shippingVatRate: 20
      },
      // Montants négatifs pour un avoir
      totalHT: parseFloat(totalHT.toFixed(2)),
      totalVAT: parseFloat(totalVAT.toFixed(2)),
      totalTTC: parseFloat(totalTTC.toFixed(2)),
      finalTotalHT: parseFloat(totalHT.toFixed(2)),
      finalTotalTTC: parseFloat(totalTTC.toFixed(2)),
      workspaceId: userInfo.workspaceId,
      createdBy: userInfo.userId,
      issueYear: issueDate.getFullYear(),
      appearance: {
        textColor: '#000000',
        headerTextColor: '#ffffff',
        headerBgColor: '#1d1d1b'
      },
      createdAt: issueDate,
      updatedAt: issueDate
    };
    
    demoCreditNotes.push(creditNote);
  }
  
  try {
    // Vérifier si des avoirs existent déjà
    const existingCreditNotes = await db.collection('creditnotes').countDocuments({
      workspaceId: userInfo.workspaceId
    });
    
    if (existingCreditNotes > 0) {
      console.log(`⚠️  ${existingCreditNotes} avoirs existent déjà. Suppression...`);
      await db.collection('creditnotes').deleteMany({
        workspaceId: userInfo.workspaceId
      });
    }
    
    await db.collection('creditnotes').insertMany(demoCreditNotes);
    console.log(`✅ ${demoCreditNotes.length} avoirs de démonstration créés avec succès`);
    return demoCreditNotes;
    
  } catch (error) {
    console.error('❌ Erreur lors de la création des avoirs:', error.message);
    return [];
  }
}

async function displaySummary(invoices, quotes, creditNotes) {
  console.log('\n📊 RÉSUMÉ DES DONNÉES CRÉÉES');
  console.log('================================');
  console.log(`📄 Factures: ${invoices.length}`);
  invoices.forEach((invoice, index) => {
    console.log(`   ${index + 1}. ${invoice.number} - ${invoice.status} - ${invoice.finalTotalTTC}€`);
  });
  
  console.log(`📋 Devis: ${quotes.length}`);
  quotes.forEach((quote, index) => {
    console.log(`   ${index + 1}. ${quote.number} - ${quote.status} - ${quote.finalTotalTTC}€`);
  });
  
  console.log(`💰 Avoirs: ${creditNotes.length}`);
  creditNotes.forEach((creditNote, index) => {
    console.log(`   ${index + 1}. ${creditNote.number} - ${creditNote.status} - ${creditNote.finalTotalTTC}€`);
  });
  
  console.log('\n✅ Script terminé avec succès !');
  console.log('🎯 Vous pouvez maintenant vous connecter avec demo@newbi.fr pour voir les données');
}

async function main() {
  try {
    // Connexion à la base de données
    const connected = await connectToDatabase();
    if (!connected) {
      process.exit(1);
    }
    
    // Recherche de l'utilisateur démo
    const userInfo = await findDemoUser();
    if (!userInfo) {
      console.error('❌ Impossible de continuer sans utilisateur démo');
      process.exit(1);
    }
    
    // Recherche ou création des clients
    const clients = await findDemoClients(userInfo.workspaceId);
    if (clients.length === 0) {
      console.error('❌ Impossible de continuer sans clients');
      process.exit(1);
    }
    
    // Création des documents
    const invoices = await createDemoInvoices(userInfo, clients);
    const quotes = await createDemoQuotes(userInfo, clients);
    const creditNotes = await createDemoCreditNotes(userInfo, clients, invoices);
    
    // Affichage du résumé
    await displaySummary(invoices, quotes, creditNotes);
    
  } catch (error) {
    console.error('❌ Erreur fatale:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
      console.log('🔌 Connexion MongoDB fermée');
    }
  }
}

// Gestion des signaux pour fermeture propre
process.on('SIGINT', async () => {
  console.log('\n⚠️  Interruption détectée, fermeture propre...');
  if (client) {
    await client.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n⚠️  Terminaison détectée, fermeture propre...');
  if (client) {
    await client.close();
  }
  process.exit(0);
});

// Exécution du script
main().catch(console.error);
