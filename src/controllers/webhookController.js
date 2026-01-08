import User from '../models/User.js';
import Invoice from '../models/Invoice.js';
import FileTransfer from '../models/FileTransfer.js';
import PartnerCommission from '../models/PartnerCommission.js';
import { AppError } from '../utils/errors.js';
import stripe from '../utils/stripe.js'; // Importer la configuration Stripe

// Paliers de commission (identiques à ceux dans partner.js)
const COMMISSION_TIERS = [
  { name: 'Bronze', percentage: 20, minRevenue: 0, maxRevenue: 1000 },
  { name: 'Argent', percentage: 25, minRevenue: 1000, maxRevenue: 5000 },
  { name: 'Or', percentage: 30, minRevenue: 5000, maxRevenue: 10000 },
  { name: 'Platine', percentage: 50, minRevenue: 10000, maxRevenue: null },
];

/**
 * Calcule le palier de commission en fonction du CA apporté
 */
const calculateCommissionTier = (totalRevenue) => {
  for (let i = COMMISSION_TIERS.length - 1; i >= 0; i--) {
    const tier = COMMISSION_TIERS[i];
    if (totalRevenue >= tier.minRevenue) {
      if (tier.maxRevenue === null || totalRevenue < tier.maxRevenue) {
        return tier;
      }
    }
  }
  return COMMISSION_TIERS[0]; // Bronze par défaut
};

/**
 * Gère les événements webhook de Stripe
 * @param {Object} event - L'événement Stripe
 * @returns {Promise<Object>} - Résultat du traitement
 */
async function handleStripeWebhook(event) {
  try {
    console.log('Événement Stripe reçu:', event.type);
    console.log('Données de l\'événement:', JSON.stringify(event.data.object, null, 2));
    
    switch (event.type) {
    case 'customer.subscription.created':
      return await handleSubscriptionCreated(event.data.object);
    
    case 'customer.subscription.updated':
      return await handleSubscriptionUpdated(event.data.object);
    
    case 'customer.subscription.deleted':
      return await handleSubscriptionDeleted(event.data.object);
    
    case 'customer.subscription.paused':
      return await handleSubscriptionPaused(event.data.object);
    
    case 'customer.subscription.resumed':
      return await handleSubscriptionResumed(event.data.object);
    
    case 'customer.subscription.pending_update_applied':
      return await handlePendingUpdateApplied(event.data.object);
    
    case 'customer.subscription.pending_update_expired':
      return await handlePendingUpdateExpired(event.data.object);
    
    case 'customer.subscription.trial_will_end':
      return await handleTrialWillEnd(event.data.object);
    
    case 'checkout.session.completed':
      return await handleCheckoutSessionCompleted(event.data.object);
    
    case 'invoice.payment_succeeded':
      return await handleInvoicePaymentSucceeded(event.data.object);
    
    default:
      return { status: 'ignored', message: `Événement non géré: ${event.type}` };
    }
  } catch (error) {
    throw new AppError('Erreur lors du traitement du webhook Stripe', 'INTERNAL_ERROR', error.message);
  }
}

/**
 * Gère la création d'un abonnement
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handleSubscriptionCreated(subscription) {
  try {
    console.log('Traitement de subscription.created pour le client:', subscription.customer);
    
    const user = await findUserByCustomerId(subscription.customer);
    if (!user) {
      console.error(`Utilisateur non trouvé pour le customer ID: ${subscription.customer}`);
      return { status: 'error', message: 'Utilisateur non trouvé' };
    }

    console.log(`Utilisateur trouvé: ${user.email}`);
    
    // S'assurer que l'objet subscription existe
    user.subscription = user.subscription || {};
    
    // Mettre à jour les champs d'abonnement
    user.subscription.licence = true;
    user.subscription.trial = subscription.status === 'trialing';
    
    await user.save();
    
    console.log(`Abonnement mis à jour pour l'utilisateur ${user.email}`);
    
    return { 
      status: 'success', 
      message: 'Abonnement créé avec succès',
      userId: user._id,
      email: user.email
    };
  } catch (error) {
    console.error('Erreur dans handleSubscriptionCreated:', error);
    return { 
      status: 'error', 
      message: `Erreur lors de la création de l'abonnement: ${error.message}` 
    };
  }
}

/**
 * Gère la mise à jour d'un abonnement
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handleSubscriptionUpdated(subscription) {
  try {
    console.log('Traitement de subscription.updated pour le client:', subscription.customer);
    
    const user = await findUserByCustomerId(subscription.customer);
    if (!user) {
      console.error(`Utilisateur non trouvé pour le customer ID: ${subscription.customer}`);
      return { status: 'error', message: 'Utilisateur non trouvé' };
    }

    console.log(`Utilisateur trouvé: ${user.email}, statut de l'abonnement: ${subscription.status}`);
    
    // S'assurer que l'objet subscription existe
    user.subscription = user.subscription || {};
    
    // Mettre à jour les champs d'abonnement
    user.subscription.licence = ['active', 'trialing'].includes(subscription.status);
    user.subscription.trial = subscription.status === 'trialing';
    
    await user.save();
    
    console.log(`Abonnement mis à jour pour l'utilisateur ${user.email}, licence: ${user.subscription.licence}, trial: ${user.subscription.trial}`);
    
    return { 
      status: 'success', 
      message: 'Abonnement mis à jour avec succès',
      userId: user._id,
      email: user.email,
      subscriptionStatus: subscription.status
    };
  } catch (error) {
    console.error('Erreur dans handleSubscriptionUpdated:', error);
    return { 
      status: 'error', 
      message: `Erreur lors de la mise à jour de l'abonnement: ${error.message}` 
    };
  }
}

/**
 * Gère la suppression d'un abonnement
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handleSubscriptionDeleted(subscription) {
  try {
    console.log('Traitement de subscription.deleted pour le client:', subscription.customer);
    
    const user = await findUserByCustomerId(subscription.customer);
    if (!user) {
      console.error(`Utilisateur non trouvé pour le customer ID: ${subscription.customer}`);
      return { status: 'error', message: 'Utilisateur non trouvé' };
    }

    console.log(`Utilisateur trouvé: ${user.email}`);
    
    // S'assurer que l'objet subscription existe
    user.subscription = user.subscription || {};
    
    // Mettre à jour les champs d'abonnement
    user.subscription.licence = false;
    user.subscription.trial = false;
    
    await user.save();
    
    console.log(`Abonnement supprimé pour l'utilisateur ${user.email}`);
    
    return { 
      status: 'success', 
      message: 'Abonnement supprimé avec succès',
      userId: user._id,
      email: user.email
    };
  } catch (error) {
    console.error('Erreur dans handleSubscriptionDeleted:', error);
    return { 
      status: 'error', 
      message: `Erreur lors de la suppression de l'abonnement: ${error.message}` 
    };
  }
}

/**
 * Gère la mise en pause d'un abonnement
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handleSubscriptionPaused(subscription) {
  const user = await findUserByCustomerId(subscription.customer);
  if (!user) {
    return { status: 'error', message: 'Utilisateur non trouvé' };
  }

  // Mettre à jour les champs d'abonnement
  user.subscription.licence = false;
  
  await user.save();
  return { status: 'success', message: 'Abonnement mis en pause avec succès' };
}

/**
 * Gère la reprise d'un abonnement
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handleSubscriptionResumed(subscription) {
  const user = await findUserByCustomerId(subscription.customer);
  if (!user) {
    return { status: 'error', message: 'Utilisateur non trouvé' };
  }

  // Mettre à jour les champs d'abonnement
  user.subscription.licence = true;
  
  await user.save();
  return { status: 'success', message: 'Abonnement repris avec succès' };
}

/**
 * Gère l'application d'une mise à jour en attente
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handlePendingUpdateApplied(subscription) {
  const user = await findUserByCustomerId(subscription.customer);
  if (!user) {
    return { status: 'error', message: 'Utilisateur non trouvé' };
  }

  // Mettre à jour les champs d'abonnement si nécessaire
  // Pour cet événement, nous ne modifions pas les champs licence et trial
  // car ils sont déjà gérés par les autres événements
  
  return { status: 'success', message: 'Mise à jour en attente appliquée avec succès' };
}

/**
 * Gère l'expiration d'une mise à jour en attente
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handlePendingUpdateExpired(subscription) {
  const user = await findUserByCustomerId(subscription.customer);
  if (!user) {
    return { status: 'error', message: 'Utilisateur non trouvé' };
  }

  return { status: 'success', message: 'Mise à jour en attente expirée' };
}

/**
 * Gère la fin prochaine d'une période d'essai
 * @param {Object} subscription - L'objet subscription de Stripe
 */
async function handleTrialWillEnd(subscription) {
  const user = await findUserByCustomerId(subscription.customer);
  if (!user) {
    return { status: 'error', message: 'Utilisateur non trouvé' };
  }

  // Nous ne modifions pas encore les champs car la période d'essai n'est pas terminée
  // Cet événement est envoyé 3 jours avant la fin de la période d'essai
  
  return { status: 'success', message: 'Notification de fin de période d\'essai traitée' };
}

/**
 * Trouve un utilisateur par son Stripe Customer ID
 * @param {string} customerId - L'ID client Stripe
 * @returns {Promise<Object|null>} - L'utilisateur trouvé ou null
 */
async function findUserByCustomerId(customerId) {
  console.log('Recherche d\'utilisateur avec customerId:', customerId);
  
  if (!customerId) {
    console.error('Customer ID est null ou undefined');
    return null;
  }
  
  try {
    // Essayer d'abord avec le champ stripeCustomerId
    let user = await User.findOne({ 'subscription.stripeCustomerId': customerId });
    
    if (user) {
      console.log('Utilisateur trouvé avec subscription.stripeCustomerId');
      return user;
    }
    
    // Si aucun utilisateur n'est trouvé, essayer avec d'autres méthodes
    
    // 1. Vérifier si le customerId est stocké dans un autre champ
    // Par exemple, si vous avez un champ stripeId au niveau racine
    user = await User.findOne({ stripeId: customerId });
    if (user) {
      console.log('Utilisateur trouvé avec stripeId');
      // Mettre à jour l'utilisateur pour utiliser le nouveau champ
      user.subscription = user.subscription || {};
      user.subscription.stripeCustomerId = customerId;
      await user.save();
      return user;
    }
    
    // 2. Essayer de récupérer les informations du client depuis Stripe
    try {
      console.log('Tentative de récupération des informations client depuis Stripe');
      const customer = await stripe.customers.retrieve(customerId);
      
      if (customer && customer.email) {
        console.log(`Email du client Stripe trouvé: ${customer.email}`);
        
        // Chercher l'utilisateur par email
        user = await User.findOne({ email: customer.email });
        
        if (user) {
          console.log(`Utilisateur trouvé par email: ${customer.email}`);
          
          // Mettre à jour l'utilisateur avec le stripeCustomerId
          user.subscription = user.subscription || {};
          user.subscription.stripeCustomerId = customerId;
          await user.save();
          
          console.log(`StripeCustomerId ajouté à l'utilisateur ${user.email}`);
          return user;
        } else {
          console.log(`Aucun utilisateur trouvé avec l'email: ${customer.email}`);
        }
      } else {
        console.log('Aucun email trouvé dans les informations du client Stripe');
      }
    } catch (stripeError) {
      console.error('Erreur lors de la récupération des informations client depuis Stripe:', stripeError.message);
    }
    
    console.log('Aucun utilisateur trouvé avec ce customerId');
    return null;
  } catch (error) {
    console.error('Erreur lors de la recherche d\'utilisateur:', error);
    return null;
  }
}

/**
 * Gère l'événement de paiement réussi (checkout.session.completed)
 * @param {Object} session - L'objet session de Stripe
 * @returns {Promise<Object>} - Résultat du traitement
 */
async function handleCheckoutSessionCompleted(session) {
  try {
    console.log('Traitement du paiement pour la session:', session.id);
    
    // Vérifier que le paiement est bien réussi
    if (session.payment_status !== 'paid') {
      console.log('Paiement non effectué pour la session:', session.id);
      return { status: 'ignored', message: 'Paiement non effectué' };
    }
    
    // Récupérer les métadonnées de la session
    const { fileTransferId } = session.metadata || {};
    
    if (!fileTransferId) {
      console.error('ID de transfert de fichier manquant dans les métadonnées');
      return { status: 'error', message: 'ID de transfert de fichier manquant' };
    }
    
    // Mettre à jour le statut de paiement dans la base de données
    const updatedTransfer = await FileTransfer.findByIdAndUpdate(
      fileTransferId,
      { 
        isPaid: true,
        paymentId: session.payment_intent || session.id,
        paymentDate: new Date(),
        status: 'active'
      },
      { new: true }
    );
    
    if (!updatedTransfer) {
      console.error('Transfert de fichier non trouvé avec l\'ID:', fileTransferId);
      return { status: 'error', message: 'Transfert de fichier non trouvé' };
    }
    
    console.log('Paiement enregistré avec succès pour le transfert:', fileTransferId);
    return { 
      status: 'success', 
      message: 'Paiement enregistré avec succès',
      fileTransferId
    };
    
  } catch (error) {
    console.error('Erreur lors du traitement du paiement:', error);
    throw new AppError('Erreur lors du traitement du paiement', 'PAYMENT_PROCESSING_ERROR', error.message);
  }
}

/**
 * Gère le paiement réussi d'une facture (invoice.payment_succeeded)
 * Crée une commission pour le partenaire à chaque paiement d'abonnement
 * @param {Object} invoice - L'objet invoice de Stripe
 * @returns {Promise<Object>} - Résultat du traitement
 */
async function handleInvoicePaymentSucceeded(invoice) {
  try {
    console.log('Traitement de invoice.payment_succeeded pour le client:', invoice.customer);
    
    // Vérifier que c'est bien un paiement d'abonnement
    if (!invoice.subscription) {
      console.log('Pas un paiement d\'abonnement, ignoré');
      return { status: 'ignored', message: 'Pas un paiement d\'abonnement' };
    }
    
    // Récupérer le montant payé (en centimes -> euros)
    const paymentAmount = invoice.amount_paid / 100;
    
    if (paymentAmount <= 0) {
      console.log('Montant nul ou négatif, ignoré');
      return { status: 'ignored', message: 'Montant nul ou négatif' };
    }
    
    // Trouver l'utilisateur par son Stripe Customer ID
    const user = await findUserByCustomerId(invoice.customer);
    if (!user) {
      console.log('Utilisateur non trouvé pour le customer:', invoice.customer);
      return { status: 'error', message: 'Utilisateur non trouvé' };
    }
    
    console.log(`Utilisateur trouvé: ${user.email}`);
    
    // Vérifier si l'utilisateur a été référé par un partenaire
    if (!user.referredBy) {
      console.log('Utilisateur non référé par un partenaire, pas de commission');
      return { status: 'ignored', message: 'Utilisateur non référé par un partenaire' };
    }
    
    console.log(`Utilisateur référé par le code: ${user.referredBy}`);
    
    // Trouver le partenaire qui a référé cet utilisateur
    const partner = await User.findOne({ 
      referralCode: user.referredBy,
      isPartner: true 
    });
    
    if (!partner) {
      console.log('Partenaire non trouvé pour le code:', user.referredBy);
      return { status: 'error', message: 'Partenaire non trouvé' };
    }
    
    console.log(`Partenaire trouvé: ${partner.email}`);
    
    // Calculer le CA total apporté par ce partenaire pour déterminer son palier
    const confirmedCommissions = await PartnerCommission.find({
      partnerId: partner._id,
      status: { $in: ['confirmed', 'paid'] },
    });
    
    const totalRevenue = confirmedCommissions.reduce(
      (sum, comm) => sum + comm.paymentAmount,
      0
    );
    
    // Déterminer le palier de commission
    const tier = calculateCommissionTier(totalRevenue);
    const commissionRate = tier.percentage;
    const commissionAmount = (paymentAmount * commissionRate) / 100;
    
    console.log(`Palier: ${tier.name}, Taux: ${commissionRate}%, Commission: ${commissionAmount}€`);
    
    // Déterminer le type d'abonnement (mensuel ou annuel)
    let subscriptionType = 'monthly';
    try {
      const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
      if (subscription && subscription.items && subscription.items.data[0]) {
        const interval = subscription.items.data[0].price.recurring?.interval;
        if (interval === 'year') {
          subscriptionType = 'annual';
        }
      }
    } catch (subError) {
      console.log('Impossible de récupérer les détails de l\'abonnement:', subError.message);
    }
    
    // Créer la commission
    const commission = new PartnerCommission({
      partnerId: partner._id,
      referralId: user._id,
      subscriptionId: invoice.subscription,
      paymentAmount,
      commissionRate,
      commissionAmount,
      subscriptionType,
      status: 'confirmed', // Commission confirmée immédiatement après paiement réussi
      generatedAt: new Date(),
      confirmedAt: new Date(),
      notes: `Paiement Stripe: ${invoice.id}`,
    });
    
    await commission.save();
    
    console.log(`Commission créée: ${commission._id} - ${commissionAmount}€ pour ${partner.email}`);
    
    return {
      status: 'success',
      message: 'Commission créée avec succès',
      commissionId: commission._id.toString(),
      partnerId: partner._id.toString(),
      amount: commissionAmount,
    };
    
  } catch (error) {
    console.error('Erreur lors de la création de la commission:', error);
    return {
      status: 'error',
      message: `Erreur lors de la création de la commission: ${error.message}`,
    };
  }
}

export {
  handleStripeWebhook
};
