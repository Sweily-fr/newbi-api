import mongoose from "mongoose";

/**
 * Domaine d'envoi connecté par un espace pour ses campagnes e-mail
 * (« Connecter mon domaine ») : l'espace saisit une adresse de son domaine,
 * Newbi déclare le domaine chez Resend et affiche les lignes DNS à ajouter
 * chez l'hébergeur. Seul un domaine VERIFIED sert à l'envoi ; sinon les
 * campagnes partent de l'adresse Newbi de l'espace (aucun blocage).
 *
 * Un domaine par espace, un espace par domaine sur toute la base. Statuts :
 * ceux de Resend en majuscules, plus EXPIRED (retiré automatiquement après
 * 7 jours sans validation, ou disparu de Resend : lignes DNS vidées, plus
 * rien chez Resend). Voir services/emailCampaigns/sendingDomains.js.
 */

export const SENDING_DOMAIN_STATUSES = [
  "NOT_STARTED",
  "PENDING",
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "PARTIALLY_FAILED",
  "TEMPORARY_FAILURE",
  "FAILED",
  "EXPIRED",
];

// Ligne DNS telle que Resend la donne (nom relatif à la zone)
const recordSchema = new mongoose.Schema(
  {
    // « record » de Resend : DKIM, SPF, Receiving...
    record: { type: String, default: "" },
    type: { type: String, default: "" },
    name: { type: String, default: "" },
    value: { type: String, default: "" },
    priority: { type: Number, default: null },
    // Statut Resend de la ligne, en majuscules
    status: { type: String, default: "NOT_STARTED" },
    ttl: { type: String, default: null },
  },
  { _id: false },
);

const emailSendingDomainSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    domain: { type: String, required: true, trim: true, lowercase: true },
    // Adresse d'envoi des campagnes une fois le domaine validé
    fromEmail: { type: String, required: true, trim: true, lowercase: true },
    // Null le temps de la déclaration chez Resend (réservation en base)
    resendDomainId: { type: String, default: null },
    region: { type: String, default: "eu-west-1" },
    status: {
      type: String,
      enum: SENDING_DOMAIN_STATUSES,
      default: "NOT_STARTED",
    },
    records: { type: [recordSchema], default: [] },
    // Zone DNS où ajouter les lignes (domaine enregistré chez l'hébergeur)
    zone: { type: String, default: "" },
    // Hébergeur DNS reconnu (OVH, Hostinger...), null si inconnu
    dnsProvider: { type: String, default: null },
    lastCheckedAt: { type: Date, default: null },
    // Dernière vérification demandée à Resend (au plus une toutes les 20 s)
    verifyRequestedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    // Retrait automatique s'il n'est toujours pas validé
    expiresAt: { type: Date, default: null },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true },
);

emailSendingDomainSchema.index({ workspaceId: 1 }, { unique: true });
emailSendingDomainSchema.index({ domain: 1 }, { unique: true });
// Cron : domaines à relire, les moins récemment lus d'abord
emailSendingDomainSchema.index({ status: 1, lastCheckedAt: 1 });

export default mongoose.models.EmailSendingDomain ||
  mongoose.model("EmailSendingDomain", emailSendingDomainSchema);
