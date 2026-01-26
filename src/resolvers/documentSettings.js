import DocumentSettings from '../models/DocumentSettings.js';
import { UserInputError } from 'apollo-server-express';
import { isAuthenticated } from '../middlewares/better-auth-jwt.js';

export default {
  Query: {
    // Récupérer les paramètres d'un type de document (facture ou devis)
    getDocumentSettings: isAuthenticated(async (_, { documentType }, { user }) => {
      // Rechercher les paramètres existants pour ce type de document et cet utilisateur
      const settings = await DocumentSettings.findOne({
        documentType,
        createdBy: user.id || user._id
      });

      // Si aucun paramètre n'existe, retourner null
      return settings;
    })
  },

  Mutation: {
    // Créer ou mettre à jour les paramètres d'un document
    saveDocumentSettings: isAuthenticated(async (_, { input }, { user }) => {
      const { documentType, ...settingsData } = input;
      const userId = user.id || user._id;

      try {
        // Rechercher les paramètres existants ou créer un nouveau document
        const settings = await DocumentSettings.findOneAndUpdate(
          { documentType, createdBy: userId },
          { ...settingsData, createdBy: userId },
          { new: true, upsert: true, runValidators: true }
        );

        return settings;
      } catch (error) {
        console.error('Erreur lors de la sauvegarde des paramètres:', error);
        throw new UserInputError('Erreur lors de la sauvegarde des paramètres', {
          invalidArgs: Object.keys(error.errors || {})
        });
      }
    })
  }
};
