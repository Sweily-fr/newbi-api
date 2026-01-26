import ClientList from '../models/ClientList.js';
import Client from '../models/Client.js';
import { isAuthenticated } from '../middlewares/better-auth-jwt.js';

export const clientListResolvers = {
  Query: {
    // Récupère toutes les listes d'un workspace
    clientLists: isAuthenticated(async (_, { workspaceId }, context) => {
      try {
        const lists = await ClientList.find({ workspaceId })
          .populate('clients')
          .sort({ isDefault: -1, createdAt: -1 });

        return lists;
      } catch (error) {
        console.error('Erreur lors de la récupération des listes:', error);
        throw new Error('Impossible de récupérer les listes de clients');
      }
    }),

    // Récupère une liste spécifique par ID
    clientList: isAuthenticated(async (_, { workspaceId, id }, context) => {
      try {
        const list = await ClientList.findOne({ _id: id, workspaceId })
          .populate('clients');

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        return list;
      } catch (error) {
        console.error('Erreur lors de la récupération de la liste:', error);
        throw error;
      }
    }),

    // Récupère les clients d'une liste avec pagination
    clientsInList: isAuthenticated(async (_, { workspaceId, listId, page = 1, limit = 10, search = '' }, context) => {
      try {
        const list = await ClientList.findOne({ _id: listId, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        // Construire la requête de recherche - s'assurer que les IDs sont des ObjectIds
        const clientIds = list.clients.map(id => typeof id === 'string' ? id : id.toString());
        let query = { _id: { $in: clientIds } };

        if (search) {
          query.$and = [
            { _id: { $in: clientIds } },
            {
              $or: [
                { name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
              ]
            }
          ];
        }

        const totalItems = await Client.countDocuments(query);
        const skip = (page - 1) * limit;

        const items = await Client.find(query)
          .skip(skip)
          .limit(limit)
          .sort({ createdAt: -1 });

        return {
          items,
          totalItems,
          currentPage: page,
          totalPages: Math.ceil(totalItems / limit)
        };
      } catch (error) {
        console.error('Erreur lors de la récupération des clients de la liste:', error);
        throw error;
      }
    }),

    // Récupère les listes auxquelles appartient un client
    clientListsByClient: isAuthenticated(async (_, { workspaceId, clientId }, context) => {
      try {
        const lists = await ClientList.find({
          workspaceId,
          clients: clientId
        }).sort({ isDefault: -1, createdAt: -1 });

        return lists;
      } catch (error) {
        console.error('Erreur lors de la récupération des listes du client:', error);
        throw error;
      }
    })
  },

  Mutation: {
    // Crée une nouvelle liste de clients
    createClientList: isAuthenticated(async (_, { workspaceId, input }, context) => {
      try {
        const newList = new ClientList({
          name: input.name,
          description: input.description || '',
          color: input.color || '#3b82f6',
          icon: input.icon || 'Users',
          workspaceId,
          createdBy: context.user.id || context.user._id,
          clients: []
        });

        await newList.save();
        return newList;
      } catch (error) {
        console.error('Erreur lors de la création de la liste:', error);
        throw error;
      }
    }),

    // Met à jour une liste existante
    updateClientList: isAuthenticated(async (_, { workspaceId, id, input }, context) => {
      try {
        const list = await ClientList.findOne({ _id: id, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        if (list.isDefault) {
          throw new Error('Les listes par défaut ne peuvent pas être modifiées');
        }

        if (input.name) list.name = input.name;
        if (input.description !== undefined) list.description = input.description;
        if (input.color) list.color = input.color;
        if (input.icon) list.icon = input.icon;

        await list.save();
        return list.populate('clients');
      } catch (error) {
        console.error('Erreur lors de la mise à jour de la liste:', error);
        throw error;
      }
    }),

    // Supprime une liste
    deleteClientList: isAuthenticated(async (_, { workspaceId, id }, context) => {
      try {
        const list = await ClientList.findOne({ _id: id, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        if (list.isDefault) {
          throw new Error('Les listes par défaut ne peuvent pas être supprimées');
        }

        await ClientList.deleteOne({ _id: id });
        return true;
      } catch (error) {
        console.error('Erreur lors de la suppression de la liste:', error);
        throw error;
      }
    }),

    // Ajoute un client à une liste
    addClientToList: isAuthenticated(async (_, { workspaceId, listId, clientId }, context) => {
      try {
        const list = await ClientList.findOne({ _id: listId, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        // Vérifier que le client existe et appartient au workspace
        const client = await Client.findOne({ _id: clientId, workspaceId });

        if (!client) {
          throw new Error('Client non trouvé');
        }

        // Ajouter le client s'il n'est pas déjà dans la liste
        if (!list.clients.includes(clientId)) {
          list.clients.push(clientId);
          await list.save();
        }

        return list.populate('clients');
      } catch (error) {
        console.error('Erreur lors de l\'ajout du client à la liste:', error);
        throw error;
      }
    }),

    // Retire un client d'une liste
    removeClientFromList: isAuthenticated(async (_, { workspaceId, listId, clientId }, context) => {
      try {
        const list = await ClientList.findOne({ _id: listId, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        list.clients = list.clients.filter(id => id.toString() !== clientId);
        await list.save();

        return list.populate('clients');
      } catch (error) {
        console.error('Erreur lors de la suppression du client de la liste:', error);
        throw error;
      }
    }),

    // Ajoute plusieurs clients à une liste
    addClientsToList: isAuthenticated(async (_, { workspaceId, listId, clientIds }, context) => {
      try {
        const list = await ClientList.findOne({ _id: listId, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        // Vérifier que tous les clients existent
        const clients = await Client.find({
          _id: { $in: clientIds },
          workspaceId
        });

        if (clients.length !== clientIds.length) {
          throw new Error('Un ou plusieurs clients n\'existent pas');
        }

        // Ajouter les clients qui ne sont pas déjà dans la liste
        const existingClientIds = list.clients.map(id => id.toString());
        const newClientIds = clientIds.filter(id => !existingClientIds.includes(id));

        list.clients.push(...newClientIds);
        await list.save();

        return list.populate('clients');
      } catch (error) {
        console.error('Erreur lors de l\'ajout des clients à la liste:', error);
        throw error;
      }
    }),

    // Retire plusieurs clients d'une liste
    removeClientsFromList: isAuthenticated(async (_, { workspaceId, listId, clientIds }, context) => {
      try {
        const list = await ClientList.findOne({ _id: listId, workspaceId });

        if (!list) {
          throw new Error('Liste non trouvée');
        }

        const clientIdStrings = clientIds.map(id => id.toString());
        list.clients = list.clients.filter(id => !clientIdStrings.includes(id.toString()));
        await list.save();

        return list.populate('clients');
      } catch (error) {
        console.error('Erreur lors de la suppression des clients de la liste:', error);
        throw error;
      }
    }),

    // Ajoute un client à plusieurs listes
    addClientToLists: isAuthenticated(async (_, { workspaceId, clientId, listIds }, context) => {
      try {
        // Vérifier que le client existe
        const client = await Client.findOne({ _id: clientId, workspaceId });

        if (!client) {
          throw new Error('Client non trouvé');
        }

        // Vérifier que toutes les listes existent
        const lists = await ClientList.find({
          _id: { $in: listIds },
          workspaceId
        });

        if (lists.length !== listIds.length) {
          throw new Error('Une ou plusieurs listes n\'existent pas');
        }

        // Ajouter le client à chaque liste
        for (const list of lists) {
          if (!list.clients.includes(clientId)) {
            list.clients.push(clientId);
            await list.save();
          }
        }

        return lists.map(list => list.populate('clients'));
      } catch (error) {
        console.error('Erreur lors de l\'ajout du client aux listes:', error);
        throw error;
      }
    }),

    // Retire un client de plusieurs listes
    removeClientFromLists: isAuthenticated(async (_, { workspaceId, clientId, listIds }, context) => {
      try {
        // Vérifier que le client existe
        const client = await Client.findOne({ _id: clientId, workspaceId });

        if (!client) {
          throw new Error('Client non trouvé');
        }

        // Vérifier que toutes les listes existent
        const lists = await ClientList.find({
          _id: { $in: listIds },
          workspaceId
        });

        if (lists.length !== listIds.length) {
          throw new Error('Une ou plusieurs listes n\'existent pas');
        }

        // Supprimer le client de chaque liste
        for (const list of lists) {
          list.clients = list.clients.filter(id => id.toString() !== clientId);
          await list.save();
        }

        return lists.map(list => list.populate('clients'));
      } catch (error) {
        console.error('Erreur lors de la suppression du client des listes:', error);
        throw error;
      }
    })
  },

  ClientList: {
    clientCount(parent) {
      return parent.clients ? parent.clients.length : 0;
    }
  }
};
