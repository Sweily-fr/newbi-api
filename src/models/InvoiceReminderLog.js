import mongoose from 'mongoose';

const invoiceReminderLogSchema = new mongoose.Schema({
  invoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice',
    required: true,
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
  },
  reminderType: {
    type: String,
    enum: ['FIRST', 'SECOND'],
    required: true,
  },
  sentAt: {
    type: Date,
    default: Date.now,
  },
  recipientEmail: {
    type: String,
    required: true,
  },
  emailSubject: {
    type: String,
    required: true,
  },
  emailBody: {
    type: String,
    required: true,
  },
  status: {
    type: String,
    enum: ['SENT', 'FAILED'],
    default: 'SENT',
  },
  error: {
    type: String,
    default: null,
  },
});

// Index pour rechercher rapidement les relances d'une facture
invoiceReminderLogSchema.index({ invoiceId: 1, reminderType: 1 });
invoiceReminderLogSchema.index({ workspaceId: 1, sentAt: -1 });

const InvoiceReminderLog = mongoose.model('InvoiceReminderLog', invoiceReminderLogSchema);

export default InvoiceReminderLog;
