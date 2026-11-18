import mongoose from "mongoose";

/**
 * Clic sur un lien suivi d'une campagne e-mail : un document par clic, pour
 * les statistiques par lien (clics et clics uniques). `linkIndex` désigne
 * l'adresse dans `EmailCampaign.links`, figée au lancement.
 */
const emailCampaignClickSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    required: true,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "EmailCampaign",
    required: true,
  },
  recipientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "EmailCampaignRecipient",
    required: true,
  },
  linkIndex: { type: Number, required: true, min: 0 },
  at: { type: Date, default: Date.now },
});

emailCampaignClickSchema.index({ campaignId: 1, linkIndex: 1 });

export default mongoose.models.EmailCampaignClick ||
  mongoose.model("EmailCampaignClick", emailCampaignClickSchema);
