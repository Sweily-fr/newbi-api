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

import express from "express";
import { ApolloServer } from "apollo-server-express";
import { createServer } from "http";
import { execute, subscribe } from "graphql";
import { SubscriptionServer } from "subscriptions-transport-ws";
import { makeExecutableSchema } from "@graphql-tools/schema";
import mongoose from "mongoose";
import { graphqlUploadExpress } from "graphql-upload";
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
import {
  betterAuthJWTMiddleware,
  validateJWT,
} from "./middlewares/better-auth-jwt.js";
import { betterAuthMiddleware } from "./middlewares/better-auth.js";
import { initializeRedis, closeRedis } from "./config/redis.js";
import typeDefs from "./schemas/index.js";
import resolvers from "./resolvers/index.js";
import webhookRoutes from "./routes/webhook.js";
import fileTransferAuthRoutes from "./routes/fileTransferAuth.js";
import fileDownloadRoutes from "./routes/fileDownload.js";
import cleanupAdminRoutes from "./routes/cleanupAdmin.js";
import bankingRoutes from "./routes/banking.js";
import bankingConnectRoutes from "./routes/banking-connect.js";
import bankingSyncRoutes from "./routes/banking-sync.js";
import reconciliationRoutes from "./routes/reconciliation.js";
import unifiedExpensesRoutes from "./routes/unified-expenses.js";
import { initializeBankingSystem } from "./services/banking/index.js";
import emailReminderScheduler from "./services/emailReminderScheduler.js";
import { startInvoiceReminderCron } from "./cron/invoiceReminderCron.js";
import fileTransferReminderService from "./services/fileTransferReminderService.js";

// Connexion à MongoDB
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => logger.info("Connecté à MongoDB"))
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
  createDirectory(dirPath, name)
);

// Configuration du serveur
async function startServer() {
  const app = express();

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
  ].filter(Boolean);

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
    })
  );

  // Webhook pour les transferts de fichiers (DOIT être AVANT les autres routes /webhook)
  app.post(
    "/webhook/file-transfer",
    express.raw({ type: "application/json" }),
    handleFileTransferStripeWebhook
  );

  // Routes webhook (avant les middlewares JSON)
  app.use("/webhook", webhookRoutes);

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
  app.use("/reconciliation", reconciliationRoutes); // Rapprochement factures/transactions
  app.use("/unified-expenses", unifiedExpensesRoutes); // Dépenses unifiées (bancaires + manuelles)

  app.use(graphqlUploadExpress({ maxFileSize: 10000000000, maxFiles: 20 }));

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
    context: async ({ req }) => {
      // Essayer d'abord better-auth (cookies), puis JWT
      let user = await betterAuthMiddleware(req);
      if (!user) {
        user = await betterAuthJWTMiddleware(req);
      }

      // Récupérer l'organizationId depuis les headers (envoyé par le frontend)
      const organizationId = req.headers["x-organization-id"] || null;

      // Récupérer le userRole depuis les headers (envoyé par le frontend)
      const userRole = req.headers["x-user-role"] || null;

      logger.debug(
        `GraphQL Context - User: ${
          user ? user._id : "null"
        }, Organization: ${organizationId}, Role: ${userRole}`
      );

      return {
        req,
        user,
        workspaceId: user?.workspaceId,
        organizationId, // Nouveau: ID de l'organisation active
        userRole, // Nouveau: Rôle de l'utilisateur dans l'organisation
        db: mongoose.connection.db, // Ajouter l'accès à la base de données MongoDB
      };
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
              `WebSocket Context - User: ${user ? user._id : "null"}`
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

        throw new Error("No authentication token provided");
      },
      onDisconnect: (webSocket, context) => {
        logger.info("🔌 [WebSocket] Client déconnecté");
      },
    },
    {
      server: httpServer,
      path: "/graphql",
    }
  );

  // Initialiser Redis PubSub
  try {
    await initializeRedis();
    logger.info("✅ Redis PubSub initialisé");
  } catch (error) {
    logger.warn(
      "⚠️ Redis PubSub non disponible, fallback vers PubSub en mémoire:",
      error.message
    );
  }

  // Initialiser le système banking
  try {
    await initializeBankingSystem();
  } catch (error) {
    logger.warn("⚠️ Système banking non disponible:", error.message);
  }

  // Démarrer le serveur HTTP avec WebSocket
  const PORT = process.env.PORT || 4000;
  httpServer.listen(PORT, () => {
    logger.info(
      `🚀 Serveur HTTP démarré sur http://localhost:${PORT}${server.graphqlPath}`
    );
    logger.info(
      `🔌 WebSocket subscriptions sur ws://localhost:${PORT}/graphql`
    );
    setupScheduledJobs();

    // Démarrer le scheduler de rappels email
    emailReminderScheduler.start();

    // Démarrer le cron de relance automatique des factures
    startInvoiceReminderCron();
    logger.info("✅ Cron de relance automatique des factures démarré");

    // Démarrer le service de rappel d'expiration des transferts
    fileTransferReminderService.start();
    logger.info("✅ Service de rappel d'expiration des transferts démarré");
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

  if (originalError?.name === "AppError") {
    return {
      message: originalError.message,
      code: originalError.code,
      details: originalError.details,
      path: error.path,
    };
  }

  if (error.extensions?.code === "BAD_USER_INPUT") {
    return {
      message: "Données d'entrée invalides",
      code: "VALIDATION_ERROR",
      details: error.extensions.exception?.validationErrors,
      path: error.path,
    };
  }

  return {
    message: error.message,
    code: error.extensions?.code || "INTERNAL_ERROR",
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
      error
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
