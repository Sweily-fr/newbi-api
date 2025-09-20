import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { ApolloServer } from "apollo-server-express";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
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
import { betterAuthJWTMiddleware, validateJWT } from "./middlewares/better-auth-jwt.js";
import typeDefs from "./schemas/index.js";
import resolvers from "./resolvers/index.js";
import webhookRoutes from "./routes/webhook.js";
import stripeWebhookRoutes from "./routes/stripeWebhook.js";
import fileTransferAuthRoutes from "./routes/fileTransferAuth.js";
import fileDownloadRoutes from "./routes/fileDownload.js";
import bankingRoutes from "./routes/banking.js";
import bankingConnectRoutes from "./routes/banking-connect.js";
import bankingSyncRoutes from "./routes/banking-sync.js";
import { initializeBankingSystem } from "./services/banking/index.js";

// Configuration des chemins
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    "http://localhost:4000",
    "https://studio.apollographql.com",
    "https://www.newbi.fr",
    "https://newbi.fr",
    "https://api.newbi.fr",
    "https://newbi-v2.vercel.app",
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
      ],
      exposedHeaders: ["Content-Disposition", "Content-Length", "Content-Type"],
    })
  );

  // Routes webhook (avant les middlewares JSON)
  app.use("/webhook", webhookRoutes);
  app.use("/webhook/stripe", stripeWebhookRoutes);

  // Middleware pour les uploads
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Routes file transfer auth
  app.use("/api/transfers", fileTransferAuthRoutes);
  
  // Routes file download proxy
  app.use("/api/files", fileDownloadRoutes);

  // Routes banking (avec authentification JWT)
  app.use("/banking", validateJWT, bankingRoutes);
  app.use("/banking-connect", validateJWT, bankingConnectRoutes);
  app.use("/banking-sync", validateJWT, bankingSyncRoutes);

  app.use(graphqlUploadExpress({ maxFileSize: 10000000000, maxFiles: 20 }));

  // Autres routes API
  setupRoutes(app);

  // Configuration Apollo Server
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: async ({ req }) => {
      console.log(" [GraphQL] === CRÉATION CONTEXTE ===");
      console.log(" [GraphQL] URL:", req.url);
      console.log(" [GraphQL] Method:", req.method);
      
      const user = await betterAuthJWTMiddleware(req);
      
      console.log(" [GraphQL] Résultat betterAuthJWTMiddleware:", {
        user: user ? {
          id: user._id,
          email: user.email
        } : null
      });
      
      const context = {
        req,
        user: user,
      };
      
      console.log(" [GraphQL] Contexte final:", {
        hasReq: !!context.req,
        hasUser: !!context.user,
        userId: context.user?._id
      });
      
      return context;
    },
    formatError: formatError,
    cache: "bounded",
    persistedQueries: { ttl: 900 },
  });

  await server.start();
  server.applyMiddleware({ app, cors: false });

  // Initialiser le système banking
  try {
    await initializeBankingSystem();
  } catch (error) {
    logger.warn(" Système banking non disponible:", error.message);
  }

  // Démarrer le serveur
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    logger.info(
      ` Serveur démarré sur http://localhost:${PORT}${server.graphqlPath}`
    );
    setupScheduledJobs();
  });
}

// Configuration des routes
function setupRoutes(app) {
  // Webhook Stripe
  app.post(
    "/webhook/stripe",
    express.raw({ type: "application/json" }),
    handleStripeWebhook
  );

  // Webhook pour les transferts de fichiers
  app.post(
    "/webhook/file-transfer",
    express.raw({ type: "application/json" }),
    handleFileTransferStripeWebhook
  );

  // Téléchargement de fichiers
  app.get("/file-transfer/download-file", downloadFile);
  app.get("/file-transfer/download-all", downloadAllFiles);
  app.get("/file-transfer/validate-payment", validatePayment);

  // Portail client Stripe
  app.post("/create-customer-portal-session", handleCustomerPortal);
}

// Gestion des erreurs
function formatError(error) {
  console.error(error);
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
