import mongoose from "mongoose";

/**
 * Compte SumUp d'un espace pour encaisser les transferts payants.
 *
 * Connecté par OAuth (« Connecter mon compte SumUp ») : Newbi crée les
 * paiements (checkouts SumUp) sur le compte marchand du client, l'argent
 * arrive directement chez lui et SumUp y prélève ses frais habituels. Newbi
 * n'encaisse rien.
 *
 * Les jetons d'accès sont chiffrés (DATA_ENCRYPTION_KEY) et ne sortent
 * jamais de l'API.
 */
const sumupMerchantAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      required: true,
    },
    // Identifiant du compte marchand SumUp (ex. « MH4H92C7 »)
    merchantCode: {
      type: String,
      required: true,
      trim: true,
    },
    // Nom commercial et e-mail du compte SumUp (affichage seulement)
    businessName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    // Devise du compte marchand : un paiement dans une autre devise est
    // refusé par SumUp
    currency: { type: String, trim: true, uppercase: true },
    // Jetons OAuth chiffrés
    accessToken: { type: String },
    accessTokenExpiresAt: { type: Date },
    refreshToken: { type: String },
    scope: { type: String },
    // « reconnect » : SumUp a refusé le renouvellement (accès retiré depuis
    // SumUp, jeton expiré) : le client doit reconnecter son compte
    status: {
      type: String,
      enum: ["active", "reconnect"],
      default: "active",
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    connectedAt: { type: Date },
  },
  { timestamps: true },
);

// Un seul compte SumUp par espace
sumupMerchantAccountSchema.index({ organizationId: 1 }, { unique: true });
sumupMerchantAccountSchema.index({ merchantCode: 1 });

const SumupMerchantAccount = mongoose.model(
  "SumupMerchantAccount",
  sumupMerchantAccountSchema,
);

export default SumupMerchantAccount;
