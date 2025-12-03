import mongoose from "mongoose";

const stripeConnectAccountSchema = new mongoose.Schema(
  {
    // NOUVEAU: ID de l'organisation (Better Auth)
    organizationId: {
      type: String,
      required: false, // Optionnel pendant la migration
      index: true,
    },
    // ANCIEN: Gardé pour compatibilité pendant la migration
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // Plus obligatoire car on utilise organizationId
      index: true,
    },
    accountId: {
      type: String,
      required: true,
      unique: true,
    },
    isOnboarded: {
      type: Boolean,
      default: false,
    },
    chargesEnabled: {
      type: Boolean,
      default: false,
    },
    payoutsEnabled: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Index unique sur organizationId (un seul compte Stripe par organisation)
stripeConnectAccountSchema.index(
  { organizationId: 1 },
  { unique: true, sparse: true }
);

// ANCIEN: Index sur userId (gardé pour compatibilité)
stripeConnectAccountSchema.index({ userId: 1 }, { sparse: true });

const StripeConnectAccount = mongoose.model(
  "StripeConnectAccount",
  stripeConnectAccountSchema
);

export default StripeConnectAccount;
