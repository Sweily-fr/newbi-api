import Stripe from 'stripe';
import dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Vérifier que la clé API Stripe est définie
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('ATTENTION: La clé API Stripe (STRIPE_SECRET_KEY) n\'est pas définie dans les variables d\'environnement.');
}

// Initialiser Stripe avec la clé API ou une valeur par défaut pour le développement
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_key_for_development';
const stripe = new Stripe(stripeSecretKey);

export default stripe;
