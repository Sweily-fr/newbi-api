#!/usr/bin/env node

import fetch from 'node-fetch';

console.log('🌐 Test CORS API Production');
console.log('============================');

const API_URL = 'https://api.newbi.fr';
const FRONTEND_ORIGIN = 'https://newbi-v2.vercel.app';

async function testCORS() {
  console.log(`🔗 API URL: ${API_URL}`);
  console.log(`🌍 Origin: ${FRONTEND_ORIGIN}`);
  console.log('');

  try {
    // Test 1: Requête OPTIONS (preflight)
    console.log('1️⃣ Test requête OPTIONS (preflight)...');
    
    const optionsResponse = await fetch(API_URL, {
      method: 'OPTIONS',
      headers: {
        'Origin': FRONTEND_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, Authorization'
      }
    });

    console.log('   Status:', optionsResponse.status);
    console.log('   Headers CORS:');
    console.log('   - Access-Control-Allow-Origin:', optionsResponse.headers.get('Access-Control-Allow-Origin'));
    console.log('   - Access-Control-Allow-Methods:', optionsResponse.headers.get('Access-Control-Allow-Methods'));
    console.log('   - Access-Control-Allow-Headers:', optionsResponse.headers.get('Access-Control-Allow-Headers'));
    console.log('   - Access-Control-Allow-Credentials:', optionsResponse.headers.get('Access-Control-Allow-Credentials'));
    
    if (optionsResponse.status === 200) {
      console.log('   ✅ Requête OPTIONS réussie');
    } else {
      console.log('   ❌ Requête OPTIONS échouée');
    }
    
    console.log('');

    // Test 2: Requête POST GraphQL
    console.log('2️⃣ Test requête POST GraphQL...');
    
    const graphqlQuery = {
      query: `
        query {
          __typename
        }
      `
    };

    const postResponse = await fetch(`${API_URL}/graphql`, {
      method: 'POST',
      headers: {
        'Origin': FRONTEND_ORIGIN,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(graphqlQuery)
    });

    console.log('   Status:', postResponse.status);
    console.log('   Headers CORS:');
    console.log('   - Access-Control-Allow-Origin:', postResponse.headers.get('Access-Control-Allow-Origin'));
    
    if (postResponse.status === 200) {
      console.log('   ✅ Requête GraphQL réussie');
      const data = await postResponse.json();
      console.log('   Réponse:', data);
    } else {
      console.log('   ❌ Requête GraphQL échouée');
      const errorText = await postResponse.text();
      console.log('   Erreur:', errorText.substring(0, 200) + '...');
    }

    console.log('');

    // Test 3: Vérification des endpoints
    console.log('3️⃣ Test des endpoints disponibles...');
    
    const endpoints = [
      '/',
      '/graphql',
      '/health',
      '/api/status'
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(`${API_URL}${endpoint}`, {
          method: 'GET',
          headers: {
            'Origin': FRONTEND_ORIGIN
          }
        });
        
        console.log(`   ${endpoint}: ${response.status} ${response.statusText}`);
      } catch (error) {
        console.log(`   ${endpoint}: ❌ ${error.message}`);
      }
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.message);
  }
}

// Test de connectivité réseau
async function testNetworkConnectivity() {
  console.log('🔍 Test de connectivité réseau...');
  
  try {
    const response = await fetch(API_URL, {
      method: 'HEAD',
      timeout: 5000
    });
    
    console.log('✅ Serveur accessible');
    console.log('   Status:', response.status);
    console.log('   Server:', response.headers.get('Server') || 'Non spécifié');
    
  } catch (error) {
    console.error('❌ Serveur inaccessible:', error.message);
  }
  
  console.log('');
}

async function runTests() {
  await testNetworkConnectivity();
  await testCORS();
  
  console.log('🎯 Recommandations:');
  console.log('===================');
  console.log('1. Vérifiez que les headers Access-Control-Allow-Origin sont présents');
  console.log('2. Assurez-vous que les requêtes OPTIONS retournent 200');
  console.log('3. Vérifiez que l\'origine Vercel est dans allowedOrigins');
  console.log('4. Redémarrez le serveur après modification: pm2 restart newbi');
}

runTests().catch(console.error);
