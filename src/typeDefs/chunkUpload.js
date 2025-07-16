import { gql } from 'apollo-server-express';

export default gql`
  # Types pour l'upload de fichiers en chunks
  type ChunkUploadResponse {
    chunkReceived: Boolean!
    fileCompleted: Boolean!
    fileId: String!
    fileName: String
    filePath: String
    fileTransferId: String
  }

  extend type Mutation {
    # Uploader un chunk de fichier
    uploadFileChunk(
      chunk: Upload!
      fileId: String!
      chunkIndex: Int!
      totalChunks: Int!
      fileName: String!
      fileSize: Int!
    ): ChunkUploadResponse!
    
    # Créer un transfert de fichier à partir des IDs de fichiers déjà uploadés en chunks
    createFileTransferWithIds(
      fileIds: [String!]!
      input: FileTransferInput
    ): FileTransferResponse!
  }
`;
