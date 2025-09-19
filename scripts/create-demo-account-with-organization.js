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
import { Board, Column, Task } from '../src/models/kanban.js';
import EmailSignature from '../src/models/EmailSignature.js';

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

console.log('🚀 Démarrage du script de création de compte démo avec organisation');
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
 * Génère une organisation Better Auth
 */
function generateDemoOrganization(userId) {
  return {
    name: 'Entreprise Démo SARL',
    slug: 'entreprise-demo-sarl',
    logo: null,
    createdBy: userId,
    // Informations d'entreprise mappées depuis l'ancien système
    companyName: 'Entreprise Démo SARL',
    companyEmail: 'contact@demo-entreprise.fr',
    companyPhone: '0123456789',
    website: 'https://www.demo-entreprise.fr',
    siret: '12345678901234',
    vatNumber: 'FR12345678901',
    rcs: 'Paris B 123 456 789',
    legalForm: 'SARL',
    capitalSocial: '10000',
    fiscalRegime: 'DEBITS',
    activityCategory: 'SERVICES',
    isVatSubject: true,
    hasCommercialActivity: true,
    // Adresse (champs aplatis)
    addressStreet: '123 Rue de la Démo',
    addressCity: 'Paris',
    addressZipCode: '75001',
    addressCountry: 'France',
    // Coordonnées bancaires (champs aplatis)
    bankName: 'Banque Démo',
    bankIban: 'FR1420041010050500013M02606',
    bankBic: 'PSSTFRPPPAR',
    showBankDetails: true,
    // Paramètres de document par défaut
    documentTextColor: '#1f2937',
    documentHeaderTextColor: '#ffffff',
    documentHeaderBgColor: '#2563eb',
    documentHeaderNotes: 'Merci de votre confiance',
    documentFooterNotes: 'Entreprise Démo SARL - SIRET: 12345678901234',
    documentTermsAndConditions: 'Paiement à 30 jours fin de mois. Aucun escompte pour paiement anticipé.',
    // Notes séparées pour les devis
    quoteHeaderNotes: 'Devis valable 30 jours',
    quoteFooterNotes: 'Ce devis est valable 30 jours à compter de sa date d\'émission',
    quoteTermsAndConditions: 'Devis valable 30 jours. Acompte de 30% à la commande.',
    // Notes séparées pour les factures
    invoiceHeaderNotes: 'Facture à régler sous 30 jours',
    invoiceFooterNotes: 'Merci pour votre confiance',
    invoiceTermsAndConditions: 'Paiement à 30 jours fin de mois. Pénalités de retard: 3 fois le taux légal.',
  };
}

/**
 * Génère des tableaux kanban factices
 */
function generateDemoKanbanBoards(workspaceId, userId) {
  return [
    {
      title: 'Projets Clients 2024',
      description: 'Suivi des projets clients en cours et à venir',
      workspaceId,
      userId,
    },
    {
      title: 'Développement Produit',
      description: 'Roadmap et fonctionnalités du produit',
      workspaceId,
      userId,
    },
  ];
}

/**
 * Génère des colonnes kanban factices
 */
function generateDemoKanbanColumns(boards, workspaceId, userId) {
  const columns = [];
  
  // Colonnes pour le premier tableau (Projets Clients)
  if (boards[0]) {
    columns.push(
      {
        title: 'À faire',
        color: '#ef4444',
        boardId: boards[0]._id,
        order: 0,
        workspaceId,
        userId,
      },
      {
        title: 'En cours',
        color: '#f59e0b',
        boardId: boards[0]._id,
        order: 1,
        workspaceId,
        userId,
      },
      {
        title: 'En révision',
        color: '#3b82f6',
        boardId: boards[0]._id,
        order: 2,
        workspaceId,
        userId,
      },
      {
        title: 'Terminé',
        color: '#10b981',
        boardId: boards[0]._id,
        order: 3,
        workspaceId,
        userId,
      }
    );
  }

  // Colonnes pour le deuxième tableau (Développement Produit)
  if (boards[1]) {
    columns.push(
      {
        title: 'Backlog',
        color: '#6b7280',
        boardId: boards[1]._id,
        order: 0,
        workspaceId,
        userId,
      },
      {
        title: 'Sprint actuel',
        color: '#8b5cf6',
        boardId: boards[1]._id,
        order: 1,
        workspaceId,
        userId,
      },
      {
        title: 'Tests',
        color: '#f59e0b',
        boardId: boards[1]._id,
        order: 2,
        workspaceId,
        userId,
      },
      {
        title: 'Déployé',
        color: '#10b981',
        boardId: boards[1]._id,
        order: 3,
        workspaceId,
        userId,
      }
    );
  }

  return columns;
}

/**
 * Génère des tâches kanban factices
 */
function generateDemoKanbanTasks(boards, columns, workspaceId, userId) {
  const tasks = [];
  
  if (boards[0] && columns.length >= 4) {
    // Tâches pour le premier tableau (Projets Clients)
    tasks.push(
      {
        title: 'Site web Société ABC',
        description: 'Développement du nouveau site vitrine avec CMS',
        status: 'À faire',
        priority: 'high',
        tags: [
          { name: 'Web', className: 'bg-blue-100 text-blue-800', bg: '#dbeafe', text: '#1e40af', border: '#93c5fd' },
          { name: 'Client', className: 'bg-green-100 text-green-800', bg: '#dcfce7', text: '#166534', border: '#86efac' }
        ],
        dueDate: new Date('2024-12-31'),
        boardId: boards[0]._id,
        columnId: columns[0]._id.toString(),
        position: 0,
        checklist: [
          { text: 'Analyser les besoins client', completed: true },
          { text: 'Créer les maquettes', completed: true },
          { text: 'Développer le frontend', completed: false },
          { text: 'Intégrer le CMS', completed: false },
          { text: 'Tests et validation', completed: false }
        ],
        workspaceId,
        userId,
      },
      {
        title: 'Formation équipe Martin Dupont',
        description: 'Formation sur les nouveaux outils de gestion',
        status: 'En cours',
        priority: 'medium',
        tags: [
          { name: 'Formation', className: 'bg-purple-100 text-purple-800', bg: '#f3e8ff', text: '#7c3aed', border: '#c4b5fd' }
        ],
        dueDate: new Date('2024-11-15'),
        boardId: boards[0]._id,
        columnId: columns[1]._id.toString(),
        position: 0,
        checklist: [
          { text: 'Préparer le contenu', completed: true },
          { text: 'Planifier les sessions', completed: true },
          { text: 'Animer la formation', completed: false }
        ],
        workspaceId,
        userId,
      },
      {
        title: 'Maintenance Tech Solutions',
        description: 'Maintenance mensuelle des serveurs',
        status: 'Terminé',
        priority: 'low',
        tags: [
          { name: 'Maintenance', className: 'bg-gray-100 text-gray-800', bg: '#f3f4f6', text: '#374151', border: '#d1d5db' }
        ],
        boardId: boards[0]._id,
        columnId: columns[3]._id.toString(),
        position: 0,
        checklist: [
          { text: 'Vérifier les serveurs', completed: true },
          { text: 'Mettre à jour les systèmes', completed: true },
          { text: 'Rapport de maintenance', completed: true }
        ],
        workspaceId,
        userId,
      }
    );
  }

  if (boards[1] && columns.length >= 8) {
    // Tâches pour le deuxième tableau (Développement Produit)
    tasks.push(
      {
        title: 'Système de notifications',
        description: 'Implémenter les notifications push et email',
        status: 'Backlog',
        priority: 'medium',
        tags: [
          { name: 'Feature', className: 'bg-indigo-100 text-indigo-800', bg: '#e0e7ff', text: '#3730a3', border: '#a5b4fc' }
        ],
        boardId: boards[1]._id,
        columnId: columns[4]._id.toString(),
        position: 0,
        checklist: [
          { text: 'Spécifications techniques', completed: false },
          { text: 'Design UI/UX', completed: false },
          { text: 'Développement', completed: false }
        ],
        workspaceId,
        userId,
      },
      {
        title: 'Optimisation performances',
        description: 'Améliorer les temps de chargement',
        status: 'Sprint actuel',
        priority: 'high',
        tags: [
          { name: 'Performance', className: 'bg-red-100 text-red-800', bg: '#fee2e2', text: '#991b1b', border: '#fca5a5' }
        ],
        boardId: boards[1]._id,
        columnId: columns[5]._id.toString(),
        position: 0,
        checklist: [
          { text: 'Audit des performances', completed: true },
          { text: 'Optimiser les requêtes', completed: false },
          { text: 'Mise en cache', completed: false }
        ],
        workspaceId,
        userId,
      }
    );
  }

  return tasks;
}

/**
 * Génère des signatures email factices
 */
function generateDemoEmailSignatures(workspaceId, userId) {
  return [
    {
      signatureName: 'Signature Professionnelle',
      isDefault: true,
      firstName: 'Jean',
      lastName: 'Démo',
      position: 'Directeur Général',
      email: 'jean.demo@demo-entreprise.fr',
      phone: '01 23 45 67 89',
      mobile: '06 12 34 56 78',
      website: 'https://www.demo-entreprise.fr',
      address: '123 Rue de la Démo, 75001 Paris',
      companyName: 'Entreprise Démo SARL',
      showPhoneIcon: true,
      showMobileIcon: true,
      showEmailIcon: true,
      showAddressIcon: true,
      showWebsiteIcon: true,
      primaryColor: '#2563eb',
      colors: {
        name: '#2563eb',
        position: '#666666',
        company: '#2563eb',
        contact: '#666666',
        separatorVertical: '#e0e0e0',
        separatorHorizontal: '#e0e0e0',
      },
      nameSpacing: 4,
      nameAlignment: 'left',
      layout: 'horizontal',
      columnWidths: {
        photo: 25,
        content: 75,
      },
      imageSize: 80,
      imageShape: 'round',
      separatorVerticalWidth: 1,
      separatorHorizontalWidth: 1,
      logoSize: 60,
      spacings: {
        global: 8,
        photoBottom: 12,
        logoBottom: 12,
        nameBottom: 8,
        positionBottom: 8,
        companyBottom: 12,
        contactBottom: 6,
        phoneToMobile: 4,
        mobileToEmail: 4,
        emailToWebsite: 4,
        websiteToAddress: 4,
        separatorTop: 12,
        separatorBottom: 12,
      },
      fontFamily: 'Arial, sans-serif',
      fontSize: {
        name: 16,
        position: 14,
        contact: 12,
      },
      workspaceId,
      createdBy: userId,
    },
    {
      signatureName: 'Signature Simple',
      isDefault: false,
      firstName: 'Jean',
      lastName: 'Démo',
      position: 'Directeur Général',
      email: 'jean.demo@demo-entreprise.fr',
      phone: '01 23 45 67 89',
      companyName: 'Entreprise Démo SARL',
      showPhoneIcon: true,
      showMobileIcon: false,
      showEmailIcon: true,
      showAddressIcon: false,
      showWebsiteIcon: false,
      primaryColor: '#1f2937',
      colors: {
        name: '#1f2937',
        position: '#6b7280',
        company: '#1f2937',
        contact: '#6b7280',
        separatorVertical: '#d1d5db',
        separatorHorizontal: '#d1d5db',
      },
      nameSpacing: 4,
      nameAlignment: 'left',
      layout: 'vertical',
      columnWidths: {
        photo: 30,
        content: 70,
      },
      imageSize: 60,
      imageShape: 'square',
      separatorVerticalWidth: 1,
      separatorHorizontalWidth: 1,
      logoSize: 50,
      spacings: {
        global: 6,
        photoBottom: 10,
        logoBottom: 10,
        nameBottom: 6,
        positionBottom: 6,
        companyBottom: 10,
        contactBottom: 4,
        phoneToMobile: 3,
        mobileToEmail: 3,
        emailToWebsite: 3,
        websiteToAddress: 3,
        separatorTop: 10,
        separatorBottom: 10,
      },
      fontFamily: 'Arial, sans-serif',
      fontSize: {
        name: 14,
        position: 12,
        contact: 11,
      },
      workspaceId,
      createdBy: userId,
    },
  ];
}
