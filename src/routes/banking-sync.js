import express from 'express';
import { bankingService } from '../services/banking/index.js';
import { betterAuthMiddleware } from '../middlewares/better-auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

/**
 * Synchronise les comptes bancaires
 */
router.post('/accounts', betterAuthMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const workspaceId = req.headers['x-workspace-id'] || req.query.workspaceId;
    
    if (!workspaceId) {
      return res.status(400).json({ error: 'WorkspaceId requis' });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize('bridge');
    const provider = bankingService.currentProvider;

    // Synchroniser les comptes
    const accounts = await provider.syncUserAccounts(user._id.toString(), workspaceId);

    logger.info(`Comptes synchronisés pour user ${user._id}: ${accounts.length} comptes`);

    res.json({
      success: true,
      accounts: accounts.length,
      data: accounts
    });

  } catch (error) {
    logger.error('Erreur synchronisation comptes:', error);
    res.status(500).json({
      error: 'Erreur lors de la synchronisation des comptes',
      details: error.message
    });
  }
});

/**
 * Synchronise les transactions
 */
router.post('/transactions', betterAuthMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const workspaceId = req.headers['x-workspace-id'] || req.query.workspaceId;
    const { accountId, limit = 50, since, until } = req.body;
    
    if (!workspaceId) {
      return res.status(400).json({ error: 'WorkspaceId requis' });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize('bridge');
    const provider = bankingService.currentProvider;

    let result;
    
    if (accountId) {
      // Synchroniser les transactions pour un compte spécifique
      const transactions = await provider.getTransactions(
        accountId, 
        user._id.toString(), 
        workspaceId, 
        { limit, since, until }
      );
      result = { accounts: 1, transactions: transactions.length };
    } else {
      // Synchroniser toutes les transactions pour tous les comptes
      result = await provider.syncAllTransactions(
        user._id.toString(), 
        workspaceId, 
        { limit, since, until }
      );
    }

    logger.info(`Transactions synchronisées pour user ${user._id}: ${result.transactions} transactions`);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Erreur synchronisation transactions:', error);
    res.status(500).json({
      error: 'Erreur lors de la synchronisation des transactions',
      details: error.message
    });
  }
});

/**
 * Synchronisation complète (comptes + transactions)
 */
router.post('/full', betterAuthMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const workspaceId = req.headers['x-workspace-id'] || req.query.workspaceId;
    const { limit = 50, since, until } = req.body;
    
    if (!workspaceId) {
      return res.status(400).json({ error: 'WorkspaceId requis' });
    }

    // Initialiser le service banking avec Bridge
    await bankingService.initialize('bridge');
    const provider = bankingService.currentProvider;

    // Synchronisation complète
    const result = await provider.syncAllTransactions(
      user._id.toString(), 
      workspaceId, 
      { limit, since, until }
    );

    logger.info(`Synchronisation complète pour user ${user._id}: ${result.accounts} comptes, ${result.transactions} transactions`);

    res.json({
      success: true,
      message: 'Synchronisation complète terminée',
      ...result
    });

  } catch (error) {
    logger.error('Erreur synchronisation complète:', error);
    res.status(500).json({
      error: 'Erreur lors de la synchronisation complète',
      details: error.message
    });
  }
});

export default router;
