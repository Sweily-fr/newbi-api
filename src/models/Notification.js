import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    // Utilisateur destinataire de la notification
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Workspace associé
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    // Type de notification
    type: {
      type: String,
      required: true,
      enum: [
        "TASK_ASSIGNED", // Assignation de tâche Kanban
        "TASK_UNASSIGNED", // Désassignation de tâche
        "TASK_COMMENT", // Commentaire sur une tâche
        "TASK_DUE_SOON", // Tâche bientôt due
        "TASK_OVERDUE", // Tâche en retard
        "DOCUMENT_SHARED", // Document partagé
        "MEMBER_JOINED", // Nouveau membre
        "MENTION", // Mention dans un commentaire
        "PURCHASE_INVOICE_RECEIVED", // Facture d'achat reçue via e-invoicing (SuperPDP)
        "DOCUMENT_IMPORTED", // Document arrivé d'une plateforme externe (Qonto…)
      ],
      index: true,
    },
    // Titre de la notification
    title: {
      type: String,
      required: true,
    },
    // Message de la notification
    message: {
      type: String,
      required: true,
    },
    // Données supplémentaires selon le type
    data: {
      // Pour TASK_ASSIGNED / TASK_UNASSIGNED
      taskId: { type: mongoose.Schema.Types.ObjectId },
      taskTitle: { type: String },
      boardId: { type: mongoose.Schema.Types.ObjectId },
      boardName: { type: String },
      columnName: { type: String },
      // Utilisateur qui a déclenché la notification
      actorId: { type: mongoose.Schema.Types.ObjectId },
      actorName: { type: String },
      actorImage: { type: String },
      // URL pour accéder à l'élément
      url: { type: String },
      // Pour PURCHASE_INVOICE_RECEIVED (facture d'achat reçue)
      purchaseInvoiceId: { type: String },
      supplierName: { type: String },
      amountTTC: { type: Number },
      // Pour DOCUMENT_IMPORTED (document importé depuis une plateforme)
      documentType: { type: String }, // INVOICE | QUOTE | PURCHASE_INVOICE
      documentId: { type: String },
      documentNumber: { type: String },
      source: { type: String }, // QONTO…
    },
    // Statut de lecture
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
    // Date de lecture
    readAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  },
);

// Index composé pour les requêtes fréquentes
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, workspaceId: 1, createdAt: -1 });

// Méthode pour marquer comme lu
notificationSchema.methods.markAsRead = function () {
  this.read = true;
  this.readAt = new Date();
  return this.save();
};

// Méthode statique pour créer une notification d'assignation de tâche
notificationSchema.statics.createTaskAssignedNotification = async function ({
  userId,
  workspaceId,
  taskId,
  taskTitle,
  boardId,
  boardName,
  columnName,
  actorId,
  actorName,
  actorImage,
  url,
}) {
  return this.create({
    userId,
    workspaceId,
    type: "TASK_ASSIGNED",
    title: "Nouvelle tâche assignée",
    message: `${actorName} vous a assigné à la tâche "${taskTitle}"`,
    data: {
      taskId,
      taskTitle,
      boardId,
      boardName,
      columnName,
      actorId,
      actorName,
      actorImage,
      url,
    },
  });
};

// Méthode statique pour créer une notification de mention
notificationSchema.statics.createMentionNotification = async function ({
  userId,
  workspaceId,
  taskId,
  taskTitle,
  boardId,
  boardName,
  actorId,
  actorName,
  actorImage,
  commentExcerpt,
  url,
}) {
  return this.create({
    userId,
    workspaceId,
    type: "MENTION",
    title: "Vous avez été mentionné",
    message: `${actorName} vous a mentionné dans un commentaire sur "${taskTitle}"${commentExcerpt ? ` : "${commentExcerpt}"` : ""}`,
    data: {
      taskId,
      taskTitle,
      boardId,
      boardName,
      actorId,
      actorName,
      actorImage,
      url,
    },
  });
};

// Méthode statique pour créer une notification de facture d'achat reçue (e-invoicing)
notificationSchema.statics.createPurchaseInvoiceReceivedNotification =
  async function ({
    userId,
    workspaceId,
    purchaseInvoiceId,
    invoiceNumber,
    supplierName,
    amountTTC,
    url,
  }) {
    return this.create({
      userId,
      workspaceId,
      type: "PURCHASE_INVOICE_RECEIVED",
      title: "Nouvelle facture reçue",
      message:
        `${supplierName || "Un fournisseur"} vous a transmis la facture ${invoiceNumber || ""}`.trim(),
      data: {
        purchaseInvoiceId: purchaseInvoiceId
          ? String(purchaseInvoiceId)
          : undefined,
        supplierName,
        amountTTC,
        url: url || "/dashboard/outils/factures-achat",
      },
    });
  };

const DOCUMENT_LABELS = {
  INVOICE: { title: "Nouvelle facture reçue", noun: "La facture" },
  QUOTE: { title: "Nouveau devis reçu", noun: "Le devis" },
  PURCHASE_INVOICE: {
    title: "Nouvelle facture d'achat reçue",
    noun: "La facture d'achat",
  },
};

const SOURCE_LABELS = { QONTO: "Qonto", GMAIL: "Gmail", SUPERPDP: "la PDP" };

/**
 * Notification « document importé depuis une plateforme externe » (Qonto…).
 * Sert aussi au front pour rafraîchir la liste concernée en temps réel.
 */
notificationSchema.statics.createDocumentImportedNotification =
  async function ({
    userId,
    workspaceId,
    documentType,
    documentId,
    documentNumber,
    source,
    counterpartName,
    amountTTC,
    url,
  }) {
    const labels = DOCUMENT_LABELS[documentType] || DOCUMENT_LABELS.INVOICE;
    const sourceLabel = SOURCE_LABELS[source] || source || "une plateforme";
    return this.create({
      userId,
      workspaceId,
      type: "DOCUMENT_IMPORTED",
      title: labels.title,
      message:
        `${labels.noun} ${documentNumber || ""}${counterpartName ? ` (${counterpartName})` : ""} est arrivé${documentType === "QUOTE" ? "" : "e"} depuis ${sourceLabel}`.replace(
          /\s+/g,
          " ",
        ),
      data: {
        documentType,
        documentId: documentId ? String(documentId) : undefined,
        documentNumber,
        source,
        supplierName: counterpartName,
        amountTTC,
        url,
      },
    });
  };

const Notification = mongoose.model("Notification", notificationSchema);

export default Notification;
