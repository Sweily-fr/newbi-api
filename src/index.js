import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { ApolloServer } from "apollo-server-express";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { graphqlUploadExpress } from "graphql-upload";

// Recréer __dirname pour ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import fs from "fs";
import cors from "cors";
import stripe from "./utils/stripe.js";
import { handleStripeWebhook } from "./controllers/webhookController.js";
import {
  handleStripeWebhook as handleFileTransferStripeWebhook,
  downloadFile,
  downloadAllFiles,
  validatePayment,
} from "./controllers/fileTransferController.js";
import { setupScheduledJobs } from "./jobs/scheduler.js";
import logger from "./utils/logger.js";

import { betterAuthMiddleware } from "./middlewares/better-auth.js";
import typeDefs from "./schemas/index.js";

// Connexion à MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => logger.info("Connecté à MongoDB"))
  .catch((err) => logger.error("Erreur de connexion MongoDB:", err));

// Chargement des resolvers
import resolvers from "./resolvers/index.js";

// Assurer que le dossier d'upload existe
const uploadLogoDir = path.resolve(
  __dirname,
  "../public/uploads/company-logos"
);
if (!fs.existsSync(uploadLogoDir)) {
  fs.mkdirSync(uploadLogoDir, { recursive: true });
  logger.info(`Dossier d'upload pour logos créé: ${uploadLogoDir}`);
}

// Assurer que le dossier d'upload pour les photos de profil existe
const uploadProfileDir = path.resolve(
  __dirname,
  "../public/uploads/profile-pictures"
);
if (!fs.existsSync(uploadProfileDir)) {
  fs.mkdirSync(uploadProfileDir, { recursive: true });
  logger.info(
    `Dossier d'upload pour photos de profil créé: ${uploadProfileDir}`
  );
}

// Assurer que le dossier d'upload pour les dépenses existe
const uploadExpensesDir = path.resolve(__dirname, "../public/uploads/expenses");
if (!fs.existsSync(uploadExpensesDir)) {
  fs.mkdirSync(uploadExpensesDir, { recursive: true });
  logger.info(`Dossier d'upload pour les dépenses créé: ${uploadExpensesDir}`);
}

// Assurer que le dossier d'upload pour les transferts de fichiers existe
const uploadFileTransfersDir = path.resolve(
  __dirname,
  "../public/uploads/file-transfers"
);
if (!fs.existsSync(uploadFileTransfersDir)) {
  fs.mkdirSync(uploadFileTransfersDir, { recursive: true });
  logger.info(
    `Dossier d'upload pour les transferts de fichiers créé: ${uploadFileTransfersDir}`
  );
}

// Assurer que le dossier temporaire pour les chunks de fichiers existe
const tempChunksDir = path.resolve(__dirname, "../public/uploads/temp-chunks");
if (!fs.existsSync(tempChunksDir)) {
  fs.mkdirSync(tempChunksDir, { recursive: true });
  logger.info(
    `Dossier temporaire pour les chunks de fichiers créé: ${tempChunksDir}`
  );
}

async function startServer() {
  const app = express();

  // Configuration CORS pour permettre l'accès aux ressources statiques
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:4000",
    "https://studio.apollographql.com",
    "https://www.newbi.fr",
    "https://newbi.fr",
    "https://api.newbi.fr",
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  // Configuration CORS pour toutes les routes
  app.use(
    cors({
      origin: function (origin, callback) {
        // Autoriser les requêtes sans origine (comme les applications mobiles ou Postman)
        if (!origin) return callback(null, true);

        // Vérifier si l'origine est dans la liste des origines autorisées
        if (allowedOrigins.indexOf(origin) === -1) {
          const msg = `L'origine ${origin} n'est pas autorisée par CORS`;
          return callback(new Error(msg), false);
        }
        return callback(null, true);
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "Accept", "Range", "apollo-require-preflight"],
      exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Type"],
    })
  );

  // Middleware pour ajouter les en-têtes CORS spécifiques aux fichiers statiques
  app.use("/uploads", (req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Range, apollo-require-preflight"
    );
    res.header(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Length, Content-Type"
    );
    next();
  });

  // Route pour les webhooks Stripe - DOIT être avant express.json() middleware
  app.post(
    "/webhook/stripe",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      try {
        const signature = req.headers["stripe-signature"];

        if (!signature) {
          logger.error("Signature Stripe manquante");
          return res.status(400).send("Webhook Error: Signature manquante");
        }

        if (!process.env.STRIPE_WEBHOOK_SECRET) {
          logger.error("STRIPE_WEBHOOK_SECRET non défini");
          return res
            .status(500)
            .send("Configuration Error: STRIPE_WEBHOOK_SECRET manquant");
        }

        logger.debug(`Signature reçue: ${signature}`);
        logger.debug(
          `Secret utilisé: ${process.env.STRIPE_WEBHOOK_SECRET.substring(0, 5)}...`
        );

        const event = stripe.webhooks.constructEvent(
          req.body,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );

        logger.info(`Événement construit avec succès: ${event.type}`);

        const result = await handleStripeWebhook(event);
        logger.info("Résultat du traitement du webhook:", result);

        res.status(200).send({ received: true, result });
      } catch (error) {
        logger.error(`Erreur webhook Stripe: ${error.message}`, {
          stack: error.stack,
        });
        res.status(400).send(`Webhook Error: ${error.message}`);
      }
    }
  );

  // Route pour les webhooks Stripe des transferts de fichiers
  app.post(
    "/webhook/file-transfer",
    express.raw({ type: "application/json" }),
    handleFileTransferStripeWebhook
  );

  // Middleware pour les routes de téléchargement de fichiers
  const fileTransferRoutes = [
    "/file-transfer/download-file",
    "/file-transfer/download-all",
    "/file-transfer/validate-payment",
  ];

  // Appliquer des en-têtes CORS spécifiques pour les routes de téléchargement
  app.use(fileTransferRoutes, (req, res, next) => {
    res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Range, apollo-require-preflight"
    );
    res.header(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Length, Content-Type"
    );
    res.header("Access-Control-Allow-Credentials", "true");

    // Répondre immédiatement aux requêtes OPTIONS
    if (req.method === "OPTIONS") {
      return res.status(200).end();
    }

    next();
  });

  // Routes pour le téléchargement de fichiers
  app.get("/file-transfer/download-file", downloadFile);
  app.get("/file-transfer/download-all", downloadAllFiles);

  // Route pour valider un paiement de transfert de fichiers
  app.get("/file-transfer/validate-payment", validatePayment);

  // Configuration améliorée pour servir les fichiers statiques avec les bons types MIME
  app.use(
    express.static(path.resolve(__dirname, "../public"), {
      setHeaders: (res, filePath) => {
        // Définir les en-têtes appropriés selon le type de fichier
        const ext = path.extname(filePath).toLowerCase();

        // Ajouter des en-têtes spécifiques pour les types de fichiers courants
        if (ext === ".pdf") {
          res.setHeader("Content-Type", "application/pdf");
        } else if ([".jpg", ".jpeg"].includes(ext)) {
          res.setHeader("Content-Type", "image/jpeg");
        } else if (ext === ".png") {
          res.setHeader("Content-Type", "image/png");
        } else if (ext === ".gif") {
          res.setHeader("Content-Type", "image/gif");
        } else if ([".doc", ".docx"].includes(ext)) {
          res.setHeader("Content-Type", "application/msword");
        } else if ([".xls", ".xlsx"].includes(ext)) {
          res.setHeader("Content-Type", "application/vnd.ms-excel");
        } else if (ext === ".zip") {
          res.setHeader("Content-Type", "application/zip");
        }

        // Ajouter des en-têtes pour permettre le téléchargement
        res.setHeader("Content-Disposition", "attachment");
        res.setHeader("Access-Control-Allow-Origin", "*");
      },
    })
  );
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Middleware pour les uploads GraphQL
  app.use(graphqlUploadExpress({ maxFileSize: 10000000000, maxFiles: 20 })); // 10GB max par fichier, 20 fichiers max

  // Route pour créer une session de portail client Stripe
  app.post("/create-customer-portal-session", async (req, res) => {
    try {
      // Vérifier si l'utilisateur est authentifié
      const user = await betterAuthMiddleware(req);

      if (!user) {
        return res.status(401).json({ error: "Non autorisé" });
      }

      // Vérifier si l'utilisateur a un ID client Stripe
      if (!user.subscription?.stripeCustomerId) {
        return res
          .status(400)
          .json({
            error: "Aucun abonnement Stripe trouvé pour cet utilisateur",
          });
      }

      // Créer une session de portail client
      const session = await stripe.billingPortal.sessions.create({
        customer: user.subscription.stripeCustomerId,
        return_url: process.env.FRONTEND_URL || "http://localhost:5173",
      });

      // Renvoyer l'URL de la session
      res.json({ url: session.url });
    } catch (error) {
      console.error(
        "Erreur lors de la création de la session de portail client:",
        error
      );
      res
        .status(500)
        .json({
          error: "Erreur lors de la création de la session de portail client",
        });
    }
  });

  // Définir la constante BASE_URL pour l'API
  const BASE_URL =
    process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`;

  // On n'exporte pas BASE_URL car nous sommes dans un module principal

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: async ({ req }) => {
      // Ajoute le user au context si authentifié
      const user = await betterAuthMiddleware(req);
      console.log(
        "Contexte créé avec utilisateur:",
        user ? user.email : "non authentifié"
      );
      return { user };
    },
    formatError: (error) => {
      console.error(error);

      // Extraire les détails de l'erreur originale
      const originalError = error.originalError;

      // Si c'est une erreur AppError, utiliser ses propriétés
      if (originalError && originalError.name === "AppError") {
        return {
          message: originalError.message,
          code: originalError.code,
          details: originalError.details || null,
          path: error.path,
        };
      }

      // Pour les erreurs de validation GraphQL
      if (error.extensions && error.extensions.code === "BAD_USER_INPUT") {
        return {
          message: "Données d'entrée invalides",
          code: "VALIDATION_ERROR",
          details: error.extensions.exception.validationErrors || null,
          path: error.path,
        };
      }

      // Pour les autres erreurs
      return {
        message: error.message,
        code: error.extensions?.code || "INTERNAL_ERROR",
        path: error.path,
      };
    },
    // Résoudre l'avertissement concernant les requêtes persistantes
    cache: "bounded",
    persistedQueries: {
      ttl: 900, // 15 minutes en secondes
    },
  });

  await server.start();
  server.applyMiddleware({ app, cors: false }); // Désactiver le CORS intégré d'Apollo car nous utilisons notre propre middleware

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(
      `🚀 Serveur démarré sur http://localhost:${PORT}${server.graphqlPath}`
    );

    // Initialiser les jobs planifiés pour la suppression automatique des fichiers expirés
    setupScheduledJobs();
    logger.info("Planificateur de tâches initialisé avec succès");
  });
}

startServer();
