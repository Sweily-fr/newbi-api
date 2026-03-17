import mongoose from 'mongoose';
import itemSchema from './schemas/item.js';
import customFieldSchema from './schemas/customField.js';
import bankDetailsSchema from './schemas/bankDetails.js';
import shippingSchema from './schemas/shipping.js';
import { applyBankDetailsEncryption } from '../utils/encryption.js';

const invoiceTemplateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Le nom du modèle est requis'],
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  items: [itemSchema],
  headerNotes: String,
  footerNotes: String,
  termsAndConditions: String,
  termsAndConditionsLink: String,
  termsAndConditionsLinkTitle: String,
  customFields: [customFieldSchema],
  discount: {
    type: Number,
    default: 0,
    min: 0
  },
  discountType: {
    type: String,
    enum: ['FIXED', 'PERCENTAGE'],
    default: 'FIXED'
  },
  invoiceType: {
    type: String,
    enum: ['standard', 'deposit', 'situation'],
    default: 'standard'
  },
  appearance: {
    textColor: { type: String, default: '#000000' },
    headerTextColor: { type: String, default: '#ffffff' },
    headerBgColor: { type: String, default: '#1d1d1b' }
  },
  clientPositionRight: {
    type: Boolean,
    default: false
  },
  isReverseCharge: {
    type: Boolean,
    default: false
  },
  showBankDetails: {
    type: Boolean,
    default: false
  },
  bankDetails: {
    type: bankDetailsSchema
  },
  shipping: {
    type: shippingSchema
  },
  prefix: {
    type: String,
    trim: true
  },
  retenueGarantie: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  escompte: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  operationType: {
    type: String,
    enum: ['LB', 'PS', 'LBPS', null],
    default: null
  },
  sourceInvoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Invoice'
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

invoiceTemplateSchema.index({ workspaceId: 1, createdAt: -1 });

// AES-256-GCM encryption for IBAN and BIC fields at rest
applyBankDetailsEncryption(invoiceTemplateSchema, ['bankDetails']);

const InvoiceTemplate = mongoose.model('InvoiceTemplate', invoiceTemplateSchema);

export default InvoiceTemplate;
