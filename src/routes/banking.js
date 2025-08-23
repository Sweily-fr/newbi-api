import express from 'express';
import { bankingService } from '../services/banking/BankingService.js';
import { betterAuthMiddleware } from '../middlewares/better-auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Routes pour les webhooks des providers bancaires
 */

// Webhook Bridge
router.post('/webhook/bridge', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await bankingService.handleWebhook('bridge', req.body);
    res.status(200).json({ received: true, processed: result });
  } catch (error) {
    console.error('Erreur webhook Bridge:', error);
    res.status(400).json({ error: error.message });
  }
});

// Webhook Stripe Banking
router.post('/webhook/stripe-banking', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await bankingService.handleWebhook('stripe', req.body);
    res.status(200).json({ received: true, processed: result });
  } catch (error) {
    console.error('Erreur webhook Stripe Banking:', error);
    res.status(400).json({ error: error.message });
  }
});

// Webhook PayPal
router.post('/webhook/paypal', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = await bankingService.handleWebhook('paypal', req.body);
    res.status(200).json({ received: true, processed: result });
  } catch (error) {
    console.error('Erreur webhook PayPal:', error);
    res.status(400).json({ error: error.message });
  }
});

/**
 * Routes d'administration banking (protégées)
 */

// Switch de provider (admin only)
router.post('/admin/switch-provider', betterAuthMiddleware, async (req, res) => {
  try {
    const user = req.user;
    
    // Vérifier les permissions admin
    if (!user.role || !user.role.includes('admin')) {
      return res.status(403).json({ error: 'Accès non autorisé' });
    }
    
    const { provider } = req.body;
    if (!provider) {
      return res.status(400).json({ error: 'Provider requis' });
    }
    
    await bankingService.switchProvider(provider);
    res.json({ success: true, message: `Provider switché vers ${provider}` });
    
  } catch (error) {
    console.error('Erreur switch provider:', error);
    res.status(500).json({ error: error.message });
  }
});

// Statut du service banking
router.get('/status', async (req, res) => {
  try {
    const status = {
      initialized: bankingService.initialized,
      currentProvider: bankingService.currentProvider?.providerName || 'none',
      availableProviders: ['bridge', 'stripe', 'paypal', 'mock']
    };
    
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Routes pour récupérer les données bancaires
 */

// Récupérer les comptes bancaires
router.get('/accounts', async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: 'Non authentifié' });
    }

    const workspaceId = req.headers['x-workspace-id'] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: 'WorkspaceId requis' });
    }

    const { default: AccountBanking } = await import('../models/AccountBanking.js');
    const accounts = await AccountBanking.find({
      workspaceId,
      status: 'active'
    }).sort({ createdAt: -1 });

    logger.info(`Récupération de ${accounts.length} comptes pour workspace ${workspaceId}`);

    res.json({
      success: true,
      accounts,
      count: accounts.length
    });

  } catch (error) {
    logger.error('Erreur récupération comptes:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la récupération des comptes',
      details: error.message 
    });
  }
});

// Endpoint pour récupérer les transactions
router.get('/transactions', async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers['x-workspace-id'] || req.query.workspaceId;
    if (!workspaceId) {
      return res.status(400).json({ error: 'WorkspaceId requis' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const page = parseInt(req.query.page) || 1;
    const skip = (page - 1) * limit;

    const { default: Transaction } = await import('../models/Transaction.js');
    
    const query = { workspaceId };
    
    // Filtres optionnels
    if (req.query.accountId) {
      query.fromAccount = req.query.accountId;
    }
    
    if (req.query.type) {
      query.type = req.query.type;
    }
    
    if (req.query.status) {
      query.status = req.query.status;
    }

    const transactions = await Transaction.find(query)
      .sort({ date: -1 })
      .limit(limit)
      .skip(skip);

    const total = await Transaction.countDocuments(query);

    logger.info(`Récupération de ${transactions.length} transactions pour workspace ${workspaceId}`);

    res.json({
      success: true,
      transactions,
      count: transactions.length,
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });

  } catch (error) {
    logger.error('Erreur récupération transactions:', error);
    res.status(500).json({ 
      error: 'Erreur lors de la récupération des transactions',
      details: error.message 
    });
  }
});

// Endpoint pour supprimer l'utilisateur Bridge
router.delete('/user', async (req, res) => {
  try {
    const user = await betterAuthMiddleware(req);
    if (!user) {
      return res.status(401).json({ error: "Non authentifié" });
    }

    const workspaceId = req.headers["x-workspace-id"];
    if (!workspaceId) {
      return res.status(400).json({ error: "WorkspaceId requis" });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize("bridge");
    const provider = bankingService.currentProvider;

    // Supprimer l'utilisateur Bridge et toutes ses données
    const result = await provider.deleteBridgeUser(workspaceId);

    logger.info(`Utilisateur Bridge supprimé pour workspace ${workspaceId}:`, result);

    res.json({
      success: true,
      message: "Utilisateur Bridge supprimé avec succès",
      deletedAccounts: result.deletedAccounts,
      deletedTransactions: result.deletedTransactions
    });

  } catch (error) {
    logger.error('Erreur suppression utilisateur Bridge:', error);
    res.status(500).json({ 
      error: "Erreur lors de la suppression de l'utilisateur Bridge",
      details: error.message 
    });
  }
});

export default router;
