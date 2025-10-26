import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { blogPosts } from './blog-content.js';

dotenv.config();

// Schéma pour les articles de blog
const blogPostSchema = new mongoose.Schema({
  slug: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  metaTitle: { type: String, required: true },
  metaDescription: { type: String, required: true },
  summary: { type: String, required: true },
  author: { type: String, default: 'Équipe Newbi' },
  authorAvatar: { type: String, default: '/images/team/avatar.jpg' },
  category: { type: String, required: true },
  tags: [String],
  image: { type: String, required: true },
  content: { type: String, required: true },
  published: { type: Boolean, default: true },
  publishedAt: { type: Date, default: Date.now },
  views: { type: Number, default: 0 },
  readTime: { type: Number, default: 5 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const BlogPost = mongoose.model('BlogPost', blogPostSchema);

// Fonction principale
async function seedBlogPosts() {
  try {
    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connecté à MongoDB');

    // Insérer ou mettre à jour les articles
    const results = [];
    for (const post of blogPosts) {
      const result = await BlogPost.findOneAndUpdate(
        { slug: post.slug },
        post,
        { upsert: true, new: true }
      );
      results.push(result);
    }
    console.log(`✅ ${results.length} articles ajoutés/mis à jour avec succès`);

    // Afficher les articles créés
    results.forEach(post => {
      console.log(`   - ${post.title} (/${post.slug})`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  }
}

// Exécuter le script
seedBlogPosts();
