# 🎯 Script de Création de Compte Démo Newbi

Ce script génère automatiquement un compte démo complet avec des données factices pour tester toutes les fonctionnalités de l'application Newbi.

## 📋 Contenu généré

Le script crée automatiquement :

### 👤 Utilisateur Démo
- **Email :** `demo@newbi.fr`
- **Mot de passe :** `Test_123@`
- **Profil :** Jean Démo
- **Entreprise :** Entreprise Démo SARL (données complètes)

### 📊 Données Factices
- **3 clients** (entreprises et particuliers)
- **3 factures** (complétée, en attente, brouillon)
- **2 devis** (accepté, en attente)
- **1 avoir** (remboursement partiel)
- **3 dépenses** (matériel, logiciel, déplacement)

## 🚀 Utilisation

### Méthode Simple
```bash
cd newbi-api
node scripts/run-demo-creation.js
```

### Méthode Force (sans confirmation)
```bash
node scripts/run-demo-creation.js --force
```

### Méthode Directe
```bash
node scripts/create-demo-account.js
```

## ⚙️ Configuration

Le script utilise automatiquement la configuration MongoDB depuis :
1. `ecosystem.config.cjs` (priorité)
2. Variables d'environnement `MONGODB_URI`
3. Fallback : `mongodb://127.0.0.1:27017/newbi-production`

## 🔄 Comportement

### Si le compte démo existe déjà :
1. ⚠️ Avertissement affiché
2. 🗑️ Suppression de toutes les données existantes
3. ✨ Création des nouvelles données factices

### Données générées :
- **Utilisateur complet** avec profil et informations entreprise
- **Clients variés** (SARL, particulier, SAS)
- **Factures réalistes** avec différents statuts
- **Devis professionnels** avec dates de validité
- **Avoir de remboursement** lié à une facture
- **Dépenses d'entreprise** avec TVA

## 📝 Détails des Données

### Entreprise Démo
```
Nom: Entreprise Démo SARL
Email: contact@demo-entreprise.fr
SIRET: 12345678901234
TVA: FR12345678901
Adresse: 123 Rue de la Démo, 75001 Paris
```

### Clients Générés
1. **Société ABC** (Lyon) - Entreprise avec SIRET/TVA
2. **Martin Dupont** (Marseille) - Particulier
3. **Tech Solutions SAS** (Toulouse) - Entreprise tech

### Factures Générées
1. **F-202409-000001** - Complétée (3 840€)
2. **F-202409-000002** - En attente (2 160€)
3. **DRAFT-000003-123456** - Brouillon (3 000€)

### Services/Produits
- Développement site web (2 500€)
- Formation utilisateurs (350€/jour)
- Maintenance mensuelle (150€/mois)

## 🛠️ Dépannage

### Erreur de connexion MongoDB
```bash
# Vérifier que MongoDB est démarré
sudo systemctl status mongod

# Ou sur macOS
brew services list | grep mongodb
```

### Erreur de permissions
```bash
# Vérifier les permissions de la base de données
mongo --eval "db.runCommand({connectionStatus: 1})"
```

### Erreur de validation
- Vérifiez que tous les modèles sont à jour
- Vérifiez les contraintes de validation dans les schémas

## 🔍 Validation

Après exécution, vérifiez :
1. ✅ Connexion avec `demo@newbi.fr` / `Test_123@`
2. ✅ Présence des clients dans la liste
3. ✅ Factures avec différents statuts
4. ✅ Devis consultables
5. ✅ Avoir lié à la première facture
6. ✅ Dépenses dans la comptabilité

## 🚨 Important

- ⚠️ **Production :** Utilisez ce script uniquement en développement/test
- 🔄 **Réexécution :** Le script supprime et recrée toutes les données démo
- 💾 **Sauvegarde :** Aucune sauvegarde automatique des données existantes
- 🔐 **Sécurité :** Le mot de passe est hashé automatiquement par bcrypt

## 📞 Support

En cas de problème :
1. Vérifiez les logs d'erreur détaillés
2. Consultez la configuration MongoDB
3. Vérifiez les permissions de la base de données
4. Contactez l'équipe technique si nécessaire
