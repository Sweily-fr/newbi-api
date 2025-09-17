import mongoose from 'mongoose';

const referralEventSchema = new mongoose.Schema({
  // Type d'événement de parrainage
  type: {
    type: String,
    enum: [
      'REFERRAL_SIGNUP', // Inscription via lien de parrainage
      'REFERRAL_SUBSCRIPTION', // Souscription d'abonnement annuel par le filleul
      'REFERRAL_PAYOUT', // Paiement effectué au parrain
      'REFERRAL_PAYOUT_FAILED' // Échec du paiement au parrain
    ],
    required: true
  },
  
  // Référence vers le parrain (utilisateur qui parraine)
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Référence vers le filleul (utilisateur parrainé)
  referredUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  
  // Code de parrainage utilisé
  referralCode: {
    type: String,
    required: true,
    index: true
  },
  
  // Montant du parrainage (50€ par défaut)
  amount: {
    type: Number,
    default: 50,
    required: true
  },
  
  // Devise
  currency: {
    type: String,
    default: 'EUR',
    required: true
  },
  
  // Statut du paiement
  paymentStatus: {
    type: String,
    enum: ['PENDING', 'SCHEDULED', 'PROCESSING', 'COMPLETED', 'FAILED'],
    default: 'PENDING'
  },
  
  scheduledFor: {
    type: Date,
    default: null
  },
  
  // ID de la transaction Stripe (pour les paiements)
  stripeTransferId: {
    type: String,
    sparse: true
  },
  
  // ID de l'abonnement qui a déclenché le parrainage
  subscriptionId: {
    type: String,
    sparse: true
  },
  
  // Métadonnées additionnelles
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Dates
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index composés pour optimiser les requêtes
referralEventSchema.index({ referrerId: 1, type: 1 });
referralEventSchema.index({ referredUserId: 1, type: 1 });
referralEventSchema.index({ referralCode: 1, type: 1 });
referralEventSchema.index({ paymentStatus: 1, createdAt: 1 });

// Middleware pour mettre à jour updatedAt
referralEventSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Méthodes statiques
referralEventSchema.statics.createReferralSignupEvent = async function(referrerId, referredUserId, referralCode) {
  try {
    const event = new this({
      type: 'REFERRAL_SIGNUP',
      referrerId,
      referredUserId,
      referralCode,
      amount: 0, // Pas de paiement à l'inscription
      paymentStatus: 'COMPLETED'
    });
    
    return await event.save();
  } catch (error) {
    console.error('Erreur lors de la création de l\'événement d\'inscription de parrainage:', error);
    throw error;
  }
};

referralEventSchema.statics.createReferralSubscriptionEvent = async function(referrerId, referredUserId, referralCode, subscriptionId) {
  try {
    const event = new this({
      type: 'REFERRAL_SUBSCRIPTION',
      referrerId,
      referredUserId,
      referralCode,
      amount: 50, // 50€ de récompense
      subscriptionId,
      paymentStatus: 'PENDING'
    });
    
    return await event.save();
  } catch (error) {
    console.error('Erreur lors de la création de l\'événement d\'abonnement de parrainage:', error);
    throw error;
  }
};

referralEventSchema.statics.createReferralPayoutEvent = async function(referrerId, referredUserId, referralCode, stripeTransferId, amount = 50) {
  try {
    const event = new this({
      type: 'REFERRAL_PAYOUT',
      referrerId,
      referredUserId,
      referralCode,
      amount,
      stripeTransferId,
      paymentStatus: 'PROCESSING'
    });
    
    return await event.save();
  } catch (error) {
    console.error('Erreur lors de la création de l\'événement de paiement de parrainage:', error);
    throw error;
  }
};

referralEventSchema.statics.updatePayoutStatus = async function(eventId, status, stripeTransferId = null) {
  try {
    const updateData = { paymentStatus: status };
    if (stripeTransferId) {
      updateData.stripeTransferId = stripeTransferId;
    }
    
    return await this.findByIdAndUpdate(eventId, updateData, { new: true });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du statut de paiement:', error);
    throw error;
  }
};

referralEventSchema.statics.getReferralStats = async function(referrerId) {
  try {
    const stats = await this.aggregate([
      { $match: { referrerId: new mongoose.Types.ObjectId(referrerId) } },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' }
        }
      }
    ]);
    
    return stats;
  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques de parrainage:', error);
    throw error;
  }
};

const ReferralEvent = mongoose.model('ReferralEvent', referralEventSchema);
export default ReferralEvent;
