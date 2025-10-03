// Exemple de configuration serveur WebSocket pour GraphQL subscriptions
// À intégrer dans votre serveur GraphQL existant

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/lib/use/ws';
import { makeExecutableSchema } from '@graphql-tools/schema';

// Vos typeDefs et resolvers existants
import typeDefs from './src/schemas/index.js';
import resolvers from './src/resolvers/index.js';

// Créer le schéma GraphQL
const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
});

// Créer le serveur HTTP
const server = createServer();

// Créer le serveur WebSocket
const wsServer = new WebSocketServer({
  server,
  path: '/graphql',
});

// Configurer graphql-ws
const serverCleanup = useServer({
  schema,
  context: async (ctx, msg, args) => {
    // Récupérer le token d'authentification depuis les paramètres de connexion
    const token = ctx.connectionParams?.authorization?.replace('Bearer ', '');
    
    if (token) {
      try {
        // Valider le JWT et récupérer l'utilisateur
        // Utilisez votre logique d'authentification existante
        const user = await validateJWT(token);
        const workspaceId = user?.workspaceId;
        
        return {
          user,
          workspaceId,
        };
      } catch (error) {
        console.error('❌ [WebSocket] Erreur authentification:', error);
        throw new Error('Authentication failed');
      }
    }
    
    throw new Error('No authentication token provided');
  },
  onConnect: async (ctx) => {
    console.log('🔌 [WebSocket] Client connecté');
  },
  onDisconnect(ctx, code, reason) {
    console.log('🔌 [WebSocket] Client déconnecté:', code, reason);
  },
}, wsServer);

// Démarrer le serveur
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur GraphQL avec WebSocket sur http://localhost:${PORT}/graphql`);
  console.log(`🔌 WebSocket subscriptions sur ws://localhost:${PORT}/graphql`);
});

// Nettoyage propre à l'arrêt
process.on('SIGTERM', () => {
  serverCleanup.dispose();
});

// Fonction d'exemple pour valider le JWT
async function validateJWT(token) {
  // Implémentez votre logique de validation JWT ici
  // Retournez l'utilisateur avec son workspaceId
  return {
    id: 'user-id',
    workspaceId: 'workspace-id',
    // ... autres propriétés utilisateur
  };
}
