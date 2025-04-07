const Client = require('../models/Client');
const Invoice = require('../models/Invoice');
const Quote = require('../models/Quote');
const { isAuthenticated } = require('../middlewares/auth');
const { 
  createNotFoundError, 
  createAlreadyExistsError,
  createResourceInUseError
} = require('../utils/errors');

const clientResolvers = {
  Query: {
    client: isAuthenticated(async (_, { id }, { user }) => {
      const client = await Client.findOne({ _id: id, createdBy: user.id });
      if (!client) throw createNotFoundError('Client');
      return client;
    }),

    clients: isAuthenticated(async (_, { search }, { user }) => {
      const query = { createdBy: user.id };
      
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }
      
      return await Client.find(query).sort({ name: 1 });
    })
  },

  Mutation: {
    createClient: isAuthenticated(async (_, { input }, { user }) => {
      // Vérifier si un client avec cet email existe déjà
      const existingClient = await Client.findOne({ 
        email: input.email.toLowerCase(),
        createdBy: user.id 
      });
      
      if (existingClient) {
        throw createAlreadyExistsError('client', 'email', input.email);
      }
      
      // Validation spécifique selon le type de client
      if (input.type === 'COMPANY') {
        // Pour une entreprise, le SIRET est recommandé
        if (!input.siret && !input.vatNumber) {
          console.warn('Création d\'un client entreprise sans SIRET ni numéro de TVA');
        }
      } else if (input.type === 'INDIVIDUAL') {
        // Pour un particulier, firstName et lastName sont recommandés
        if (!input.firstName && !input.lastName) {
          console.warn('Création d\'un client particulier sans prénom ni nom de famille');
        }
      }
      
      const client = new Client({
        ...input,
        email: input.email.toLowerCase(),
        createdBy: user.id
      });
      
      await client.save();
      return client;
    }),

    updateClient: isAuthenticated(async (_, { id, input }, { user }) => {
      const client = await Client.findOne({ _id: id, createdBy: user.id });
      
      if (!client) {
        throw createNotFoundError('Client');
      }
      
      // Si l'email est modifié, vérifier qu'il n'existe pas déjà
      if (input.email && input.email !== client.email) {
        const existingClient = await Client.findOne({ 
          email: input.email.toLowerCase(),
          createdBy: user.id,
          _id: { $ne: id }
        });
        
        if (existingClient) {
          throw createAlreadyExistsError('client', 'email', input.email);
        }
      }
      
      // Validation spécifique selon le type de client
      if (input.type === 'COMPANY') {
        // Pour une entreprise, le SIRET est recommandé
        if (!input.siret && !input.vatNumber && !client.siret && !client.vatNumber) {
          console.warn('Mise à jour d\'un client entreprise sans SIRET ni numéro de TVA');
        }
      } else if (input.type === 'INDIVIDUAL') {
        // Pour un particulier, firstName et lastName sont recommandés
        const firstName = input.firstName || client.firstName;
        const lastName = input.lastName || client.lastName;
        if (!firstName && !lastName) {
          console.warn('Mise à jour d\'un client particulier sans prénom ni nom de famille');
        }
      }
      
      // Mettre à jour le client
      Object.keys(input).forEach(key => {
        client[key] = key === 'email' ? input[key].toLowerCase() : input[key];
      });
      
      await client.save();
      return client;
    }),

    deleteClient: isAuthenticated(async (_, { id }, { user }) => {
      const client = await Client.findOne({ _id: id, createdBy: user.id });
      
      if (!client) {
        throw createNotFoundError('Client');
      }
      
      // Vérifier si le client est utilisé dans des factures
      const invoiceCount = await Invoice.countDocuments({ 
        'client.email': client.email,
        createdBy: user.id
      });
      
      if (invoiceCount > 0) {
        throw createResourceInUseError('client', 'factures');
      }
      
      // Vérifier si le client est utilisé dans des devis
      const quoteCount = await Quote.countDocuments({ 
        'client.email': client.email,
        createdBy: user.id
      });
      
      if (quoteCount > 0) {
        throw createResourceInUseError('client', 'devis');
      }
      
      await Client.deleteOne({ _id: id, createdBy: user.id });
      return true;
    })
  }
};

module.exports = clientResolvers;
