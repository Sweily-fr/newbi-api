/**
 * Types GraphQL pour l'upload d'images vers Cloudflare
 */

import { gql } from 'apollo-server-express';

const imageUploadTypeDefs = gql`
  scalar Upload

  type ImageUploadResult {
    success: Boolean!
    key: String
    url: String
    contentType: String
    message: String
  }

  type ImageUrlResult {
    success: Boolean!
    key: String
    url: String
    message: String
  }

  type ImageDeleteResult {
    success: Boolean!
    message: String
  }

  type SignedUrlResult {
    success: Boolean!
    url: String
    expiresIn: Int
    message: String
  }

  enum ImageType {
    PROFILE
    COMPANY
  }

  extend type Query {
    """
    Récupère l'URL publique d'une image stockée sur Cloudflare
    """
    getImageUrl(key: String!): ImageUrlResult!
  }

  extend type Mutation {
    """
    Upload une image de signature vers Cloudflare R2
    """
    uploadSignatureImage(
      file: Upload!
      imageType: String = "profile"
    ): ImageUploadResult!

    """
    Supprime une image de signature de Cloudflare R2
    """
    deleteSignatureImage(key: String!): ImageDeleteResult!

    """
    Génère une URL signée temporaire pour accès privé à une image
    """
    generateSignedImageUrl(
      key: String!
      expiresIn: Int = 3600
    ): SignedUrlResult!
  }
`;

export default imageUploadTypeDefs;
