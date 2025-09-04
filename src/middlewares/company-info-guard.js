import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";

/**
 * Vérifie si les informations d'entreprise de l'organisation sont complètes
 * @param {Object} organization - Objet organization (Better Auth)
 * @returns {boolean} - true si les informations sont complètes
 */
const isCompanyInfoComplete = (organization) => {
  if (!organization) {
    return false;
  }

  // Vérifier les champs obligatoires de l'organisation
  const requiredFields = [
    organization.companyName,
    organization.companyEmail,
    organization.addressStreet,
    organization.addressCity,
    organization.addressZipCode,
    organization.addressCountry
  ];

  return requiredFields.every(field => field && field.toString().trim().length > 0);
};

/**
 * Middleware GraphQL pour vérifier les informations d'entreprise
 * Utilisé pour protéger les mutations/queries de facturation et devis
 */
const requireCompanyInfo = (resolver) => {
  return async (parent, args, context, info) => {
    const { user, workspaceId } = context;

    // Vérifier que l'utilisateur est authentifié
    if (!user) {
      logger.warn('Tentative d\'accès sans authentification aux fonctionnalités d\'entreprise');
      throw new AppError(
        'Authentification requise',
        ERROR_CODES.UNAUTHORIZED,
        401
      );
    }

    // Récupérer le workspaceId depuis les arguments ou le contexte
    const finalWorkspaceId = args.workspaceId || workspaceId;
    if (!finalWorkspaceId) {
      throw new AppError(
        'workspaceId requis',
        ERROR_CODES.BAD_REQUEST,
        400
      );
    }

    // Récupérer les informations de l'organisation depuis la collection Better Auth
    let organization;
    try {
      const db = mongoose.connection.db;
      const organizationCollection = db.collection('organization');
      organization = await organizationCollection.findOne({ _id: new mongoose.Types.ObjectId(finalWorkspaceId) });
    } catch (error) {
      logger.error('Erreur lors de la récupération de l\'organisation:', error);
      throw new AppError(
        'Erreur lors de la récupération des informations d\'entreprise',
        ERROR_CODES.INTERNAL_ERROR,
        500
      );
    }

    if (!organization) {
      logger.warn(`Organisation non trouvée pour workspaceId: ${finalWorkspaceId}`);
      throw new AppError(
        'Organisation non trouvée',
        ERROR_CODES.NOT_FOUND,
        404
      );
    }

    // Vérifier les informations d'entreprise
    if (!isCompanyInfoComplete(organization)) {
      logger.warn(`WorkspaceId ${finalWorkspaceId} - Informations d'entreprise incomplètes`, {
        workspaceId: finalWorkspaceId,
        userId: user.id,
        organization: {
          companyName: organization.companyName,
          companyEmail: organization.companyEmail,
          addressStreet: organization.addressStreet,
          addressCity: organization.addressCity,
          addressZipCode: organization.addressZipCode,
          addressCountry: organization.addressCountry
        }
      });

      throw new AppError(
        'Les informations d\'entreprise doivent être complétées avant d\'utiliser cette fonctionnalité. Veuillez configurer votre entreprise dans les paramètres.',
        ERROR_CODES.COMPANY_INFO_INCOMPLETE,
        403,
        {
          missingFields: [
            'Nom de l\'entreprise',
            'Email de contact',
            'Adresse complète (rue, ville, code postal, pays)'
          ],
          currentCompany: {
            hasName: !!organization.companyName,
            hasEmail: !!organization.companyEmail,
            hasAddress: !!(organization.addressStreet && 
                          organization.addressCity && 
                          organization.addressZipCode && 
                          organization.addressCountry)
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
const validateCompanyInfo = async (workspaceId) => {
  if (!workspaceId) {
    throw new AppError(
      'workspaceId requis',
      ERROR_CODES.BAD_REQUEST,
      400
    );
  }

  // Récupérer les informations de l'organisation
  let organization;
  try {
    const db = mongoose.connection.db;
    const organizationCollection = db.collection('organization');
    organization = await organizationCollection.findOne({ _id: new mongoose.Types.ObjectId(workspaceId) });
  } catch (error) {
    throw new AppError(
      'Erreur lors de la récupération des informations d\'entreprise',
      ERROR_CODES.INTERNAL_ERROR,
      500
    );
  }

  if (!organization) {
    throw new AppError(
      'Organisation non trouvée',
      ERROR_CODES.NOT_FOUND,
      404
    );
  }

  if (!isCompanyInfoComplete(organization)) {
    throw new AppError(
      'Informations d\'entreprise incomplètes',
      ERROR_CODES.COMPANY_INFO_INCOMPLETE,
      403
    );
  }

  return true;
};

/**
 * Fonction utilitaire pour récupérer les informations d'organisation
 * @param {string} workspaceId - ID de l'organisation
 * @returns {Object} - Objet organization
 */
const getOrganizationInfo = async (workspaceId) => {
  if (!workspaceId) {
    throw new AppError(
      'workspaceId requis',
      ERROR_CODES.BAD_REQUEST,
      400
    );
  }

  let organization;
  try {
    const db = mongoose.connection.db;
    const organizationCollection = db.collection('organization');
    organization = await organizationCollection.findOne({ _id: new mongoose.Types.ObjectId(workspaceId) });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'organisation:', error);
    throw new AppError(
      'Erreur lors de la récupération des informations d\'entreprise',
      ERROR_CODES.INTERNAL_ERROR,
      500
    );
  }

  if (!organization) {
    throw new AppError(
      'Organisation non trouvée',
      ERROR_CODES.NOT_FOUND,
      404
    );
  }

  return organization;
};

export { requireCompanyInfo, isCompanyInfoComplete, validateCompanyInfo, getOrganizationInfo };
