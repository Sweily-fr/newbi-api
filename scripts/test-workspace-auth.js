#!/usr/bin/env node

/**
 * Script de test pour vérifier l'authentification workspace
 */

import fetch from 'node-fetch';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Configuration
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const BACKEND_URL = 'http://localhost:4000/graphql';

async function testWorkspaceAuth() {
  try {
    console.log('🧪 Test de l\'authentification workspace');
    console.log(`Frontend URL: ${FRONTEND_URL}`);
    console.log(`Backend URL: ${BACKEND_URL}`);

    // Test GraphQL query avec workspaceId
    const query = `
      query GetInvoices($workspaceId: ID!, $page: Int, $limit: Int) {
        invoices(workspaceId: $workspaceId, page: $page, limit: $limit) {
          invoices {
            id
            number
            clientName
            totalAmount
            status
          }
          pagination {
            total
            page
            limit
            totalPages
          }
        }
      }
    `;

    const variables = {
      workspaceId: '68932751626f06764f62ca2e',
      page: 1,
      limit: 10
    };

    console.log('\n📤 Envoi de la requête GraphQL...');
    console.log('Variables:', variables);

    const response = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Note: En production, il faudrait inclure les cookies de session
        'Cookie': 'better-auth.session_token=your_session_token_here'
      },
      body: JSON.stringify({
        query,
        variables
      })
    });

    const result = await response.json();

    console.log('\n📥 Réponse reçue:');
    console.log('Status:', response.status);
    
    if (result.errors) {
      console.log('❌ Erreurs GraphQL:');
      result.errors.forEach(error => {
        console.log(`  - ${error.message}`);
        if (error.extensions) {
          console.log(`    Code: ${error.extensions.code}`);
        }
      });
    }

    if (result.data) {
      console.log('✅ Données reçues:');
      console.log(`  - Factures: ${result.data.invoices?.invoices?.length || 0}`);
      console.log(`  - Total: ${result.data.invoices?.pagination?.total || 0}`);
      
      if (result.data.invoices?.invoices?.length > 0) {
        console.log('  - Première facture:', {
          number: result.data.invoices.invoices[0].number,
          client: result.data.invoices.invoices[0].clientName,
          amount: result.data.invoices.invoices[0].totalAmount
        });
      }
    }

  } catch (error) {
    console.error('❌ Erreur de test:', error.message);
  }
}

// Exécuter le test
testWorkspaceAuth();
