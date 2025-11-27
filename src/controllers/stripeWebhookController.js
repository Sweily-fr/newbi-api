import Stripe from 'stripe';
import FileTransfer from '../models/FileTransfer.js';
import AccessGrant from '../models/AccessGrant.js';
import User from '../models/User.js';
import PartnerCommission from '../models/PartnerCommission.js';
import logger from '../utils/logger.js';
import { sendFileTransferPaymentNotification } from '../utils/mailer.js';

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
    
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object);
      break;
    
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionChange(event.data.object);
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
  logger.debug('🔍 Session complète reçue:', JSON.stringify(session, null, 2));

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

    // Envoyer une notification par email à l'expéditeur du fichier
    try {
      // Récupérer l'utilisateur expéditeur
      const sender = await User.findById(fileTransfer.userId);
      if (sender && sender.email) {
        const paymentData = {
          buyerEmail: accessGrant.buyerEmail,
          paidAmount: accessGrant.paidAmount,
          currency: accessGrant.currency,
          files: fileTransfer.files,
          transferId: fileTransfer._id,
          paymentDate: new Date()
        };

        const emailSent = await sendFileTransferPaymentNotification(sender.email, paymentData);
        
        if (emailSent) {
          logger.info('✅ Email de notification envoyé à l\'expéditeur', {
            senderEmail: sender.email,
            transferId: transferId
          });
        } else {
          logger.warn('⚠️ Échec envoi email de notification à l\'expéditeur', {
            senderEmail: sender.email,
            transferId: transferId
          });
        }
      } else {
        logger.warn('⚠️ Expéditeur non trouvé ou email manquant', {
          userId: fileTransfer.userId,
          transferId: transferId
        });
      }
    } catch (emailError) {
      logger.error('❌ Erreur lors de l\'envoi de l\'email de notification:', emailError);
      // Ne pas faire échouer le webhook pour une erreur d'email
    }

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

/**
 * Gérer les paiements de factures Stripe (abonnements)
 */
async function handleInvoicePaymentSucceeded(invoice) {
  logger.info('💰 Traitement invoice.payment_succeeded', { 
    invoiceId: invoice.id,
    customerId: invoice.customer,
    subscriptionId: invoice.subscription
  });

  try {
    // Vérifier si c'est un abonnement annuel
    if (!invoice.subscription) {
      logger.info('🔍 Facture sans abonnement, pas de parrainage à traiter');
      return;
    }

    // Récupérer les détails de l'abonnement
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    
    // Vérifier si c'est un abonnement annuel
    const isAnnualSubscription = subscription.items.data.some(item => 
      item.price.recurring && item.price.recurring.interval === 'year'
    );

    if (!isAnnualSubscription) {
      logger.info('🔍 Abonnement non annuel, pas de parrainage à traiter', {
        subscriptionId: subscription.id,
        interval: subscription.items.data[0]?.price?.recurring?.interval
      });
      return;
    }

    // Vérifier si c'est le premier paiement réel (après la période d'essai)
    // Pendant la période d'essai, amount_paid = 0
    if (invoice.amount_paid === 0) {
      logger.info('🔍 Paiement de 0€ (période d\'essai), pas de parrainage à traiter', {
        invoiceId: invoice.id,
        amountPaid: invoice.amount_paid,
        subscriptionId: subscription.id
      });
      return;
    }

    // Vérifier si c'est bien le premier paiement de cet abonnement
    // (pour éviter de payer plusieurs fois pour le même abonnement)
    const invoices = await stripe.invoices.list({
      subscription: invoice.subscription,
      status: 'paid',
      limit: 10
    });

    const paidInvoices = invoices.data.filter(inv => inv.amount_paid > 0);
    const isFirstPaidInvoice = paidInvoices.length === 1 && paidInvoices[0].id === invoice.id;

    if (!isFirstPaidInvoice) {
      logger.info('🔍 Pas le premier paiement de cet abonnement, pas de parrainage à traiter', {
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
        paidInvoicesCount: paidInvoices.length
      });
      return;
    }

    // Récupérer l'utilisateur par son customer ID Stripe
    const user = await User.findOne({ 'subscription.stripeCustomerId': invoice.customer });
    if (!user) {
      logger.info('🔍 Utilisateur non trouvé pour ce customer ID', {
        customerId: invoice.customer
      });
      return;
    }

    // Vérifier si l'utilisateur a été parrainé
    if (!user.referredBy) {
      logger.info('🔍 Utilisateur non parrainé, pas de commission à créer', {
        userId: user._id
      });
      return;
    }

    // Trouver le partenaire qui a parrainé cet utilisateur
    const partner = await User.findOne({ 
      referralCode: user.referredBy,
      isPartner: true 
    });

    if (!partner) {
      logger.warn('⚠️  Code de parrainage invalide ou partenaire non trouvé', {
        referredBy: user.referredBy,
        userId: user._id
      });
      return;
    }

    // Calculer le CA cumulé du partenaire (commissions confirmées/payées)
    const existingCommissions = await PartnerCommission.find({
      partnerId: partner._id,
      status: { $in: ['confirmed', 'paid'] }
    });

    const cumulativeRevenue = existingCommissions.reduce((sum, c) => sum + (c.paymentAmount || 0), 0);
    const paymentAmount = invoice.amount_paid / 100; // Convertir de centimes en euros
    const newCumulativeRevenue = cumulativeRevenue + paymentAmount;

    // Paliers de commission
    const tiers = [
      { min: 0, max: 1000, rate: 20, name: 'Bronze 🥉' },
      { min: 1000, max: 5000, rate: 25, name: 'Argent 🥈' },
      { min: 5000, max: 10000, rate: 30, name: 'Or 🥇' },
      { min: 10000, max: Infinity, rate: 50, name: 'Platine 💎' }
    ];

    // Fonction pour calculer la commission avec paliers progressifs
    const calculateCommission = (startRevenue, amount) => {
      let remaining = amount;
      let totalCommission = 0;
      let currentRevenue = startRevenue;

      for (const tier of tiers) {
        if (currentRevenue >= tier.max) {
          // On a déjà dépassé ce palier
          continue;
        }

        // Calculer combien on peut mettre dans ce palier
        const availableInTier = tier.max - Math.max(currentRevenue, tier.min);
        const amountInTier = Math.min(remaining, availableInTier);

        if (amountInTier > 0) {
          const commissionInTier = (amountInTier * tier.rate) / 100;
          totalCommission += commissionInTier;
          remaining -= amountInTier;
          currentRevenue += amountInTier;

          logger.info(`  📊 ${tier.name}: ${amountInTier.toFixed(2)}€ × ${tier.rate}% = ${commissionInTier.toFixed(2)}€`);
        }

        if (remaining <= 0) break;
      }

      return totalCommission;
    };

    // Calculer la commission
    const commissionAmount = calculateCommission(cumulativeRevenue, paymentAmount);
    const commissionRate = (commissionAmount / paymentAmount) * 100; // Taux moyen

    // Déterminer le palier actuel pour le log
    const currentTier = tiers.find(t => newCumulativeRevenue > t.min && newCumulativeRevenue <= t.max) || tiers[tiers.length - 1];
    
    logger.info(`💰 Commission calculée avec paliers progressifs`, {
      cumulativeRevenue: cumulativeRevenue.toFixed(2),
      newCumulativeRevenue: newCumulativeRevenue.toFixed(2),
      paymentAmount: paymentAmount.toFixed(2),
      commissionAmount: commissionAmount.toFixed(2),
      averageRate: `${commissionRate.toFixed(2)}%`,
      currentTier: currentTier.name
    });

    // Créer la commission
    const commission = new PartnerCommission({
      partnerId: partner._id,
      referralId: user._id,
      subscriptionId: subscription.id,
      paymentAmount: paymentAmount,
      commissionRate: commissionRate,
      commissionAmount: commissionAmount,
      subscriptionType: 'annual',
      status: 'confirmed',
      generatedAt: new Date(),
      confirmedAt: new Date(),
    });

    await commission.save();

    logger.info('✅ Commission de parrainage créée', {
      partnerId: partner._id,
      partnerEmail: partner.email,
      referralId: user._id,
      referralEmail: user.email,
      commissionAmount: commissionAmount,
      paymentAmount: paymentAmount,
      subscriptionId: subscription.id,
      invoiceId: invoice.id
    });

  } catch (error) {
    logger.error('❌ Erreur handleInvoicePaymentSucceeded:', error);
  }
}

/**
 * Gérer les changements d'abonnement
 */
async function handleSubscriptionChange(subscription) {
  logger.info('🔄 Traitement changement abonnement', { 
    subscriptionId: subscription.id,
    status: subscription.status,
    customerId: subscription.customer
  });

  try {
    // Récupérer l'utilisateur par son customer ID Stripe
    const user = await User.findOne({ 'subscription.stripeCustomerId': subscription.customer });
    if (!user) {
      logger.info('🔍 Utilisateur non trouvé pour ce customer ID', {
        customerId: subscription.customer
      });
      return;
    }

    // Logique de gestion de l'abonnement
    logger.info('✅ Abonnement traité', {
      userId: user._id,
      subscriptionId: subscription.id,
      status: subscription.status
    });

  } catch (error) {
    logger.error('❌ Erreur handleSubscriptionChange:', error);
  }
}

// Export des fonctions pour les tests
export { handleInvoicePaymentSucceeded };
