import Product from '../models/Product.js';
// ✅ Import des wrappers RBAC
import {
  requireRead,
  requireWrite,
  requireDelete,
} from '../middlewares/rbac.js';
import {
  createNotFoundError,
  createAlreadyExistsError,
  AppError,
  ERROR_CODES
} from '../utils/errors.js';

const productResolvers = {
  Query: {
    // ✅ Protégé par RBAC - nécessite la permission "view" sur "products"
    product: requireRead("products")(
      async (_, { id, workspaceId: inputWorkspaceId }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        // ✅ FIX: Les produits sont partagés au niveau du workspace
        // Tous les utilisateurs avec permission "view" voient les produits du workspace
        const product = await Product.findOne({
          _id: id,
          workspaceId: workspaceId,
        });
        if (!product) throw createNotFoundError('Produit');
        return product;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "view" sur "products"
    products: requireRead("products")(
      async (_, { workspaceId: inputWorkspaceId, search, category, page = 1, limit = 20 }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }
        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        if (!workspaceId) {
          throw new AppError('workspaceId requis', ERROR_CODES.BAD_REQUEST);
        }

        // ✅ FIX: Les produits sont partagés au niveau du workspace
        // Tous les utilisateurs avec permission "view" voient les produits du workspace
        const query = {
          workspaceId: workspaceId,
        };

        if (search && search.trim() !== '') {
          const searchRegex = new RegExp(search, 'i');

          query.$or = [
            { name: searchRegex },
            { reference: searchRegex },
            { description: searchRegex }
          ];
        }

        if (category) {
          query.category = category;
        }

        const skip = (page - 1) * limit;
        let sortOptions = { name: 1 };

        const [products, totalCount] = await Promise.all([
          Product.find(query)
            .sort(sortOptions)
            .skip(skip)
            .limit(limit),
          Product.countDocuments(query)
        ]);

        return {
          products,
          totalCount,
          hasNextPage: skip + products.length < totalCount
        };
      }
    )
  },

  Mutation: {
    // ✅ Protégé par RBAC - nécessite la permission "create" sur "products"
    createProduct: requireWrite("products")(
      async (_, { input }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        const inputWorkspaceId = input.workspaceId;

        // Validation du workspaceId
        if (inputWorkspaceId && contextWorkspaceId && inputWorkspaceId !== contextWorkspaceId) {
          throw new AppError(
            "Organisation invalide. Vous n'avez pas accès à cette organisation.",
            ERROR_CODES.FORBIDDEN
          );
        }

        const workspaceId = inputWorkspaceId || contextWorkspaceId;

        if (!workspaceId) {
          throw new AppError('workspaceId requis', ERROR_CODES.BAD_REQUEST);
        }

        // ✅ FIX: Vérifier si un produit avec ce nom existe déjà dans le workspace
        // Les produits sont partagés au niveau de l'organisation
        const existingProduct = await Product.findOne({
          name: input.name,
          workspaceId: workspaceId,
        });

        if (existingProduct) {
          throw createAlreadyExistsError('produit', 'nom', input.name);
        }

        const product = new Product({
          ...input,
          workspaceId: workspaceId,
          createdBy: user.id
        });

        await product.save();
        return product;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "edit" sur "products"
    updateProduct: requireWrite("products")(
      async (_, { id, input }, context) => {
        const { user, workspaceId: contextWorkspaceId } = context;

        // ✅ FIX: Les produits sont partagés au niveau du workspace
        // Utilisateurs avec permission "edit" peuvent modifier tous les produits du workspace
        const product = await Product.findOne({
          _id: id,
          workspaceId: contextWorkspaceId
        });

        if (!product) {
          throw createNotFoundError('Produit');
        }

        // Si le nom est modifié, vérifier qu'il n'existe pas déjà dans le workspace
        if (input.name && input.name !== product.name) {
          const existingProduct = await Product.findOne({
            name: input.name,
            workspaceId: contextWorkspaceId,
            _id: { $ne: id }
          });

          if (existingProduct) {
            throw createAlreadyExistsError('produit', 'nom', input.name);
          }
        }

        // Mettre à jour le produit
        Object.keys(input).forEach(key => {
          if (key !== 'workspaceId') { // Ne pas permettre la modification du workspaceId
            product[key] = input[key];
          }
        });

        await product.save();
        return product;
      }
    ),

    // ✅ Protégé par RBAC - nécessite la permission "delete" sur "products"
    // ✅ FIX: Les produits sont partagés au niveau du workspace
    // Utilisateurs avec permission "delete" peuvent supprimer tous les produits du workspace
    deleteProduct: requireDelete("products")(
      async (_, { id }, context) => {
        const { workspaceId: contextWorkspaceId } = context;

        const product = await Product.findOne({
          _id: id,
          workspaceId: contextWorkspaceId
        });

        if (!product) {
          throw createNotFoundError('Produit');
        }

        await Product.deleteOne({
          _id: id,
          workspaceId: contextWorkspaceId
        });
        return true;
      }
    )
  }
};

export default productResolvers;
