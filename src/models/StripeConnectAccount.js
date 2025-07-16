import mongoose from 'mongoose';

const stripeConnectAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    accountId: {
      type: String,
      required: true,
      unique: true
    },
    isOnboarded: {
      type: Boolean,
      default: false
    },
    chargesEnabled: {
      type: Boolean,
      default: false
    },
    payoutsEnabled: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

// Créer un index composé pour éviter les doublons
stripeConnectAccountSchema.index({ userId: 1 }, { unique: true });

const StripeConnectAccount = mongoose.model('StripeConnectAccount', stripeConnectAccountSchema);

export default StripeConnectAccount;
