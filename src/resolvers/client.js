import Client from "../models/Client.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import { isAuthenticated } from "../middlewares/auth.js";
import {
  createNotFoundError,
  createAlreadyExistsError,
  createResourceInUseError,
} from "../utils/errors.js";

const clientResolvers = {
  Query: {
    client: isAuthenticated(async (_, { id }, { user }) => {
      const client = await Client.findOne({ _id: id, createdBy: user.id });
      if (!client) throw createNotFoundError("Client");
      return client;
    }),

    clients: isAuthenticated(
      async (_, { page = 1, limit = 10, search }, { user }) => {
        const query = { createdBy: user.id };

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
    createClient: isAuthenticated(async (_, { input }, { user }) => {
      // Vérifier si un client avec cet email existe déjà
      const existingClient = await Client.findOne({
        email: input.email.toLowerCase(),
        createdBy: user.id,
      });

      if (existingClient) {
        throw createAlreadyExistsError("client", "email", input.email);
      }

      // Validation spécifique selon le type de client
      if (input.type === "COMPANY") {
        // Pour une entreprise, le SIRET est recommandé
        if (!input.siret && !input.vatNumber) {
          console.warn(
            "Création d'un client entreprise sans SIRET ni numéro de TVA"
          );
        }
      } else if (input.type === "INDIVIDUAL") {
        // Pour un particulier, firstName et lastName sont recommandés
        if (!input.firstName && !input.lastName) {
          console.warn(
            "Création d'un client particulier sans prénom ni nom de famille"
          );
        }
      }

      const client = new Client({
        ...input,
        email: input.email.toLowerCase(),
        createdBy: user.id,
      });

      await client.save();
      return client;
    }),

    updateClient: isAuthenticated(async (_, { id, input }, { user }) => {
      const client = await Client.findOne({ _id: id, createdBy: user.id });

      if (!client) {
        throw createNotFoundError("Client");
      }

      // Si l'email est modifié, vérifier qu'il n'existe pas déjà
      if (input.email && input.email !== client.email) {
        const existingClient = await Client.findOne({
          email: input.email.toLowerCase(),
          createdBy: user.id,
          _id: { $ne: id },
        });

        if (existingClient) {
          throw createAlreadyExistsError("client", "email", input.email);
        }
      }

      // Validation spécifique selon le type de client
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
        // Pour un particulier, firstName et lastName sont recommandés
        const firstName = input.firstName || client.firstName;
        const lastName = input.lastName || client.lastName;
        if (!firstName && !lastName) {
          console.warn(
            "Mise à jour d'un client particulier sans prénom ni nom de famille"
          );
        }
      }

      // Mettre à jour le client
      Object.keys(input).forEach((key) => {
        client[key] = key === "email" ? input[key].toLowerCase() : input[key];
      });

      await client.save();
      return client;
    }),

    deleteClient: isAuthenticated(async (_, { id }, { user }) => {
      const client = await Client.findOne({ _id: id, createdBy: user.id });

      if (!client) {
        throw createNotFoundError("Client");
      }

      // Vérifier si le client est utilisé dans des factures
      const invoiceCount = await Invoice.countDocuments({
        "client.id": id, // Utiliser l'ID du client plutôt que l'email
        createdBy: user.id,
      });

      if (invoiceCount > 0) {
        throw createResourceInUseError("client", "factures");
      }

      // Vérifier si le client est utilisé dans des devis
      const quoteCount = await Quote.countDocuments({
        "client.id": id, // Utiliser l'ID du client plutôt que l'email
        createdBy: user.id,
      });

      if (quoteCount > 0) {
        throw createResourceInUseError("client", "devis");
      }

      await Client.deleteOne({ _id: id, createdBy: user.id });
      return true;
    }),
  },
};

export default clientResolvers;
