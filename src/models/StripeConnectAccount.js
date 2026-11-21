import mongoose from "mongoose";

const stripeConnectAccountSchema = new mongoose.Schema(
  {
    // NOUVEAU: ID de l'organisation (Better Auth)
    organizationId: {
      type: String,
      required: false, // Optionnel pendant la migration
      // Note: do not set `index: true` — a unique sparse index is declared via
      // `stripeConnectAccountSchema.index({ organizationId: 1 }, { unique, sparse })` below.
    },
    // ANCIEN: Gardé pour compatibilité pendant la migration
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false, // Plus obligatoire car on utilise organizationId
      // Note: do not set `index: true` — a single-field sparse index on userId
      // is declared via `stripeConnectAccountSchema.index({ userId: 1 }, { sparse: true })`.
      // Setting both produces a duplicate-index warning.
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
    // Mode de connexion :
    // - « express » (ancien parcours) : compte Express créé par Newbi ; les
    //   paiements passent par le compte Stripe de Newbi (destination
    //   charges), qui en paie les frais ;
    // - « oauth » : compte Stripe du client rattaché par OAuth ; les
    //   paiements sont créés directement sur son compte, frais Stripe à sa
    //   charge, sans passer par le compte de Newbi.
    // Les documents antérieurs n'ont pas le champ : ancien parcours.
    connectionType: {
      type: String,
      enum: ["express", "oauth"],
      default: "express",
    },
    livemode: {
      type: Boolean,
    },
    // Nom et e-mail du compte, affichés dans les réglages
    displayName: {
      type: String,
      trim: true,
    },
    accountEmail: {
      type: String,
      trim: true,
    },
    connectedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    connectedAt: {
      type: Date,
    },
    // Compte Express remplacé par la connexion OAuth (trace)
    replacedAccountId: {
      type: String,
    },
  },
  { timestamps: true },
);

// Index unique sur organizationId (un seul compte Stripe par organisation)
stripeConnectAccountSchema.index(
  { organizationId: 1 },
  { unique: true, sparse: true },
);

// ANCIEN: Index sur userId (gardé pour compatibilité)
stripeConnectAccountSchema.index({ userId: 1 }, { sparse: true });

const StripeConnectAccount = mongoose.model(
  "StripeConnectAccount",
  stripeConnectAccountSchema,
);

export default StripeConnectAccount;
