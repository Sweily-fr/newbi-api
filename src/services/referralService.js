import User from '../models/User.js';
import StripeConnectAccount from '../models/StripeConnectAccount.js';
import ReferralEvent from '../models/ReferralEvent.js';
import logger from '../utils/logger.js';
import { transferToStripeConnect } from './stripeConnectService.js';
import { sendReferralThankYouEmail } from '../utils/mailer.js';

/**
 * Traiter le paiement de parrainage lorsqu'un filleul souscrit à un abonnement annuel
 */
export const processReferralPayout = async (referredUserId, subscriptionId, subscriptionAmount) => {
  try {
    logger.info('🎯 Début traitement paiement parrainage', {
      referredUserId,
      subscriptionId,
      subscriptionAmount
    });

    // Récupérer l'utilisateur filleul
    const referredUser = await User.findById(referredUserId);
    if (!referredUser) {
      throw new Error('Utilisateur filleul non trouvé');
    }

    // Vérifier si l'utilisateur a été parrainé
    if (!referredUser.referredBy) {
      logger.info('❌ Utilisateur non parrainé, pas de paiement à effectuer', {
        referredUserId
      });
      return { success: true, message: 'Utilisateur non parrainé' };
    }

    // Trouver le parrain
    const referrer = await User.findOne({ referralCode: referredUser.referredBy });
    if (!referrer) {
      logger.error('❌ Parrain non trouvé', {
        referralCode: referredUser.referredBy,
        referredUserId
      });
      throw new Error('Parrain non trouvé');
    }

    // Chercher le compte Stripe Connect du parrain
    const stripeConnectAccount = await StripeConnectAccount.findOne({ userId: referrer._id });
    
    // Vérifier si le parrain a un compte Stripe Connect configuré
    if (!stripeConnectAccount || !stripeConnectAccount.chargesEnabled || !stripeConnectAccount.payoutsEnabled) {
      logger.error('❌ Parrain sans compte Stripe Connect configuré', {
        referrerId: referrer._id,
        referralCode: referredUser.referredBy
      });
      
      // Créer un événement d'échec
      await ReferralEvent.create({
        type: 'REFERRAL_PAYOUT_FAILED',
        referrerId: referrer._id,
        referredUserId: referredUser._id,
        referralCode: referredUser.referredBy,
        amount: 50,
        subscriptionId,
        paymentStatus: 'FAILED',
        metadata: {
          reason: 'Stripe Connect non configuré',
          subscriptionAmount
        }
      });

      throw new Error('Parrain sans compte Stripe Connect configuré');
    }

    // Vérifier s'il n'y a pas déjà un paiement en cours pour cette souscription
    const existingEvent = await ReferralEvent.findOne({
      referredUserId: referredUser._id,
      subscriptionId,
      type: { $in: ['REFERRAL_SUBSCRIPTION', 'REFERRAL_PAYOUT'] }
    });

    if (existingEvent) {
      logger.info('✅ Paiement de parrainage déjà traité', {
        existingEventId: existingEvent._id,
        subscriptionId
      });
      return { success: true, message: 'Paiement déjà traité' };
    }

    // Créer l'événement de souscription
    const subscriptionEvent = await ReferralEvent.createReferralSubscriptionEvent(
      referrer._id,
      referredUser._id,
      referredUser.referredBy,
      subscriptionId
    );

    logger.info('✅ Événement de souscription créé', {
      eventId: subscriptionEvent._id,
      referrerId: referrer._id,
      referredUserId: referredUser._id
    });

    // Effectuer le virement de 50€ depuis le solde Stripe de Newbi vers le parrain
    const payoutAmount = 50; // 50€ fixe
    
    logger.info('💰 Début du virement de parrainage depuis le solde Newbi', {
      referrerId: referrer._id,
      referrerEmail: referrer.email,
      stripeAccountId: stripeConnectAccount.accountId,
      amount: payoutAmount,
      referredUserEmail: referredUser.email
    });
    
    const transferResult = await transferToStripeConnect(
      stripeConnectAccount.accountId,
      payoutAmount * 100, // Stripe utilise les centimes
      'eur',
      {
        description: `Récompense parrainage Newbi - Filleul: ${referredUser.email}`,
        referralEventId: subscriptionEvent._id.toString(),
        referredUserId: referredUser._id.toString(),
        subscriptionId,
        referrerEmail: referrer.email,
        payoutType: 'referral_reward'
      }
    );

    if (!transferResult.success) {
      // Marquer l'événement comme échoué
      await ReferralEvent.updatePayoutStatus(subscriptionEvent._id, 'FAILED');
      
      logger.error('❌ Échec du virement Stripe Connect', {
        error: transferResult.error,
        referrerId: referrer._id,
        amount: payoutAmount
      });
      
      throw new Error(`Échec du virement: ${transferResult.error}`);
    }

    // Créer l'événement de paiement
    const payoutEvent = await ReferralEvent.createReferralPayoutEvent(
      referrer._id,
      referredUser._id,
      referredUser.referredBy,
      transferResult.transferId,
      payoutAmount
    );

    // Marquer l'événement de souscription comme complété
    await ReferralEvent.updatePayoutStatus(subscriptionEvent._id, 'COMPLETED');

    // Mettre à jour les gains du parrain
    await User.findByIdAndUpdate(referrer._id, {
      $inc: { referralEarnings: payoutAmount }
    });

    logger.info('✅ Paiement de parrainage traité avec succès', {
      referrerId: referrer._id,
      referredUserId: referredUser._id,
      amount: payoutAmount,
      transferId: transferResult.transferId,
      payoutEventId: payoutEvent._id
    });

    // Envoyer un email de remerciement au parrain (asynchrone)
    setTimeout(async () => {
      try {
        await sendReferralThankYouEmail(referrer, referredUser, payoutAmount);
        logger.info('✅ Email de remerciement envoyé au parrain', {
          referrerId: referrer._id,
          referrerEmail: referrer.email
        });
      } catch (emailError) {
        logger.error('❌ Erreur envoi email remerciement parrain:', emailError);
      }
    }, 1000);

    return {
      success: true,
      message: 'Paiement de parrainage traité avec succès',
      transferId: transferResult.transferId,
      amount: payoutAmount,
      referrer: {
        id: referrer._id,
        email: referrer.email,
        referralCode: referrer.referralCode
      }
    };

  } catch (error) {
    logger.error('❌ Erreur traitement paiement parrainage:', error);
    throw error;
  }
};

/**
 * Créer un événement d'inscription de parrainage
 */
export const createReferralSignupEvent = async (referrerId, referredUserId, referralCode) => {
  try {
    const event = await ReferralEvent.createReferralSignupEvent(
      referrerId,
      referredUserId,
      referralCode
    );

    logger.info('✅ Événement d\'inscription de parrainage créé', {
      eventId: event._id,
      referrerId,
      referredUserId,
      referralCode
    });

    return event;
  } catch (error) {
    logger.error('❌ Erreur création événement inscription parrainage:', error);
    throw error;
  }
};

/**
 * Vérifier et traiter les parrainages en attente pour un utilisateur
 */
export const checkPendingReferrals = async (userId) => {
  try {
    const user = await User.findById(userId);
    if (!user || !user.referredBy) {
      return { success: true, message: 'Aucun parrainage en attente' };
    }

    // Vérifier si l'utilisateur a un abonnement annuel actif
    const hasAnnualSubscription = user.subscription && 
                                 user.subscription.status === 'active' &&
                                 user.subscription.interval === 'year';

    if (!hasAnnualSubscription) {
      logger.info('🔍 Utilisateur parrainé sans abonnement annuel', {
        userId,
        subscriptionStatus: user.subscription?.status,
        subscriptionInterval: user.subscription?.interval
      });
      return { success: true, message: 'Pas d\'abonnement annuel' };
    }

    // Traiter le paiement de parrainage
    const result = await processReferralPayout(
      userId,
      user.subscription.stripeSubscriptionId || 'manual',
      user.subscription.amount || 0
    );

    return result;
  } catch (error) {
    logger.error('❌ Erreur vérification parrainages en attente:', error);
    throw error;
  }
};

/**
 * Programmer un paiement de parrainage avec délai de 7 jours
 */
export const scheduleReferralPayout = async (userId, subscriptionId, invoiceAmount) => {
  try {
    logger.info('📅 Programmation du paiement de parrainage avec délai de 7 jours', {
      userId,
      subscriptionId,
      invoiceAmount
    });

    // Récupérer l'utilisateur et son parrain
    const user = await User.findById(userId);
    if (!user || !user.referredBy) {
      logger.error('❌ Utilisateur non trouvé ou non parrainé', { userId });
      return;
    }

    const referrer = await User.findOne({ referralCode: user.referredBy });
    if (!referrer) {
      logger.error('❌ Parrain non trouvé', { referralCode: user.referredBy });
      return;
    }

    // Calculer la date d'exécution (7 jours après maintenant)
    const scheduledFor = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // Créer l'événement de parrainage programmé
    const referralEvent = await ReferralEvent.create({
      type: 'REFERRAL_PAYOUT',
      referrerId: referrer._id,
      referredUserId: user._id,
      referralCode: user.referredBy,
      amount: 50, // Montant fixe de 50€
      currency: 'EUR',
      paymentStatus: 'SCHEDULED',
      scheduledFor: scheduledFor,
      subscriptionId: subscriptionId,
      metadata: {
        invoiceAmount: invoiceAmount,
        scheduledDate: scheduledFor.toISOString()
      }
    });

    logger.info('✅ Paiement de parrainage programmé avec succès', {
      eventId: referralEvent._id,
      referrerId: referrer._id,
      referredUserId: user._id,
      amount: 50,
      scheduledFor: scheduledFor.toISOString(),
      daysDelay: 7
    });

    // L'email sera envoyé lors du traitement réel du paiement après 7 jours
    logger.info('📧 Email de remerciement sera envoyé lors du traitement du paiement', {
      referrerId: referrer._id,
      referrerEmail: referrer.email,
      scheduledFor: scheduledFor.toISOString()
    });

    return referralEvent;

  } catch (error) {
    logger.error('❌ Erreur lors de la programmation du paiement de parrainage', {
      error: error.message,
      userId,
      subscriptionId
    });
    throw error;
  }
};
