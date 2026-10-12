import mongoose from "mongoose";

/**
 * Compte gestionnaire : en pratique un cabinet comptable, créé par Newbi
 * depuis le back-office (newbi-admin). Rattaché à un utilisateur Newbi.
 *
 * Le gestionnaire crée ensuite des comptes clients (ManagedClient). Par
 * défaut chaque client paie son abonnement ; si le gestionnaire coche « je
 * paie », l'abonnement passe sur sa facture, avec la remise négociée ici.
 */
const accountManagerSchema = new mongoose.Schema(
  {
    // Utilisateur Newbi qui pilote le compte (collection Better Auth `user`)
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
    },
    // Nom du cabinet, affiché dans l'admin et chez ses clients
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    // Remise en % sur les abonnements des clients qu'il paie
    discountPercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active",
    },
    // Client Stripe du gestionnaire (facturation des clients qu'il paie)
    stripeCustomerId: {
      type: String,
      default: null,
    },
    // E-mails des admins Newbi (newbi-admin), pour la traçabilité
    createdByAdmin: { type: String, default: null },
    updatedByAdmin: { type: String, default: null },
  },
  { timestamps: true },
);

const AccountManager = mongoose.model("AccountManager", accountManagerSchema);

export default AccountManager;
