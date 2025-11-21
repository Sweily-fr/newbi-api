# 🧹 Système de Nettoyage Automatique des Fichiers

## Vue d'ensemble

Le système de nettoyage automatique supprime les fichiers expirés stockés sur **Cloudflare R2** et en **local** pour libérer de l'espace de stockage.

## 📅 Planification

### Exécution automatique

- **Fréquence** : Tous les jours à **3h00 du matin** (heure serveur)
- **Configuration** : `src/jobs/scheduler.js`
- **Cron** : `0 3 * * *`

### Processus en 2 étapes

#### 1️⃣ Marquage des transferts expirés

- Recherche tous les transferts avec `status: 'active'` et `expiryDate < maintenant`
- Change leur statut à `'expired'`
- **Aucune suppression de fichier** à cette étape

#### 2️⃣ Suppression des fichiers (48h après expiration)

- Recherche tous les transferts avec `status: 'expired'` et `expiryDate < maintenant - 48h`
- Supprime les fichiers physiques :
  - **Cloudflare R2** : via `deleteFileFromR2(r2Key)`
  - **Local** : via `deleteFile(filePath)`
- Marque le transfert comme `'deleted'`
- **Marge de sécurité** : 48h pour éviter les suppressions accidentelles

## 🔧 Déclenchement manuel

### Via API (authentification requise)

#### Nettoyage complet

```bash
POST /api/admin/cleanup/run
Authorization: Bearer <token>
```

**Réponse :**

```json
{
  "success": true,
  "message": "Nettoyage exécuté avec succès",
  "result": {
    "transfersMarked": 5,
    "filesDeleted": {
      "local": 2,
      "r2": 8,
      "failed": 0,
      "total": 10
    },
    "spaceFreed": "245.67 MB"
  }
}
```

#### Marquer uniquement (sans supprimer)

```bash
POST /api/admin/cleanup/mark-expired
Authorization: Bearer <token>
```

#### Supprimer uniquement (sans marquer)

```bash
POST /api/admin/cleanup/delete-files
Authorization: Bearer <token>
```

### Via script Node.js

```bash
cd newbi-api
node src/scripts/runCleanupJob.js
```

## 📊 Logs détaillés

Le système génère des logs détaillés pour chaque opération :

```
🧹 Suppression des fichiers de 3 transferts expirés (expirés depuis plus de 48h)
📦 Traitement du transfert 673d5f8a9b2c1d4e5f6a7b8c (5 fichiers, expiré le 2025-11-18T14:30:00.000Z)
✅ Fichier R2 supprimé: transfers/temp_abc123/file1.pdf (document.pdf) - 2.45 MB
✅ Fichier R2 supprimé: transfers/temp_abc123/file2.jpg (image.jpg) - 1.23 MB
✅ Nettoyage terminé pour transfert 673d5f8a9b2c1d4e5f6a7b8c
🎉 Suppression terminée: 0 fichiers locaux, 10 fichiers R2, 0 échecs, 245.67 MB libérés
```

## 🔍 Détails techniques

### Fichiers concernés

- **Backend** :
  - `src/jobs/cleanupExpiredFiles.js` - Logique de nettoyage
  - `src/jobs/scheduler.js` - Planification cron
  - `src/routes/cleanupAdmin.js` - Routes API admin
  - `src/utils/chunkUploadR2Utils.js` - Suppression R2

### Modèle de données

#### États d'un transfert

1. `active` - Transfert actif et accessible
2. `expired` - Transfert expiré mais fichiers encore présents
3. `deleted` - Fichiers supprimés, transfert archivé

### Sécurité

- ✅ **Authentification JWT** requise pour les routes admin
- ✅ **Marge de 48h** avant suppression définitive
- ✅ **Logs détaillés** pour audit
- ✅ **Gestion d'erreurs** robuste (échecs n'interrompent pas le processus)

## 📈 Métriques suivies

Pour chaque exécution :

- Nombre de transferts marqués comme expirés
- Nombre de fichiers supprimés (local vs R2)
- Nombre d'échecs de suppression
- Espace disque libéré (en MB)

## ⚙️ Configuration

### Variables d'environnement requises

```env
# Cloudflare R2
R2_API_URL=https://...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
TRANSFER_BUCKET=transfers

# MongoDB
MONGODB_URI=mongodb://...
```

### Modification de la fréquence

Éditer `src/jobs/scheduler.js` :

```javascript
// Tous les jours à 3h
cron.schedule('0 3 * * *', async () => { ... });

// Toutes les 6 heures
cron.schedule('0 */6 * * *', async () => { ... });

// Tous les dimanches à minuit
cron.schedule('0 0 * * 0', async () => { ... });
```

## 🚨 Dépannage

### Le nettoyage ne s'exécute pas

1. Vérifier que `setupScheduledJobs()` est appelé dans `server.js`
2. Vérifier les logs serveur au démarrage
3. Vérifier la timezone du serveur

### Fichiers non supprimés

1. Vérifier les logs pour les erreurs
2. Vérifier les permissions Cloudflare R2
3. Vérifier que `r2Key` est bien défini dans les fichiers

### Tester le système

```bash
# Créer un transfert de test avec expiration courte
# Attendre l'expiration
# Déclencher manuellement le nettoyage
curl -X POST http://localhost:4000/api/admin/cleanup/run \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## 📝 Notes importantes

- Les fichiers sont **définitivement supprimés** après 48h d'expiration
- **Aucune récupération possible** après suppression
- Le système gère automatiquement les deux types de stockage (local + R2)
- Les échecs de suppression sont loggés mais n'interrompent pas le processus

## 🔄 Améliorations futures possibles

- [ ] Notification email aux admins après chaque nettoyage
- [ ] Dashboard de statistiques de nettoyage
- [ ] Archivage avant suppression définitive
- [ ] Configuration de la marge de sécurité (actuellement 48h)
- [ ] Nettoyage sélectif par taille/date
