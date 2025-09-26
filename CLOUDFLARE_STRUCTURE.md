# Structure d'arborescence Cloudflare R2 - Signatures Mail

## Vue d'ensemble

Cette documentation décrit la structure d'organisation des fichiers sur Cloudflare R2 pour les signatures mail, garantissant une arborescence claire et lisible avec **minimum 2 niveaux de dossiers**.

## Structure d'arborescence

### Bucket principal
- **Nom du bucket :** `image-signature`
- **URL publique :** `https://157ce0fed50fe542bc92a07317a09205.r2.cloudflarestorage.com/image-signature`

### Hiérarchie des dossiers

```
image-signature/
├── {userId}/                           # Niveau 1 - Dossier utilisateur
│   ├── {signatureId}/                  # Niveau 2 - Dossier signature
│   │   ├── ImgProfil/                  # Niveau 3 - Images de profil
│   │   │   ├── uuid1.jpg
│   │   │   ├── uuid2.png
│   │   │   └── ...
│   │   └── logoReseau/                 # Niveau 3 - Logos réseaux sociaux
│   │       ├── uuid3.svg
│   │       ├── uuid4.png
│   │       └── ...
│   └── {autreSignatureId}/
│       ├── ImgProfil/
│       └── logoReseau/
└── {autreUserId}/
    └── ...
```

### Exemple concret

```
image-signature/
├── 68bfdfaae141839448458fe3/           # ID utilisateur
│   ├── temp-1727213077123/             # ID signature temporaire
│   │   ├── ImgProfil/
│   │   │   └── 6cb8bb7c-c34f-492f-a00c-c28779cdb457.png
│   │   └── logoReseau/
│   │       └── a1b2c3d4-e5f6-7890-abcd-ef1234567890.svg
│   └── signature-prod-456/             # ID signature production
│       ├── ImgProfil/
│       │   └── profile-image.jpg
│       └── logoReseau/
│           ├── linkedin-logo.png
│           └── facebook-logo.svg
```

## Types d'images supportés

| Type d'image | Dossier cible | Description |
|--------------|---------------|-------------|
| `imgProfil` | `ImgProfil/` | Images de profil utilisateur dans les signatures |
| `logoReseau` | `logoReseau/` | Logos des réseaux sociaux |

## Règles de nommage

### Clé complète
Format : `{userId}/{signatureId}/{typeImage}/{uuid}.{extension}`

**Exemple :**
```
68bfdfaae141839448458fe3/temp-1727213077123/ImgProfil/6cb8bb7c-c34f-492f-a00c-c28779cdb457.png
```

### Composants
- **userId :** ID MongoDB de l'utilisateur (24 caractères hexadécimaux)
- **signatureId :** ID unique de la signature (peut être temporaire ou permanent)
- **typeImage :** `ImgProfil` ou `logoReseau`
- **uuid :** UUID v4 généré automatiquement
- **extension :** Extension du fichier original (.jpg, .png, .gif, .webp, .svg)

## URL d'accès

### URL publique
```
https://157ce0fed50fe542bc92a07317a09205.r2.cloudflarestorage.com/image-signature/{clé-complète}
```

**Exemple :**
```
https://157ce0fed50fe542bc92a07317a09205.r2.cloudflarestorage.com/image-signature/68bfdfaae141839448458fe3/temp-1727213077123/ImgProfil/6cb8bb7c-c34f-492f-a00c-c28779cdb457.png
```

## Fonctionnalités automatiques

### 1. Création de dossiers
- Les dossiers sont créés automatiquement lors du premier upload
- Des fichiers marqueurs `.folder` sont créés pour assurer la visibilité des dossiers vides

### 2. Suppression automatique
- Avant chaque upload, les anciennes images du même type sont supprimées automatiquement
- Évite l'accumulation de fichiers obsolètes

### 3. Validation stricte
- **signatureId obligatoire** pour tous les uploads de signature
- **Types d'images validés** : seuls `imgProfil` et `logoReseau` sont acceptés
- **Formats supportés** : JPG, PNG, GIF, WebP, SVG
- **Taille maximale** : 5MB par fichier

## Utilisation dans le code

### Upload d'une image de profil
```javascript
const result = await cloudflareService.uploadSignatureImage(
  fileBuffer,
  'profile.jpg',
  userId,
  signatureId,
  'imgProfil'
);
```

### Upload d'un logo réseau social
```javascript
const result = await cloudflareService.uploadSignatureImage(
  fileBuffer,
  'linkedin.png',
  userId,
  signatureId,
  'logoReseau'
);
```

### Suppression d'un dossier complet
```javascript
await cloudflareService.deleteSignatureFolder(userId, signatureId, 'imgProfil');
```

## Avantages de cette structure

1. **Lisibilité** : Organisation claire par utilisateur puis par signature
2. **Sécurité** : Isolation des fichiers par utilisateur
3. **Performance** : Accès direct via URL publique
4. **Maintenance** : Suppression facile par utilisateur ou signature
5. **Évolutivité** : Structure extensible pour de nouveaux types d'images

## Migration depuis l'ancienne structure

L'ancienne structure utilisait `imageProfil` au lieu de `ImgProfil`. La nouvelle structure est rétrocompatible et les anciennes images continuent de fonctionner.

## Variables d'environnement requises

```env
IMAGE_SIGNATURE_BUCKET_NAME=image-signature
IMAGE_SIGNATURE_PUBLIC_URL=https://157ce0fed50fe542bc92a07317a09205.r2.cloudflarestorage.com/image-signature
AWS_S3_API_URL=https://157ce0fed50fe542bc92a07317a09205.r2.cloudflarestorage.com
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
```

---

*Documentation mise à jour le 24 septembre 2025*
