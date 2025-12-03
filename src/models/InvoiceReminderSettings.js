import mongoose from 'mongoose';

const invoiceReminderSettingsSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    unique: true,
  },
  enabled: {
    type: Boolean,
    default: false,
  },
  firstReminderDays: {
    type: Number,
    default: 7,
    min: 0, // 0 = envoi le jour même de l'échéance
  },
  secondReminderDays: {
    type: Number,
    default: 14,
    min: 0, // 0 = envoi le jour même de l'échéance
  },
  reminderHour: {
    type: Number,
    default: 9, // 9h00 par défaut
    min: 0,
    max: 23,
  },
  useCustomSender: {
    type: Boolean,
    default: false,
  },
  customSenderEmail: {
    type: String,
    default: '',
  },
  fromEmail: {
    type: String,
    default: '',
  },
  fromName: {
    type: String,
    default: '',
  },
  replyTo: {
    type: String,
    default: '',
  },
  excludedClientIds: {
    type: [mongoose.Schema.Types.ObjectId],
    ref: 'Client',
    default: [],
  },
  emailSubject: {
    type: String,
    default: 'Rappel de paiement - Facture {invoiceNumber}',
  },
  emailBody: {
    type: String,
    default: `Bonjour {clientName},

Nous vous rappelons que la facture {invoiceNumber} d'un montant de {totalAmount} est arrivée à échéance le {dueDate}.

Nous vous remercions de bien vouloir procéder au règlement dans les plus brefs délais.

Cordialement,
{companyName}`,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Mettre à jour updatedAt avant chaque sauvegarde
invoiceReminderSettingsSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const InvoiceReminderSettings = mongoose.model('InvoiceReminderSettings', invoiceReminderSettingsSchema);

export default InvoiceReminderSettings;
