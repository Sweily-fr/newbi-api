const { gql } = require('apollo-server-express');

module.exports = gql`
  # Types pour le transfert de fichiers
  type File {
    id: ID
    originalName: String
    fileName: String
    filePath: String
    mimeType: String
    size: Float
    uploadDate: DateTime
  }

  type FileTransfer {
    id: ID!
    userId: ID
    files: [File]
    totalSize: Float
    shareLink: String
    accessKey: String
    expiryDate: DateTime
    downloadCount: Int
    lastDownloadDate: DateTime
    isPaymentRequired: Boolean
    paymentAmount: Float
    paymentCurrency: String
    isPaid: Boolean
    paymentId: String
    paymentDate: DateTime
    status: FileTransferStatus
    recipientEmail: String
    notificationSent: Boolean
    createdAt: DateTime
    updatedAt: DateTime
  }

  enum FileTransferStatus {
    active
    expired
    deleted
  }

  type FileTransferPaymentInfo {
    isPaymentRequired: Boolean
    paymentAmount: Float
    paymentCurrency: String
    isPaid: Boolean
    checkoutUrl: String
  }

  type FileTransferInfo {
    id: ID!
    files: [File]
    totalSize: Float
    expiryDate: DateTime
    paymentInfo: FileTransferPaymentInfo
    isAccessible: Boolean
  }

  type FileTransferCreationResponse {
    success: Boolean
    message: String
    fileTransfer: FileTransfer
    shareLink: String
    accessKey: String
  }

  type FileTransferAccessResponse {
    success: Boolean
    message: String
    fileTransfer: FileTransferInfo
  }

  type FileTransferPaymentResponse {
    success: Boolean
    message: String
    checkoutUrl: String
  }

  # Inputs pour le transfert de fichiers
  input FileTransferInput {
    expiryDays: Int
    isPaymentRequired: Boolean = false
    paymentAmount: Float = 0
    paymentCurrency: String = "EUR"
    recipientEmail: String
  }

  # Type pour la réponse paginée des transferts de fichiers
  type FileTransferPaginatedResponse {
    items: [FileTransfer!]!
    totalItems: Int!
    currentPage: Int!
    totalPages: Int!
    hasNextPage: Boolean!
  }

  # Requêtes et mutations
  extend type Query {
    # Obtenir les transferts de fichiers de l'utilisateur connecté avec pagination
    myFileTransfers(page: Int = 1, limit: Int = 10): FileTransferPaginatedResponse!
    
    # Obtenir les informations d'un transfert de fichiers par son ID
    fileTransferById(id: ID!): FileTransfer
    
    # Obtenir les informations d'un transfert de fichiers par son lien de partage et sa clé d'accès
    getFileTransferByLink(shareLink: String!, accessKey: String!): FileTransferAccessResponse
  }

  # Input pour un fichier en base64
  input Base64FileInput {
    name: String!
    type: String!
    size: Float!
    base64: String!
  }

  extend type Mutation {
    # Créer un nouveau transfert de fichiers
    createFileTransfer(files: [Upload!]!, input: FileTransferInput): FileTransferCreationResponse
    
    # Créer un nouveau transfert de fichiers avec des fichiers en base64
    createFileTransferBase64(files: [Base64FileInput!]!, input: FileTransferInput): FileTransferCreationResponse
    
    # Supprimer un transfert de fichiers
    deleteFileTransfer(id: ID!): Boolean
    
    # Générer un lien de paiement pour un transfert de fichiers
    generateFileTransferPaymentLink(shareLink: String!, accessKey: String!): FileTransferPaymentResponse
  }
`;
