# Guide de Migration de Production vers la Nouvelle Structure

Ce guide détaille le processus complet de migration de votre base de données de production vers la nouvelle structure avec le système de workspaces.

## 📋 Vue d'ensemble

### Changements principaux
- **Collection utilisateurs** : `Users` → `user`
- **Système workspace** : Ajout de `workspaceId` sur tous les documents
- **Organisations Better Auth** : Création automatique pour chaque utilisateur
- **Intégrité des données** : Validation complète et rollback possible

### Scripts disponibles
1. `backup-production-db.js` - Sauvegarde complète
2. `migrate-production-to-new-structure.js` - Migration principale
3. `validate-migration-integrity.js` - Validation post-migration
4. `rollback-migration.js` - Rollback en cas de problème

## 🚨 Prérequis

### 1. Outils requis
```bash
# Installer MongoDB Database Tools
brew install mongodb/brew/mongodb-database-tools  # macOS
# ou
sudo apt-get install mongodb-database-tools       # Ubuntu
```

### 2. Variables d'environnement
Vérifiez que votre fichier `.env` contient :
```env
MONGODB_URI=mongodb://...
FRONTEND_URL=https://your-domain.com
```

### 3. Arrêt de l'application
```bash
# Arrêter l'application en production
pm2 stop newbi-api
# ou
docker-compose down
```

## 📦 Étape 1 : Sauvegarde

### Exécution de la sauvegarde
```bash
cd newbi-api
node scripts/backup-production-db.js --output-dir=/path/to/backup
```

### Vérification de la sauvegarde
```bash
# Vérifier que les fichiers ont été créés
ls -la /path/to/backup/backup_YYYY-MM-DD_HH-MM-SS/

# Vérifier le rapport
cat /path/to/backup/backup_YYYY-MM-DD_HH-MM-SS/backup_report.txt
```

### ✅ Critères de validation
- [ ] Sauvegarde mongodump créée (fichiers .bson.gz)
- [ ] Exports JSON des collections critiques
- [ ] Rapport de sauvegarde généré
- [ ] Taille de sauvegarde cohérente avec les données

## 🔄 Étape 2 : Migration (Test)

### Test en mode dry-run
```bash
# Test sans modification des données
node scripts/migrate-production-to-new-structure.js --dry-run --verbose
```

### Analyse des résultats du test
- Vérifiez les statistiques affichées
- Identifiez les erreurs potentielles
- Confirmez le nombre d'utilisateurs et documents

### ✅ Critères de validation du test
- [ ] Aucune erreur fatale
- [ ] Nombre d'utilisateurs cohérent
- [ ] Mapping workspace créé pour tous les utilisateurs
- [ ] Statistiques de migration réalistes

## 🚀 Étape 3 : Migration (Production)

### Exécution de la migration
```bash
# Migration réelle (ATTENTION : modifie les données)
node scripts/migrate-production-to-new-structure.js --batch-size=50
```

### Surveillance en temps réel
- Surveillez les logs pour détecter les erreurs
- Notez les statistiques de progression
- Arrêtez si des erreurs critiques apparaissent

### ✅ Critères de succès
- [ ] Migration terminée sans erreur fatale
- [ ] Tous les utilisateurs migrés
- [ ] Organisations créées pour chaque utilisateur
- [ ] WorkspaceId ajoutés aux documents

## 🔍 Étape 4 : Validation

### Validation complète
```bash
# Validation détaillée avec rapport
node scripts/validate-migration-integrity.js --detailed
```

### Vérification manuelle
```bash
# Connexion à MongoDB pour vérifications manuelles
mongosh "your-mongodb-uri"

# Vérifier les collections
show collections

# Compter les utilisateurs
db.user.countDocuments()
db.Users.countDocuments()

# Vérifier les organisations
db.organization.countDocuments()
db.member.countDocuments()

# Vérifier les workspaceId sur quelques documents
db.invoices.findOne({}, {workspaceId: 1, createdBy: 1})
db.quotes.findOne({}, {workspaceId: 1, createdBy: 1})
```

### ✅ Critères de validation
- [ ] Rapport de validation sans erreur critique
- [ ] Tous les documents ont un workspaceId valide
- [ ] Organisations et membres cohérents
- [ ] Aucun utilisateur manquant

## 🔧 Étape 5 : Test de l'application

### Redémarrage de l'application
```bash
# Redémarrer l'application
pm2 start newbi-api
# ou
docker-compose up -d
```

### Tests fonctionnels
1. **Connexion utilisateur** : Vérifiez que les utilisateurs peuvent se connecter
2. **Création de documents** : Testez la création de factures/devis
3. **Accès aux données** : Vérifiez que les documents existants sont accessibles
4. **Organisations** : Confirmez que les organisations sont bien configurées

### ✅ Critères de validation applicative
- [ ] Connexion utilisateur fonctionnelle
- [ ] Création de nouveaux documents
- [ ] Accès aux documents existants
- [ ] Pas d'erreur dans les logs

## 🎯 Étape 6 : Finalisation

### Nettoyage (optionnel)
```bash
# Une fois la migration validée, vous pouvez supprimer l'ancienne collection
mongosh "your-mongodb-uri"
db.Users.drop()
```

### Mise à jour des sauvegardes
- Configurez vos sauvegardes régulières pour inclure les nouvelles collections
- Mettez à jour vos scripts de monitoring

## 🚨 Procédure de Rollback

### En cas de problème critique
```bash
# 1. Arrêter l'application
pm2 stop newbi-api

# 2. Exécuter le rollback
node scripts/rollback-migration.js --confirm

# 3. Restaurer la sauvegarde si nécessaire
mongorestore --drop /path/to/backup/backup_YYYY-MM-DD_HH-MM-SS/

# 4. Redémarrer l'application
pm2 start newbi-api
```

### ✅ Critères de rollback réussi
- [ ] WorkspaceId supprimés des documents
- [ ] Organisations et membres supprimés
- [ ] Collection "user" supprimée
- [ ] Application fonctionnelle avec l'ancienne structure

## 📊 Monitoring Post-Migration

### Métriques à surveiller
- **Performance** : Temps de réponse des requêtes
- **Erreurs** : Logs d'erreur liés aux workspaces
- **Intégrité** : Cohérence des données utilisateur

### Requêtes de monitoring
```javascript
// Vérifier les documents sans workspaceId
db.invoices.countDocuments({workspaceId: {$exists: false}})
db.quotes.countDocuments({workspaceId: {$exists: false}})

// Vérifier les organisations orphelines
db.organization.aggregate([
  {$lookup: {from: "member", localField: "_id", foreignField: "organizationId", as: "members"}},
  {$match: {members: {$size: 0}}}
])
```

## 🔧 Dépannage

### Problèmes courants

#### 1. Erreur "mongodump not found"
```bash
# Installer MongoDB Database Tools
brew install mongodb/brew/mongodb-database-tools
```

#### 2. Erreur de connexion MongoDB
- Vérifiez la variable `MONGODB_URI`
- Confirmez que MongoDB est accessible
- Vérifiez les credentials

#### 3. Utilisateurs manquants après migration
```bash
# Vérifier les logs de migration
# Relancer la validation
node scripts/validate-migration-integrity.js --detailed
```

#### 4. WorkspaceId manquants
```bash
# Relancer la migration des workspaceId seulement
node scripts/migrate-workspace-ids.js
```

### Contacts d'urgence
- **Développeur** : [Votre contact]
- **DBA** : [Contact DBA si applicable]
- **Support** : [Contact support]

## 📝 Checklist Complète

### Pré-migration
- [ ] Outils MongoDB installés
- [ ] Variables d'environnement configurées
- [ ] Application arrêtée
- [ ] Sauvegarde complète effectuée
- [ ] Test dry-run réussi

### Migration
- [ ] Migration exécutée sans erreur
- [ ] Validation post-migration réussie
- [ ] Tests applicatifs validés
- [ ] Monitoring en place

### Post-migration
- [ ] Application redémarrée
- [ ] Utilisateurs peuvent se connecter
- [ ] Nouveaux documents créés avec workspaceId
- [ ] Ancienne collection supprimée (optionnel)
- [ ] Sauvegardes mises à jour

---

## 📞 Support

En cas de problème durant la migration :

1. **Arrêtez immédiatement** la migration si des erreurs critiques apparaissent
2. **Conservez les logs** pour analyse
3. **Exécutez le rollback** si nécessaire
4. **Contactez le support** avec les détails de l'erreur

**⚠️ Important** : Ne supprimez jamais la sauvegarde avant d'avoir validé complètement la migration sur plusieurs jours d'utilisation.
