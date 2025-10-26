import BlogPost from '../models/BlogPost.js';

const blogResolvers = {
  Query: {
    // Récupérer tous les articles publiés
    getAllBlogPosts: async (_, { limit = 10, offset = 0 }) => {
      try {
        const posts = await BlogPost.find({ published: true })
          .sort({ publishedAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean();

        const total = await BlogPost.countDocuments({ published: true });

        return {
          success: true,
          posts,
          total,
          hasMore: offset + limit < total,
        };
      } catch (error) {
        console.error('Error fetching blog posts:', error);
        return {
          success: false,
          message: error.message,
          posts: [],
          total: 0,
          hasMore: false,
        };
      }
    },

    // Récupérer un article par slug
    getBlogPostBySlug: async (_, { slug }) => {
      try {
        const post = await BlogPost.findOne({ slug, published: true }).lean();

        if (!post) {
          return {
            success: false,
            message: 'Article non trouvé',
            post: null,
          };
        }

        // Incrémenter les vues
        await BlogPost.updateOne({ slug }, { $inc: { views: 1 } });

        return {
          success: true,
          post: {
            ...post,
            views: post.views + 1,
          },
        };
      } catch (error) {
        console.error('Error fetching blog post:', error);
        return {
          success: false,
          message: error.message,
          post: null,
        };
      }
    },

    // Récupérer les articles par catégorie
    getBlogPostsByCategory: async (_, { category, limit = 10 }) => {
      try {
        const posts = await BlogPost.find({ category, published: true })
          .sort({ publishedAt: -1 })
          .limit(limit)
          .lean();

        return {
          success: true,
          posts,
          total: posts.length,
        };
      } catch (error) {
        console.error('Error fetching blog posts by category:', error);
        return {
          success: false,
          message: error.message,
          posts: [],
          total: 0,
        };
      }
    },

    // Récupérer les articles par tag
    getBlogPostsByTag: async (_, { tag, limit = 10 }) => {
      try {
        const posts = await BlogPost.find({ tags: tag, published: true })
          .sort({ publishedAt: -1 })
          .limit(limit)
          .lean();

        return {
          success: true,
          posts,
          total: posts.length,
        };
      } catch (error) {
        console.error('Error fetching blog posts by tag:', error);
        return {
          success: false,
          message: error.message,
          posts: [],
          total: 0,
        };
      }
    },

    // Récupérer les articles populaires
    getPopularBlogPosts: async (_, { limit = 5 }) => {
      try {
        const posts = await BlogPost.find({ published: true })
          .sort({ views: -1 })
          .limit(limit)
          .lean();

        return {
          success: true,
          posts,
        };
      } catch (error) {
        console.error('Error fetching popular blog posts:', error);
        return {
          success: false,
          message: error.message,
          posts: [],
        };
      }
    },

    // Rechercher des articles
    searchBlogPosts: async (_, { query, limit = 10 }) => {
      try {
        const posts = await BlogPost.find({
          published: true,
          $or: [
            { title: { $regex: query, $options: 'i' } },
            { summary: { $regex: query, $options: 'i' } },
            { content: { $regex: query, $options: 'i' } },
            { tags: { $regex: query, $options: 'i' } },
          ],
        })
          .sort({ publishedAt: -1 })
          .limit(limit)
          .lean();

        return {
          success: true,
          posts,
          total: posts.length,
        };
      } catch (error) {
        console.error('Error searching blog posts:', error);
        return {
          success: false,
          message: error.message,
          posts: [],
          total: 0,
        };
      }
    },
  },
};

export default blogResolvers;
