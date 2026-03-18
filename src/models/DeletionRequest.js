import mongoose from "mongoose";

/**
 * Modèle pour les demandes de suppression de compte (RGPD)
 *
 * Gère le délai de grâce de 30 jours avant suppression définitive.
 * Conforme à l'article 17 du RGPD (droit à l'effacement).
 */
const deletionRequestSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    // Date à laquelle la suppression sera exécutée (30 jours après la demande)
    scheduledAt: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "cancelled", "completed", "failed"],
      default: "pending",
      index: true,
    },
    // Raison optionnelle fournie par l'utilisateur
    reason: {
      type: String,
      trim: true,
      maxlength: [1000, "La raison ne peut pas dépasser 1000 caractères"],
    },
    // Email de l'utilisateur au moment de la demande (pour audit)
    userEmail: {
      type: String,
      required: true,
    },
    // Date d'annulation (si applicable)
    cancelledAt: {
      type: Date,
      default: null,
    },
    // Date de complétion (si applicable)
    completedAt: {
      type: Date,
      default: null,
    },
    // Erreur en cas d'échec
    error: {
      type: String,
      default: null,
    },
    // Résumé des données supprimées (pour audit)
    deletionSummary: {
      invoicesAnonymized: { type: Number, default: 0 },
      creditNotesAnonymized: { type: Number, default: 0 },
      quotesAnonymized: { type: Number, default: 0 },
      clientsDeleted: { type: Number, default: 0 },
      productsDeleted: { type: Number, default: 0 },
      expensesDeleted: { type: Number, default: 0 },
      signaturesDeleted: { type: Number, default: 0 },
      kanbanProjectsDeleted: { type: Number, default: 0 },
      fileTransfersDeleted: { type: Number, default: 0 },
      organizationDeleted: { type: Boolean, default: false },
    },
  },
  {
    timestamps: true,
  }
);

// Index composé pour trouver les demandes en attente à traiter
deletionRequestSchema.index({ status: 1, scheduledAt: 1 });
// Un seul pending par user
deletionRequestSchema.index(
  { userId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "pending" },
    name: "one_pending_per_user",
  }
);

const DeletionRequest = mongoose.model("DeletionRequest", deletionRequestSchema);
export default DeletionRequest;
