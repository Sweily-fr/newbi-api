import Client from "../models/Client.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import {
  isAuthenticated,
  withWorkspace,
} from "../middlewares/better-auth-jwt.js";
import {
  createNotFoundError,
  createAlreadyExistsError,
  createResourceInUseError,
} from "../utils/errors.js";
import mongoose from "mongoose";

const clientResolvers = {
  Query: {
    client: withWorkspace(
      async (
        _,
        { id, workspaceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });
        if (!client) throw createNotFoundError("Client");
        return client;
      }
    ),

    clients: withWorkspace(
      async (
        _,
        { page = 1, limit = 10, search, workspaceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const query = {
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        };

        if (search) {
          query.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { "address.city": { $regex: search, $options: "i" } },
            { "address.country": { $regex: search, $options: "i" } },
            { "address.postalCode": { $regex: search, $options: "i" } },
            { "address.street": { $regex: search, $options: "i" } },
            { firstName: { $regex: search, $options: "i" } },
            { lastName: { $regex: search, $options: "i" } },
            { siret: { $regex: search, $options: "i" } },
            { vatNumber: { $regex: search, $options: "i" } },
          ];
        }

        // Convertir en nombres pour éviter les problèmes de type
        const currentPage = parseInt(page, 10);
        const itemsPerPage = parseInt(limit, 10);

        // Calculer le nombre total de clients correspondant à la requête
        const totalItems = await Client.countDocuments(query);

        // Calculer le nombre total de pages
        const totalPages = Math.ceil(totalItems / itemsPerPage);

        // Récupérer les clients pour la page demandée
        const items = await Client.find(query)
          .sort({ name: 1 })
          .skip((currentPage - 1) * itemsPerPage)
          .limit(itemsPerPage);

        return {
          items,
          totalItems,
          currentPage,
          totalPages,
        };
      }
    ),
  },

  Mutation: {
    createClient: withWorkspace(
      async (
        _,
        { input, workspaceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;

        const existingClient = await Client.findOne({
          email: input.email.toLowerCase(),
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });

        if (existingClient) {
          throw createAlreadyExistsError("client", "email", input.email);
        }

        // Validation et traitement spécifique selon le type de client
        let clientData = { ...input };

        if (input.type === "COMPANY") {
          // Pour une entreprise, le SIRET est recommandé
          if (!input.siret && !input.vatNumber) {
            console.warn(
              "Création d'un client entreprise sans SIRET ni numéro de TVA"
            );
          }
        } else if (input.type === "INDIVIDUAL") {
          // Pour un particulier, générer le nom complet à partir de firstName et lastName
          if (input.firstName && input.lastName) {
            clientData.name = `${input.firstName} ${input.lastName}`;
          } else if (input.firstName) {
            clientData.name = input.firstName;
          } else if (input.lastName) {
            clientData.name = input.lastName;
          } else if (!input.name) {
            console.warn(
              "Création d'un client particulier sans prénom, nom de famille, ni nom complet"
            );
          }
        }

        const client = new Client({
          ...clientData,
          email: input.email.toLowerCase(),
          createdBy: user.id,
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });

        await client.save();
        return client;
      }
    ),

    updateClient: withWorkspace(
      async (
        _,
        { id, input, workspaceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Si l'email est modifié, vérifier qu'il n'existe pas déjà dans ce workspace
        if (input.email && input.email !== client.email) {
          const existingClient = await Client.findOne({
            email: input.email.toLowerCase(),
            workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
            _id: { $ne: id },
          });

          if (existingClient) {
            throw createAlreadyExistsError("client", "email", input.email);
          }
        }

        // Validation et traitement spécifique selon le type de client
        let updateData = { ...input };

        if (input.type === "COMPANY") {
          // Pour une entreprise, le SIRET est recommandé
          if (
            !input.siret &&
            !input.vatNumber &&
            !client.siret &&
            !client.vatNumber
          ) {
            console.warn(
              "Mise à jour d'un client entreprise sans SIRET ni numéro de TVA"
            );
          }
        } else if (input.type === "INDIVIDUAL") {
          // Pour un particulier, générer le nom complet à partir de firstName et lastName
          const firstName =
            input.firstName !== undefined ? input.firstName : client.firstName;
          const lastName =
            input.lastName !== undefined ? input.lastName : client.lastName;

          if (firstName && lastName) {
            updateData.name = `${firstName} ${lastName}`;
          } else if (firstName) {
            updateData.name = firstName;
          } else if (lastName) {
            updateData.name = lastName;
          } else if (!input.name && !client.name) {
            console.warn(
              "Mise à jour d'un client particulier sans prénom, nom de famille, ni nom complet"
            );
          }
        }

        // Mettre à jour le client
        Object.keys(updateData).forEach((key) => {
          client[key] =
            key === "email" ? updateData[key].toLowerCase() : updateData[key];
        });

        await client.save();
        return client;
      }
    ),

    deleteClient: withWorkspace(
      async (
        _,
        { id, workspaceId },
        { user, workspaceId: contextWorkspaceId }
      ) => {
        const finalWorkspaceId = workspaceId || contextWorkspaceId;
        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Vérifier si le client est utilisé dans des factures
        const invoiceCount = await Invoice.countDocuments({
          "client.id": id, // Utiliser l'ID du client plutôt que l'email
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });

        if (invoiceCount > 0) {
          throw createResourceInUseError("client", "factures");
        }

        // Vérifier si le client est utilisé dans des devis
        const quoteCount = await Quote.countDocuments({
          "client.id": id, // Utiliser l'ID du client plutôt que l'email
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });

        if (quoteCount > 0) {
          throw createResourceInUseError("client", "devis");
        }

        await Client.deleteOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(finalWorkspaceId),
        });
        return true;
      }
    ),
  },
};

export default clientResolvers;
