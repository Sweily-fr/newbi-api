import express from 'express';
import { handleStripeWebhook } from '../controllers/stripeWebhookController.js';

const router = express.Router();

// Middleware pour capturer le body brut (requis pour la vérification Stripe)
const rawBodyParser = express.raw({ type: 'application/json' });

// Endpoint webhook Stripe pour les transferts de fichiers
router.post('/file-transfer', rawBodyParser, handleStripeWebhook);

export default router;
