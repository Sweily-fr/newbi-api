# 🚀 Guide de Déploiement Newbi API

Ce guide explique comment configurer et utiliser les déploiements automatiques via GitHub Actions.

## 📋 Table des Matières

1. [Configuration Initiale](#-configuration-initiale)
2. [Workflows Disponibles](#-workflows-disponibles)
3. [Utilisation](#-utilisation)
4. [Dépannage](#-dépannage)

---

## 🔧 Configuration Initiale

### Étape 1 : Configurer les Secrets GitHub

1. **Accédez aux paramètres de votre repository** :
   - Allez sur https://github.com/VOTRE_USERNAME/VOTRE_REPO
   - Cliquez sur **Settings** (⚙️)
   - Dans le menu latéral, cliquez sur **Secrets and variables** > **Actions**

2. **Ajoutez le secret VPS_SSH_KEY** :
   - Cliquez sur **New repository secret**
   - **Name** : `VPS_SSH_KEY`
   - **Value** : Copiez le contenu de votre clé SSH privée
   
   ```bash
   # Sur votre machine locale
   cat ~/.ssh/vps_key
   ```
   
   - Copiez TOUT le contenu (incluant `-----BEGIN ... KEY-----` et `-----END ... KEY-----`)
   - Cliquez sur **Add secret**

3. **Ajoutez le secret REDIS_PASSWORD** :
   - Cliquez sur **New repository secret**
   - **Name** : `REDIS_PASSWORD`
   - **Value** : `7dkY6dNWbGVLGpQqAOeEEi`
   - Cliquez sur **Add secret**

### Étape 2 : Vérifier la Configuration du Serveur

Assurez-vous que votre serveur VPS est correctement configuré :

```bash
# Connectez-vous au serveur
ssh -i ~/.ssh/vps_key joaquim@51.91.254.74

# Vérifiez que les dossiers existent
ls -la ~/api.newbi.fr
ls -la ~/staging

# Vérifiez PM2
pm2 list

# Vérifiez Redis
redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping
```

### Étape 3 : Commiter les Workflows

```bash
# Ajoutez les workflows au repository
git add .github/workflows/
git commit -m "ci: add GitHub Actions workflows for auto-deployment"
git push origin main
```

---

## 📊 Workflows Disponibles

### 🟢 Production (`deploy-production.yml`)

| Propriété | Valeur |
|-----------|--------|
| **Branche** | `main` |
| **Destination** | `~/api.newbi.fr` |
| **PM2 Process** | `newbi` |
| **URL** | https://www.newbi.fr |
| **Déclenchement** | Push sur `main` ou manuel |

### 🟡 Staging (`deploy-staging.yml`)

| Propriété | Valeur |
|-----------|--------|
| **Branche** | `develop` |
| **Destination** | `~/staging` |
| **PM2 Process** | `newbi-staging` |
| **URL** | Staging URL |
| **Déclenchement** | Push sur `develop` ou manuel |

---

## 🎯 Utilisation

### Déploiement Automatique

#### Production (main)

```bash
# 1. Assurez-vous d'être sur la branche main
git checkout main

# 2. Mergez vos changements depuis develop
git merge develop

# 3. Poussez vers GitHub
git push origin main

# ✅ Le déploiement se lance automatiquement !
```

#### Staging (develop)

```bash
# 1. Assurez-vous d'être sur la branche develop
git checkout develop

# 2. Ajoutez vos changements
git add .
git commit -m "feat: nouvelle fonctionnalité"

# 3. Poussez vers GitHub
git push origin develop

# ✅ Le déploiement se lance automatiquement !
```

### Déploiement Manuel

Si vous voulez déclencher un déploiement sans faire de push :

1. Allez sur https://github.com/VOTRE_USERNAME/VOTRE_REPO/actions
2. Sélectionnez le workflow souhaité :
   - **Deploy to Production** pour production
   - **Deploy to Staging** pour staging
3. Cliquez sur **Run workflow** (bouton bleu)
4. Sélectionnez la branche
5. Cliquez sur **Run workflow**

### Voir les Logs de Déploiement

1. Allez sur https://github.com/VOTRE_USERNAME/VOTRE_REPO/actions
2. Cliquez sur le workflow en cours ou terminé
3. Cliquez sur le job "Deploy to Production Server" ou "Deploy to Staging Server"
4. Consultez les logs détaillés de chaque étape

---

## 🔍 Monitoring Post-Déploiement

### Vérifier le Statut PM2

```bash
# Production
ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
pm2 status newbi
pm2 logs newbi --lines 50

# Staging
ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
pm2 status newbi-staging
pm2 logs newbi-staging --lines 50
```

### Vérifier Redis

```bash
ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping
# Devrait retourner: PONG
```

### Tester l'API

```bash
# Production
curl https://www.newbi.fr/graphql

# Staging
curl https://staging.newbi.fr/graphql
```

---

## 🛠️ Dépannage

### ❌ Erreur : "Permission denied (publickey)"

**Cause** : La clé SSH n'est pas correctement configurée.

**Solution** :
1. Vérifiez que le secret `VPS_SSH_KEY` contient la bonne clé privée
2. Vérifiez que la clé publique est dans `~/.ssh/authorized_keys` sur le serveur :
   ```bash
   ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
   cat ~/.ssh/authorized_keys
   ```

### ❌ Erreur : "npm ci failed"

**Cause** : Problème avec les dépendances npm.

**Solution** :
1. Vérifiez que `package-lock.json` est bien commité
2. Vérifiez l'espace disque sur le serveur :
   ```bash
   ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
   df -h
   ```

### ❌ Erreur : "pm2 reload failed"

**Cause** : Le process PM2 n'existe pas ou est mal configuré.

**Solution** :
1. Vérifiez que le process existe :
   ```bash
   ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
   pm2 list
   ```
2. Si le process n'existe pas, démarrez-le manuellement :
   ```bash
   cd ~/api.newbi.fr  # ou ~/staging
   pm2 start ecosystem.config.cjs
   pm2 save
   ```

### ❌ Erreur : "Redis connection failed"

**Cause** : Redis n'est pas démarré ou le mot de passe est incorrect.

**Solution** :
1. Redémarrez Redis :
   ```bash
   ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
   sudo snap restart redis
   ```
2. Vérifiez la connexion :
   ```bash
   redis.cli -a "7dkY6dNWbGVLGpQqAOeEEi" ping
   ```

### 🔄 Rollback vers une Version Précédente

Si un déploiement cause des problèmes :

1. **Via GitHub Actions** :
   - Allez sur **Actions**
   - Sélectionnez le workflow
   - Cliquez sur **Run workflow**
   - Sélectionnez un commit précédent
   - Lancez le workflow

2. **Via Git** :
   ```bash
   # Revert le dernier commit
   git revert HEAD
   git push origin main  # ou develop
   
   # Le déploiement se lance automatiquement avec l'ancienne version
   ```

---

## 📚 Ressources Utiles

- [Documentation GitHub Actions](https://docs.github.com/en/actions)
- [Documentation PM2](https://pm2.keymetrics.io/)
- [Documentation Rsync](https://linux.die.net/man/1/rsync)
- [Documentation Redis](https://redis.io/docs/)

---

## 🎉 Avantages du Déploiement Automatique

- ✅ **Gain de temps** : Plus besoin de `make deploy` manuel
- ✅ **Traçabilité** : Historique complet dans GitHub Actions
- ✅ **Sécurité** : Clés SSH stockées de manière sécurisée
- ✅ **Rollback facile** : Redéployez une version précédente en 1 clic
- ✅ **Tests en staging** : Testez avant de déployer en production
- ✅ **Notifications** : Recevez des notifications de succès/échec

---

## 📞 Support

En cas de problème, consultez :
1. Les logs GitHub Actions
2. Les logs PM2 sur le serveur
3. Les logs de l'application dans `~/api.newbi.fr/logs/` ou `~/staging/logs/`
