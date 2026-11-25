import mongoose from "mongoose";

/**
 * Adresse prospectée par un espace : une seule fiche par adresse et par
 * espace (index unique), réservée de façon atomique juste avant l'appel au
 * fournisseur (services/prospecting/contacts.js). Deux boîtes du même
 * espace, servies en parallèle par le cron, ne peuvent donc jamais écrire à
 * la même adresse à moins de 30 jours d'intervalle.
 *
 * `lastSentAt` : dernier envoi réel (ou possible : envoi incertain ou
 * interrompu) ; `sequenceId` / `recipientId` : envoi qui a réservé
 * l'adresse.
 */
const prospectingContactSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    email: { type: String, required: true, trim: true, lowercase: true },
    lastSentAt: { type: Date, default: null },
    sequenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProspectingSequence",
      default: null,
    },
    recipientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProspectingRecipient",
      default: null,
    },
  },
  { timestamps: true, collection: "prospecting_contacts" },
);

prospectingContactSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
// Adresses prospectées récemment par l'espace (décompte de l'audience)
prospectingContactSchema.index({ workspaceId: 1, lastSentAt: 1 });

export default mongoose.models.ProspectingContact ||
  mongoose.model("ProspectingContact", prospectingContactSchema);
