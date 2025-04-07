# API GraphQL de Gestion de Factures et Devis

API GraphQL construite avec Apollo Server, Express, et MongoDB pour la gestion de factures et devis.

## Fonctionnalités

- **Authentification**
  - Connexion
  - Inscription
  - Réinitialisation de mot de passe

- **Gestion des Factures**
  - CRUD complet
  - Gestion des états : Brouillon → À encaisser → Terminée

- **Gestion des Devis**
  - CRUD complet
  - Gestion des états : En attente → Terminé

## Installation

1. Cloner le repository
2. Installer les dépendances :
   ```bash
   npm install
   ```
3. Créer un fichier `.env` avec les variables suivantes :
   ```
   MONGODB_URI=mongodb://localhost:27017/invoice-app
   JWT_SECRET=votre_secret_jwt
   PORT=4000
   ```
4. Démarrer le serveur :
   ```bash
   npm start
   ```

## Structure du Projet

```
src/
  ├── models/         # Modèles Mongoose
  ├── schemas/        # Schémas GraphQL
  ├── resolvers/      # Resolvers GraphQL
  ├── middlewares/    # Middlewares (auth, etc.)
  ├── utils/          # Utilitaires
  └── index.js        # Point d'entrée
```

## Technologies Utilisées

- Apollo Server Express
- Express
- MongoDB avec Mongoose
- JWT pour l'authentification
- bcryptjs pour le hachage des mots de passe
