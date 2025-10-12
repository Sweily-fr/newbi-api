import { betterAuthJWTMiddleware } from '../src/middlewares/better-auth-jwt.js';
import logger from '../src/utils/logger.js';

// Script de diagnostic pour tester l'authentification
async function debugAuthIssue() {
  console.log('🔍 Diagnostic du problème d\'authentification...\n');

  // Simuler une requête avec un token JWT
  const mockReq = {
    headers: {
      authorization: 'Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6IjEifQ.eyJzdWIiOiI2OGNjZTBlMzRiYWRjYzBiNGZjZGY2ZTgiLCJlbWFpbCI6ImRlbW9AbmV3YmkuZnIiLCJpYXQiOjE3Mjc0NTI4NjIsImV4cCI6MTcyNzQ1NjQ2MiwiaXNzIjoiaHR0cDovL2xvY2FsaG9zdDozMDAwIn0.example'
    },
    ip: '127.0.0.1'
  };

  try {
    console.log('📋 Test 1: Validation JWT avec token valide');
    const user = await betterAuthJWTMiddleware(mockReq);
    console.log('Résultat:', user ? `Utilisateur trouvé: ${user._id}` : 'Aucun utilisateur');

    console.log('\n📋 Test 2: Validation JWT sans token');
    const mockReqNoToken = { headers: {}, ip: '127.0.0.1' };
    const userNoToken = await betterAuthJWTMiddleware(mockReqNoToken);
    console.log('Résultat:', userNoToken ? `Utilisateur trouvé: ${userNoToken._id}` : 'Aucun utilisateur (attendu)');

    console.log('\n📋 Test 3: Validation JWT avec token invalide');
    const mockReqInvalidToken = {
      headers: { authorization: 'Bearer invalid.token.here' },
      ip: '127.0.0.1'
    };
    const userInvalidToken = await betterAuthJWTMiddleware(mockReqInvalidToken);
    console.log('Résultat:', userInvalidToken ? `Utilisateur trouvé: ${userInvalidToken._id}` : 'Aucun utilisateur (attendu)');

  } catch (error) {
    console.error('❌ Erreur lors du diagnostic:', error.message);
  }
}

// Exécuter le diagnostic
debugAuthIssue().then(() => {
  console.log('\n✅ Diagnostic terminé');
  process.exit(0);
}).catch(error => {
  console.error('❌ Erreur fatale:', error);
  process.exit(1);
});
