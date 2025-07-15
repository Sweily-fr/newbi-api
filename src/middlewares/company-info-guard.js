const { AppError, ERROR_CODES } = require('../utils/errors');
const logger = require('../utils/logger');

/**
 * Vérifie si les informations d'entreprise de l'utilisateur sont complètes
 * @param {Object} company - Objet company de l'utilisateur
 * @returns {boolean} - true si les informations sont complètes
 */
const isCompanyInfoComplete = (company) => {
  if (!company) {
    return false;
  }

  // Vérifier les champs obligatoires
  const requiredFields = [
    company.name,
    company.email,
    company.address?.street,
    company.address?.city,
    company.address?.postalCode,
    company.address?.country
  ];

  return requiredFields.every(field => field && field.trim().length > 0);
};

/**
 * Middleware GraphQL pour vérifier les informations d'entreprise
 * Utilisé pour protéger les mutations/queries de facturation et devis
 */
const requireCompanyInfo = (resolver) => {
  return async (parent, args, context, info) => {
    const { user } = context;

    // Vérifier que l'utilisateur est authentifié
    if (!user) {
      logger.warn('Tentative d\'accès sans authentification aux fonctionnalités d\'entreprise');
      throw new AppError(
        'Authentification requise',
        ERROR_CODES.UNAUTHORIZED,
        401
      );
    }

    // Vérifier les informations d'entreprise
    if (!isCompanyInfoComplete(user.company)) {
      logger.warn(`Utilisateur ${user.id} - Informations d'entreprise incomplètes`, {
        userId: user.id,
        email: user.email,
        company: user.company
      });

      throw new AppError(
        'Les informations d\'entreprise doivent être complétées avant d\'utiliser cette fonctionnalité. Veuillez configurer votre entreprise dans les paramètres.',
        ERROR_CODES.COMPANY_INFO_INCOMPLETE,
        403,
        {
          requiredFields: [
            'Nom de l\'entreprise',
            'Email de contact',
            'Adresse complète (rue, ville, code postal, pays)'
          ],
          currentCompany: {
            hasName: !!user.company?.name,
            hasEmail: !!user.company?.email,
            hasAddress: !!(user.company?.address?.street && 
                          user.company?.address?.city && 
                          user.company?.address?.postalCode && 
                          user.company?.address?.country)
          }
        }
      );
    }

    // Si tout est OK, exécuter le resolver
    return resolver(parent, args, context, info);
  };
};

/**
 * Fonction utilitaire pour vérifier les informations d'entreprise
 * Peut être utilisée dans d'autres parties de l'application
 */
const validateCompanyInfo = (user) => {
  if (!user) {
    throw new AppError(
      'Utilisateur non authentifié',
      ERROR_CODES.UNAUTHORIZED,
      401
    );
  }

  if (!isCompanyInfoComplete(user.company)) {
    throw new AppError(
      'Informations d\'entreprise incomplètes',
      ERROR_CODES.COMPANY_INFO_INCOMPLETE,
      403
    );
  }

  return true;
};

module.exports = {
  requireCompanyInfo,
  isCompanyInfoComplete,
  validateCompanyInfo
};
