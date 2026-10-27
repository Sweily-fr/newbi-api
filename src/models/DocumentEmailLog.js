import mongoose from "mongoose";

/**
 * Envoi d'un document par e-mail : ce que le client a reçu (aperçu ouvert
 * depuis le reçu de l'émetteur) et l'état de cet envoi (historique du
 * document). Un document renvoyé a une entrée par envoi, là où
 * emailTracking ne garde que le dernier.
 *
 * Le HTML est conservé sans pixel ni liens de suivi : le consulter ne doit
 * pas marquer le document « Ouvert ». Les pièces jointes ajoutées à la main
 * sont conservées dans un bucket privé (storageKey) ; les envois antérieurs
 * n'en gardent que le nom et la taille.
 */
const attachmentSchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    size: { type: Number },
    // PDF du document : lu depuis l'archive du document lui-même
    isDocument: { type: Boolean, default: false },
    // Fichier ajouté à la main, conservé après l'envoi (bucket privé)
    storageKey: { type: String },
    contentType: { type: String },
  },
  { _id: false },
);

const documentEmailLogSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
    },
    documentType: {
      type: String,
      enum: ["invoice", "quote", "creditNote", "purchaseOrder", "deliveryNote"],
      required: true,
    },
    documentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    documentNumber: { type: String },
    // Avoir : sa page est rattachée à la facture d'origine
    originalInvoiceId: { type: mongoose.Schema.Types.ObjectId },
    sentAt: { type: Date, required: true },
    // Utilisateur qui a envoyé (destinataire du reçu)
    senderEmail: { type: String },
    from: { type: String },
    replyTo: { type: String },
    to: { type: String, required: true },
    cc: { type: [String], default: [] },
    bcc: { type: [String], default: [] },
    subject: { type: String },
    html: { type: String },
    attachments: { type: [attachmentSchema], default: [] },
    resendMessageId: { type: String },
    trackingToken: { type: String },
    deliveryStatus: {
      type: String,
      enum: ["SENT", "DELIVERED", "DELAYED", "FAILED"],
    },
    deliveredAt: { type: Date },
    deliveryFailedAt: { type: Date },
    deliveryFailureReason: { type: String },
    openedAt: { type: Date },
  },
  { timestamps: true, collection: "document_email_logs" },
);

// Historique d'un document, du plus récent au plus ancien
documentEmailLogSchema.index({
  workspaceId: 1,
  documentType: 1,
  documentId: 1,
  sentAt: -1,
});
// Webhook Resend (remise, ouverture) et pixel de suivi
documentEmailLogSchema.index({ resendMessageId: 1 }, { sparse: true });
documentEmailLogSchema.index({ trackingToken: 1 }, { sparse: true });

const DocumentEmailLog = mongoose.model(
  "DocumentEmailLog",
  documentEmailLogSchema,
);

export default DocumentEmailLog;
