import mongoose from "mongoose";

/**
 * Liste d'exclusion des campagnes e-mail d'un espace : aucune campagne de
 * l'espace ne part plus vers ces adresses.
 *
 *   UNSUBSCRIBED  désinscription (lien du pied ou désabonnement en un clic)
 *   BOUNCED       rejet définitif signalé par le service d'envoi
 *   COMPLAINED    signalement comme indésirable
 *   MANUAL        ajout à la main dans Newbi (seul motif retirable)
 *
 * Une adresse n'y figure qu'une fois : un motif plus fort remplace le
 * précédent (une adresse ajoutée à la main puis désinscrite ne peut plus
 * être retirée par l'espace).
 *
 * La liste est commune aux campagnes et à la prospection : une adresse
 * désinscrite d'une prospection ne reçoit plus de campagne, et
 * inversement (`sequenceId` : prospection d'origine).
 */

export const SUPPRESSION_REASONS = [
  "UNSUBSCRIBED",
  "BOUNCED",
  "COMPLAINED",
  "MANUAL",
];

const emailSuppressionSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    email: { type: String, required: true, trim: true, lowercase: true },
    reason: { type: String, enum: SUPPRESSION_REASONS, required: true },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      default: null,
    },
    sequenceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProspectingSequence",
      default: null,
    },
    // Origine : « one-click », « link », « webhook », « manual »,
    // « prospecting-link », « prospecting-one-click », « prospecting-reply »
    // (« Ne plus contacter » après une réponse)
    source: { type: String, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

emailSuppressionSchema.index({ workspaceId: 1, email: 1 }, { unique: true });
emailSuppressionSchema.index({ workspaceId: 1, createdAt: -1 });

export default mongoose.models.EmailSuppression ||
  mongoose.model("EmailSuppression", emailSuppressionSchema);
