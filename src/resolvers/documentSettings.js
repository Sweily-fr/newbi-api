const DocumentSettings = require('../models/DocumentSettings');
const { AuthenticationError, UserInputError } = require('apollo-server-express');

module.exports = {
  Query: {
    // Récupérer les paramètres d'un type de document (facture ou devis)
    getDocumentSettings: async (_, { documentType }, { user }) => {
      if (!user) {
        throw new AuthenticationError('Vous devez être connecté pour accéder à ces informations');
      }

      // Rechercher les paramètres existants pour ce type de document et cet utilisateur
      const settings = await DocumentSettings.findOne({
        documentType,
        createdBy: user.id
      });

      // Si aucun paramètre n'existe, retourner null
      return settings;
    }
  },

  Mutation: {
    // Créer ou mettre à jour les paramètres d'un document
    saveDocumentSettings: async (_, { input }, { user }) => {
      if (!user) {
        throw new AuthenticationError('Vous devez être connecté pour effectuer cette action');
      }

      const { documentType, ...settingsData } = input;

      try {
        // Rechercher les paramètres existants ou créer un nouveau document
        const settings = await DocumentSettings.findOneAndUpdate(
          { documentType, createdBy: user.id },
          { ...settingsData, createdBy: user.id },
          { new: true, upsert: true, runValidators: true }
        );

        return settings;
      } catch (error) {
        console.error('Erreur lors de la sauvegarde des paramètres:', error);
        throw new UserInputError('Erreur lors de la sauvegarde des paramètres', {
          invalidArgs: Object.keys(error.errors || {})
        });
      }
    }
  }
};
