import ProductCustomField from "../models/ProductCustomField.js";
import {
  checkSubscriptionActive,
  requireWorkspaceLevel,
  requireWorkspaceAction,
} from "../middlewares/rbac.js";

// Champs personnalisés du catalogue : rôle contrôlé sur le module
// « products » dans l'espace args.workspaceId (celui que lisent les
// resolvers). requireWorkspaceLevel laisse passer les messages d'erreur des
// resolvers tels quels (« Un champ avec ce nom existe déjà »…).
const readProducts = requireWorkspaceLevel("products", "read");
// Créer, modifier, réordonner et supprimer : action « customFields »
const manageCustomFields = requireWorkspaceAction("products", "customFields");

export const productCustomFieldResolvers = {
  Query: {
    // Récupère tous les champs personnalisés produits d'un workspace
    productCustomFields: readProducts(async (_, { workspaceId }, context) => {
      try {
        const fields = await ProductCustomField.find({ workspaceId }).sort({
          order: 1,
          createdAt: 1,
        });

        return fields;
      } catch (error) {
        console.error(
          "Erreur lors de la récupération des champs personnalisés produits:",
          error,
        );
        throw new Error(
          "Impossible de récupérer les champs personnalisés produits",
        );
      }
    }),

    // Récupère un champ personnalisé produit par ID
    productCustomField: readProducts(
      async (_, { workspaceId, id }, context) => {
        try {
          const field = await ProductCustomField.findOne({
            _id: id,
            workspaceId,
          });

          if (!field) {
            throw new Error("Champ personnalisé produit non trouvé");
          }

          return field;
        } catch (error) {
          console.error(
            "Erreur lors de la récupération du champ personnalisé produit:",
            error,
          );
          throw error;
        }
      },
    ),
  },

  Mutation: {
    // Créer un nouveau champ personnalisé produit
    createProductCustomField: manageCustomFields(
      async (_, { workspaceId, input }, context) => {
        try {
          const userId = context.user.id;

          // Vérifier si un champ avec le même nom existe déjà
          const existingField = await ProductCustomField.findOne({
            workspaceId,
            name: input.name,
          });

          if (existingField) {
            throw new Error("Un champ avec ce nom existe déjà");
          }

          // Récupérer l'ordre maximum actuel
          const maxOrderField = await ProductCustomField.findOne({
            workspaceId,
          }).sort({ order: -1 });
          const nextOrder = maxOrderField ? maxOrderField.order + 1 : 0;

          const field = new ProductCustomField({
            ...input,
            order: input.order ?? nextOrder,
            workspaceId,
            createdBy: userId,
          });

          await field.save();

          return field;
        } catch (error) {
          console.error(
            "Erreur lors de la création du champ personnalisé produit:",
            error,
          );
          throw error;
        }
      },
    ),

    // Modifier un champ personnalisé produit
    updateProductCustomField: manageCustomFields(
      async (_, { workspaceId, id, input }, context) => {
        try {
          // Vérifier si un autre champ avec le même nom existe
          if (input.name) {
            const existingField = await ProductCustomField.findOne({
              workspaceId,
              name: input.name,
              _id: { $ne: id },
            });

            if (existingField) {
              throw new Error("Un champ avec ce nom existe déjà");
            }
          }

          const field = await ProductCustomField.findOneAndUpdate(
            { _id: id, workspaceId },
            { $set: input },
            { new: true, runValidators: true },
          );

          if (!field) {
            throw new Error("Champ personnalisé produit non trouvé");
          }

          return field;
        } catch (error) {
          console.error(
            "Erreur lors de la modification du champ personnalisé produit:",
            error,
          );
          throw error;
        }
      },
    ),

    // Supprimer un champ personnalisé produit
    deleteProductCustomField: manageCustomFields(
      async (_, { workspaceId, id }, context) => {
        try {
          const result = await ProductCustomField.findOneAndDelete({
            _id: id,
            workspaceId,
          });

          if (!result) {
            throw new Error("Champ personnalisé produit non trouvé");
          }

          return true;
        } catch (error) {
          console.error(
            "Erreur lors de la suppression du champ personnalisé produit:",
            error,
          );
          throw error;
        }
      },
    ),

    // Réordonner les champs personnalisés produits
    reorderProductCustomFields: manageCustomFields(
      async (_, { workspaceId, fieldIds }, context) => {
        try {
          // Mettre à jour l'ordre de chaque champ
          const updatePromises = fieldIds.map((fieldId, index) =>
            ProductCustomField.findOneAndUpdate(
              { _id: fieldId, workspaceId },
              { $set: { order: index } },
              { new: true },
            ),
          );

          await Promise.all(updatePromises);

          // Retourner les champs dans le nouvel ordre
          const fields = await ProductCustomField.find({ workspaceId }).sort({
            order: 1,
          });

          return fields;
        } catch (error) {
          console.error(
            "Erreur lors du réordonnancement des champs produits:",
            error,
          );
          throw error;
        }
      },
    ),
  },

  // Resolver pour le type ProductCustomField
  ProductCustomField: {
    id: (parent) => parent._id?.toString() || parent.id,
  },
};

// ✅ Phase A.3 — Subscription check sur toutes les mutations productCustomField
const originalProductCFMutations = productCustomFieldResolvers.Mutation;
productCustomFieldResolvers.Mutation = Object.fromEntries(
  Object.entries(originalProductCFMutations).map(([name, fn]) => [
    name,
    async (parent, args, context, info) => {
      await checkSubscriptionActive(context);
      return fn(parent, args, context, info);
    },
  ]),
);
