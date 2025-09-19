#!/usr/bin/env node

import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🔍 VALIDATION DE LA MIGRATION COMPANY → ORGANIZATION');
console.log('==================================================');

// Fonction pour charger les variables d'environnement depuis ecosystem.config.cjs
async function loadEcosystemConfig() {
  const ecosystemPath = path.resolve(__dirname, '../ecosystem.config.cjs');
  
  if (fs.existsSync(ecosystemPath)) {
    try {
      const ecosystemConfig = await import(`file://${ecosystemPath}`);
      const config = ecosystemConfig.default;
      
      if (config && config.apps && config.apps[0] && config.apps[0].env) {
        Object.assign(process.env, config.apps[0].env);
        
        if (config.apps[0].env_production) {
          Object.assign(process.env, config.apps[0].env_production);
        }
        
        return true;
      }
    } catch (error) {
      console.log('⚠️  Erreur lors du chargement d\'ecosystem.config.cjs:', error.message);
    }
  }
  
  return false;
}

// Fonction de validation des données migrées
async function validateMigration() {
  let client;
  
  try {
    // Charger la configuration
    await loadEcosystemConfig();
    
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI non définie dans les variables d\'environnement');
    }

    console.log('🔗 Connexion à MongoDB...');
    client = new MongoClient(mongoUri);
    await client.connect();
    
    const db = client.db();
    console.log('✅ Connexion réussie\n');

    // Statistiques globales
    const stats = {
      totalUsers: 0,
      usersWithCompany: 0,
      usersWithoutCompany: 0,
      totalOrganizations: 0,
      organizationsWithData: 0,
      totalMembers: 0,
      orphanedOrganizations: 0,
      missingMemberships: 0,
      dataIntegrityIssues: []
    };

    console.log('📊 ANALYSE DES COLLECTIONS');
    console.log('==========================');

    // 1. Analyser la collection user
    console.log('\n👥 Collection USER:');
    const users = await db.collection('user').find({}).toArray();
    stats.totalUsers = users.length;
    
    const usersWithCompany = users.filter(user => user.company && Object.keys(user.company).length > 0);
    const usersWithoutCompany = users.filter(user => !user.company || Object.keys(user.company).length === 0);
    
    stats.usersWithCompany = usersWithCompany.length;
    stats.usersWithoutCompany = usersWithoutCompany.length;
    
    console.log(`   Total utilisateurs: ${stats.totalUsers}`);
    console.log(`   Avec données company: ${stats.usersWithCompany}`);
    console.log(`   Sans données company: ${stats.usersWithoutCompany}`);

    // 2. Analyser la collection organization
    console.log('\n🏢 Collection ORGANIZATION:');
    const organizations = await db.collection('organization').find({}).toArray();
    stats.totalOrganizations = organizations.length;
    
    const organizationsWithData = organizations.filter(org => 
      org.companyName || org.companyEmail || org.siret || org.vatNumber
    );
    stats.organizationsWithData = organizationsWithData.length;
    
    console.log(`   Total organisations: ${stats.totalOrganizations}`);
    console.log(`   Avec données company: ${stats.organizationsWithData}`);

    // 3. Analyser la collection member
    console.log('\n👤 Collection MEMBER:');
    const members = await db.collection('member').find({}).toArray();
    stats.totalMembers = members.length;
    
    console.log(`   Total memberships: ${stats.totalMembers}`);

    // 4. Vérifications d'intégrité
    console.log('\n🔍 VÉRIFICATIONS D\'INTÉGRITÉ');
    console.log('============================');

    // Vérifier les organisations orphelines (sans créateur)
    console.log('\n🔸 Organisations orphelines:');
    for (const org of organizations) {
      if (org.createdBy) {
        const creator = await db.collection('user').findOne({ _id: { $in: [org.createdBy, { $oid: org.createdBy }] } });
        if (!creator) {
          stats.orphanedOrganizations++;
          stats.dataIntegrityIssues.push({
            type: 'ORPHANED_ORGANIZATION',
            orgId: org._id,
            createdBy: org.createdBy,
            message: `Organisation ${org.name} créée par un utilisateur inexistant: ${org.createdBy}`
          });
        }
      }
    }
    console.log(`   Organisations orphelines: ${stats.orphanedOrganizations}`);

    // Vérifier les memberships manquants
    console.log('\n🔸 Memberships manquants:');
    for (const org of organizations) {
      if (org.createdBy) {
        const membership = await db.collection('member').findOne({
          organizationId: org._id.toString(),
          userId: org.createdBy
        });
        
        if (!membership) {
          stats.missingMemberships++;
          stats.dataIntegrityIssues.push({
            type: 'MISSING_MEMBERSHIP',
            orgId: org._id,
            userId: org.createdBy,
            message: `Membership manquant pour l'organisation ${org.name} et l'utilisateur ${org.createdBy}`
          });
        }
      }
    }
    console.log(`   Memberships manquants: ${stats.missingMemberships}`);

    // Vérifier la cohérence des données migrées
    console.log('\n🔸 Cohérence des données migrées:');
    let dataConsistencyIssues = 0;
    
    for (const user of usersWithCompany) {
      // Trouver l'organisation correspondante
      const userOrg = await db.collection('organization').findOne({
        createdBy: user._id.toString()
      });
      
      if (userOrg) {
        // Vérifier que les données importantes ont été migrées dans les champs directs
        const company = user.company;
        const issues = [];
        
        if (company.name && !userOrg.companyName) {
          issues.push('companyName manquant');
        }
        if (company.email && !userOrg.companyEmail) {
          issues.push('companyEmail manquant');
        }
        if (company.siret && !userOrg.siret) {
          issues.push('siret manquant');
        }
        if (company.vatNumber && !userOrg.vatNumber) {
          issues.push('vatNumber manquant');
        }
        if (company.address && company.address.street && !userOrg.addressStreet) {
          issues.push('addressStreet manquant');
        }
        if (company.bankDetails && company.bankDetails.iban && !userOrg.bankIban) {
          issues.push('bankIban manquant');
        }
        if (company.companyStatus && !userOrg.legalForm) {
          issues.push('legalForm manquant');
        }
        if (company.website && !userOrg.website) {
          issues.push('website manquant');
        }
        if (company.transactionCategory && !userOrg.activityCategory) {
          issues.push('activityCategory manquant');
        }
        if (company.vatPaymentCondition && !userOrg.fiscalRegime) {
          issues.push('fiscalRegime manquant');
        }
        
        // Vérifier les champs calculés Better Auth
        if (company.vatNumber && !userOrg.isVatSubject) {
          issues.push('isVatSubject devrait être true');
        }
        if ((company.transactionCategory === 'GOODS' || company.transactionCategory === 'MIXED') && !userOrg.hasCommercialActivity) {
          issues.push('hasCommercialActivity devrait être true');
        }
        if (company.bankDetails && (company.bankDetails.iban || company.bankDetails.bic) && !userOrg.showBankDetails) {
          issues.push('showBankDetails devrait être true');
        }
        
        if (issues.length > 0) {
          dataConsistencyIssues++;
          stats.dataIntegrityIssues.push({
            type: 'DATA_CONSISTENCY',
            userId: user._id,
            userEmail: user.email,
            orgId: userOrg._id,
            issues: issues,
            message: `Données incohérentes pour ${user.email}: ${issues.join(', ')}`
          });
        }
      } else {
        // Utilisateur avec company mais sans organisation
        dataConsistencyIssues++;
        stats.dataIntegrityIssues.push({
          type: 'MISSING_ORGANIZATION',
          userId: user._id,
          userEmail: user.email,
          message: `Utilisateur ${user.email} a des données company mais aucune organisation`
        });
      }
    }
    
    console.log(`   Problèmes de cohérence: ${dataConsistencyIssues}`);

    // 5. Résumé et recommandations
    console.log('\n📈 RÉSUMÉ DE LA VALIDATION');
    console.log('==========================');
    console.log(`✅ Total utilisateurs: ${stats.totalUsers}`);
    console.log(`📊 Utilisateurs avec company restants: ${stats.usersWithCompany}`);
    console.log(`🏢 Organisations créées: ${stats.totalOrganizations}`);
    console.log(`👥 Memberships créés: ${stats.totalMembers}`);
    console.log(`⚠️  Problèmes d'intégrité: ${stats.dataIntegrityIssues.length}`);

    // Afficher les problèmes détaillés
    if (stats.dataIntegrityIssues.length > 0) {
      console.log('\n🚨 PROBLÈMES DÉTECTÉS:');
      console.log('======================');
      
      stats.dataIntegrityIssues.forEach((issue, index) => {
        console.log(`\n${index + 1}. ${issue.type}:`);
        console.log(`   ${issue.message}`);
        if (issue.issues) {
          console.log(`   Détails: ${issue.issues.join(', ')}`);
        }
      });
      
      console.log('\n💡 RECOMMANDATIONS:');
      console.log('===================');
      
      if (stats.orphanedOrganizations > 0) {
        console.log('- Supprimer ou réassigner les organisations orphelines');
      }
      if (stats.missingMemberships > 0) {
        console.log('- Créer les memberships manquants');
      }
      if (dataConsistencyIssues > 0) {
        console.log('- Relancer la migration pour les utilisateurs avec des données incohérentes');
      }
    } else {
      console.log('\n🎉 VALIDATION RÉUSSIE - Aucun problème détecté');
    }

    // Suggestions d'actions
    console.log('\n🔧 ACTIONS SUGGÉRÉES:');
    console.log('=====================');
    
    if (stats.usersWithCompany > 0) {
      console.log('- Relancer la migration pour les utilisateurs ayant encore des données company');
    }
    
    if (stats.totalOrganizations === 0) {
      console.log('- Aucune organisation trouvée, vérifier que la migration a bien eu lieu');
    }
    
    console.log('- Tester les fonctionnalités de l\'application avec les nouvelles données');
    console.log('- Vérifier que les utilisateurs peuvent accéder à leurs organisations');

    // Sauvegarder le rapport de validation
    const reportPath = path.resolve(__dirname, '../backups', `validation-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const report = {
      timestamp: new Date().toISOString(),
      statistics: stats,
      issues: stats.dataIntegrityIssues
    };
    
    // Créer le dossier backups s'il n'existe pas
    const backupDir = path.dirname(reportPath);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Rapport sauvegardé: ${reportPath}`);

  } catch (error) {
    console.error('💥 Erreur lors de la validation:', error.message);
    console.error(error.stack);
  } finally {
    if (client) {
      await client.close();
      console.log('\n🔌 Connexion MongoDB fermée');
    }
  }
}

// Validation des arguments
if (process.argv.includes('--help')) {
  console.log(`
Usage: node validate-company-migration.js

Description:
  Valide l'intégrité de la migration des données company vers organization.
  Génère un rapport détaillé des problèmes potentiels.

Exemples:
  node validate-company-migration.js
`);
  process.exit(0);
}

// Exécution
validateMigration().catch(console.error);
