/**
 * ========================================
 * SCRIPT DE TEST DU SYSTÈME RBAC
 * ========================================
 * 
 * Ce script teste le système RBAC en simulant différents scénarios
 * avec différents rôles utilisateur
 * 
 * Usage: node scripts/test-rbac-system.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import {
  getActiveOrganization,
  getMemberRole,
  hasPermission,
  hasPermissionLevel,
  ROLE_PERMISSIONS,
} from "../src/middlewares/rbac.js";

// Charger les variables d'environnement
dotenv.config();

// Couleurs pour les logs
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const log = {
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warning: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
  info: (msg) => console.log(`${colors.blue}ℹ️  ${msg}${colors.reset}`),
  title: (msg) => console.log(`\n${colors.cyan}${"=".repeat(60)}\n${msg}\n${"=".repeat(60)}${colors.reset}\n`),
};

/**
 * Connexion à MongoDB
 */
async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    log.success("Connecté à MongoDB");
  } catch (error) {
    log.error(`Erreur de connexion MongoDB: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Test 1: Vérification de la structure des permissions
 */
async function testPermissionStructure() {
  log.title("TEST 1: Structure des permissions");
  
  const roles = ["owner", "admin", "member", "accountant"];
  const resources = ["invoices", "expenses", "clients", "team", "billing"];
  
  let passed = 0;
  let failed = 0;
  
  roles.forEach((role) => {
    const rolePerms = ROLE_PERMISSIONS[role];
    
    if (!rolePerms) {
      log.error(`Rôle ${role} non défini`);
      failed++;
      return;
    }
    
    log.info(`Rôle: ${role}`);
    
    resources.forEach((resource) => {
      const perms = rolePerms[resource];
      if (perms) {
        console.log(`  - ${resource}: ${perms.join(", ")}`);
        passed++;
      } else {
        console.log(`  - ${resource}: aucune permission`);
      }
    });
    
    console.log("");
  });
  
  log.success(`Structure validée: ${passed} permissions définies`);
  return { passed, failed };
}

/**
 * Test 2: Vérification des permissions par rôle
 */
async function testRolePermissions() {
  log.title("TEST 2: Permissions par rôle");
  
  const tests = [
    // Owner
    { role: "owner", resource: "invoices", action: "delete", expected: true },
    { role: "owner", resource: "billing", action: "manage", expected: true },
    { role: "owner", resource: "team", action: "remove", expected: true },
    
    // Admin
    { role: "admin", resource: "invoices", action: "delete", expected: true },
    { role: "admin", resource: "billing", action: "manage", expected: false },
    { role: "admin", resource: "team", action: "invite", expected: true },
    
    // Member
    { role: "member", resource: "invoices", action: "create", expected: true },
    { role: "member", resource: "invoices", action: "delete", expected: false },
    { role: "member", resource: "team", action: "invite", expected: false },
    
    // Accountant
    { role: "accountant", resource: "invoices", action: "view", expected: true },
    { role: "accountant", resource: "invoices", action: "mark-paid", expected: true },
    { role: "accountant", resource: "expenses", action: "approve", expected: true },
    { role: "accountant", resource: "invoices", action: "create", expected: false },
  ];
  
  let passed = 0;
  let failed = 0;
  
  tests.forEach((test) => {
    const result = hasPermission(test.role, test.resource, test.action);
    const status = result === test.expected ? "✅" : "❌";
    
    console.log(
      `${status} ${test.role} - ${test.resource}.${test.action}: ${result} (attendu: ${test.expected})`
    );
    
    if (result === test.expected) {
      passed++;
    } else {
      failed++;
    }
  });
  
  console.log("");
  log.info(`Tests réussis: ${passed}/${tests.length}`);
  
  if (failed > 0) {
    log.error(`Tests échoués: ${failed}`);
  } else {
    log.success("Tous les tests de permissions sont passés !");
  }
  
  return { passed, failed };
}

/**
 * Test 3: Vérification des niveaux de permissions
 */
async function testPermissionLevels() {
  log.title("TEST 3: Niveaux de permissions");
  
  const tests = [
    // Read level
    { role: "owner", resource: "invoices", level: "read", expected: true },
    { role: "member", resource: "invoices", level: "read", expected: true },
    { role: "accountant", resource: "invoices", level: "read", expected: true },
    
    // Write level
    { role: "owner", resource: "invoices", level: "write", expected: true },
    { role: "admin", resource: "invoices", level: "write", expected: true },
    { role: "member", resource: "invoices", level: "write", expected: true },
    { role: "accountant", resource: "invoices", level: "write", expected: false },
    
    // Delete level
    { role: "owner", resource: "invoices", level: "delete", expected: true },
    { role: "admin", resource: "invoices", level: "delete", expected: true },
    { role: "member", resource: "invoices", level: "delete", expected: false },
    { role: "accountant", resource: "invoices", level: "delete", expected: false },
    
    // Admin level
    { role: "owner", resource: "team", level: "admin", expected: true },
    { role: "admin", resource: "team", level: "admin", expected: true },
    { role: "member", resource: "team", level: "admin", expected: false },
  ];
  
  let passed = 0;
  let failed = 0;
  
  tests.forEach((test) => {
    const result = hasPermissionLevel(test.role, test.resource, test.level);
    const status = result === test.expected ? "✅" : "❌";
    
    console.log(
      `${status} ${test.role} - ${test.resource} [${test.level}]: ${result} (attendu: ${test.expected})`
    );
    
    if (result === test.expected) {
      passed++;
    } else {
      failed++;
    }
  });
  
  console.log("");
  log.info(`Tests réussis: ${passed}/${tests.length}`);
  
  if (failed > 0) {
    log.error(`Tests échoués: ${failed}`);
  } else {
    log.success("Tous les tests de niveaux sont passés !");
  }
  
  return { passed, failed };
}

/**
 * Test 4: Récupération d'organisation et rôle depuis MongoDB
 */
async function testDatabaseIntegration() {
  log.title("TEST 4: Intégration MongoDB");
  
  try {
    const db = mongoose.connection.db;
    
    // Compter les organisations
    const orgCollection = db.collection("organization");
    const orgCount = await orgCollection.countDocuments();
    log.info(`Organisations trouvées: ${orgCount}`);
    
    // Compter les membres
    const memberCollection = db.collection("member");
    const memberCount = await memberCollection.countDocuments();
    log.info(`Membres trouvés: ${memberCount}`);
    
    if (memberCount === 0) {
      log.warning("Aucun membre trouvé dans la base de données");
      log.warning("Créez une organisation et des membres pour tester complètement");
      return { passed: 0, failed: 0, skipped: true };
    }
    
    // Récupérer un membre pour test
    const testMember = await memberCollection.findOne({});
    
    if (!testMember) {
      log.warning("Impossible de récupérer un membre pour le test");
      return { passed: 0, failed: 0, skipped: true };
    }
    
    log.info(`Test avec membre: ${testMember.userId} (rôle: ${testMember.role})`);
    
    // Test getActiveOrganization
    const organization = await getActiveOrganization(testMember.userId);
    
    if (organization) {
      log.success(`Organisation récupérée: ${organization.name} (${organization.id})`);
    } else {
      log.error("Échec de récupération de l'organisation");
      return { passed: 0, failed: 1 };
    }
    
    // Test getMemberRole
    const memberRole = await getMemberRole(organization.id, testMember.userId);
    
    if (memberRole) {
      log.success(`Rôle récupéré: ${memberRole.role}`);
    } else {
      log.error("Échec de récupération du rôle");
      return { passed: 1, failed: 1 };
    }
    
    log.success("Intégration MongoDB validée !");
    return { passed: 2, failed: 0 };
    
  } catch (error) {
    log.error(`Erreur lors du test MongoDB: ${error.message}`);
    return { passed: 0, failed: 1 };
  }
}

/**
 * Test 5: Scénarios réels d'utilisation
 */
async function testRealWorldScenarios() {
  log.title("TEST 5: Scénarios réels");
  
  const scenarios = [
    {
      name: "Owner peut tout faire",
      role: "owner",
      tests: [
        { resource: "invoices", action: "create", expected: true },
        { resource: "invoices", action: "delete", expected: true },
        { resource: "billing", action: "manage", expected: true },
        { resource: "team", action: "remove", expected: true },
      ],
    },
    {
      name: "Admin ne peut pas gérer la facturation",
      role: "admin",
      tests: [
        { resource: "invoices", action: "create", expected: true },
        { resource: "invoices", action: "delete", expected: true },
        { resource: "billing", action: "view", expected: true },
        { resource: "billing", action: "manage", expected: false },
      ],
    },
    {
      name: "Member peut créer mais pas supprimer",
      role: "member",
      tests: [
        { resource: "invoices", action: "create", expected: true },
        { resource: "invoices", action: "view", expected: true },
        { resource: "invoices", action: "delete", expected: false },
        { resource: "team", action: "invite", expected: false },
      ],
    },
    {
      name: "Accountant peut valider et exporter",
      role: "accountant",
      tests: [
        { resource: "invoices", action: "view", expected: true },
        { resource: "invoices", action: "mark-paid", expected: true },
        { resource: "expenses", action: "approve", expected: true },
        { resource: "invoices", action: "create", expected: false },
        { resource: "invoices", action: "delete", expected: false },
      ],
    },
  ];
  
  let totalPassed = 0;
  let totalFailed = 0;
  
  scenarios.forEach((scenario) => {
    console.log(`\n📋 Scénario: ${scenario.name}`);
    
    let scenarioPassed = 0;
    let scenarioFailed = 0;
    
    scenario.tests.forEach((test) => {
      const result = hasPermission(scenario.role, test.resource, test.action);
      const status = result === test.expected ? "✅" : "❌";
      
      console.log(
        `  ${status} ${test.resource}.${test.action}: ${result}`
      );
      
      if (result === test.expected) {
        scenarioPassed++;
        totalPassed++;
      } else {
        scenarioFailed++;
        totalFailed++;
      }
    });
    
    if (scenarioFailed === 0) {
      log.success(`Scénario validé: ${scenarioPassed}/${scenario.tests.length}`);
    } else {
      log.error(`Scénario échoué: ${scenarioFailed} erreurs`);
    }
  });
  
  console.log("");
  log.info(`Total: ${totalPassed} tests réussis, ${totalFailed} échoués`);
  
  return { passed: totalPassed, failed: totalFailed };
}

/**
 * Fonction principale
 */
async function main() {
  console.log("\n");
  log.title("🔐 TEST DU SYSTÈME RBAC");
  
  await connectDB();
  
  const results = {
    structure: await testPermissionStructure(),
    permissions: await testRolePermissions(),
    levels: await testPermissionLevels(),
    database: await testDatabaseIntegration(),
    scenarios: await testRealWorldScenarios(),
  };
  
  // Résumé final
  log.title("📊 RÉSUMÉ DES TESTS");
  
  let totalPassed = 0;
  let totalFailed = 0;
  
  Object.entries(results).forEach(([name, result]) => {
    if (result.skipped) {
      log.warning(`${name}: Ignoré`);
    } else {
      console.log(`${name}: ${result.passed} réussis, ${result.failed} échoués`);
      totalPassed += result.passed;
      totalFailed += result.failed;
    }
  });
  
  console.log("");
  
  if (totalFailed === 0) {
    log.success(`🎉 TOUS LES TESTS SONT PASSÉS ! (${totalPassed} tests)`);
  } else {
    log.error(`❌ ${totalFailed} tests ont échoué sur ${totalPassed + totalFailed}`);
  }
  
  await mongoose.disconnect();
  log.info("Déconnecté de MongoDB");
  
  process.exit(totalFailed > 0 ? 1 : 0);
}

// Exécuter les tests
main().catch((error) => {
  log.error(`Erreur fatale: ${error.message}`);
  console.error(error);
  process.exit(1);
});
