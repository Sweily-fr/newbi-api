import mongoose from 'mongoose';

/**
 * Schéma pour les demandes de retrait des partenaires
 */
const withdrawalSchema = new mongoose.Schema(
  {
    partnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [0, 'Le montant doit être positif'],
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'rejected'],
      default: 'pending',
      index: true,
    },
    method: {
      type: String,
      enum: ['bank_transfer', 'paypal', 'stripe'],
      required: true,
    },
    bankDetails: {
      iban: String,
      bic: String,
      accountHolder: String,
    },
    paypalEmail: String,
    stripeAccountId: String,
    requestedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    processedAt: Date,
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    rejectionReason: String,
    notes: String,
  },
  {
    timestamps: true,
  }
);

// Index composé pour les requêtes fréquentes
withdrawalSchema.index({ partnerId: 1, status: 1 });
withdrawalSchema.index({ partnerId: 1, requestedAt: -1 });

const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

export default Withdrawal;
