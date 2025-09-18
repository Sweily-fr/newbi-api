import { ApolloClient, InMemoryCache, HttpLink, ApolloLink } from '@apollo/client/core/index.js';
import { createUploadLink } from 'apollo-upload-client';
import fetch from 'node-fetch';
import { testChunkUpload } from './chunkUpload.test.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Charger les variables d'environnement
dotenv.config();

// Obtenir le chemin du fichier actuel
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration du client Apollo
const httpLink = createUploadLink({
  uri: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/graphql',
  fetch,
  headers: {
    // Ajouter ici les en-têtes d'authentification si nécessaire
    Authorization: process.env.AUTH_TOKEN ? `Bearer ${process.env.AUTH_TOKEN}` : ''
  }
});

const client = new ApolloClient({
  link: httpLink,
  cache: new InMemoryCache()
});

// Fonction principale
async function main() {
  try {
    // Vérifier si un chemin de fichier a été fourni en argument
    const filePath = process.argv[2];
    
    if (!filePath) {
      console.error('Veuillez fournir le chemin d\'un fichier à uploader en argument.');
      console.error('Exemple: node runChunkUploadTest.js /chemin/vers/fichier.pdf');
      process.exit(1);
    }
    
    console.log(`Test d'upload de fichier en chunks pour: ${filePath}`);
    
    // Exécuter le test
    await testChunkUpload(client, filePath);
    
    console.log('Test terminé avec succès!');
  } catch (error) {
    console.error('Erreur lors de l\'exécution du test:', error);
    process.exit(1);
  }
}

// Exécuter la fonction principale
main();
