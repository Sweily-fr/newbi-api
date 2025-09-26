/**
 * Resolvers GraphQL pour la génération d'icônes sociales personnalisées
 */

import socialIconService from '../services/socialIconService.js';
import { isAuthenticated } from '../middlewares/better-auth.js';
import { createValidationError, createNotFoundError } from '../utils/errors.js';

const socialIconResolvers = {
  Mutation: {
    /**
     * Génère les icônes sociales personnalisées pour une signature
     */
    generateCustomSocialIcons: isAuthenticated(
      async (_, { signatureId, logoUrl }, { user }) => {
        try {
          console.log(`🚀 Génération icônes sociales - User: ${user.id}, Signature: ${signatureId}`);
          
          // Validation des paramètres
          if (!signatureId) {
            throw createValidationError('signatureId est requis');
          }
          
          if (!logoUrl) {
            throw createValidationError('logoUrl est requis');
          }

          // Générer les icônes personnalisées
          const generatedIcons = await socialIconService.generateCustomSocialIcons(
            user.id,
            signatureId,
            logoUrl
          );

          console.log(`✅ Icônes générées:`, Object.keys(generatedIcons));

          return {
            success: true,
            message: `${Object.keys(generatedIcons).length} icônes sociales générées avec succès`,
            icons: generatedIcons
          };

        } catch (error) {
          console.error('❌ Erreur génération icônes sociales:', error.message);
          return {
            success: false,
            message: error.message,
            icons: {}
          };
        }
      }
    ),

    /**
     * Met à jour les icônes sociales quand le logo change
     */
    updateCustomSocialIcons: isAuthenticated(
      async (_, { signatureId, newLogoUrl }, { user }) => {
        try {
          console.log(`🔄 Mise à jour icônes sociales - User: ${user.id}, Signature: ${signatureId}`);
          
          // Validation des paramètres
          if (!signatureId) {
            throw createValidationError('signatureId est requis');
          }
          
          if (!newLogoUrl) {
            throw createValidationError('newLogoUrl est requis');
          }

          // Mettre à jour les icônes
          const updatedIcons = await socialIconService.updateCustomSocialIcons(
            user.id,
            signatureId,
            newLogoUrl
          );

          console.log(`✅ Icônes mises à jour:`, Object.keys(updatedIcons));

          return {
            success: true,
            message: `${Object.keys(updatedIcons).length} icônes sociales mises à jour avec succès`,
            icons: updatedIcons
          };

        } catch (error) {
          console.error('❌ Erreur mise à jour icônes sociales:', error.message);
          return {
            success: false,
            message: error.message,
            icons: {}
          };
        }
      }
    ),

    /**
     * Supprime les icônes sociales personnalisées d'une signature
     */
    deleteCustomSocialIcons: isAuthenticated(
      async (_, { signatureId }, { user }) => {
        try {
          console.log(`🗑️ Suppression icônes sociales - User: ${user.id}, Signature: ${signatureId}`);
          
          // Validation des paramètres
          if (!signatureId) {
            throw createValidationError('signatureId est requis');
          }

          // Supprimer les icônes
          const result = await socialIconService.deleteCustomSocialIcons(
            user.id,
            signatureId
          );

          return {
            success: result,
            message: result ? 'Icônes sociales supprimées avec succès' : 'Erreur lors de la suppression'
          };

        } catch (error) {
          console.error('❌ Erreur suppression icônes sociales:', error.message);
          return {
            success: false,
            message: error.message
          };
        }
      }
    )
  }
};

export default socialIconResolvers;
