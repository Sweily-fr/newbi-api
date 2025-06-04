require('dotenv').config();
const express = require('express');
const { ApolloServer } = require('apollo-server-express');
const mongoose = require('mongoose');
const path = require('path');
const { graphqlUploadExpress } = require('graphql-upload');
const fs = require('fs');
const cors = require('cors');
const stripe = require('./utils/stripe');
const { handleStripeWebhook } = require('./controllers/webhookController');
const { handleStripeWebhook: handleFileTransferStripeWebhook, downloadFile, downloadAllFiles, validatePayment } = require('./controllers/fileTransferController');
const { setupScheduledJobs } = require('./jobs/scheduler');
const logger = require('./utils/logger');

const { authMiddleware } = require('./middlewares/auth');
const typeDefs = require('./schemas');

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connecté à MongoDB'))
  .catch(err => console.error('Erreur de connexion MongoDB:', err));

// Chargement des resolvers
const resolvers = require('./resolvers');

// Assurer que le dossier d'upload existe
const uploadLogoDir = path.resolve(__dirname, '../public/uploads/company-logos');
if (!fs.existsSync(uploadLogoDir)) {
  fs.mkdirSync(uploadLogoDir, { recursive: true });
  console.log('Dossier d\'upload pour logos créé:', uploadLogoDir);
}

// Assurer que le dossier d'upload pour les photos de profil existe
const uploadProfileDir = path.resolve(__dirname, '../public/uploads/profile-pictures');
if (!fs.existsSync(uploadProfileDir)) {
  fs.mkdirSync(uploadProfileDir, { recursive: true });
  console.log('Dossier d\'upload pour photos de profil créé:', uploadProfileDir);
}

// Assurer que le dossier d'upload pour les dépenses existe
const uploadExpensesDir = path.resolve(__dirname, '../public/uploads/expenses');
if (!fs.existsSync(uploadExpensesDir)) {
  fs.mkdirSync(uploadExpensesDir, { recursive: true });
  console.log('Dossier d\'upload pour les dépenses créé:', uploadExpensesDir);
}

// Assurer que le dossier d'upload pour les transferts de fichiers existe
const uploadFileTransfersDir = path.resolve(__dirname, '../public/uploads/file-transfers');
if (!fs.existsSync(uploadFileTransfersDir)) {
  fs.mkdirSync(uploadFileTransfersDir, { recursive: true });
  console.log('Dossier d\'upload pour les transferts de fichiers créé:', uploadFileTransfersDir);
}

async function startServer() {
  const app = express();

  // Configuration CORS pour permettre l'accès aux ressources statiques
  app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:4000', 'https://studio.apollographql.com', process.env.FRONTEND_URL].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'] 
  }));

  // Middleware pour ajouter les en-têtes CORS spécifiques aux images
  app.use('/uploads', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  // Route pour les webhooks Stripe - DOIT être avant express.json() middleware
  app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
    try {
      const signature = req.headers['stripe-signature'];
      
      if (!signature) {
        console.error('Signature Stripe manquante');
        return res.status(400).send('Webhook Error: Signature manquante');
      }
      
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.error('STRIPE_WEBHOOK_SECRET non défini');
        return res.status(500).send('Configuration Error: STRIPE_WEBHOOK_SECRET manquant');
      }
      
      console.log('Signature reçue:', signature);
      console.log('Secret utilisé:', process.env.STRIPE_WEBHOOK_SECRET.substring(0, 5) + '...');
      
      const event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      
      console.log('Événement construit avec succès:', event.type);
      
      const result = await handleStripeWebhook(event);
      console.log('Résultat du traitement:', result);
      
      res.status(200).send({ received: true, result });
    } catch (error) {
      console.error('Erreur webhook Stripe:', error.message);
      res.status(400).send(`Webhook Error: ${error.message}`);
    }
  });
  
  // Route pour les webhooks Stripe des transferts de fichiers
  app.post('/webhook/file-transfer', express.raw({type: 'application/json'}), handleFileTransferStripeWebhook);
  
  // Routes pour le téléchargement de fichiers
  app.get('/file-transfer/download/:shareLink/:accessKey/:fileId', downloadFile);
  app.get('/file-transfer/download-all/:shareLink/:accessKey', downloadAllFiles);
  
  // Route pour valider un paiement de transfert de fichiers
  app.get('/file-transfer/validate-payment', validatePayment);

  app.use(express.static(path.resolve(__dirname, '../public')));
  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ limit: '100mb', extended: true }));
  
  // Middleware pour les uploads GraphQL
  app.use(graphqlUploadExpress({ maxFileSize: 10000000000, maxFiles: 20 })); // 10GB max par fichier, 20 fichiers max

  // Route pour créer une session de portail client Stripe
  app.post('/create-customer-portal-session', async (req, res) => {
    try {
      // Vérifier si l'utilisateur est authentifié
      const token = req.headers.authorization || '';
      const user = await authMiddleware(token);
      
      if (!user) {
        return res.status(401).json({ error: 'Non autorisé' });
      }
      
      // Vérifier si l'utilisateur a un ID client Stripe
      if (!user.subscription?.stripeCustomerId) {
        return res.status(400).json({ error: 'Aucun abonnement Stripe trouvé pour cet utilisateur' });
      }
      
      // Créer une session de portail client
      const session = await stripe.billingPortal.sessions.create({
        customer: user.subscription.stripeCustomerId,
        return_url: process.env.FRONTEND_URL || 'http://localhost:5173',
      });
      
      // Renvoyer l'URL de la session
      res.json({ url: session.url });
    } catch (error) {
      console.error('Erreur lors de la création de la session de portail client:', error);
      res.status(500).json({ error: 'Erreur lors de la création de la session de portail client' });
    }
  });

  // Définir la constante BASE_URL pour l'API
  const BASE_URL = process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;

  // Exporter BASE_URL pour une utilisation dans d'autres modules
  module.exports.BASE_URL = BASE_URL;

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: async ({ req }) => {
      // Ajoute le user au context si authentifié
      const token = req.headers.authorization || '';
      const user = await authMiddleware(token);
      console.log('Contexte créé avec utilisateur:', user ? user.email : 'non authentifié');
      return { user };
    },
    formatError: (error) => {
      console.error(error);
      
      // Extraire les détails de l'erreur originale
      const originalError = error.originalError;
      
      // Si c'est une erreur AppError, utiliser ses propriétés
      if (originalError && originalError.name === 'AppError') {
        return {
          message: originalError.message,
          code: originalError.code,
          details: originalError.details || null,
          path: error.path
        };
      }
      
      // Pour les erreurs de validation GraphQL
      if (error.extensions && error.extensions.code === 'BAD_USER_INPUT') {
        return {
          message: 'Données d\'entrée invalides',
          code: 'VALIDATION_ERROR',
          details: error.extensions.exception.validationErrors || null,
          path: error.path
        };
      }
      
      // Pour les autres erreurs
      return {
        message: error.message,
        code: error.extensions?.code || 'INTERNAL_ERROR',
        path: error.path
      };
    },
    // Résoudre l'avertissement concernant les requêtes persistantes
    cache: 'bounded',
    persistedQueries: {
      ttl: 900 // 15 minutes en secondes
    }
  });

  await server.start();
  server.applyMiddleware({ app, cors: false }); // Désactiver le CORS intégré d'Apollo car nous utilisons notre propre middleware

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}${server.graphqlPath}`);
    
    // Initialiser les jobs planifiés pour la suppression automatique des fichiers expirés
    setupScheduledJobs();
    logger.info('Planificateur de tâches initialisé avec succès');
  });
}

startServer();
