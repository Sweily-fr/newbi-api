import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import mongoose from "mongoose";

/**
 * Vérifie si les informations d'entreprise de l'organisation sont complètes
 * Vérifie TOUTES les informations: générales ET légales
 * @param {Object} organization - Objet organization (Better Auth)
 * @returns {boolean} - true si les informations sont complètes
 */
const isCompanyInfoComplete = (organization) => {
  if (!organization) {
    return false;
  }

  // Vérifier les champs obligatoires de l'organisation
  // Informations générales + Informations légales
  const requiredFields = [
    // Informations générales
    organization.companyName,
    organization.companyEmail,
    organization.addressStreet,
    organization.addressCity,
    organization.addressZipCode,
    organization.addressCountry,
    // Informations légales
    organization.siret,
    organization.legalForm
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
    let finalWorkspaceId = args.workspaceId || workspaceId;
    
    // Si workspaceId n'est pas fourni, essayer de le récupérer depuis le document
    // Cela permet de gérer les mutations update/delete qui n'ont que l'ID
    if (!finalWorkspaceId && args.id) {
      try {
        const db = mongoose.connection.db;
        
        // Déterminer la collection à interroger selon le type de mutation
        let collectionName = null;
        const mutationName = info.fieldName;
        
        if (mutationName.toLowerCase().includes('quote')) {
          collectionName = 'quotes';
        } else if (mutationName.toLowerCase().includes('invoice')) {
          collectionName = 'invoices';
        } else if (mutationName.toLowerCase().includes('creditnote')) {
          collectionName = 'creditnotes';
        }
        
        if (collectionName) {
          const collection = db.collection(collectionName);
          const document = await collection.findOne({ 
            _id: new mongoose.Types.ObjectId(args.id),
            createdBy: new mongoose.Types.ObjectId(user.id)
          });
          
          if (document && document.workspaceId) {
            finalWorkspaceId = document.workspaceId.toString();
          }
        }
      } catch (error) {
        logger.error('Erreur lors de la récupération du workspaceId depuis le document:', error);
      }
    }
    
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

    // Vérifier les informations d'entreprise (générales + légales)
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
          addressCountry: organization.addressCountry,
          siret: organization.siret,
          legalForm: organization.legalForm
        }
      });

      throw new AppError(
        'Les informations d\'entreprise doivent être complétées avant d\'utiliser cette fonctionnalité. Veuillez configurer les informations générales ET légales dans les paramètres.',
        ERROR_CODES.COMPANY_INFO_INCOMPLETE,
        403,
        {
          missingFields: [
            'Nom de l\'entreprise',
            'Email de contact',
            'Adresse complète (rue, ville, code postal, pays)',
            'SIRET',
            'Forme juridique'
          ],
          currentCompany: {
            hasName: !!organization.companyName,
            hasEmail: !!organization.companyEmail,
            hasAddress: !!(organization.addressStreet && 
                          organization.addressCity && 
                          organization.addressZipCode && 
                          organization.addressCountry),
            hasSiret: !!organization.siret,
            hasLegalForm: !!organization.legalForm
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
