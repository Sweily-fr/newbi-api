import ClientCustomField from "../models/ClientCustomField.js";
import {
  withOrganization,
  resolveWorkspaceId,
  checkSubscriptionActive,
} from "../middlewares/rbac.js";

// 🔐 Ferme l'IDOR : valide l'appartenance à l'organisation (withOrganization)
// et impose le workspace validé par RBAC à la place de l'ID brut des args.
const scopedQuery = (fn) =>
  withOrganization(async (parent, args, context, info) =>
    fn(
      parent,
      {
        ...args,
        workspaceId: resolveWorkspaceId(args.workspaceId, context.workspaceId),
      },
      context,
      info,
    ),
  );

const scopedMutation = (fn) =>
  withOrganization(async (parent, args, context, info) => {
    await checkSubscriptionActive(context);
    return fn(
      parent,
      {
        ...args,
        workspaceId: resolveWorkspaceId(args.workspaceId, context.workspaceId),
      },
      context,
      info,
    );
  });

export const clientCustomFieldResolvers = {
  Query: {
    // Récupère tous les champs personnalisés d'un workspace
    clientCustomFields: scopedQuery(async (_, { workspaceId }, context) => {
      try {
        const fields = await ClientCustomField.find({ workspaceId }).sort({
          order: 1,
          createdAt: 1,
        });

        return fields;
      } catch (error) {
        console.error(
          "Erreur lors de la récupération des champs personnalisés:",
          error,
        );
        throw new Error("Impossible de récupérer les champs personnalisés");
      }
    }),

    // Récupère un champ personnalisé par ID
    clientCustomField: scopedQuery(async (_, { workspaceId, id }, context) => {
      try {
        const field = await ClientCustomField.findOne({
          _id: id,
          workspaceId,
        });

        if (!field) {
          throw new Error("Champ personnalisé non trouvé");
        }

        return field;
      } catch (error) {
        console.error(
          "Erreur lors de la récupération du champ personnalisé:",
          error,
        );
        throw error;
      }
    }),
  },

  Mutation: {
    // Créer un nouveau champ personnalisé
    createClientCustomField: scopedMutation(
      async (_, { workspaceId, input }, context) => {
        try {
          const userId = context.user.id;

          // Vérifier si un champ avec le même nom existe déjà
          const existingField = await ClientCustomField.findOne({
            workspaceId,
            name: input.name,
          });

          if (existingField) {
            throw new Error("Un champ avec ce nom existe déjà");
          }

          // Récupérer l'ordre maximum actuel
          const maxOrderField = await ClientCustomField.findOne({
            workspaceId,
          }).sort({ order: -1 });
          const nextOrder = maxOrderField ? maxOrderField.order + 1 : 0;

          const field = new ClientCustomField({
            ...input,
            order: input.order ?? nextOrder,
            workspaceId,
            createdBy: userId,
          });

          await field.save();

          return field;
        } catch (error) {
          console.error(
            "Erreur lors de la création du champ personnalisé:",
            error,
          );
          throw error;
        }
      },
    ),

    // Modifier un champ personnalisé
    updateClientCustomField: scopedMutation(
      async (_, { workspaceId, id, input }, context) => {
        try {
          // Vérifier si un autre champ avec le même nom existe
          if (input.name) {
            const existingField = await ClientCustomField.findOne({
              workspaceId,
              name: input.name,
              _id: { $ne: id },
            });

            if (existingField) {
              throw new Error("Un champ avec ce nom existe déjà");
            }
          }

          const field = await ClientCustomField.findOneAndUpdate(
            { _id: id, workspaceId },
            { $set: input },
            { new: true, runValidators: true },
          );

          if (!field) {
            throw new Error("Champ personnalisé non trouvé");
          }

          return field;
        } catch (error) {
          console.error(
            "Erreur lors de la modification du champ personnalisé:",
            error,
          );
          throw error;
        }
      },
    ),

    // Supprimer un champ personnalisé
    deleteClientCustomField: scopedMutation(
      async (_, { workspaceId, id }, context) => {
        try {
          const result = await ClientCustomField.findOneAndDelete({
            _id: id,
            workspaceId,
          });

          if (!result) {
            throw new Error("Champ personnalisé non trouvé");
          }

          return true;
        } catch (error) {
          console.error(
            "Erreur lors de la suppression du champ personnalisé:",
            error,
          );
          throw error;
        }
      },
    ),

    // Réordonner les champs personnalisés
    reorderClientCustomFields: scopedMutation(
      async (_, { workspaceId, fieldIds }, context) => {
        try {
          // Mettre à jour l'ordre de chaque champ
          const updatePromises = fieldIds.map((fieldId, index) =>
            ClientCustomField.findOneAndUpdate(
              { _id: fieldId, workspaceId },
              { $set: { order: index } },
              { new: true },
            ),
          );

          await Promise.all(updatePromises);

          // Retourner les champs dans le nouvel ordre
          const fields = await ClientCustomField.find({ workspaceId }).sort({
            order: 1,
          });

          return fields;
        } catch (error) {
          console.error("Erreur lors du réordonnancement des champs:", error);
          throw error;
        }
      },
    ),
  },

  // Resolver pour le type ClientCustomField
  ClientCustomField: {
    id: (parent) => parent._id?.toString() || parent.id,
  },
};

// Le contrôle d'abonnement est fait dans scopedMutation, APRÈS l'enrichissement
// RBAC (context.workspaceId validé), plus via un wrapper externe pré-RBAC.
