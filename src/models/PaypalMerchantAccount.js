import mongoose from "mongoose";

/**
 * Compte PayPal d'un espace pour encaisser les transferts payants.
 *
 * Seule l'adresse e-mail du compte PayPal Business est connue : Newbi crée
 * la commande avec sa propre application PayPal en désignant ce compte comme
 * bénéficiaire (`payee`), l'argent arrive directement chez le client et les
 * frais PayPal sont prélevés sur son compte. Aucune clé ni aucun jeton du
 * client n'est conservé.
 */
const paypalMerchantAccountSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true },
);

// Un seul compte PayPal par espace
paypalMerchantAccountSchema.index({ organizationId: 1 }, { unique: true });

const PaypalMerchantAccount = mongoose.model(
  "PaypalMerchantAccount",
  paypalMerchantAccountSchema,
);

export default PaypalMerchantAccount;
