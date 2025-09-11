import Stripe from 'stripe';
import FileTransfer from '../models/FileTransfer.js';
import AccessGrant from '../models/AccessGrant.js';
import logger from '../utils/logger.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    // Vérifier la signature du webhook
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    logger.info('✅ Webhook Stripe vérifié', { type: event.type, id: event.id });
  } catch (err) {
    logger.error('❌ Erreur vérification webhook Stripe:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Traiter l'événement selon son type
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object);
        break;
      
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object);
        break;
      
      default:
        logger.info(`🔔 Événement Stripe non géré: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('❌ Erreur traitement webhook Stripe:', error);
    res.status(500).json({ error: 'Erreur interne serveur' });
  }
};

async function handleCheckoutSessionCompleted(session) {
  logger.info('🎯 Traitement checkout.session.completed', { sessionId: session.id });
  console.log('🔍 Session complète reçue:', JSON.stringify(session, null, 2));

  try {
    // Extraire les métadonnées de la session
    const { transferId, fileId } = session.metadata || {};
    
    if (!transferId) {
      logger.error('❌ transferId manquant dans les métadonnées', { sessionId: session.id });
      return;
    }

    // Récupérer le transfert
    const fileTransfer = await FileTransfer.findById(transferId);
    if (!fileTransfer) {
      logger.error('❌ FileTransfer non trouvé', { transferId, sessionId: session.id });
      return;
    }

    // Vérifier si un AccessGrant existe déjà pour cette session
    const existingGrant = await AccessGrant.findOne({ stripeSessionId: session.id });
    if (existingGrant) {
      logger.info('✅ AccessGrant déjà existant', { 
        grantId: existingGrant._id, 
        sessionId: session.id 
      });
      return;
    }

    // Créer l'AccessGrant
    const accessGrant = await AccessGrant.createFromStripeSession({
      sessionId: session.id,
      transferId: transferId,
      fileId: fileId || null, // null = accès à tous les fichiers
      buyerEmail: session.customer_details?.email || session.customer_email,
      paidAmount: session.amount_total / 100, // Stripe utilise les centimes
      currency: session.currency,
      buyerIp: session.customer_details?.address?.country || null,
      buyerUserAgent: null // Pas disponible dans le webhook
    });

    // Marquer le transfert comme payé
    fileTransfer.isPaid = true;
    fileTransfer.paidAt = new Date();
    fileTransfer.stripeSessionId = session.id;
    fileTransfer.paymentIntentId = session.payment_intent;
    await fileTransfer.save();

    logger.info('✅ Paiement traité avec succès', {
      transferId: transferId,
      accessGrantId: accessGrant._id,
      buyerEmail: accessGrant.buyerEmail,
      amount: accessGrant.paidAmount,
      currency: accessGrant.currency
    });

  } catch (error) {
    logger.error('❌ Erreur handleCheckoutSessionCompleted:', error);
    throw error;
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  logger.info('💰 Traitement payment_intent.succeeded', { 
    paymentIntentId: paymentIntent.id 
  });

  try {
    // Mettre à jour l'AccessGrant avec l'ID du PaymentIntent
    const accessGrant = await AccessGrant.findOne({ 
      stripeSessionId: paymentIntent.metadata?.sessionId 
    });

    if (accessGrant) {
      accessGrant.stripePaymentIntentId = paymentIntent.id;
      await accessGrant.save();
      
      logger.info('✅ AccessGrant mis à jour avec PaymentIntent', {
        accessGrantId: accessGrant._id,
        paymentIntentId: paymentIntent.id
      });
    }
  } catch (error) {
    logger.error('❌ Erreur handlePaymentIntentSucceeded:', error);
  }
}

async function handlePaymentIntentFailed(paymentIntent) {
  logger.info('❌ Traitement payment_intent.payment_failed', { 
    paymentIntentId: paymentIntent.id 
  });

  try {
    // Marquer l'AccessGrant comme révoqué si le paiement échoue
    const accessGrant = await AccessGrant.findOne({ 
      stripeSessionId: paymentIntent.metadata?.sessionId 
    });

    if (accessGrant) {
      accessGrant.status = 'revoked';
      accessGrant.stripePaymentIntentId = paymentIntent.id;
      await accessGrant.save();
      
      logger.info('✅ AccessGrant révoqué suite à échec paiement', {
        accessGrantId: accessGrant._id,
        paymentIntentId: paymentIntent.id
      });
    }

    // Marquer le transfert comme non payé
    const fileTransfer = await FileTransfer.findOne({ 
      paymentIntentId: paymentIntent.id 
    });
    
    if (fileTransfer) {
      fileTransfer.isPaid = false;
      fileTransfer.paidAt = null;
      await fileTransfer.save();
    }

  } catch (error) {
    logger.error('❌ Erreur handlePaymentIntentFailed:', error);
  }
}
