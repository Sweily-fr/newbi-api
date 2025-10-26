# Script d'insertion des articles de blog

Ce script permet d'insérer 6 articles de blog optimisés SEO dans votre base de données MongoDB.

## 📋 Contenu des articles

Les 6 articles créés sont :

1. **Optimiser sa facturation freelance** (Facturation)
2. **Gestion de trésorerie pour PME** (Finance)
3. **Transformation digitale entreprise** (Digital)
4. **Créer des devis professionnels** (Ventes)
5. **Automatiser sa gestion administrative** (Productivité)
6. **Sécuriser ses transferts de fichiers** (Sécurité)

## 🎯 Optimisations SEO

Chaque article contient :
- ✅ **Meta title** optimisé (< 60 caractères)
- ✅ **Meta description** optimisée (< 160 caractères)
- ✅ **Mots-clés ciblés** dans les tags
- ✅ **Structure H2/H3** pour le SEO
- ✅ **Backlinks internes** vers :
  - Landing pages Newbi (`https://newbi.app`)
  - Features (`https://newbi.app/#features`)
  - Pricing (`https://newbi.app/#pricing`)
  - Documentation (`https://docs.newbi.app`)

## 🚀 Utilisation

### 1. Prérequis

Assurez-vous d'avoir :
- Node.js installé
- MongoDB configuré
- Variable d'environnement `MONGODB_URI` dans votre `.env`

### 2. Installation

```bash
cd newbi-api
npm install mongoose dotenv
```

### 3. Exécution du script

```bash
node scripts/seed-blog-posts.js
```

### 4. Résultat attendu

```
✅ Connecté à MongoDB
🗑️  Articles existants supprimés
✅ 6 articles insérés avec succès
   - Comment optimiser votre facturation en tant que freelance en 2025 (/optimiser-facturation-freelance-2025)
   - Gestion de trésorerie pour PME : Le guide complet 2025 (/gestion-tresorerie-pme-guide-complet)
   - Transformation digitale : Guide pratique pour les entreprises en 2025 (/transformation-digitale-entreprise-2025)
   - Créer des devis professionnels qui convertissent : Guide 2025 (/devis-professionnels-guide-complet)
   - Automatiser sa gestion administrative : Guide pratique 2025 (/automatisation-gestion-administrative)
   - Sécuriser ses transferts de fichiers : Guide complet 2025 (/securiser-transferts-fichiers-entreprise)
```

## 📊 Structure de la collection

```javascript
{
  slug: String,              // URL-friendly identifier
  title: String,             // Titre de l'article
  metaTitle: String,         // Meta title SEO
  metaDescription: String,   // Meta description SEO
  summary: String,           // Résumé court
  author: String,            // Auteur (défaut: "Équipe Newbi")
  authorAvatar: String,      // Avatar de l'auteur
  category: String,          // Catégorie
  tags: [String],            // Tags pour le SEO
  image: String,             // Image de couverture (Unsplash)
  content: String,           // Contenu HTML
  published: Boolean,        // Publié ou brouillon
  publishedAt: Date,         // Date de publication
  views: Number,             // Nombre de vues
  readTime: Number,          // Temps de lecture (minutes)
  createdAt: Date,           // Date de création
  updatedAt: Date            // Date de mise à jour
}
```

## 🔗 Backlinks intégrés

Chaque article contient des liens stratégiques vers :

### Landing Pages
- `https://newbi.app` - Page d'accueil
- `https://newbi.app/#features` - Fonctionnalités
- `https://newbi.app/#pricing` - Tarifs

### Documentation
- `https://docs.newbi.app` - Documentation générale
- `https://docs.newbi.app/facturation` - Guide facturation
- `https://docs.newbi.app/devis` - Guide devis
- `https://docs.newbi.app/automatisation` - Guide automatisation
- `https://docs.newbi.app/securite` - Documentation sécurité

## ✏️ Modifier le contenu

Pour modifier ou ajouter des articles, éditez le fichier `blog-content.js` :

```javascript
module.exports = [
  {
    slug: 'mon-nouvel-article',
    title: 'Mon nouveau titre',
    metaTitle: 'Mon titre SEO | Newbi',
    metaDescription: 'Ma description SEO optimisée...',
    // ... autres champs
    content: `
      <p>Mon contenu HTML...</p>
      <h2>Section</h2>
      <p>Avec des <a href="https://newbi.app">backlinks</a>.</p>
    `,
  },
  // ... autres articles
];
```

## 🔄 Réexécution

Le script supprime tous les articles existants avant d'insérer les nouveaux. Pour ajouter sans supprimer, modifiez la ligne :

```javascript
// Commentez cette ligne pour ne pas supprimer
// await BlogPost.deleteMany({});
```

## 📝 Notes

- Les articles sont en français
- Le contenu HTML est prêt pour l'affichage avec Tailwind CSS
- Les images utilisent Unsplash avec des URLs optimisées
- Tous les articles sont marqués comme `published: true`

## 🐛 Dépannage

### Erreur de connexion MongoDB
```
❌ Erreur: MongooseServerSelectionError
```
→ Vérifiez votre `MONGODB_URI` dans le `.env`

### Erreur de duplication
```
❌ E11000 duplicate key error
```
→ Le slug existe déjà. Changez le slug ou supprimez l'article existant.

## 📚 Ressources

- [Documentation Mongoose](https://mongoosejs.com/)
- [Guide SEO](https://developers.google.com/search/docs)
- [Unsplash API](https://unsplash.com/developers)
