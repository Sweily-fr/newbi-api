import { client, connect } from "../config/database.js";
import { betterAuth } from "better-auth";
import { oAuthProxy } from "better-auth/plugins";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import dotenv from "dotenv";

dotenv.config();
await connect();

const mongoClient = client();
if (!mongoClient) {
  throw new Error("Client MongoDB non disponible pour Better Auth");
}
const db = mongoClient.db();

// Définir les origines autorisées (identiques à celles dans index.js)
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4000",
  "http://localhost:3000",
  "https://studio.apollographql.com",
  "https://www.newbi.fr",
  "https://newbi.fr",
  "https://api.newbi.fr",
  process.env.FRONTEND_URL,
].filter(Boolean);

export const auth = betterAuth({
  database: mongodbAdapter(db),
  plugins: [
    oAuthProxy({
      currentURL: process.env.API_URL || "http://localhost:4000", // URL de l'API
      productionURL: process.env.API_URL || "http://localhost:4000",
    }),
  ],
  secret: process.env.BETTER_AUTH_SECRET || "default-secret-key-change-me",
  url: process.env.API_URL || "http://localhost:4000", // URL de l'API
  trustedOrigins: allowedOrigins, // Toutes les origines autorisées
  basePath: "/api/auth", // Chemin de base pour les routes d'authentification
  emailAndPassword: {
    enabled: true,
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    },
  },
  user: {
    additionalFields: {
      firstName: {
        type: "string",
        required: false,
        defaultValue: "",
      },
      lastName: {
        type: "string",
        required: false,
        defaultValue: "",
      },
      phone: {
        type: "string",
        required: false,
        defaultValue: "",
      },
      // avatar: {
      //   type: "string",
      //   required: false,
      //   defaultValue: "",
      // },
    },
  },
  cookies: {
    maxAge: 14 * 24 * 60 * 60,
    sameSite: "lax", // Important pour les redirections OAuth
  },
});

console.log("Better Auth initialisé avec succès");

export const requireAuth = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Non authentifié" });
  }
  next();
};

export const requireRole = (role) => (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "Non authentifié" });
  }

  if (!req.session.user.roles || !req.session.user.roles.includes(role)) {
    return res.status(403).json({ error: "Accès non autorisé" });
  }

  next();
};
