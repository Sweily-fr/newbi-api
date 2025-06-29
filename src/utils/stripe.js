import Stripe from 'stripe';

// Vérifier si la clé API Stripe est disponible
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('ATTENTION: La variable d\'environnement STRIPE_SECRET_KEY n\'est pas définie. Les fonctionnalités Stripe seront désactivées.');
}

// Initialiser Stripe avec la clé API ou une clé factice pour éviter l'erreur
const stripe = process.env.STRIPE_SECRET_KEY 
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : new Stripe('sk_test_dummy_key_for_development_only');

export default stripe;
