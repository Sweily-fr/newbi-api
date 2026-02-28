import mongoose from 'mongoose';

const processedEmailSchema = new mongoose.Schema({
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  gmailConnectionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GmailConnection',
    required: true,
    index: true
  },
  gmailMessageId: {
    type: String,
    required: true
  },
  gmailThreadId: {
    type: String,
    default: null
  },
  subject: {
    type: String,
    default: ''
  },
  from: {
    type: String,
    default: ''
  },
  receivedAt: {
    type: Date,
    default: null
  },
  hasInvoice: {
    type: Boolean,
    default: false
  },
  attachmentCount: {
    type: Number,
    default: 0
  },
  invoiceAttachments: [{
    filename: { type: String },
    mimeType: { type: String },
    size: { type: Number },
    importedInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportedInvoice', default: null }
  }],
  status: {
    type: String,
    enum: ['processed', 'skipped', 'error'],
    default: 'processed'
  },
  errorMessage: {
    type: String,
    default: null
  },
  processedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  collection: 'processed_emails'
});

// Unique index to prevent double-processing
processedEmailSchema.index({ workspaceId: 1, gmailMessageId: 1 }, { unique: true });
processedEmailSchema.index({ gmailConnectionId: 1, processedAt: -1 });

const ProcessedEmail = mongoose.model('ProcessedEmail', processedEmailSchema);

export default ProcessedEmail;
