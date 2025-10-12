# Scripts de Vérification et Correction des WorkspaceId

## 📋 Vue d'ensemble

Ces scripts permettent de vérifier et corriger l'intégrité des `workspaceId` dans la base de données de production Newbi. Ils sont essentiels pour s'assurer que tous les documents sont correctement liés à leur organisation respective.

## 🔍 Script de Vérification

### `verify-workspace-ids.js`

**Objectif :** Vérifier que toutes les collections qui doivent avoir un `workspaceId` l'ont bien.

**Usage :**
```bash
# Vérification complète
node scripts/verify-workspace-ids.js

# Avec tentative de correction (non implémentée)
node scripts/verify-workspace-ids.js --fix
```

**Collections vérifiées :**
- ✅ **Avec workspaceId requis :** invoices, quotes, clients, expenses, creditnotes, emailsignatures, documentsettings, apimetrics, accountbankings, ocrdocuments, boards, columns, tasks, transactions, products, events, filetransfers, integrations, downloadevents, accessgrants
- ❌ **Sans workspaceId :** user, users, organization, member, subscription, session, account, verification, jwks, stripeconnectaccounts, referralevents

**Sortie :**
- Nombre total de documents vérifiés
- Documents avec/sans workspaceId par collection
- Exemples de documents problématiques
- Résumé détaillé par collection

## 🔧 Script de Correction

### `fix-missing-workspace-ids.js`

**Objectif :** Corriger automatiquement les `workspaceId` manquants en utilisant les relations existantes.

**Usage :**
```bash
# Simulation (recommandé en premier)
node scripts/fix-missing-workspace-ids.js

# Correction réelle
node scripts/fix-missing-workspace-ids.js --apply

# Correction d'une collection spécifique
node scripts/fix-missing-workspace-ids.js --collection=invoices --apply
```

**Stratégies de correction par collection :**

| Collection | Stratégie | Description |
|------------|-----------|-------------|
| `invoices` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `quotes` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `clients` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `expenses` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `creditnotes` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `emailsignatures` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `documentsettings` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `ocrdocuments` | `userId_to_workspace` | Utilise le champ `userId` pour trouver le workspace de l'utilisateur |
| `boards` | `userId_to_workspace` | Utilise le champ `userId` pour trouver le workspace de l'utilisateur |
| `columns` | `boardId_to_workspace` | Utilise le champ `boardId` pour trouver le workspace du board parent |
| `tasks` | `boardId_to_workspace` | Utilise le champ `boardId` pour trouver le workspace du board parent |
| `products` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |
| `events` | `createdBy_to_workspace` | Utilise le champ `createdBy` pour trouver le workspace de l'utilisateur |

## 🚀 Procédure Recommandée

### 1. Vérification Initiale
```bash
node scripts/verify-workspace-ids.js
```
- Identifie les collections avec des problèmes
- Fournit un aperçu des documents sans workspaceId

### 2. Simulation de Correction
```bash
node scripts/fix-missing-workspace-ids.js
```
- Mode simulation (aucune modification)
- Montre quels documents seraient corrigés
- Identifie les documents non corrigeables

### 3. Correction Ciblée (Optionnel)
```bash
node scripts/fix-missing-workspace-ids.js --collection=invoices
```
- Teste la correction sur une collection spécifique
- Permet de valider la stratégie avant correction globale

### 4. Correction Complète
```bash
node scripts/fix-missing-workspace-ids.js --apply
```
- Applique toutes les corrections
- **⚠️ ATTENTION :** Modifie la base de données de production

### 5. Vérification Post-Correction
```bash
node scripts/verify-workspace-ids.js
```
- Confirme que les corrections ont été appliquées
- Identifie les documents restants non corrigés

## 🔍 Logique de Résolution des WorkspaceId

### Stratégie `createdBy_to_workspace`
1. Récupère le `createdBy` du document
2. Cherche l'utilisateur dans la collection `user`
3. Si trouvé et a un `workspaceId`, l'utilise
4. Sinon, cherche dans la collection `member` avec `userId`
5. Utilise l'`organizationId` du membership

### Stratégie `userId_to_workspace`
1. Récupère le `userId` du document
2. Même logique que `createdBy_to_workspace`

### Stratégie `boardId_to_workspace`
1. Récupère le `boardId` du document
2. Cherche le board dans la collection `boards`
3. Utilise le `workspaceId` du board parent

## ⚠️ Précautions

### Avant Exécution
- **Sauvegarde :** Toujours faire une sauvegarde avant correction
- **Test :** Utiliser le mode simulation en premier
- **Validation :** Vérifier les résultats sur un échantillon

### Pendant l'Exécution
- **Monitoring :** Surveiller les logs pour détecter les erreurs
- **Performance :** Les scripts peuvent prendre du temps sur de gros volumes
- **Interruption :** Possibilité d'arrêter avec Ctrl+C

### Après Exécution
- **Vérification :** Relancer le script de vérification
- **Tests :** Tester l'application pour s'assurer du bon fonctionnement
- **Monitoring :** Surveiller les erreurs applicatives

## 🚨 Cas d'Erreur

### Documents Non Corrigeables
- Documents sans `createdBy`, `userId`, ou `boardId`
- Utilisateurs supprimés ou orphelins
- Relations cassées dans la base de données

### Solutions
1. **Investigation manuelle :** Analyser les documents problématiques
2. **Correction manuelle :** Assigner manuellement les workspaceId
3. **Suppression :** Supprimer les documents orphelins (avec précaution)

## 📊 Métriques de Succès

- **100% des documents** avec workspaceId dans les collections requises
- **0 erreur** lors de l'accès aux données dans l'application
- **Performance stable** des requêtes avec filtrage par workspace

## 🔄 Maintenance

### Exécution Régulière
- **Hebdomadaire :** Vérification de l'intégrité
- **Après migration :** Vérification post-déploiement
- **Après incident :** Vérification de cohérence

### Amélioration Continue
- Ajouter de nouvelles stratégies selon les besoins
- Optimiser les performances pour de gros volumes
- Étendre la couverture à de nouvelles collections

## 📞 Support

En cas de problème :
1. Vérifier les logs d'erreur détaillés
2. Consulter la documentation des modèles
3. Tester sur un environnement de développement
4. Contacter l'équipe technique si nécessaire
