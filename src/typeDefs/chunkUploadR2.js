import { gql } from 'apollo-server-express';

export default gql`
  type ChunkUploadR2Result {
    chunkReceived: Boolean!
    fileCompleted: Boolean!
    fileId: String!
    fileName: String
    filePath: String
    fileTransferId: String
    storageType: String!
  }

  type FileUploadR2Result {
    fileId: String!
    fileName: String!
    filePath: String!
    r2Key: String!
    size: Int!
    mimeType: String!
    storageType: String!
  }

  input Base64FileInputR2 {
    name: String!
    type: String!
    size: Int!
    base64: String!
  }

  type PresignedUploadUrl {
    chunkIndex: Int!
    uploadUrl: String!
    key: String!
  }

  type PresignedUploadUrlsResponse {
    fileId: String!
    transferId: String!
    uploadUrls: [PresignedUploadUrl!]!
    expiresIn: Int!
  }

  extend type Mutation {
    # Générer des URLs signées pour upload direct vers R2
    generatePresignedUploadUrls(
      fileId: String!
      totalChunks: Int!
      fileName: String!
    ): PresignedUploadUrlsResponse!

    # Confirmer qu'un chunk a été uploadé directement vers R2
    confirmChunkUploadedToR2(
      fileId: String!
      chunkIndex: Int!
      totalChunks: Int!
      fileName: String!
      fileSize: Int!
    ): ChunkUploadR2Result!

    # Upload d'un chunk vers Cloudflare R2
    uploadFileChunkToR2(
      chunk: Upload!
      fileId: String!
      chunkIndex: Int!
      totalChunks: Int!
      fileName: String!
      fileSize: Int!
    ): ChunkUploadR2Result!

    # Créer un transfert à partir d'IDs de fichiers R2
    createFileTransferWithIdsR2(
      fileIds: [String!]!
      input: FileTransferInput
    ): FileTransferResponse!

    # Upload direct d'un fichier vers R2
    uploadFileDirectToR2(
      file: Upload!
      transferId: String
    ): FileUploadR2Result!

    # Upload d'un fichier base64 vers R2
    uploadBase64FileToR2(
      fileInput: Base64FileInputR2!
      transferId: String
    ): FileUploadR2Result!
  }
`;
