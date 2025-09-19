# Guide de Migration Company → Organization

## Vue d'ensemble

Ce guide décrit la procédure complète pour migrer les données de l'objet `company` de la collection `user` vers la nouvelle collection `organization` dans Newbi.

## Architecture de la Migration

### Structure Source (User.company)
```javascript
{
  name: String,
  email: String,
  phone: String,
  website: String,
  siret: String,
  vatNumber: String,
  companyStatus: String,
  capitalSocial: String,
  rcs: String,
  transactionCategory: String,
  vatPaymentCondition: String,
  address: {
    street: String,
    city: String,
    zipCode: String,
    country: String
  },
  bankDetails: {
    bankName: String,
    iban: String,
    bic: String
  }
}
```

### Structure Cible (Organization)
```javascript
{
  name: String,
  slug: String,
  companyName: String,
  companyEmail: String,
  companyPhone: String,
  website: String,
  siret: String,
  vatNumber: String,
  rcs: String,
  legalForm: String,
  capitalSocial: String,
  activityCategory: String,
  fiscalRegime: String,
  isVatSubject: Boolean,
  hasCommercialActivity: Boolean,
  addressStreet: String,
  addressCity: String,
  addressZipCode: String,
  addressCountry: String,
  bankName: String,
  bankIban: String,
  bankBic: String,
  showBankDetails: Boolean,
  createdBy: String,
  createdAt: Date,
  updatedAt: Date
}
```

## Scripts Disponibles

### 1. Script de Migration Principal
**Fichier:** `migrate-company-to-organization.js`

**Fonctionnalités:**
- Sauvegarde automatique avant migration
- Mapping complet des données company → organization
- Création des memberships automatique
- Gestion des organisations existantes
- Mode dry-run pour simulation

**Usage:**
```bash
# Simulation (recommandé en premier)
node migrate-company-to-organization.js --dry-run

# Migration réelle
node migrate-company-to-organization.js

# Migration sans sauvegarde (non recommandé)
node migrate-company-to-organization.js --skip-backup

# Aide
node migrate-company-to-organization.js --help
```

### 2. Script de Validation
**Fichier:** `validate-company-migration.js`

**Fonctionnalités:**
- Analyse de l'intégrité des données migrées
- Détection des problèmes de cohérence
- Génération de rapport JSON
- Statistiques détaillées

**Usage:**
```bash
# Validation post-migration
node validate-company-migration.js
```

### 3. Script de Rollback
**Fichier:** `rollback-company-migration.js`

**Fonctionnalités:**
- Restauration depuis sauvegarde
- Rollback manuel par suppression
- Interface interactive
- Mode dry-run

**Usage:**
```bash
# Simulation de rollback
node rollback-company-migration.js --dry-run

# Rollback interactif
node rollback-company-migration.js

# Rollback automatique (sauvegarde la plus récente)
node rollback-company-migration.js --auto-confirm
```

## Procédure de Migration Complète

### Étape 1: Préparation
1. **Vérifier les prérequis:**
   ```bash
   # Vérifier MongoDB
   node scripts/diagnose-mongodb.js
   
   # Vérifier les variables d'environnement
   echo $MONGODB_URI
   ```

2. **Analyser l'état actuel:**
   ```bash
   # Compter les utilisateurs avec données company
   mongosh "$MONGODB_URI" --eval "db.user.countDocuments({'company': {\$exists: true, \$ne: null}})"
   ```

### Étape 2: Simulation
```bash
# Tester la migration en mode dry-run
node scripts/migrate-company-to-organization.js --dry-run
```

**Vérifier la sortie:**
- Nombre d'utilisateurs à migrer
- Organisations qui seraient créées/mises à jour
- Aucune erreur critique

### Étape 3: Migration Réelle
```bash
# Exécuter la migration
node scripts/migrate-company-to-organization.js
```

**Surveillance:**
- Suivre les logs en temps réel
- Noter les erreurs éventuelles
- Vérifier la création de la sauvegarde

### Étape 4: Validation
```bash
# Valider l'intégrité des données
node scripts/validate-company-migration.js
```

**Points de contrôle:**
- Toutes les organisations créées
- Memberships corrects
- Données cohérentes
- Aucun problème d'intégrité

### Étape 5: Tests Applicatifs
1. **Redémarrer l'application**
2. **Tester les fonctionnalités:**
   - Connexion utilisateur
   - Accès aux organisations
   - Création de factures/devis
   - Paramètres d'entreprise

## Mapping des Champs

| Champ Source | Champ Cible | Transformation |
|--------------|-------------|----------------|
| `company.name` | `companyName` | Direct |
| `company.email` | `companyEmail` | Direct |
| `company.phone` | `companyPhone` | Direct |
| `company.website` | `website` | Direct |
| `company.siret` | `siret` | Direct |
| `company.vatNumber` | `vatNumber` | Direct |
| `company.rcs` | `rcs` | Direct |
| `company.companyStatus` | `legalForm` | Direct |
| `company.capitalSocial` | `capitalSocial` | Direct |
| `company.transactionCategory` | `activityCategory` | Direct |
| `company.vatPaymentCondition` | `fiscalRegime` | Direct |
| `company.address.street` | `addressStreet` | Flatten |
| `company.address.city` | `addressCity` | Flatten |
| `company.address.zipCode` | `addressZipCode` | Flatten |
| `company.address.country` | `addressCountry` | Flatten |
| `company.bankDetails.bankName` | `bankName` | Flatten |
| `company.bankDetails.iban` | `bankIban` | Flatten |
| `company.bankDetails.bic` | `bankBic` | Flatten |
| - | `isVatSubject` | Calculé (vatNumber exists) |
| - | `hasCommercialActivity` | Calculé (GOODS/MIXED) |
| - | `showBankDetails` | Calculé (iban/bic exists) |

## Gestion des Erreurs

### Erreurs Communes

1. **MONGODB_URI non définie**
   ```bash
   # Vérifier ecosystem.config.cjs
   cat ecosystem.config.cjs | grep MONGODB_URI
   ```

2. **Permissions MongoDB insuffisantes**
   ```bash
   # Tester la connexion
   mongosh "$MONGODB_URI" --eval "db.runCommand('ping')"
   ```

3. **Espace disque insuffisant**
   ```bash
   # Vérifier l'espace disponible
   df -h
   ```

4. **Organisation déjà existante**
   - Le script met à jour l'organisation existante
   - Aucune action requise

### Procédure de Récupération

1. **En cas d'erreur pendant la migration:**
   ```bash
   # Arrêter le processus (Ctrl+C)
   # Exécuter le rollback
   node scripts/rollback-company-migration.js
   ```

2. **En cas de données corrompues:**
   ```bash
   # Restaurer depuis la sauvegarde
   node scripts/rollback-company-migration.js --auto-confirm
   ```

## Sauvegardes

### Emplacement
- **Dossier:** `newbi-api/backups/`
- **Format:** `company-migration-backup-YYYY-MM-DDTHH-mm-ss-sssZ/`

### Contenu
- Dump complet de la base MongoDB
- Toutes les collections préservées
- Métadonnées de sauvegarde

### Restauration Manuelle
```bash
# Si les scripts ne fonctionnent pas
mongorestore --uri="$MONGODB_URI" --drop /path/to/backup/folder
```

## Validation Post-Migration

### Vérifications Automatiques
- ✅ Nombre d'organisations créées
- ✅ Memberships corrects
- ✅ Intégrité référentielle
- ✅ Cohérence des données

### Vérifications Manuelles
1. **Interface utilisateur:**
   - Paramètres d'entreprise accessibles
   - Données affichées correctement

2. **Fonctionnalités métier:**
   - Création de factures
   - Génération de PDF
   - Coordonnées bancaires

3. **Base de données:**
   ```bash
   # Vérifier les collections
   mongosh "$MONGODB_URI" --eval "
     console.log('Users:', db.user.countDocuments());
     console.log('Organizations:', db.organization.countDocuments());
     console.log('Members:', db.member.countDocuments());
   "
   ```

## Nettoyage Post-Migration

### Suppression des Données company (Optionnel)
```javascript
// Le script supprime automatiquement les données company
// Pour vérifier:
db.user.countDocuments({'company': {$exists: true, $ne: null}})
// Résultat attendu: 0
```

### Suppression des Sauvegardes Anciennes
```bash
# Après validation complète (optionnel)
find newbi-api/backups/ -name "company-migration-backup-*" -mtime +30 -exec rm -rf {} \;
```

## Dépannage

### Logs Détaillés
- Tous les scripts génèrent des logs détaillés
- Erreurs avec stack traces complètes
- Statistiques de progression

### Support
1. **Vérifier les logs de migration**
2. **Exécuter le script de validation**
3. **Consulter le rapport JSON généré**
4. **Tester en mode dry-run pour reproduire**

### Commandes Utiles
```bash
# État des collections
mongosh "$MONGODB_URI" --eval "show collections"

# Exemple d'organisation
mongosh "$MONGODB_URI" --eval "db.organization.findOne()"

# Exemple de membership
mongosh "$MONGODB_URI" --eval "db.member.findOne()"

# Utilisateurs sans company
mongosh "$MONGODB_URI" --eval "db.user.countDocuments({'company': {\$exists: false}})"
```

## Checklist de Migration

### Avant Migration
- [ ] Sauvegarde manuelle de sécurité
- [ ] Vérification de l'espace disque
- [ ] Test en mode dry-run réussi
- [ ] Application arrêtée (recommandé)

### Pendant Migration
- [ ] Surveillance des logs
- [ ] Vérification des erreurs
- [ ] Sauvegarde automatique créée

### Après Migration
- [ ] Validation automatique exécutée
- [ ] Tests applicatifs réussis
- [ ] Rapport de validation consulté
- [ ] Utilisateurs informés

### En Cas de Problème
- [ ] Rollback exécuté
- [ ] Cause identifiée
- [ ] Solution appliquée
- [ ] Nouvelle tentative planifiée

---

**Note:** Cette migration est irréversible sans sauvegarde. Toujours tester en mode dry-run avant l'exécution réelle.
