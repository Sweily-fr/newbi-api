import Client from "../models/Client.js";
import ClientCustomField from "../models/ClientCustomField.js";
import Invoice from "../models/Invoice.js";
import Quote from "../models/Quote.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import User from "../models/User.js";
// ✅ Import des wrappers RBAC
import {
  requireRead,
  requireWrite,
  requireDelete,
} from "../middlewares/rbac.js";
import {
  createNotFoundError,
  createAlreadyExistsError,
  createResourceInUseError,
  AppError,
  ERROR_CODES,
} from "../utils/errors.js";
import mongoose from "mongoose";
import { automationService } from "./clientAutomation.js";

const clientResolvers = {
  Query: {
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "clients"
    client: requireRead("clients")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        if (!client) throw createNotFoundError("Client");
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "view" sur "clients"
    clients: requireRead("clients")(
      async (_, { page = 1, limit = 10, search, workspaceId: inputWorkspaceId }, context) => {
        const { workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const query = {
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
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
    // ✅ Protégé par RBAC - nécessite la permission "create" sur "clients"
    createClient: requireWrite("clients")(
      async (_, { input, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const existingClient = await Client.findOne({
          email: input.email.toLowerCase(),
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (existingClient) {
          throw createAlreadyExistsError("client", "email", input.email);
        }

        // Validation et traitement spécifique selon le type de client
        let clientData = { ...input };

        if (input.type === "COMPANY") {
          // Pour une entreprise, le numéro d'identification est obligatoire
          if (!input.siret || input.siret.trim() === "") {
            throw new Error(
              input.isInternational
                ? "Le numéro d'identification est obligatoire pour une entreprise internationale"
                : "Le SIREN/SIRET est obligatoire pour une entreprise française"
            );
          }
          // Valider le format du SIREN (9 chiffres) ou SIRET (14 chiffres) - uniquement pour les entreprises françaises
          if (
            !input.isInternational &&
            !/^\d{9}$/.test(input.siret) &&
            !/^\d{14}$/.test(input.siret)
          ) {
            throw new Error(
              "Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres"
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
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
          activity: [
            {
              id: new mongoose.Types.ObjectId().toString(),
              userId: user.id,
              userName: user.name || user.email,
              userImage: user.image || null,
              type: "created",
              description: "a créé le client",
              createdAt: new Date(),
            },
          ],
        });

        await client.save();

        // Exécuter les automatisations CLIENT_CREATED
        try {
          await automationService.executeAutomations(
            "CLIENT_CREATED",
            workspaceId,
            client._id.toString(),
            {}
          );
        } catch (automationError) {
          console.error(
            "Erreur lors de l'exécution des automatisations CLIENT_CREATED:",
            automationError
          );
        }

        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    updateClient: requireWrite("clients")(
      async (_, { id, input, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Si l'email est modifié, vérifier qu'il n'existe pas déjà dans ce workspace
        if (input.email && input.email !== client.email) {
          const existingClient = await Client.findOne({
            email: input.email.toLowerCase(),
            workspaceId: new mongoose.Types.ObjectId(workspaceId),
            _id: { $ne: id },
          });

          if (existingClient) {
            throw createAlreadyExistsError("client", "email", input.email);
          }
        }

        // Validation et traitement spécifique selon le type de client
        let updateData = { ...input };

        if (input.type === "COMPANY") {
          // Pour une entreprise, le numéro d'identification est obligatoire
          if (!input.siret || input.siret.trim() === "") {
            throw new Error(
              input.isInternational
                ? "Le numéro d'identification est obligatoire pour une entreprise internationale"
                : "Le SIREN/SIRET est obligatoire pour une entreprise française"
            );
          }
          // Valider le format du SIREN (9 chiffres) ou SIRET (14 chiffres) - uniquement pour les entreprises françaises
          if (
            !input.isInternational &&
            !/^\d{9}$/.test(input.siret) &&
            !/^\d{14}$/.test(input.siret)
          ) {
            throw new Error(
              "Le SIREN doit contenir 9 chiffres ou le SIRET 14 chiffres"
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

        // Fonction pour comparer deux valeurs en profondeur
        const hasChanged = (oldVal, newVal) => {
          // Si les deux sont null/undefined, pas de changement
          if (oldVal == null && newVal == null) return false;
          // Si l'un est null/undefined et pas l'autre, changement
          if ((oldVal == null) !== (newVal == null)) return true;
          // Pour les objets, comparer en JSON (trié pour éviter les faux positifs)
          if (typeof oldVal === "object" && typeof newVal === "object") {
            return JSON.stringify(oldVal) !== JSON.stringify(newVal);
          }
          // Pour les valeurs primitives, comparaison directe
          return oldVal !== newVal;
        };

        // Tracker les changements
        const changes = [];

        // Récupérer les noms des champs personnalisés si customFields a changé
        let customFieldNamesMap = {};
        if (updateData.customFields) {
          const fieldIds = [
            ...(client.customFields || []).map((cf) => cf.fieldId),
            ...updateData.customFields.map((cf) => cf.fieldId),
          ].filter(Boolean);

          if (fieldIds.length > 0) {
            const customFieldDefs = await ClientCustomField.find({
              _id: { $in: fieldIds },
              workspaceId: new mongoose.Types.ObjectId(workspaceId),
            });
            customFieldDefs.forEach((def) => {
              customFieldNamesMap[def._id.toString()] = def.name;
            });
          }
        }

        Object.keys(updateData).forEach((key) => {
          if (key !== "notes" && key !== "activity") {
            const oldValue = client[key];
            const newValue =
              key === "email" ? updateData[key].toLowerCase() : updateData[key];

            // Vérifier si la valeur a réellement changé
            if (hasChanged(oldValue, newValue)) {
              if (key === "customFields") {
                // Identifier quels champs personnalisés ont changé
                // .toString() pour uniformiser ObjectId vs string
                const oldFields = new Map(
                  (oldValue || []).map((cf) => [cf.fieldId?.toString(), cf.value])
                );
                const newFields = new Map(
                  (newValue || []).map((cf) => [cf.fieldId?.toString(), cf.value])
                );

                const allFieldIds = new Set([
                  ...oldFields.keys(),
                  ...newFields.keys(),
                ]);
                const changedFieldNames = [];
                for (const fieldId of allFieldIds) {
                  if (oldFields.get(fieldId) !== newFields.get(fieldId)) {
                    const name = customFieldNamesMap[fieldId];
                    if (name) {
                      changedFieldNames.push(`le champ "${name}"`);
                    }
                  }
                }
                if (changedFieldNames.length > 0) {
                  changes.push(...changedFieldNames);
                } else {
                  changes.push("les champs personnalisés");
                }
              } else {
                const fieldNames = {
                  name: "le nom",
                  firstName: "le prénom",
                  lastName: "le nom de famille",
                  email: "l'email",
                  phone: "le téléphone",
                  address: "l'adresse de facturation",
                  hasDifferentShippingAddress:
                    "l'option adresse de livraison différente",
                  shippingAddress: "l'adresse de livraison",
                  siret: "le SIRET",
                  vatNumber: "le numéro de TVA",
                  type: "le type",
                };
                changes.push(fieldNames[key] || key);
              }
            }

            client[key] = newValue;
          }
        });

        // Ajouter une activité si des changements ont été effectués
        if (changes.length > 0) {
          const description =
            changes.length === 1
              ? `a modifié ${changes[0]}`
              : `a modifié ${changes.slice(0, -1).join(", ")} et ${changes[changes.length - 1]}`;

          client.activity.push({
            id: new mongoose.Types.ObjectId().toString(),
            userId: user.id,
            userName: user.name || user.email,
            userImage: user.image || null,
            type: "updated",
            description: description,
            createdAt: new Date(),
          });
        }

        await client.save();
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "clients"
    deleteClient: requireDelete("clients")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        // Vérifier si le client est utilisé dans des factures
        const invoiceCount = await Invoice.countDocuments({
          "client.id": id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (invoiceCount > 0) {
          throw createResourceInUseError("client", "factures");
        }

        // Vérifier si le client est utilisé dans des devis
        const quoteCount = await Quote.countDocuments({
          "client.id": id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (quoteCount > 0) {
          throw createResourceInUseError("client", "devis");
        }

        // Vérifier si le client est utilisé dans des bons de commande
        const purchaseOrderCount = await PurchaseOrder.countDocuments({
          "client.id": id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (purchaseOrderCount > 0) {
          throw createResourceInUseError("client", "bons de commande");
        }

        await Client.deleteOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });
        return true;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    assignClientMembers: requireWrite("clients")(
      async (_, { id, memberIds, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) throw createNotFoundError("Client");

        client.assignedMembers = memberIds;

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          type: "assigned",
          description: memberIds.length > 0
            ? `a assigné ${memberIds.length} membre${memberIds.length > 1 ? "s" : ""}`
            : "a retiré tous les membres assignés",
          createdAt: new Date(),
        });

        await client.save();
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    blockClient: requireWrite("clients")(
      async (_, { id, reason, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) throw createNotFoundError("Client");

        if (client.isBlocked) {
          throw new AppError("Ce client est déjà bloqué", ERROR_CODES.BAD_REQUEST);
        }

        client.isBlocked = true;
        client.blockedAt = new Date();
        client.blockedReason = reason || null;

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          type: "blocked",
          description: reason ? `a bloqué le client : ${reason}` : "a bloqué le client",
          createdAt: new Date(),
        });

        try {
          await client.save();
        } catch (saveError) {
          if (saveError.name === 'ValidationError') {
            throw new AppError(
              "Impossible de bloquer ce contact en raison de données incohérentes dans son historique d'activité. Veuillez contacter le support.",
              ERROR_CODES.BAD_REQUEST
            );
          }
          throw saveError;
        }
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    unblockClient: requireWrite("clients")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: id,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) throw createNotFoundError("Client");

        if (!client.isBlocked) {
          throw new AppError("Ce client n'est pas bloqué", ERROR_CODES.BAD_REQUEST);
        }

        client.isBlocked = false;
        client.blockedAt = null;
        client.blockedReason = null;

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          type: "unblocked",
          description: "a débloqué le client",
          createdAt: new Date(),
        });

        try {
          await client.save();
        } catch (saveError) {
          if (saveError.name === 'ValidationError') {
            throw new AppError(
              "Impossible de débloquer ce contact en raison de données incohérentes dans son historique d'activité. Veuillez contacter le support.",
              ERROR_CODES.BAD_REQUEST
            );
          }
          throw saveError;
        }
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    addClientNote: requireWrite("clients")(
      async (_, { clientId, input, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        const noteId = new mongoose.Types.ObjectId().toString();
        const newNote = {
          id: noteId,
          content: input.content,
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        // Ajouter la note
        client.notes.push(newNote);

        // Ajouter l'activité
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "note_added",
          description: "a ajouté une note",
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
        });

        await client.save();
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    updateClientNote: requireWrite("clients")(
      async (_, { clientId, noteId, content, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        const note = client.notes.find((n) => n.id === noteId);
        if (!note) {
          throw createNotFoundError("Note");
        }

        // Vérifier que l'utilisateur est le créateur de la note
        if (note.userId.toString() !== user.id) {
          throw new Error("Vous n'êtes pas autorisé à modifier cette note");
        }

        note.content = content;
        note.updatedAt = new Date();

        // Ajouter l'activité
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "note_updated",
          description: "a modifié une note",
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
        });

        await client.save();
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "clients"
    deleteClientNote: requireDelete("clients")(
      async (_, { clientId, noteId, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        const noteIndex = client.notes.findIndex((n) => n.id === noteId);
        if (noteIndex === -1) {
          throw createNotFoundError("Note");
        }

        // Vérifier que l'utilisateur est le créateur de la note
        if (client.notes[noteIndex].userId.toString() !== user.id) {
          throw new Error("Vous n'êtes pas autorisé à supprimer cette note");
        }

        client.notes.splice(noteIndex, 1);

        // Ajouter l'activité
        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: "note_deleted",
          description: "a supprimé une note",
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          createdAt: new Date(),
        });

        await client.save();
        return client;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "clients"
    addClientActivity: requireWrite("clients")(
      async (_, { clientId, input, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        const client = await Client.findOne({
          _id: clientId,
          workspaceId: new mongoose.Types.ObjectId(workspaceId),
        });

        if (!client) {
          throw createNotFoundError("Client");
        }

        client.activity.push({
          id: new mongoose.Types.ObjectId().toString(),
          type: input.type,
          description: input.description,
          userId: user.id,
          userName: user.name || user.email,
          userImage: user.image || null,
          metadata: input.metadata || {},
          createdAt: new Date(),
        });

        await client.save();
        return client;
      }
    ),
  },

  // Resolvers de champs pour convertir les dates en strings ISO
  Client: {
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    updatedAt: (parent) =>
      parent.updatedAt?.toISOString?.() || parent.updatedAt,
    blockedAt: (parent) =>
      parent.blockedAt?.toISOString?.() || parent.blockedAt,
    hasDocuments: async (parent) => {
      const clientId = parent._id?.toString() || parent.id;
      const workspaceId = parent.workspaceId;

      const [invoiceCount, quoteCount, purchaseOrderCount] = await Promise.all([
        Invoice.countDocuments({ "client.id": clientId, workspaceId }),
        Quote.countDocuments({ "client.id": clientId, workspaceId }),
        PurchaseOrder.countDocuments({ "client.id": clientId, workspaceId }),
      ]);

      return invoiceCount + quoteCount + purchaseOrderCount > 0;
    },
  },

  ClientNote: {
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    updatedAt: (parent) =>
      parent.updatedAt?.toISOString?.() || parent.updatedAt,
    userName: async (parent) => {
      if (parent.userName && !parent.userName.includes("@")) {
        return parent.userName;
      }
      if (parent.userId) {
        try {
          const user = await User.findById(parent.userId).select("name email").lean();
          if (user?.name) return user.name;
        } catch {}
      }
      return parent.userName || "Système";
    },
    userImage: async (parent) => {
      if (parent.userImage) return parent.userImage;
      if (parent.userId) {
        try {
          const user = await User.findById(parent.userId).select("avatar").lean();
          return user?.avatar || null;
        } catch {}
      }
      return null;
    },
  },

  ClientActivity: {
    createdAt: (parent) =>
      parent.createdAt?.toISOString?.() || parent.createdAt,
    userName: async (parent) => {
      if (parent.userName && !parent.userName.includes("@")) {
        return parent.userName;
      }
      if (parent.userId) {
        try {
          const user = await User.findById(parent.userId).select("name email").lean();
          if (user?.name) return user.name;
        } catch {}
      }
      return parent.userName || "Système";
    },
    userImage: async (parent) => {
      if (parent.userImage) return parent.userImage;
      if (parent.userId) {
        try {
          const user = await User.findById(parent.userId).select("avatar").lean();
          return user?.avatar || null;
        } catch {}
      }
      return null;
    },
  },
};

export default clientResolvers;
