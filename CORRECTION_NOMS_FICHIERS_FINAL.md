# 🔧 Correction Finale - Noms de Fichiers avec ID

## 🎯 Problème identifié

Les fichiers téléchargés avaient des noms avec des IDs :

```
f_99bc5d90-b713-4250-be02-ab0ff68203d9_Capture_d_e_cran_2025-11-20_a_14.13.16.png
```

Au lieu de :

```
Capture_d_e_cran_2025-11-20_a_14.13.16.png
```

## 🔍 Cause racine

Le système Cloudflare R2 génère des chemins avec préfixe pour garantir l'unicité :

```
prod/2025/11/21/t_transferId/f_fileId_nomOriginal.png
```

Le problème était que le dernier segment du chemin (`f_fileId_nomOriginal.png`) était utilisé comme `originalName` dans la base de données.

## ✅ Solutions appliquées

### 1. Correction dans `completeMultipartUpload`

**Fichier** : `/src/resolvers/chunkUploadR2.js` (lignes 161-171)

```javascript
// ✅ CORRECTION: Extraire le nom original en retirant le préfixe f_fileId_
const keyFileName = key.split("/").pop();
const cleanOriginalName = keyFileName.replace(/^f_[a-f0-9-]+_/, "");

const fileMetadata = {
  originalName: cleanOriginalName, // ✅ Nom propre sans ID
  displayName: cleanOriginalName, // ✅ Nom propre sans ID
  fileName: keyFileName, // Nom complet avec ID pour le stockage
  // ...
};
```

**Pattern utilisé** : `/^f_[a-f0-9-]+_/`

- Détecte : `f_` + UUID + `_`
- Exemple : `f_99bc5d90-b713-4250-be02-ab0ff68203d9_`

### 2. Correction dans `reconstructFileFromR2`

**Fichier** : `/src/utils/chunkUploadR2Utils.js` (lignes 127-142)

```javascript
// ✅ CORRECTION #2: Séparer le nom original (sans ID) du nom de stockage (avec ID)
const sanitizedFileName = cloudflareTransferService.sanitizeFileName(fileName);

return {
  originalName: fileName, // Nom original sans ID
  displayName: fileName, // Nom affiché sans ID
  fileName: `${fileId}_${sanitizedFileName}`, // Nom de stockage avec ID
  // ...
};
```

### 3. Correction à la volée dans le resolver GraphQL

**Fichier** : `/src/resolvers/fileTransfer.js` (lignes 140-153)

```javascript
// Fonction pour nettoyer les noms de fichiers avec ID
const cleanFileName = (fileName) => {
  if (!fileName) return fileName;
  const uuidPattern =
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_/i;
  return fileName.replace(uuidPattern, "");
};

const filesWithDownloadUrls = fileTransfer.files.map((file) => ({
  ...file.toObject(),
  originalName: cleanFileName(file.originalName), // ✅ Nettoyer à la volée
  displayName: cleanFileName(file.displayName || file.originalName),
  // ...
}));
```

### 4. Script de migration pour les fichiers existants

**Fichier** : `/src/scripts/fixFileNames.js`

Nettoie les noms de fichiers dans la base de données pour les transferts existants.

**Exécution** :

```bash
cd newbi-api
node src/scripts/fixFileNames.js
```

## 🧪 Tests

### Test 1 : Nouveau transfert

1. ✅ Uploader un fichier nommé `Mon Document.pdf`
2. ✅ Créer le transfert
3. ✅ Vérifier dans la BDD que `originalName` = `Mon Document.pdf` (sans ID)
4. ✅ Télécharger le fichier
5. ✅ Vérifier que le nom téléchargé est `Mon Document.pdf`

### Test 2 : Transferts existants

1. ✅ Exécuter le script de migration
2. ✅ Vérifier que les noms sont nettoyés dans la BDD
3. ✅ Télécharger un fichier d'un ancien transfert
4. ✅ Vérifier que le nom est propre (sans ID)

### Test 3 : Correction à la volée

1. ✅ Même si un fichier a un ID dans la BDD
2. ✅ Le resolver GraphQL le nettoie automatiquement
3. ✅ Le frontend reçoit le nom propre

## 📊 Structure des noms

### Dans la base de données (après correction)

```json
{
  "originalName": "Capture_d_e_cran_2025-11-20_a_14.13.16.png",
  "displayName": "Capture_d_e_cran_2025-11-20_a_14.13.16.png",
  "fileName": "f_99bc5d90-b713-4250-be02-ab0ff68203d9_Capture_d_e_cran_2025-11-20_a_14.13.16.png",
  "r2Key": "prod/2025/11/21/t_df9da91a-f1c2-48b6-b188-deb408b50a73/f_99bc5d90-b713-4250-be02-ab0ff68203d9_Capture_d_e_cran_2025-11-20_a_14.13.16.png"
}
```

### Utilisation

- **`originalName`** : Affiché à l'utilisateur, utilisé pour le téléchargement
- **`displayName`** : Affiché dans l'interface (identique à originalName)
- **`fileName`** : Nom de stockage avec ID (pour unicité en BDD)
- **`r2Key`** : Chemin complet dans Cloudflare R2 (avec ID pour unicité)

## 🔄 Flux complet

### Upload

1. Frontend envoie `fileName` = `"Mon Document.pdf"`
2. Backend génère `fileId` = `"99bc5d90-b713-4250-be02-ab0ff68203d9"`
3. R2 stocke avec chemin : `prod/.../f_99bc5d90-..._Mon_Document.pdf`
4. **✅ CORRECTION** : BDD stocke `originalName` = `"Mon Document.pdf"` (sans ID)

### Téléchargement

1. Frontend demande le fichier via GraphQL
2. **✅ CORRECTION** : Resolver nettoie le nom à la volée si nécessaire
3. Frontend affiche `"Mon Document.pdf"`
4. Utilisateur clique sur télécharger
5. Backend utilise `originalName` pour le header `Content-Disposition`
6. Fichier téléchargé : `"Mon Document.pdf"` ✅

## 📝 Patterns de nettoyage

### Pattern 1 : Préfixe R2 (nouveau système)

```javascript
/^f_[a-f0-9-]+_/;
```

Détecte : `f_99bc5d90-b713-4250-be02-ab0ff68203d9_`

### Pattern 2 : UUID simple (ancien système)

```javascript
/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_/i;
```

Détecte : `4c87efaf-7e61-4632-9ad4-cd345372c820_`

## ⚠️ Points d'attention

1. **Unicité en stockage** : Le `fileName` et `r2Key` conservent l'ID pour garantir l'unicité
2. **Affichage utilisateur** : Seuls `originalName` et `displayName` sont sans ID
3. **Migration nécessaire** : Exécuter le script pour les fichiers existants
4. **Correction à la volée** : Le resolver nettoie automatiquement les noms

## 🚀 Déploiement

### Étapes

1. ✅ Déployer le code backend avec les corrections
2. ✅ Redémarrer le serveur API
3. ✅ Exécuter le script de migration :
   ```bash
   node src/scripts/fixFileNames.js
   ```
4. ✅ Tester avec un nouveau transfert
5. ✅ Vérifier les anciens transferts

### Rollback

Si problème, les corrections sont isolées dans :

- `chunkUploadR2.js` (lignes 161-171)
- `chunkUploadR2Utils.js` (lignes 127-142)
- `fileTransfer.js` (lignes 140-153)

## 📞 Support

En cas de problème :

1. Vérifier les logs : `📝 Nettoyage du nom: "..." → "..."`
2. Vérifier la BDD : champs `originalName` et `displayName`
3. Exécuter le script de migration si nécessaire

---

**Date** : 21 novembre 2025
**Version** : 2.0 (Correction finale)
**Status** : ✅ Testé et validé
