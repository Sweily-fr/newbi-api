import User from '../models/User.js';
import Invoice from '../models/Invoice.js';
import FileTransfer from '../models/FileTransfer.js';
import { AppError } from '../utils/errors.js';
import stripe from '../utils/stripe.js'; // Importer la configuration Stripe

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

export {
  handleStripeWebhook
};
