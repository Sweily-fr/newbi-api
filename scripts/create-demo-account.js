import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Configuration ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import des modèles
import User from '../src/models/User.js';
import Client from '../src/models/Client.js';
import Invoice from '../src/models/Invoice.js';
import Quote from '../src/models/Quote.js';
import CreditNote from '../src/models/CreditNote.js';
import Expense from '../src/models/Expense.js';

// Import des constantes
import { INVOICE_STATUS, QUOTE_STATUS, CREDIT_NOTE_STATUS, PAYMENT_METHOD, DISCOUNT_TYPE } from '../src/models/constants/enums.js';

// Configuration MongoDB
let MONGODB_URI;
try {
  const config = await import('../ecosystem.config.cjs');
  MONGODB_URI = config.default.apps[0].env.MONGODB_URI;
} catch (error) {
  MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/newbi-production";
}

console.log('🚀 Démarrage du script de création de compte démo');
console.log('📋 Configuration MongoDB:', MONGODB_URI.replace(/\/\/.*@/, '//***:***@'));

/**
 * Génère des données factices pour un utilisateur démo
 */
function generateDemoUserData() {
  return {
    email: 'demo@newbi.fr',
    password: 'Test_123@', // Sera hashé automatiquement par le middleware
    isEmailVerified: true,
    isDisabled: false,
    subscription: {
      licence: true,
      trial: false,
    },
    profile: {
      firstName: 'Jean',
      lastName: 'Démo',
      phone: '0123456789',
    },
    company: {
      name: 'Entreprise Démo SARL',
      email: 'contact@demo-entreprise.fr',
      phone: '0123456789',
      website: 'https://www.demo-entreprise.fr',
      siret: '12345678901234',
      vatNumber: 'FR12345678901',
      transactionCategory: 'SERVICES',
      vatPaymentCondition: 'DEBITS',
      companyStatus: 'SARL',
      capitalSocial: '10000',
      rcs: 'Paris B 123 456 789',
      address: {
        street: '123 Rue de la Démo',
        city: 'Paris',
        zipCode: '75001',
        country: 'France',
      },
      bankDetails: {
        bankName: 'Banque Démo',
        iban: 'FR1420041010050500013M02606',
        bic: 'PSSTFRPPPAR',
      },
    },
  };
}

/**
 * Génère des clients factices
 */
function generateDemoClients(workspaceId, userId) {
  return [
    {
      name: 'Société ABC',
      email: 'contact@abc-company.fr',
      phone: '0145678901',
      type: 'COMPANY',
      siret: '98765432109876',
      vatNumber: 'FR98765432109',
      address: {
        street: '456 Avenue des Clients',
        city: 'Lyon',
        zipCode: '69001',
        country: 'France',
      },
      shippingAddress: {
        fullName: 'Directeur Général ABC',
        street: '456 Avenue des Clients',
        city: 'Lyon',
        zipCode: '69001',
        country: 'France',
      },
      createdBy: userId,
      workspaceId,
    },
    {
      name: 'Martin Dupont',
      email: 'martin.dupont@email.fr',
      phone: '0156789012',
      type: 'INDIVIDUAL',
      address: {
        street: '789 Rue des Particuliers',
        city: 'Marseille',
        zipCode: '13001',
        country: 'France',
      },
      shippingAddress: {
        fullName: 'Martin Dupont',
        street: '789 Rue des Particuliers',
        city: 'Marseille',
        zipCode: '13001',
        country: 'France',
      },
      createdBy: userId,
      workspaceId,
    },
    {
      name: 'Tech Solutions SAS',
      email: 'info@tech-solutions.fr',
      phone: '0167890123',
      type: 'COMPANY',
      siret: '11223344556677',
      vatNumber: 'FR11223344556',
      address: {
        street: '321 Boulevard de la Tech',
        city: 'Toulouse',
        zipCode: '31000',
        country: 'France',
      },
      shippingAddress: {
        fullName: 'Service Comptabilité',
        street: '321 Boulevard de la Tech',
        city: 'Toulouse',
        zipCode: '31000',
        country: 'France',
      },
      createdBy: userId,
      workspaceId,
    },
  ];
}

/**
 * Génère des articles/services factices
 */
function generateDemoItems() {
  return [
    {
      description: 'Développement site web',
      quantity: 1,
      unitPrice: 2500.00,
      vatRate: 20,
      unit: 'forfait',
      discount: 0,
      discountType: 'PERCENTAGE',
    },
    {
      description: 'Formation utilisateurs',
      quantity: 2,
      unitPrice: 350.00,
      vatRate: 20,
      unit: 'jour',
      discount: 10,
      discountType: 'PERCENTAGE',
    },
    {
      description: 'Maintenance mensuelle',
      quantity: 12,
      unitPrice: 150.00,
      vatRate: 20,
      unit: 'mois',
      discount: 0,
      discountType: 'PERCENTAGE',
    },
  ];
}

/**
 * Génère les informations d'entreprise pour les documents
 */
function generateCompanyInfo() {
  return {
    name: 'Entreprise Démo SARL',
    address: {
      street: '123 Rue de la Démo',
      city: 'Paris',
      zipCode: '75001',
      country: 'France',
    },
    phone: '0123456789',
    email: 'contact@demo-entreprise.fr',
    website: 'https://www.demo-entreprise.fr',
    siret: '12345678901234',
    vatNumber: 'FR12345678901',
    bankDetails: {
      bankName: 'Banque Démo',
      iban: 'FR1420041010050500013M02606',
      bic: 'PSSTFRPPPAR',
    },
    transactionCategory: 'SERVICES',
    vatPaymentCondition: 'DEBITS',
    companyStatus: 'SARL',
    capitalSocial: '10000',
    rcs: 'Paris B 123 456 789',
  };
}

/**
 * Génère des factures factices
 */
function generateDemoInvoices(clients, workspaceId, userId) {
  const items = generateDemoItems();
  const companyInfo = generateCompanyInfo();
  const invoices = [];
  
  // Facture complétée
  invoices.push({
    prefix: 'F-202409-',
    number: '000001',
    issueDate: new Date('2024-09-01'),
    dueDate: new Date('2024-09-30'),
    status: INVOICE_STATUS.COMPLETED,
    client: clients[0],
    companyInfo,
    items: [items[0], items[1]],
    subtotal: 3200.00,
    totalVat: 640.00,
    finalTotalTTC: 3840.00,
    paymentMethod: PAYMENT_METHOD.BANK_TRANSFER,
    footerNotes: 'Merci pour votre confiance !',
    termsAndConditions: 'Paiement à 30 jours fin de mois.',
    workspaceId,
    userId,
    createdBy: userId,
  });

  // Facture en attente
  invoices.push({
    prefix: 'F-202409-',
    number: '000002',
    issueDate: new Date('2024-09-15'),
    dueDate: new Date('2024-10-15'),
    status: INVOICE_STATUS.PENDING,
    client: clients[1],
    companyInfo,
    items: [items[2]],
    subtotal: 1800.00,
    totalVat: 360.00,
    finalTotalTTC: 2160.00,
    paymentMethod: PAYMENT_METHOD.BANK_TRANSFER,
    footerNotes: 'Facture en attente de paiement',
    termsAndConditions: 'Paiement à 30 jours fin de mois.',
    workspaceId,
    userId,
    createdBy: userId,
  });

  // Brouillon de facture
  invoices.push({
    prefix: 'F-202409-',
    number: 'DRAFT-000003-123456',
    issueDate: new Date(),
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    status: INVOICE_STATUS.DRAFT,
    client: clients[2],
    companyInfo,
    items: [items[0]],
    subtotal: 2500.00,
    totalVat: 500.00,
    finalTotalTTC: 3000.00,
    paymentMethod: PAYMENT_METHOD.BANK_TRANSFER,
    footerNotes: 'Brouillon de facture',
    termsAndConditions: 'Conditions à définir.',
    workspaceId,
    userId,
    createdBy: userId,
  });

  return invoices;
}

/**
 * Génère des devis factices
 */
function generateDemoQuotes(clients, workspaceId, userId) {
  const items = generateDemoItems();
  const companyInfo = generateCompanyInfo();
  const quotes = [];

  // Devis accepté
  quotes.push({
    prefix: 'D-202409-',
    number: '000001',
    issueDate: new Date('2024-09-01'),
    validUntil: new Date('2024-10-01'),
    status: QUOTE_STATUS.COMPLETED,
    client: clients[0],
    companyInfo,
    items: [items[0], items[1]],
    subtotal: 3200.00,
    totalVat: 640.00,
    finalTotalTTC: 3840.00,
    footerNotes: 'Devis accepté par le client',
    termsAndConditions: 'Devis valable 30 jours.',
    workspaceId,
    createdBy: userId,
  });

  // Devis en attente
  quotes.push({
    prefix: 'D-202409-',
    number: '000002',
    issueDate: new Date('2024-09-10'),
    validUntil: new Date('2024-10-10'),
    status: QUOTE_STATUS.PENDING,
    client: clients[2],
    companyInfo,
    items: [items[2]],
    subtotal: 1800.00,
    totalVat: 360.00,
    finalTotalTTC: 2160.00,
    footerNotes: 'En attente de validation client',
    termsAndConditions: 'Devis valable 30 jours.',
    workspaceId,
    createdBy: userId,
  });

  return quotes;
}

/**
 * Génère des avoirs factices
 */
function generateDemoCreditNotes(invoices, workspaceId, userId) {
  const creditNotes = [];

  // Avoir sur la première facture
  if (invoices.length > 0) {
    creditNotes.push({
      number: '000001',
      issueDate: new Date('2024-09-20'),
      status: CREDIT_NOTE_STATUS.CREATED,
      reason: 'Remboursement partiel suite à un défaut',
      originalInvoice: invoices[0]._id,
      originalInvoiceNumber: invoices[0].number,
      creditType: 'REFUND',
      client: invoices[0].client,
      companyInfo: invoices[0].companyInfo,
      items: [{
        description: 'Remboursement partiel - Développement site web',
        quantity: 1,
        unitPrice: -500.00,
        vatRate: 20,
        unit: 'forfait',
        discount: 0,
        discountType: 'PERCENTAGE',
      }],
      subtotal: -500.00,
      totalVat: -100.00,
      finalTotalTTC: -600.00,
      footerNotes: 'Avoir émis suite à réclamation client',
      workspaceId,
      userId,
      createdBy: userId,
    });
  }

  return creditNotes;
}

/**
 * Génère des dépenses factices
 */
function generateDemoExpenses(workspaceId, userId) {
  return [
    {
      title: 'Achat matériel informatique',
      description: 'Ordinateur portable pour le développement',
      amount: 1200.00,
      vatAmount: 240.00,
      totalAmount: 1440.00,
      category: 'HARDWARE',
      date: new Date('2024-09-05'),
      paymentMethod: 'CREDIT_CARD',
      vendor: 'TechStore France',
      workspaceId,
      createdBy: userId,
    },
    {
      title: 'Abonnement logiciel',
      description: 'Licence annuelle Adobe Creative Suite',
      amount: 600.00,
      vatAmount: 120.00,
      totalAmount: 720.00,
      category: 'SOFTWARE',
      date: new Date('2024-09-01'),
      paymentMethod: 'BANK_TRANSFER',
      vendor: 'Adobe France',
      workspaceId,
      createdBy: userId,
    },
    {
      title: 'Frais de déplacement',
      description: 'Mission client à Lyon',
      amount: 150.00,
      vatAmount: 30.00,
      totalAmount: 180.00,
      category: 'TRAVEL',
      date: new Date('2024-09-12'),
      paymentMethod: 'CASH',
      vendor: 'SNCF',
      workspaceId,
      createdBy: userId,
    },
  ];
}

/**
 * Script principal
 */
async function createDemoAccount() {
  try {
    // Connexion à MongoDB
    console.log('📋 Étape 1/6 - Connexion à MongoDB...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Connexion MongoDB réussie');

    // Vérifier si l'utilisateur démo existe déjà
    console.log('📋 Étape 2/6 - Vérification utilisateur existant...');
    const existingUser = await User.findOne({ email: 'demo@newbi.fr' });
    if (existingUser) {
      console.log('⚠️  L\'utilisateur démo existe déjà. Suppression des données existantes...');
      
      // Supprimer toutes les données liées à cet utilisateur
      const workspaceId = existingUser._id.toString();
      await Promise.all([
        Client.deleteMany({ workspaceId }),
        Invoice.deleteMany({ workspaceId }),
        Quote.deleteMany({ workspaceId }),
        CreditNote.deleteMany({ workspaceId }),
        Expense.deleteMany({ workspaceId }),
        User.deleteOne({ _id: existingUser._id }),
      ]);
      console.log('✅ Données existantes supprimées');
    }

    // Créer l'utilisateur démo
    console.log('📋 Étape 3/6 - Création utilisateur démo...');
    const userData = generateDemoUserData();
    const demoUser = new User(userData);
    await demoUser.save();
    console.log('✅ Utilisateur démo créé:', demoUser.email);

    const workspaceId = demoUser._id.toString();
    const userId = demoUser._id;

    // Créer les clients factices
    console.log('📋 Étape 4/6 - Création clients factices...');
    const clientsData = generateDemoClients(workspaceId, userId);
    const clients = await Client.insertMany(clientsData);
    console.log(`✅ ${clients.length} clients créés`);

    // Créer les factures factices
    console.log('📋 Étape 5/6 - Création factures factices...');
    const invoicesData = generateDemoInvoices(clients, workspaceId, userId);
    const invoices = await Invoice.insertMany(invoicesData);
    console.log(`✅ ${invoices.length} factures créées`);

    // Créer les devis factices
    console.log('📋 Étape 6/6 - Création devis factices...');
    const quotesData = generateDemoQuotes(clients, workspaceId, userId);
    const quotes = await Quote.insertMany(quotesData);
    console.log(`✅ ${quotes.length} devis créés`);

    // Créer les avoirs factices
    console.log('📋 Création avoirs factices...');
    const creditNotesData = generateDemoCreditNotes(invoices, workspaceId, userId);
    const creditNotes = await CreditNote.insertMany(creditNotesData);
    console.log(`✅ ${creditNotes.length} avoirs créés`);

    // Créer les dépenses factices
    console.log('📋 Création dépenses factices...');
    const expensesData = generateDemoExpenses(workspaceId, userId);
    const expenses = await Expense.insertMany(expensesData);
    console.log(`✅ ${expenses.length} dépenses créées`);

    // Résumé final
    console.log('\n🎉 COMPTE DÉMO CRÉÉ AVEC SUCCÈS !');
    console.log('=====================================');
    console.log(`📧 Email: demo@newbi.fr`);
    console.log(`🔑 Mot de passe: Test_123@`);
    console.log(`👤 Utilisateur: ${demoUser.profile.firstName} ${demoUser.profile.lastName}`);
    console.log(`🏢 Entreprise: ${demoUser.company.name}`);
    console.log(`🆔 Workspace ID: ${workspaceId}`);
    console.log('\n📊 DONNÉES GÉNÉRÉES:');
    console.log(`   • ${clients.length} clients`);
    console.log(`   • ${invoices.length} factures`);
    console.log(`   • ${quotes.length} devis`);
    console.log(`   • ${creditNotes.length} avoirs`);
    console.log(`   • ${expenses.length} dépenses`);
    console.log('\n✨ Le compte démo est prêt à être utilisé !');

  } catch (error) {
    console.error('❌ Erreur lors de la création du compte démo:', error);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('📋 Connexion MongoDB fermée');
  }
}

// Exécution du script
if (import.meta.url === `file://${process.argv[1]}`) {
  createDemoAccount();
}

export default createDemoAccount;
