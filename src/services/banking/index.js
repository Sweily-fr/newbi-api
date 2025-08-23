/**
 * Point d'entrée principal pour le système banking
 * Initialise tous les providers et expose l'API unifiée
 */

// Import des providers pour les enregistrer automatiquement
import './providers/BridgeProvider.js';
import './providers/MockProvider.js';

// Import du service principal
import { bankingService } from './BankingService.js';
import { BankingProviderFactory } from './factory/BankingProviderFactory.js';

/**
 * Initialise le système banking au démarrage du serveur
 */
export async function initializeBankingSystem() {
  try {
    console.log('🏦 Initialisation du système banking...');
    
    // Initialisation de la factory
    await BankingProviderFactory.initialize();
    
    // Initialisation du service avec le provider par défaut
    const defaultProvider = process.env.BANKING_PROVIDER || 'mock';
    console.log(`🔧 Tentative d'initialisation avec le provider: ${defaultProvider}`);
    
    // Vérifier la configuration avant d'initialiser
    if (defaultProvider === 'bridge') {
      const BridgeProvider = (await import('./providers/BridgeProvider.js')).BridgeProvider;
      const tempProvider = new BridgeProvider();
      
      if (!tempProvider.validateConfig()) {
        console.warn('⚠️ Configuration Bridge invalide, fallback vers mock');
        await bankingService.initialize('mock');
      } else {
        await bankingService.initialize(defaultProvider);
      }
    } else {
      await bankingService.initialize(defaultProvider);
    }
    
    console.log('✅ Système banking initialisé avec succès');
    
    return bankingService;
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation du système banking:', error);
    
    // Fallback vers le provider mock en cas d'erreur
    try {
      console.log('🔄 Tentative de fallback vers le provider mock...');
      await bankingService.initialize('mock');
      console.log('✅ Fallback vers mock réussi');
      return bankingService;
    } catch (fallbackError) {
      console.error('❌ Échec du fallback:', fallbackError);
      throw new Error('Impossible d\'initialiser le système banking');
    }
  }
}

// Export du service pour utilisation dans les resolvers
export { bankingService };
export { BankingProviderFactory };

// Export des modèles
export { default as Transaction } from '../../models/Transaction.js';
export { default as AccountBanking } from '../../models/AccountBanking.js';
export { default as ApiMetric } from '../../models/ApiMetric.js';
