import mongoose from "mongoose";

/**
 * Accord de suivi des campagnes e-mail d'un espace, par adresse
 * (recommandation CNIL sur les pixels de suivi : accord préalable de chaque
 * destinataire). Sans document : aucun choix, aucun suivi.
 *
 *   GRANTED  l'adresse accepte que l'espace mesure l'ouverture de ses
 *            e-mails et les clics sur leurs liens
 *   REFUSED  l'adresse refuse : rien n'est suivi, ce qui l'avait été est
 *            effacé
 *
 * Origine : CONTACT (choix du destinataire sur la page de préférences, que
 * l'espace ne peut ni changer ni retirer) ou SENDER (saisi par un membre de
 * l'espace, qui atteste avoir recueilli l'accord ; `note` dit comment).
 * `history` garde les 20 derniers changements (preuve).
 */

export const TRACKING_CONSENT_STATUSES = ["GRANTED", "REFUSED"];
export const TRACKING_CONSENT_SOURCES = ["CONTACT", "SENDER"];

const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: TRACKING_CONSENT_STATUSES, required: true },
    source: { type: String, enum: TRACKING_CONSENT_SOURCES, required: true },
    at: { type: Date, required: true },
    byName: { type: String, default: null },
    note: { type: String, default: null },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      default: null,
    },
  },
  { _id: false },
);

const emailTrackingConsentSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    email: { type: String, required: true, trim: true, lowercase: true },
    status: { type: String, enum: TRACKING_CONSENT_STATUSES, required: true },
    source: { type: String, enum: TRACKING_CONSENT_SOURCES, required: true },
    note: { type: String, default: null, maxlength: 200 },
    decidedAt: { type: Date, required: true },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    decidedByName: { type: String, default: null },
    // Campagne dont l'e-mail a mené à la page de préférences (CONTACT)
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmailCampaign",
      default: null,
    },
    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

emailTrackingConsentSchema.index(
  { workspaceId: 1, email: 1 },
  { unique: true },
);
emailTrackingConsentSchema.index({ workspaceId: 1, status: 1, decidedAt: -1 });

export default mongoose.models.EmailTrackingConsent ||
  mongoose.model("EmailTrackingConsent", emailTrackingConsentSchema);
