import { AppError, ERROR_CODES } from "../utils/errors.js";
import logger from "../utils/logger.js";
import User from "../models/User.js";
import OrganizationTrialService from "../services/organizationTrialService.js";

/**
 * Extrait le token de session depuis les cookies
 * @param {string} cookieHeader - Header Cookie de la requête
 * @returns {string|null} - Token de session ou null
 */
const extractSessionToken = (cookieHeader) => {
  if (!cookieHeader) return null;

  // Chercher le cookie better-auth.session_token
  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    if (cookie.startsWith("better-auth.session_token=")) {
      return cookie.split("=")[1];
    }
  }

  return null;
};

/**
 * Valide une session better-auth via l'API du frontend
 * @param {Object} headers - Headers de la requête
 * @returns {Object|null} - Données utilisateur avec organisations ou null
 */
const validateSession = async (headers) => {
  if (!headers) return null;

  try {
    const cookieHeader = headers.cookie;
    if (!cookieHeader) {
      logger.debug("Aucun cookie trouvé");
      return null;
    }

    // Vérifier la présence du token better-auth
    const sessionToken = extractSessionToken(cookieHeader);
    if (!sessionToken) {
      logger.debug("Token de session better-auth non trouvé");
      return null;
    }

    // Valider la session via l'API better-auth du frontend
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const response = await fetch(`${frontendUrl}/api/auth/get-session`, {
      method: "GET",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      logger.debug(`Validation de session échouée: ${response.status}`);
      return null;
    }

    const sessionData = await response.json();

    if (!sessionData || !sessionData.user) {
      logger.debug("Session invalide ou utilisateur non trouvé");
      return null;
    }

    logger.debug(
      `Session validée pour l'utilisateur: ${sessionData.user.email}`
    );

    // Retourner simplement l'utilisateur - les organisations sont gérées côté frontend
    return sessionData.user;
  } catch (error) {
    logger.error("Erreur lors de la validation de session:", error.message);
    return null;
  }
};

/**
 * Middleware d'authentification better-auth
 * Valide les sessions via les cookies et l'API better-auth
 */
const betterAuthMiddleware = async (req) => {
  try {
    // Valider la session avec better-auth
    const sessionUser = await validateSession(req.headers);

    if (!sessionUser) {
      logger.debug("Session invalide ou utilisateur non authentifié");
      return null;
    }

    // Récupérer l'utilisateur complet depuis la base de données
    // en utilisant l'email ou l'ID de la session validée
    const user = await User.findOne({
      email: sessionUser.email,
      isDisabled: { $ne: true },
    });

    if (!user) {
      logger.warn(
        `Utilisateur ${sessionUser.email} non trouvé ou désactivé en base de données`
      );
      return null;
    }

    logger.debug(`Authentification réussie pour: ${user.email}`);
    
    // Enrichir l'utilisateur avec les données d'organisation et trial
    try {
      let organization = await OrganizationTrialService.getUserOrganization(user._id.toString());
      
      if (organization) {
        // Vérifier si les champs trial existent, sinon les créer
        const hasTrialFields = Object.prototype.hasOwnProperty.call(organization, 'isTrialActive') && 
                              Object.prototype.hasOwnProperty.call(organization, 'hasUsedTrial');
        
        if (!hasTrialFields) {
          logger.info(`🔧 Création des champs trial manquants pour l'organisation: ${organization.name} (utilisateur: ${user.email})`);
          
          try {
            // Créer les champs trial manquants
            await OrganizationTrialService.createTrialFields(organization._id);
            
            // Récupérer l'organisation mise à jour
            const updatedOrganization = await OrganizationTrialService.getUserOrganization(user._id.toString());
            organization = updatedOrganization;
            
            logger.info(`✅ Champs trial créés avec succès pour ${organization.name}`);
          } catch (createError) {
            logger.error(`❌ Erreur lors de la création des champs trial pour ${user.email}:`, createError.message);
            
            // Fallback : ajouter les champs par défaut en mémoire
            organization.isTrialActive = false;
            organization.hasUsedTrial = false;
            organization.trialStartDate = null;
            organization.trialEndDate = null;
          }
        }
        
        // Vérifier si on peut auto-démarrer le trial
        const canAutoStartTrial = !organization.hasUsedTrial && !organization.isTrialActive;
        
        if (canAutoStartTrial) {
          logger.info(`🚀 Auto-démarrage du trial pour l'organisation: ${organization.name} (utilisateur: ${user.email})`);
          
          try {
            // Démarrer automatiquement le trial
            const trialStatus = await OrganizationTrialService.startTrial(user._id.toString());
            
            // Récupérer l'organisation mise à jour
            const updatedOrganization = await OrganizationTrialService.getUserOrganization(user._id.toString());
            
            user.organization = {
              id: updatedOrganization.id,
              name: updatedOrganization.name,
              // Données trial mises à jour
              isTrialActive: updatedOrganization.isTrialActive || false,
              trialEndDate: updatedOrganization.trialEndDate || null,
              trialStartDate: updatedOrganization.trialStartDate || null,
              hasUsedTrial: updatedOrganization.hasUsedTrial || false,
              // Autres données d'organisation
              ...updatedOrganization
            };
            
            logger.info(`✅ Trial auto-démarré avec succès pour ${user.email} - ${trialStatus.daysRemaining} jours restants`);
          } catch (trialError) {
            logger.error(`❌ Erreur lors de l'auto-démarrage du trial pour ${user.email}:`, trialError.message);
            
            // Fallback : utiliser les données d'organisation actuelles
            user.organization = {
              id: organization.id,
              name: organization.name,
              isTrialActive: organization.isTrialActive || false,
              trialEndDate: organization.trialEndDate || null,
              trialStartDate: organization.trialStartDate || null,
              hasUsedTrial: organization.hasUsedTrial || false,
              ...organization
            };
          }
        } else {
          // Pas d'auto-start, utiliser les données existantes
          user.organization = {
            id: organization.id,
            name: organization.name,
            // Données trial
            isTrialActive: organization.isTrialActive || false,
            trialEndDate: organization.trialEndDate || null,
            trialStartDate: organization.trialStartDate || null,
            hasUsedTrial: organization.hasUsedTrial || false,
            // Autres données d'organisation si nécessaires
            ...organization
          };
        }
        
        logger.debug(`Organisation trouvée pour ${user.email}: ${organization.name} (trial actif: ${user.organization.isTrialActive})`);
      } else {
        logger.debug(`Aucune organisation trouvée pour ${user.email}`);
        user.organization = null;
      }
    } catch (error) {
      logger.warn(`Erreur lors de la récupération de l'organisation pour ${user.email}:`, error.message);
      user.organization = null;
    }
    
    return user;
  } catch (error) {
    logger.error("Erreur dans le middleware better-auth:", error.message);
    return null;
  }
};

/**
 * Wrapper pour les resolvers nécessitant une authentification
 */
const isAuthenticated = (resolver) => {
  return (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED
      );
    }
    return resolver(parent, args, context, info);
  };
};

/**
 * Wrapper pour les resolvers nécessitant une authentification et un workspace
 * Extrait le workspaceId depuis les headers ou les arguments
 */
const withWorkspace = (resolver) => {
  return async (parent, args, context, info) => {
    if (!context.user) {
      throw new AppError(
        "Vous devez être connecté pour effectuer cette action",
        ERROR_CODES.UNAUTHENTICATED
      );
    }

    // Extraire le workspaceId depuis les headers ou les arguments
    let workspaceId =
      args.workspaceId || context.req?.headers["x-workspace-id"];

    if (!workspaceId) {
      throw new AppError("WorkspaceId requis", ERROR_CODES.VALIDATION_ERROR);
    }

    // Ajouter le workspaceId au contexte
    const enhancedContext = {
      ...context,
      workspaceId,
    };

    return resolver(parent, args, enhancedContext, info);
  };
};

export { betterAuthMiddleware, isAuthenticated, withWorkspace };
