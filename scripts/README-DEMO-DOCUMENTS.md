# Scripts d'Ajout de Données de Démonstration

Ce dossier contient les scripts pour ajouter des données de démonstration (factures, devis, avoirs) à l'utilisateur `demo@newbi.fr` en production.

## 📁 Fichiers

### Scripts Principaux
- **`add-demo-documents.js`** - Script principal qui ajoute les données
- **`run-add-demo-documents.js`** - Script d'exécution convivial avec interface utilisateur
- **`README-DEMO-DOCUMENTS.md`** - Cette documentation

## 🎯 Objectif

Ajouter des données de démonstration réalistes pour l'utilisateur `demo@newbi.fr` :
- **13 Factures** avec différents statuts et services variés
- **10 Devis** avec différents statuts et projets variés
- **5 Avoirs** liés à des factures existantes avec types variés

## 📊 Données Créées

### Factures (13)
**Services variés générés aléatoirement :**
- Développement application web (2,500€)
- Formation équipe technique (800€/jour)
- Consultation stratégique (150€/heure)
- Maintenance système (200€/mois)
- Audit sécurité informatique (1,200€)
- Développement API REST (1,800€)
- Migration base de données (900€)
- Support technique (80€/heure)
- Hébergement cloud (120€/mois)
- Optimisation performances (600€)
- Formation utilisateurs (400€/jour)
- Intégration système (1,500€)
- Tests et validation (350€/jour)

**Répartition des statuts :**
- 50% COMPLETED (factures payées)
- 30% PENDING (en attente de paiement)
- 15% DRAFT (brouillons)
- 5% CANCELED (annulées)

**Caractéristiques :**
- Dates réparties sur les 90 derniers jours
- Montants entre 100€ et 15,000€
- Clients assignés aléatoirement
- Remises occasionnelles (30% de chance)

### Devis (10)
**Projets variés générés aléatoirement :**
- Refonte site web e-commerce (5,000€)
- Application mobile iOS/Android (8,000€)
- Système de gestion CRM (3,500€)
- Plateforme e-learning (6,500€)
- API de paiement sécurisé (2,800€)
- Dashboard analytique (4,200€)
- Système de réservation (3,800€)
- Marketplace B2B (9,500€)
- Solution IoT connectée (7,200€)
- Audit et conseil digital (1,500€)

**Répartition des statuts :**
- 30% ACCEPTED (acceptés)
- 50% PENDING (en attente)
- 15% REJECTED (refusés)
- 5% EXPIRED (expirés)

**Caractéristiques :**
- Dates réparties sur les 60 derniers jours
- Validité de 30 jours
- Montants entre 1,500€ et 11,400€
- Remises occasionnelles (40% de chance)

### Avoirs (5)
**Types variés générés aléatoirement :**
- COMMERCIAL_GESTURE (Geste commercial)
- CORRECTION (Correction de facturation)
- REFUND (Remboursement)
- STOCK_SHORTAGE (Rupture de stock)

**Méthodes de remboursement :**
- NEXT_INVOICE (Déduction prochaine facture)
- BANK_TRANSFER (Virement bancaire)
- CHECK (Chèque)
- VOUCHER (Bon d'achat)

**Caractéristiques :**
- Montants entre 50€ et 500€ (négatifs)
- Liés aux factures COMPLETED en priorité
- Dates réparties sur les 30 derniers jours
- Motifs réalistes et variés

## 🚀 Utilisation

### Méthode Recommandée (Interface Conviviale)
```bash
cd /path/to/newbi-api/scripts
node run-add-demo-documents.js
```

### Options Disponibles
```bash
# Exécution normale avec confirmation
node run-add-demo-documents.js

# Exécution sans confirmation
node run-add-demo-documents.js --force

# Aperçu seulement (sans exécution)
node run-add-demo-documents.js --preview

# Afficher l'aide
node run-add-demo-documents.js --help
```

### Méthode Directe (Script Principal)
```bash
node add-demo-documents.js
```

## ⚙️ Configuration

### Prérequis
1. **MongoDB** doit être accessible avec l'URI fournie
2. **Utilisateur démo** `demo@newbi.fr` doit exister
3. **Node.js** avec support ES modules

### Variables de Configuration
```javascript
// Dans add-demo-documents.js
const MONGODB_URI = "mongodb://newbiAdmin:j6FKJHBb39Rdw^kM^2^Fp5ohPfjgy9@localhost:27017/newbi?authSource=admin";
const DB_NAME = "newbi";
const DEMO_EMAIL = "demo@newbi.fr";
```

## 🔄 Fonctionnement

### Étapes d'Exécution
1. **Connexion MongoDB** - Vérification de la connectivité
2. **Recherche utilisateur** - Trouve l'utilisateur démo et son organisation
3. **Gestion clients** - Recherche ou crée des clients de démonstration
4. **Création factures** - Ajoute 3 factures avec différents statuts
5. **Création devis** - Ajoute 2 devis avec différents statuts
6. **Création avoirs** - Ajoute 1 avoir lié à une facture
7. **Résumé** - Affiche un récapitulatif des données créées

### Gestion des Données Existantes
- **Suppression automatique** des documents existants avant création
- **Préservation des clients** existants (ou création si aucun)
- **Numérotation cohérente** respectant les règles métier

## 🛡️ Sécurités

### Validations
- Vérification de l'existence de l'utilisateur démo
- Validation de la structure des données
- Respect des contraintes de schéma MongoDB
- Gestion des erreurs avec messages explicites

### Rollback
- Les anciennes données sont supprimées avant création
- En cas d'erreur, les données partielles peuvent être nettoyées manuellement
- Logs détaillés pour diagnostic

## 📋 Logs et Monitoring

### Types de Logs
- **🚀** Démarrage et configuration
- **📋** Étapes numérotées (1-6)
- **✅** Succès avec détails
- **❌** Erreurs avec solutions
- **⚠️** Avertissements et informations
- **📊** Résumés et statistiques

### Exemple de Sortie
```
🚀 Démarrage du script d'ajout de données de démonstration
📧 Utilisateur cible: demo@newbi.fr
📋 Étape 1: Connexion à MongoDB...
✅ Connexion MongoDB réussie
📊 Version MongoDB: 7.0.0
📋 Étape 2: Recherche de l'utilisateur démo...
✅ Utilisateur démo trouvé: 64f1a2b3c4d5e6f7g8h9i0j1
...
📊 RÉSUMÉ DES DONNÉES CRÉÉES
================================
📄 Factures: 3
   1. 000001 - COMPLETED - 4728€
   2. 000002 - PENDING - 720€
   3. DRAFT-000003-1695123456 - DRAFT - 2616€
📋 Devis: 2
   1. 000001 - ACCEPTED - 7680€
   2. 000002 - PENDING - 8640€
💰 Avoirs: 1
   1. 000001 - CREATED - -240€
✅ Script terminé avec succès !
```

## 🔧 Dépannage

### Erreurs Courantes

#### Erreur de Connexion MongoDB
```
❌ Erreur de connexion MongoDB: ECONNREFUSED
```
**Solution**: Vérifiez que MongoDB est démarré et accessible

#### Utilisateur Démo Non Trouvé
```
❌ Utilisateur démo non trouvé dans la collection user
```
**Solution**: Créez d'abord l'utilisateur avec `create-demo-account.js`

#### Erreur d'Authentification
```
❌ Erreur de connexion MongoDB: Authentication failed
```
**Solution**: Vérifiez les identifiants MongoDB dans l'URI

#### Erreur de Schéma
```
❌ Erreur lors de la création des factures: ValidationError
```
**Solution**: Vérifiez que les données respectent les contraintes du modèle

### Diagnostic Avancé

#### Vérification Manuelle
```javascript
// Connexion MongoDB pour vérification
use newbi
db.user.findOne({email: "demo@newbi.fr"})
db.member.findOne({userId: ObjectId("...")})
db.invoices.find({workspaceId: ObjectId("...")}).count()
```

#### Nettoyage Manuel
```javascript
// Suppression des données de test
db.invoices.deleteMany({workspaceId: ObjectId("...")})
db.quotes.deleteMany({workspaceId: ObjectId("...")})
db.creditnotes.deleteMany({workspaceId: ObjectId("...")})
```

## 📈 Validation Post-Exécution

### Vérifications Recommandées
1. **Connexion** avec `demo@newbi.fr`
2. **Navigation** vers les pages Factures/Devis
3. **Vérification** des données affichées
4. **Test** de création de nouveaux documents
5. **Validation** de la numérotation séquentielle

### Métriques de Succès
- ✅ 3 factures visibles dans l'interface
- ✅ 2 devis visibles dans l'interface
- ✅ 1 avoir visible dans l'interface
- ✅ Numérotation cohérente et séquentielle
- ✅ Données complètes (clients, montants, statuts)

## 🔄 Maintenance

### Réexécution
- Le script peut être réexécuté sans problème
- Les données existantes sont automatiquement supprimées
- Nouvelle numérotation générée à chaque exécution

### Mise à Jour
- Modifier les données dans `add-demo-documents.js`
- Ajuster les montants, descriptions, dates selon les besoins
- Respecter les contraintes de schéma MongoDB

## 📞 Support

En cas de problème :
1. Vérifiez les logs détaillés
2. Consultez la section Dépannage
3. Vérifiez la configuration MongoDB
4. Validez l'existence de l'utilisateur démo
