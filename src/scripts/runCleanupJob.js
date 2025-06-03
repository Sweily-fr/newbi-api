/**
 * Script pour exécuter manuellement le job de nettoyage des fichiers expirés
 * Utile pour tester le fonctionnement du job sans attendre l'exécution planifiée
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { cleanupExpiredFiles } = require('../jobs/cleanupExpiredFiles');
const logger = require('../utils/logger');

// Connexion à MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => logger.info('Connecté à MongoDB'))
  .catch(err => logger.error('Erreur de connexion MongoDB:', err));

async function runCleanupJob() {
  try {
    logger.info('Démarrage manuel du job de nettoyage des fichiers expirés');
    
    const result = await cleanupExpiredFiles();
    
    logger.info('Résultat du job de nettoyage:', result);
    logger.info(`${result.markedCount} transferts marqués comme expirés, ${result.deletedCount} fichiers supprimés`);
    
    // Fermer la connexion à MongoDB
    await mongoose.connection.close();
    logger.info('Connexion MongoDB fermée');
    
    process.exit(0);
  } catch (error) {
    logger.error('Erreur lors de l\'exécution du job de nettoyage:', error);
    
    // Fermer la connexion à MongoDB en cas d'erreur
    await mongoose.connection.close();
    logger.error('Connexion MongoDB fermée après erreur');
    
    process.exit(1);
  }
}

// Exécuter le job
runCleanupJob();
