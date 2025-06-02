/**
 * Constantes globales pour l'API GraphQL de Newbi
 */

// URL de base du frontend pour les redirections
const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Autres constantes utiles
const DEFAULT_EXPIRY_DAYS = 7; // Durée d'expiration par défaut pour les transferts de fichiers (en jours)
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB en octets

module.exports = {
  BASE_URL,
  DEFAULT_EXPIRY_DAYS,
  MAX_FILE_SIZE
};
