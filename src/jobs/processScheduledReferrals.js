/**
 * Job pour traiter les paiements de parrainage programmés
 */

import ReferralEvent from '../models/ReferralEvent.js';
import User from '../models/User.js';
import StripeConnectAccount from '../models/StripeConnectAccount.js';
import logger from '../utils/logger.js';
import { transferToStripeConnect } from '../services/stripeConnectService.js';
import { sendReferralThankYouEmail } from '../utils/mailer.js';

/**
 * Traite les paiements de parrainage programmés qui sont dus
 */
export const processScheduledReferrals = async () => {
  try {
    logger.info('🔄 Début du traitement des paiements de parrainage programmés');

    // Récupérer tous les événements programmés dont la date d'exécution est passée
    const now = new Date();
    const scheduledEvents = await ReferralEvent.find({
      paymentStatus: 'SCHEDULED',
      scheduledFor: { $lte: now }
    }).populate('referrerId referredUserId');

    if (scheduledEvents.length === 0) {
      logger.info('✅ Aucun paiement de parrainage programmé à traiter');
      return { processed: 0, errors: 0 };
    }

    logger.info(`🎯 ${scheduledEvents.length} paiement(s) de parrainage à traiter`);

    let processed = 0;
    let errors = 0;

    for (const event of scheduledEvents) {
      try {
        await processScheduledReferralEvent(event);
        processed++;
      } catch (error) {
        logger.error('❌ Erreur traitement événement programmé:', {
          eventId: event._id,
          error: error.message
        });
        errors++;
      }
    }

    logger.info('✅ Traitement des paiements programmés terminé', {
      processed,
      errors,
      total: scheduledEvents.length
    });

    return { processed, errors };

  } catch (error) {
    logger.error('❌ Erreur générale lors du traitement des paiements programmés:', error);
    throw error;
  }
};

/**
 * Traite un événement de parrainage programmé spécifique
 */
const processScheduledReferralEvent = async (event) => {
  logger.info('💰 Traitement paiement programmé', {
    eventId: event._id,
    referrerId: event.referrerId._id,
    referredUserId: event.referredUserId._id,
    amount: event.amount
  });

  // Marquer comme en cours de traitement
  await ReferralEvent.findByIdAndUpdate(event._id, {
    paymentStatus: 'PROCESSING'
  });

  // Vérifier que le parrain a toujours un compte Stripe Connect configuré
  const stripeConnectAccount = await StripeConnectAccount.findOne({ 
    userId: event.referrerId._id 
  });
  
  if (!stripeConnectAccount || !stripeConnectAccount.chargesEnabled || !stripeConnectAccount.payoutsEnabled) {
    logger.error('❌ Parrain sans compte Stripe Connect configuré', {
      referrerId: event.referrerId._id,
      eventId: event._id
    });
    
    await ReferralEvent.findByIdAndUpdate(event._id, {
      paymentStatus: 'FAILED',
      metadata: {
        ...event.metadata,
        failureReason: 'Stripe Connect non configuré'
      }
    });
    
    throw new Error('Parrain sans compte Stripe Connect configuré');
  }

  // Effectuer le virement
  const transferResult = await transferToStripeConnect(
    stripeConnectAccount.accountId,
    event.amount * 100, // Stripe utilise les centimes
    'eur',
    {
      description: `Récompense parrainage Newbi - Filleul: ${event.referredUserId.email}`,
      referralEventId: event._id.toString(),
      referredUserId: event.referredUserId._id.toString(),
      subscriptionId: event.subscriptionId,
      referrerEmail: event.referrerId.email,
      payoutType: 'referral_reward_scheduled'
    }
  );

  if (!transferResult.success) {
    logger.error('❌ Échec du virement Stripe Connect programmé', {
      error: transferResult.error,
      eventId: event._id,
      referrerId: event.referrerId._id
    });
    
    await ReferralEvent.findByIdAndUpdate(event._id, {
      paymentStatus: 'FAILED',
      metadata: {
        ...event.metadata,
        failureReason: transferResult.error
      }
    });
    
    throw new Error(`Échec du virement: ${transferResult.error}`);
  }

  // Marquer comme complété
  await ReferralEvent.findByIdAndUpdate(event._id, {
    paymentStatus: 'COMPLETED',
    stripeTransferId: transferResult.transferId,
    processedAt: new Date(),
    metadata: {
      ...event.metadata,
      transferId: transferResult.transferId,
      processedDate: new Date().toISOString()
    }
  });

  // Mettre à jour les gains du parrain
  await User.findByIdAndUpdate(event.referrerId._id, {
    $inc: { referralEarnings: event.amount }
  });

  logger.info('✅ Paiement de parrainage programmé traité avec succès', {
    eventId: event._id,
    referrerId: event.referrerId._id,
    referredUserId: event.referredUserId._id,
    amount: event.amount,
    transferId: transferResult.transferId
  });

  // Envoyer l'email de remerciement au parrain
  try {
    await sendReferralThankYouEmail(event.referrerId, event.referredUserId, event.amount);
    logger.info('✅ Email de remerciement envoyé au parrain', {
      referrerId: event.referrerId._id,
      referrerEmail: event.referrerId.email,
      eventId: event._id
    });
  } catch (emailError) {
    logger.error('❌ Erreur envoi email remerciement parrain (paiement traité):', {
      error: emailError.message,
      eventId: event._id,
      referrerId: event.referrerId._id
    });
    // Ne pas faire échouer le paiement si l'email échoue
  }
};
