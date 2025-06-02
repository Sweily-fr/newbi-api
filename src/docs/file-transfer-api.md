# API de transfert de fichiers volumineux - Newbi

## Vue d'ensemble

Cette API permet aux utilisateurs de Newbi de transférer des fichiers volumineux (jusqu'à 100GB) via des liens de partage. Elle offre les fonctionnalités suivantes :

- Upload de fichiers multiples (jusqu'à 100GB au total)
- Génération automatique d'un lien de partage et d'une clé d'accès
- Option de paiement pour le téléchargement (intégration Stripe)
- Téléchargement de fichiers individuels ou en archive ZIP
- Gestion de l'expiration des liens
- Suivi du nombre de téléchargements

## Schéma GraphQL

### Types

```graphql
enum FileTransferStatus {
  ACTIVE
  EXPIRED
  DELETED
}

type File {
  id: ID!
  filename: String!
  originalFilename: String!
  mimeType: String!
  size: Int!
  filePath: String!
  downloadUrl: String
}

type FileTransfer {
  id: ID!
  userId: ID!
  files: [File!]!
  totalSize: Int!
  shareLink: String!
  accessKey: String!
  expiryDate: Date!
  status: FileTransferStatus!
  requiresPayment: Boolean!
  paymentAmount: Float
  paymentCurrency: String
  isPaid: Boolean!
  paymentSessionId: String
  paymentSessionUrl: String
  downloadCount: Int!
  createdAt: Date!
  updatedAt: Date!
  zipDownloadUrl: String
}
```

### Requêtes

```graphql
# Obtenir tous les transferts de fichiers de l'utilisateur connecté
myFileTransfers: [FileTransfer!]!

# Obtenir un transfert de fichiers par son ID
fileTransferById(id: ID!): FileTransfer

# Obtenir un transfert de fichiers par son lien de partage et sa clé d'accès
getFileTransferByLink(shareLink: String!, accessKey: String!): FileTransfer
```

### Mutations

```graphql
# Créer un nouveau transfert de fichiers
createFileTransfer(
  files: [Upload!]!
  expiryDays: Int
  requiresPayment: Boolean
  paymentAmount: Float
  paymentCurrency: String
): FileTransferResponse!

# Supprimer un transfert de fichiers
deleteFileTransfer(id: ID!): Boolean!

# Générer un lien de paiement pour un transfert de fichiers
generateFileTransferPaymentLink(id: ID!): FileTransferPaymentResponse!
```

## Endpoints REST

En plus des opérations GraphQL, l'API expose les endpoints REST suivants :

### Téléchargement de fichiers

- **GET** `/api/file-transfers/:fileId/download?shareLink=xxx&accessKey=yyy`
  - Télécharge un fichier individuel
  - Requiert le lien de partage et la clé d'accès valides
  - Vérifie si le paiement est requis et effectué

- **GET** `/api/file-transfers/:transferId/download-all?shareLink=xxx&accessKey=yyy`
  - Télécharge tous les fichiers en une archive ZIP
  - Requiert le lien de partage et la clé d'accès valides
  - Vérifie si le paiement est requis et effectué

### Webhooks Stripe

- **POST** `/api/file-transfers/stripe-webhook`
  - Webhook pour les événements Stripe liés aux transferts de fichiers
  - Traite les paiements réussis et met à jour le statut du transfert

## Exemples d'utilisation

### Créer un transfert de fichiers

```javascript
const CREATE_FILE_TRANSFER = gql`
  mutation CreateFileTransfer(
    $files: [Upload!]!
    $expiryDays: Int
    $requiresPayment: Boolean
    $paymentAmount: Float
    $paymentCurrency: String
  ) {
    createFileTransfer(
      files: $files
      expiryDays: $expiryDays
      requiresPayment: $requiresPayment
      paymentAmount: $paymentAmount
      paymentCurrency: $paymentCurrency
    ) {
      fileTransfer {
        id
        shareLink
        accessKey
        expiryDate
        requiresPayment
        paymentAmount
        paymentCurrency
      }
      shareLink
      accessKey
    }
  }
`;

// Utilisation avec Apollo Client
const [createFileTransfer, { loading, error, data }] = useMutation(CREATE_FILE_TRANSFER);

// Exemple d'appel
createFileTransfer({
  variables: {
    files: [file1, file2], // Objets File du navigateur
    expiryDays: 7,
    requiresPayment: true,
    paymentAmount: 5.99,
    paymentCurrency: "EUR"
  }
});
```

### Récupérer un transfert par lien et clé

```javascript
const GET_FILE_TRANSFER = gql`
  query GetFileTransfer($shareLink: String!, $accessKey: String!) {
    getFileTransferByLink(shareLink: $shareLink, accessKey: $accessKey) {
      id
      files {
        id
        filename
        originalFilename
        size
        mimeType
        downloadUrl
      }
      requiresPayment
      isPaid
      paymentAmount
      paymentCurrency
      paymentSessionUrl
      expiryDate
      status
    }
  }
`;

// Utilisation avec Apollo Client
const { loading, error, data } = useQuery(GET_FILE_TRANSFER, {
  variables: {
    shareLink: "lien-partage-unique",
    accessKey: "cle-acces-secrete"
  }
});
```

## Limitations et considérations

- Taille maximale totale des fichiers : 100GB
- Taille maximale par fichier : 10GB
- Nombre maximum de fichiers par transfert : 20
- Les fichiers sont stockés dans `public/uploads/file-transfers/{userId}`
- Les transferts expirés ne sont pas automatiquement supprimés du système de fichiers

## Variables d'environnement requises

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
API_URL=http://localhost:4000
FRONTEND_URL=http://localhost:3000
```

## Intégration frontend

Pour l'intégration frontend, utilisez les composants suivants :

- Formulaire d'upload avec gestion de la progression
- Page de téléchargement accessible via le lien de partage
- Interface de paiement Stripe si nécessaire
- Affichage des métadonnées des fichiers (taille, type, etc.)

Le design doit respecter la charte graphique de Newbi avec la couleur primaire #5b50ff.
