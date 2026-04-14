import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// Configuration des chemins (doit être avant dotenv.config)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Charger le fichier .env selon l'environnement
const envFile =
  process.env.NODE_ENV === "production"
    ? ".env.production"
    : process.env.NODE_ENV === "staging"
      ? ".env.staging"
      : ".env";

const envPath = path.resolve(process.cwd(), envFile);
dotenv.config({ path: envPath });

console.log(`🌍 Environnement: ${process.env.NODE_ENV || "development"}`);
console.log(`📄 Fichier .env chargé: ${envFile}`);

// Handlers globaux pour éviter les crashes silencieux
process.on("unhandledRejection", (reason, promise) => {
  console.error("⚠️  Unhandled Promise Rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("⚠️  Uncaught Exception:", error.message);
  // Ne pas process.exit() pour garder le serveur en vie
  // Sauf si l'erreur est vraiment critique (ex: out of memory)
  if (
    error.message?.includes("ENOMEM") ||
    error.message?.includes("allocation failed")
  ) {
    process.exit(1);
  }
});

import express from "express";
import { ApolloServer } from "apollo-server-express";
import { createServer } from "http";
import { execute, subscribe } from "graphql";
import { SubscriptionServer } from "subscriptions-transport-ws";
import { makeExecutableSchema } from "@graphql-tools/schema";
import depthLimit from "graphql-depth-limit";
import { createDataLoaders } from "./dataloaders/index.js";
import mongoose from "mongoose";
import { graphqlUploadExpress } from "graphql-upload";
import fs from "fs";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import stripe from "./utils/stripe.js";
import {
  handleStripeWebhook as handleFileTransferStripeWebhook,
  downloadFile,
  downloadAllFiles,
  validatePayment,
} from "./controllers/fileTransferController.js";
import { setupScheduledJobs } from "./jobs/scheduler.js";
import logger from "./utils/logger.js";
import {
  betterAuthJWTMiddleware,
  validateJWT,
} from "./middlewares/better-auth-jwt.js";
import { betterAuthMiddleware } from "./middlewares/better-auth.js";
import { initializeRedis, closeRedis } from "./config/redis.js";
import typeDefs from "./schemas/index.js";
import resolvers from "./resolvers/index.js";
import webhookRoutes from "./routes/webhook.js";
// DÉSACTIVÉ: SuperPDP API pas encore active
// import superPdpWebhookRoutes from "./routes/superPdpWebhook.js";
import fileTransferAuthRoutes from "./routes/fileTransferAuth.js";
import fileDownloadRoutes from "./routes/fileDownload.js";
import cleanupAdminRoutes from "./routes/cleanupAdmin.js";
import bankingRoutes from "./routes/banking.js";
import bankingConnectRoutes from "./routes/banking-connect.js";
import bankingSyncRoutes from "./routes/banking-sync.js";
import bankingCacheRoutes from "./routes/banking-cache.js";
import reconciliationRoutes from "./routes/reconciliation.js";
// DÉSACTIVÉ: SuperPDP API pas encore active
// import superpdpOAuthRoutes from "./routes/superpdp-oauth.js";
import sharedDocumentDownloadRoutes from "./routes/sharedDocumentDownload.js";
import calendarConnectRoutes from "./routes/calendar-connect.js";
import calendarWebhookRoutes from "./routes/calendar-webhooks.js";
import gmailConnectRoutes from "./routes/gmail-connect.js";
import guideLeadsRoutes from "./routes/guideLeads.js";
import esignatureWebhookRoutes from "./routes/esignature-webhook.js";
import emailTrackingRoutes from "./routes/emailTracking.js";
import resendWebhookRoutes from "./routes/resendWebhook.js";
import { initializeBankingSystem } from "./services/banking/index.js";
import emailReminderScheduler from "./services/emailReminderScheduler.js";
import { startInvoiceReminderCron } from "./cron/invoiceReminderCron.js";
import { startRecurringInvoiceDetectionCron } from "./cron/recurringInvoiceDetectionCron.js";
import { startCrmEmailAutomationCron } from "./cron/crmEmailAutomationCron.js";
import { startCalendarSyncCron } from "./cron/calendarSyncCron.js";
import { startCalendarWebhookRenewalCron } from "./cron/calendarWebhookRenewalCron.js";
import { startGmailSyncCron } from "./cron/gmailSyncCron.js";
import { startOverdueAutomationCron } from "./cron/overdueAutomationCron.js";
import fileTransferReminderService from "./services/fileTransferReminderService.js";
import Event from "./models/Event.js";

// Connexion à MongoDB — pool réduit car 4 instances PM2 (4 × 5 = 20 connexions max)
mongoose
  .connect(process.env.MONGODB_URI, {
    maxPoolSize: 5,
    minPoolSize: 1,
    maxIdleTimeMS: 30000,
    serverSelectionTimeoutMS: 5000,
  })
  .then(async () => {
    logger.info("Connecté à MongoDB (pool: 1-5 connexions)");

    // Nettoyage des anciens index obsolètes qui ne sont plus dans les schémas
    // Mongoose ne supprime pas automatiquement les index retirés du code
    const legacyIndexes = [
      { collection: "quotes", index: "workspaceId_1_number_1" },
      { collection: "quotes", index: "number_1_createdBy_1" },
    ];

    for (const { collection, index } of legacyIndexes) {
      try {
        await mongoose.connection.db.collection(collection).dropIndex(index);
        logger.info(`Index obsolète supprimé: ${collection}.${index}`);
      } catch (err) {
        // L'index n'existe pas ou a déjà été supprimé — on ignore
        if (err.codeName !== "IndexNotFound") {
          logger.warn(
            `Impossible de supprimer l'index ${collection}.${index}:`,
            err.message,
          );
        }
      }
    }
  })
  .catch((err) => logger.error("Erreur de connexion MongoDB:", err));

// Création des dossiers nécessaires
const createDirectory = (dirPath, dirName) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    logger.info(`Dossier ${dirName} créé: ${dirPath}`);
  }
};

// Liste des dossiers à créer
const directories = [
  {
    path: path.resolve(__dirname, "./public/uploads/company-logos"),
    name: "logos",
  },
  {
    path: path.resolve(__dirname, "./public/uploads/profile-pictures"),
    name: "photos de profil",
  },
  {
    path: path.resolve(__dirname, "./public/uploads/expenses"),
    name: "dépenses",
  },
  {
    path: path.resolve(__dirname, "./public/uploads/file-transfers"),
    name: "transferts de fichiers",
  },
  {
    path: path.resolve(__dirname, "./public/uploads/temp-chunks"),
    name: "fragments temporaires",
  },
];

directories.forEach(({ path: dirPath, name }) =>
  createDirectory(dirPath, name),
);

// Configuration du serveur
async function startServer() {
  const app = express();

  // Trust proxy (nginx) pour obtenir la vraie IP client via X-Forwarded-For
  app.set("trust proxy", 1);

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Managed separately or by frontend
      crossOriginEmbedderPolicy: false, // Needed for GraphQL playground
    }),
  );

  // Global rate limiter
  const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // limit each IP to 1000 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use(globalLimiter);

  // Strict rate limiter for auth routes
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20, // strict limit for auth
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Too many authentication attempts, please try again later.",
    },
  });
  app.use("/api/auth", authLimiter);

  // Configuration CORS
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001", // Espace partenaire
    "http://localhost:4000",
    "https://studio.apollographql.com",
    "https://www.newbi.fr",
    "https://newbi.fr",
    "https://api.newbi.fr",
    "https://newbi-v2.vercel.app",
    "https://newbi-v2-git-develop-sofianemtimet6-2653s-projects.vercel.app",
    "https://staging-api.newbi.fr",
    process.env.FRONTEND_URL,
    process.env.PARTNER_FRONTEND_URL,
  ].filter(Boolean);

  // Dev: autoriser ngrok et cloudflare tunnels
  if (process.env.NODE_ENV !== "production") {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (
        origin &&
        (origin.includes("ngrok") || origin.includes("trycloudflare.com"))
      ) {
        allowedOrigins.push(origin);
      }
      next();
    });
  }

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, true);
        } else {
          callback(new Error(`Origine non autorisée: ${origin}`));
        }
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "Range",
        "apollo-require-preflight",
        "x-workspace-id",
        "x-organization-id", // Nouveau: ID de l'organisation
        "x-user-role", // Nouveau: Rôle de l'utilisateur
      ],
      exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Type"],
    }),
  );

  // Webhook pour les transferts de fichiers (DOIT être AVANT les autres routes /webhook)
  app.post(
    "/webhook/file-transfer",
    express.raw({ type: "application/json" }),
    handleFileTransferStripeWebhook,
  );

  // Routes webhook (avant les middlewares JSON)
  app.use("/webhook", webhookRoutes);

  // DÉSACTIVÉ: SuperPDP API pas encore active
  // Webhook SuperPDP pour la facturation électronique
  // app.use("/webhook/superpdp", superPdpWebhookRoutes);

  // Webhook eSignature
  app.use("/api/esignature/webhook", esignatureWebhookRoutes);

  // Webhook Resend pour le tracking d'ouverture d'email
  app.use("/webhook/resend", resendWebhookRoutes);

  // Middleware pour les uploads
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Routes file transfer auth
  app.use("/api/transfers", fileTransferAuthRoutes);

  // Routes file download proxy
  app.use("/api/files", fileDownloadRoutes);

  // Routes admin cleanup (nécessite authentification)
  app.use("/api/admin", validateJWT, cleanupAdminRoutes);

  // Routes banking (authentification gérée par betterAuthMiddleware dans chaque route)
  app.use("/banking", bankingRoutes); // Auth via betterAuthMiddleware dans chaque route
  app.use("/banking-connect", bankingConnectRoutes); // Auth via betterAuthMiddleware
  app.use("/banking-sync", bankingSyncRoutes); // Auth via betterAuthMiddleware dans chaque route
  app.use("/banking-cache", bankingCacheRoutes); // Gestion du cache bancaire
  app.use("/reconciliation", reconciliationRoutes); // Rapprochement factures/transactions

  // DÉSACTIVÉ: SuperPDP API pas encore active
  // Routes OAuth SuperPDP (facturation électronique)
  // app.use("/api/superpdp", superpdpOAuthRoutes);

  // Routes téléchargement documents partagés (ZIP dossiers)
  app.use("/api/shared-documents", sharedDocumentDownloadRoutes);

  // Routes connexion calendriers externes (OAuth Google/Microsoft)
  app.use("/calendar-connect", calendarConnectRoutes);

  // Routes webhooks calendriers (Google/Microsoft push notifications)
  app.use("/calendar-webhooks", calendarWebhookRoutes);

  // Routes connexion Gmail pour import factures fournisseurs
  app.use("/gmail-connect", gmailConnectRoutes);

  // Routes leads guides (publique, sans auth)
  app.use("/api/leads", guideLeadsRoutes);

  // Routes tracking d'ouverture d'email (publique, sans auth)
  app.use("/tracking", emailTrackingRoutes);

  app.use(graphqlUploadExpress({ maxFileSize: 104857600, maxFiles: 20 }));

  // DEBUG: Log les requêtes GraphQL qui retournent 400
  app.use("/graphql", (req, res, next) => {
    const originalSend = res.send;
    res.send = function (body) {
      if (res.statusCode === 400) {
        console.error("⚠️ [DEBUG 400] Requête GraphQL retournant 400:");
        console.error(
          "  Body reçu:",
          JSON.stringify(req.body)?.substring(0, 500),
        );
        console.error(
          "  Réponse:",
          typeof body === "string"
            ? body.substring(0, 500)
            : JSON.stringify(body)?.substring(0, 500),
        );
      }
      return originalSend.call(this, body);
    };
    next();
  });

  // Autres routes API
  setupRoutes(app);

  // Créer le schéma GraphQL exécutable
  const schema = makeExecutableSchema({
    typeDefs,
    resolvers,
  });

  // Configuration Apollo Server
  const server = new ApolloServer({
    schema,
    // Limiter la profondeur des queries à 10 niveaux pour protéger le backend
    validationRules: [depthLimit(10)],
    context: async ({ req }) => {
      // DataLoaders instanciés par requête (cache per-request, évite les N+1)
      const loaders = createDataLoaders();

      try {
        // Auth unifiée : cookie session (principal) + JWT fallback (WebSocket)
        let user = await betterAuthJWTMiddleware(req);

        // Récupérer l'organizationId depuis les headers (envoyé par le frontend)
        const organizationId = req.headers["x-organization-id"] || null;

        // Récupérer le userRole depuis les headers (envoyé par le frontend)
        const userRole = req.headers["x-user-role"] || null;

        logger.debug(
          `GraphQL Context - User: ${
            user ? user._id : "null"
          }, Organization: ${organizationId}, Role: ${userRole}`,
        );

        return {
          req,
          user,
          workspaceId: user?.workspaceId,
          organizationId,
          userRole,
          db: mongoose.connection.db,
          loaders,
        };
      } catch (error) {
        logger.error(
          "Erreur dans le contexte Apollo (session expirée ou invalide):",
          error.message,
        );
        return {
          req,
          user: null,
          workspaceId: null,
          organizationId: req.headers?.["x-organization-id"] || null,
          userRole: req.headers?.["x-user-role"] || null,
          db: mongoose.connection.db,
          loaders,
        };
      }
    },
    formatError: formatError,
    cache: "bounded",
    persistedQueries: { ttl: 900 },
  });

  await server.start();
  server.applyMiddleware({ app, cors: false });

  // Créer le serveur HTTP
  const httpServer = createServer(app);

  // Configurer les subscriptions WebSocket
  const subscriptionServer = SubscriptionServer.create(
    {
      schema,
      execute,
      subscribe,
      onConnect: async (connectionParams, webSocket) => {
        logger.info("🔌 [WebSocket] Client connecté");

        // Récupérer le token d'authentification depuis les paramètres de connexion
        const token = connectionParams?.authorization?.replace("Bearer ", "");

        if (token) {
          try {
            // Créer un faux objet req pour le middleware
            const fakeReq = {
              headers: {
                authorization: `Bearer ${token}`,
              },
              ip: "127.0.0.1", // IP par défaut pour WebSocket
              get: (header) => {
                if (header.toLowerCase() === "authorization") {
                  return `Bearer ${token}`;
                }
                return null;
              },
            };

            // Utiliser betterAuthJWTMiddleware directement
            const user = await betterAuthJWTMiddleware(fakeReq);
            const workspaceId = user?.workspaceId;

            logger.debug(
              `WebSocket Context - User: ${user ? user._id : "null"}`,
            );

            return {
              user,
              workspaceId,
              db: mongoose.connection.db, // Ajouter l'accès à la base de données MongoDB
            };
          } catch (error) {
            logger.error("❌ [WebSocket] Erreur authentification:", error);
            throw new Error("Authentication failed");
          }
        }

        // Permettre les connexions sans authentification pour les subscriptions publiques
        // Le resolver de la subscription publique vérifiera le token de partage
        logger.info(
          "ℹ️ [WebSocket] Connexion sans authentification (page publique)",
        );
        return {
          user: null,
          workspaceId: null,
          isPublic: true,
          db: mongoose.connection.db,
        };
      },
      onDisconnect: (webSocket, context) => {
        logger.info("🔌 [WebSocket] Client déconnecté");
      },
    },
    {
      server: httpServer,
      path: "/graphql",
    },
  );

  // Initialiser Redis PubSub
  try {
    await initializeRedis();
    logger.info("✅ Redis PubSub initialisé");
  } catch (error) {
    logger.warn(
      "⚠️ Redis PubSub non disponible, fallback vers PubSub en mémoire:",
      error.message,
    );
  }

  // Initialiser le système banking
  try {
    await initializeBankingSystem();
  } catch (error) {
    logger.warn("⚠️ Système banking non disponible:", error.message);
  }

  // Migration one-shot: corriger les événements sans champ source (leur donner 'newbi')
  try {
    const fixSource = await Event.updateMany(
      { source: { $exists: false } },
      { $set: { source: "newbi" } },
    );
    const fixSourceNull = await Event.updateMany(
      { source: null },
      { $set: { source: "newbi" } },
    );
    const totalSource =
      (fixSource.modifiedCount || 0) + (fixSourceNull.modifiedCount || 0);
    if (totalSource > 0) {
      logger.info(
        `Migration calendrier: ${totalSource} evenement(s) corrige(s) (source -> newbi)`,
      );
    }
    // Corriger les événements externes sans visibility correcte
    const fixVis = await Event.updateMany(
      {
        source: { $in: ["google", "microsoft", "apple"] },
        visibility: { $nin: ["private", "workspace"] },
      },
      { $set: { visibility: "private" } },
    );
    if (fixVis.modifiedCount > 0) {
      logger.info(
        `Migration calendrier: ${fixVis.modifiedCount} evenement(s) externe(s) corrige(s) (visibility -> private)`,
      );
    }
  } catch (migrationError) {
    logger.warn(
      "Migration calendrier echouee (non bloquant):",
      migrationError.message,
    );
  }

  // Démarrer le serveur HTTP avec WebSocket
  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, () => {
    logger.info(
      `🚀 Serveur HTTP démarré sur http://localhost:${PORT}${server.graphqlPath}`,
    );
    logger.info(
      `🔌 WebSocket subscriptions sur ws://localhost:${PORT}/graphql`,
    );
    // Ne démarrer les crons/schedulers que sur une seule instance PM2
    // pour éviter les envois d'emails en double/triple
    const instanceId = parseInt(
      process.env.NODE_APP_INSTANCE || process.env.pm_id || "0",
      10,
    );
    if (instanceId === 0) {
      setupScheduledJobs();

      // Démarrer le scheduler de rappels email
      emailReminderScheduler.start();

      // Démarrer le cron de relance automatique des factures
      startInvoiceReminderCron();
      logger.info("✅ Cron de relance automatique des factures démarré");

      // Démarrer le cron d'automatisation email CRM
      startCrmEmailAutomationCron();
      logger.info("✅ Cron d'automatisation email CRM démarré");

      // Démarrer le service de rappel d'expiration des transferts
      fileTransferReminderService.start();
      logger.info("✅ Service de rappel d'expiration des transferts démarré");

      // Démarrer le cron de synchronisation des calendriers externes
      startCalendarSyncCron();
      logger.info("✅ Cron de synchronisation des calendriers démarré");
      // Démarrer le cron de renouvellement des webhooks calendrier
      startCalendarWebhookRenewalCron();
      logger.info("✅ Cron de renouvellement des webhooks calendrier démarré");

      // Démarrer le cron de synchronisation Gmail (factures fournisseurs)
      startGmailSyncCron();
      logger.info("✅ Cron de synchronisation Gmail démarré");

      // Démarrer le cron de vérification des documents en retard
      startOverdueAutomationCron();
      logger.info("✅ Cron de vérification des documents en retard démarré");

      // Démarrer le cron de détection des factures récurrentes
      startRecurringInvoiceDetectionCron();
      logger.info("✅ Cron de détection des factures récurrentes démarré");
    } else {
      logger.info(
        `⏭️ Instance PM2 #${instanceId} — crons/schedulers désactivés (gérés par l'instance #0)`,
      );
    }
  });

  // Nettoyage propre à l'arrêt
  process.on("SIGTERM", async () => {
    logger.info("🛑 Arrêt du serveur en cours...");
    try {
      emailReminderScheduler.stop();
      subscriptionServer.close();
      await closeRedis();
      logger.info("✅ Serveur arrêté proprement");
    } catch (error) {
      logger.error("❌ Erreur lors de l'arrêt:", error);
    }
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    logger.info("🛑 Interruption du serveur (Ctrl+C)...");
    try {
      emailReminderScheduler.stop();
      // Arrêter la queue de relances
      const { stopInvoiceReminderCron } =
        await import("./cron/invoiceReminderCron.js");
      await stopInvoiceReminderCron();
      subscriptionServer.close();
      await closeRedis();
      logger.info("✅ Serveur arrêté proprement");
    } catch (error) {
      logger.error("❌ Erreur lors de l'arrêt:", error);
    }
    process.exit(0);
  });
}

// Configuration des routes
function setupRoutes(app) {
  // Webhook Stripe (déjà configuré plus haut avec les autres webhooks)
  // La route /webhook/file-transfer est maintenant définie avant express.json()

  // Téléchargement de fichiers
  app.get("/file-transfer/download-file", downloadFile);
  app.get("/file-transfer/download-all", downloadAllFiles);
  app.get("/file-transfer/validate-payment", validatePayment);

  // Portail client Stripe
  app.post("/create-customer-portal-session", handleCustomerPortal);
}

// Gestion des erreurs
function formatError(error) {
  console.error("❌ [GraphQL Error]:", error.message);
  console.error("Path:", error.path);
  console.error("Extensions:", error.extensions);
  const originalError = error.originalError;

  // Cas 1: originalError est une AppError directe
  if (originalError?.name === "AppError") {
    return {
      message: originalError.message,
      extensions: {
        code: originalError.code,
        details: originalError.details,
      },
      path: error.path,
    };
  }

  // ✅ FIX: Cas 2: AppError encapsulée dans extensions.exception
  // (quand Apollo Server perd la référence originalError mais conserve l'exception sérialisée)
  const exception = error.extensions?.exception;
  if (exception?.name === "AppError" && exception?.code) {
    return {
      message: error.message,
      extensions: {
        code: exception.code,
        details: exception.details || null,
      },
      path: error.path,
    };
  }

  // Cas 3: TypeError sur null/undefined — typiquement context.user est null
  // car le JWT a expiré et le resolver accède à user._id sans guard.
  // On reclassifie en UNAUTHENTICATED pour que le frontend retry silencieusement
  // avec un nouveau JWT au lieu d'afficher un toast d'erreur.
  // Si c'est un vrai bug (pas lié à l'auth), le retry réauthentifiera le user
  // et l'erreur remontera normalement au second essai.
  if (
    originalError?.name === "TypeError" &&
    /cannot read properties of (null|undefined)/i.test(originalError?.message)
  ) {
    logger.warn(
      `TypeError reclassifié en UNAUTHENTICATED (probable JWT expiré): ${originalError.message}`,
    );
    return {
      message: "Session expirée, veuillez réessayer",
      extensions: {
        code: "UNAUTHENTICATED",
      },
      path: error.path,
    };
  }

  if (error.extensions?.code === "BAD_USER_INPUT") {
    return {
      message: "Données d'entrée invalides",
      extensions: {
        code: "VALIDATION_ERROR",
        details: error.extensions.exception?.validationErrors,
      },
      path: error.path,
    };
  }

  return {
    message: error.message,
    extensions: {
      code: error.extensions?.code || "INTERNAL_ERROR",
    },
    path: error.path,
  };
}

// Gestion du portail client Stripe
async function handleCustomerPortal(req, res) {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non autorisé" });
    }

    if (!user.subscription?.stripeCustomerId) {
      return res.status(400).json({
        error: "Aucun abonnement Stripe trouvé pour cet utilisateur",
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.subscription.stripeCustomerId,
      return_url: process.env.FRONTEND_URL || "http://localhost:5173",
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(
      "Erreur lors de la création de la session de portail client:",
      error,
    );
    res.status(500).json({
      error: "Erreur lors de la création de la session de portail client",
    });
  }
}

// Démarrer le serveur
startServer().catch((error) => {
  console.error("Erreur lors du démarrage du serveur:", error);
  process.exit(1);
});
