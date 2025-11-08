import mongoose from 'mongoose';

const emailLogSchema = new mongoose.Schema({
  // Référence vers l'événement
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Event',
    required: true,
    index: true
  },
  
  // Référence vers l'organisation
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  
  // Destinataire
  recipientEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  
  recipientUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Type de rappel
  reminderType: {
    type: String,
    enum: ['due', 'anticipated'],
    required: true
  },
  
  // Anticipation (si applicable)
  anticipation: {
    type: String,
    enum: [null, '1h', '3h', '1d', '3d'],
    default: null
  },
  
  // Statut d'envoi
  status: {
    type: String,
    enum: ['sent', 'failed', 'deferred'],
    required: true
  },
  
  // Détails de l'envoi
  sentAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  
  scheduledFor: {
    type: Date,
    required: true
  },
  
  // Raison d'échec ou de report
  failureReason: {
    type: String,
    default: null
  },
  
  deferredReason: {
    type: String,
    default: null
  },
  
  // Informations de l'événement (snapshot)
  eventSnapshot: {
    title: String,
    description: String,
    start: Date,
    end: Date
  },
  
  // Métadonnées
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index composés pour les requêtes fréquentes
emailLogSchema.index({ workspaceId: 1, createdAt: -1 });
emailLogSchema.index({ workspaceId: 1, status: 1 });
emailLogSchema.index({ recipientUserId: 1, createdAt: -1 });

const EmailLog = mongoose.model('EmailLog', emailLogSchema);
export default EmailLog;
