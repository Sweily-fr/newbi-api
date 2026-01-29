import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  // Utilisateur destinataire de la notification
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
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
      'TASK_ASSIGNED',      // Assignation de tâche Kanban
      'TASK_UNASSIGNED',    // Désassignation de tâche
      'TASK_COMMENT',       // Commentaire sur une tâche
      'TASK_DUE_SOON',      // Tâche bientôt due
      'TASK_OVERDUE',       // Tâche en retard
      'DOCUMENT_SHARED',    // Document partagé
      'MEMBER_JOINED',      // Nouveau membre
      'MENTION',            // Mention dans un commentaire
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
}, {
  timestamps: true,
});

// Index composé pour les requêtes fréquentes
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });

// Méthode pour marquer comme lu
notificationSchema.methods.markAsRead = function() {
  this.read = true;
  this.readAt = new Date();
  return this.save();
};

// Méthode statique pour créer une notification d'assignation de tâche
notificationSchema.statics.createTaskAssignedNotification = async function({
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
    type: 'TASK_ASSIGNED',
    title: 'Nouvelle tâche assignée',
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

const Notification = mongoose.model('Notification', notificationSchema);

export default Notification;
