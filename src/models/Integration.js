import mongoose from 'mongoose';
import crypto from 'crypto';

// Regex pour valider les clés API Stripe
// Format: sk_test_, sk_live_, pk_test_ ou pk_live_ suivi de caractères alphanumériques et underscores
const STRIPE_API_KEY_REGEX =
  /^(sk_test_|sk_live_|pk_test_|pk_live_)[a-zA-Z0-9_]{24,}$/;

/**
 * Schéma pour les intégrations externes (Stripe, etc.)
 */
const integrationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    provider: {
      type: String,
      required: true,
      enum: ["stripe", "zapier", "hubspot"],
      lowercase: true,
    },
    isConnected: {
      type: Boolean,
      default: true,
    },
    // Stockage sécurisé des clés API avec chiffrement
    credentials: {
      encryptedData: {
        type: String,
        required: false,
      },
      iv: {
        type: String,
        required: false,
      },
    },
    lastUpdated: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Créer un index composé pour éviter les doublons d'intégration par utilisateur
integrationSchema.index({ userId: 1, provider: 1 }, { unique: true });

/**
 * Méthode pour valider le format d'une clé API selon le fournisseur
 */
integrationSchema.statics.validateApiKey = function (provider, apiKey) {
  if (!apiKey) {
    throw new Error("La clé API est requise");
  }

  switch (provider) {
    case "stripe":
      if (!STRIPE_API_KEY_REGEX.test(apiKey)) {
        throw new Error("Format de clé API Stripe invalide");
      }

      // Vérifier si c'est une clé publique ou privée
      if (apiKey.startsWith("pk_")) {
        console.warn(
          "Attention: Utilisation d'une clé publique Stripe. Il est recommandé d'utiliser une clé secrète pour une intégration complète."
        );
      }
      break;
    // Ajouter d'autres fournisseurs ici si nécessaire
    default:
      // Pour les autres fournisseurs, vérifier simplement que la clé n'est pas vide
      if (!apiKey.trim()) {
        throw new Error(`La clé API pour ${provider} est requise`);
      }
  }

  return true;
};

/**
 * Méthodes pour chiffrer et déchiffrer les clés API
 */
integrationSchema.statics.encryptApiKey = function (apiKey) {
  // Utiliser une clé d'environnement pour le chiffrement
  const ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY || "default-encryption-key-change-in-production";

  // Générer un vecteur d'initialisation aléatoire
  const iv = crypto.randomBytes(16);

  // Créer un chiffreur avec l'algorithme AES-256-CBC
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), // S'assurer que la clé fait 32 octets
    iv
  );

  // Chiffrer la clé API
  let encrypted = cipher.update(apiKey, "utf8", "hex");
  encrypted += cipher.final("hex");

  return {
    encryptedData: encrypted,
    iv: iv.toString("hex"),
  };
};

integrationSchema.statics.decryptApiKey = function (encryptedData, iv) {
  try {
    const ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY ||
      "default-encryption-key-change-in-production";

    // Créer un déchiffreur
    const decipher = crypto.createDecipheriv(
      "aes-256-cbc",
      Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)),
      Buffer.from(iv, "hex")
    );

    // Déchiffrer la clé API
    let decrypted = decipher.update(encryptedData, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (error) {
    console.error("Erreur lors du déchiffrement:", error);
    return null;
  }
};

export default mongoose.model("Integration", integrationSchema);
