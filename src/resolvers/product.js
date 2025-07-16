import Product from '../models/Product.js';
import { isAuthenticated } from '../middlewares/auth.js';
import { 
  createNotFoundError, 
  createAlreadyExistsError
} from '../utils/errors.js';

const productResolvers = {
  Query: {
    product: isAuthenticated(async (_, { id }, { user }) => {
      const product = await Product.findOne({ _id: id, createdBy: user.id });
      if (!product) throw createNotFoundError('Produit');
      return product;
    }),

    products: isAuthenticated(async (_, { search, category, page = 1, limit = 20 }, { user }) => {
      const query = { createdBy: user.id };
      
      if (search && search.trim() !== '') {
        // Créer une requête OR pour rechercher dans plusieurs champs
        const searchRegex = new RegExp(search, 'i'); // 'i' pour insensible à la casse
        
        query.$or = [
          { name: searchRegex },         // Recherche par nom
          { reference: searchRegex },    // Recherche par référence
          { description: searchRegex }   // Recherche par description
        ];
        
        // Nous n'utilisons plus l'index de texte car il peut être moins fiable pour les recherches simples
        // query.$text = { 
        //   $search: search,
        //   $caseSensitive: false,
        //   $diacriticSensitive: false
        // };
      }
      
      if (category) {
        query.category = category;
      }
      
      const skip = (page - 1) * limit;
      
      // Définir les options de tri
      let sortOptions = { name: 1 }; // Tri par défaut par nom
      
      // Nous n'utilisons plus le tri par score car nous n'utilisons plus l'index de texte
      // if (search) {
      //   // Si recherche textuelle, trier par score de pertinence
      //   sortOptions = { score: { $meta: 'textScore' } };
      // }
      
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
    })
  },

  Mutation: {
    createProduct: isAuthenticated(async (_, { input }, { user }) => {
      // Vérifier si un produit avec ce nom existe déjà pour cet utilisateur
      const existingProduct = await Product.findOne({ 
        name: input.name,
        createdBy: user.id 
      });
      
      if (existingProduct) {
        throw createAlreadyExistsError('produit', 'nom', input.name);
      }
      
      const product = new Product({
        ...input,
        createdBy: user.id
      });
      
      await product.save();
      return product;
    }),

    updateProduct: isAuthenticated(async (_, { id, input }, { user }) => {
      const product = await Product.findOne({ _id: id, createdBy: user.id });
      
      if (!product) {
        throw createNotFoundError('Produit');
      }
      
      // Si le nom est modifié, vérifier qu'il n'existe pas déjà
      if (input.name && input.name !== product.name) {
        const existingProduct = await Product.findOne({ 
          name: input.name,
          createdBy: user.id,
          _id: { $ne: id }
        });
        
        if (existingProduct) {
          throw createAlreadyExistsError('produit', 'nom', input.name);
        }
      }
      
      // Mettre à jour le produit
      Object.keys(input).forEach(key => {
        product[key] = input[key];
      });
      
      await product.save();
      return product;
    }),

    deleteProduct: isAuthenticated(async (_, { id }, { user }) => {
      const product = await Product.findOne({ _id: id, createdBy: user.id });
      
      if (!product) {
        throw createNotFoundError('Produit');
      }
      
      await Product.deleteOne({ _id: id, createdBy: user.id });
      return true;
    })
  }
};

export default productResolvers;
