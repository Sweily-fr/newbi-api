import { gql } from 'apollo-server-express';

const emailSignatureTypeDefs = gql`
  type EmailSignature {
    id: ID!
    signatureName: String!
    isDefault: Boolean!
    
    # Informations personnelles
    firstName: String!
    lastName: String!
    position: String!
    
    # Informations de contact
    email: String!
    phone: String
    mobile: String
    website: String
    address: String
    companyName: String
    
    # Options d'affichage des icônes
    showPhoneIcon: Boolean!
    showMobileIcon: Boolean!
    showEmailIcon: Boolean!
    showAddressIcon: Boolean!
    showWebsiteIcon: Boolean!
    
    # Couleurs
    primaryColor: String!
    colors: SignatureColors!
    
    # Configuration layout
    nameSpacing: Int!
    nameAlignment: String!
    layout: String!
    columnWidths: ColumnWidths!
    
    # Images
    photo: String
    photoKey: String
    logo: String
    logoKey: String
    imageSize: Int!
    imageShape: String!
    logoSize: Int!
    
    # Séparateurs
    separatorVerticalWidth: Int!
    separatorHorizontalWidth: Int!
    
    # Espacements
    spacings: SignatureSpacings!
    
    # Typographie
    fontFamily: String!
    fontSize: FontSizes!
    
    # Métadonnées
    createdBy: ID!
    createdAt: String!
    updatedAt: String!
  }

  type SignatureColors {
    name: String!
    position: String!
    company: String!
    contact: String!
    separatorVertical: String!
    separatorHorizontal: String!
  }

  type ColumnWidths {
    photo: Int!
    content: Int!
  }

  type SignatureSpacings {
    global: Int!
    photoBottom: Int!
    logoBottom: Int!
    nameBottom: Int!
    positionBottom: Int!
    companyBottom: Int!
    contactBottom: Int!
    phoneToMobile: Int!
    mobileToEmail: Int!
    emailToWebsite: Int!
    websiteToAddress: Int!
    separatorTop: Int!
    separatorBottom: Int!
  }

  type FontSizes {
    name: Int!
    position: Int!
    contact: Int!
  }

  input EmailSignatureInput {
    signatureName: String!
    isDefault: Boolean
    
    # Informations personnelles
    firstName: String!
    lastName: String!
    position: String!
    
    # Informations de contact
    email: String!
    phone: String
    mobile: String
    website: String
    address: String
    companyName: String
    
    # Options d'affichage des icônes
    showPhoneIcon: Boolean
    showMobileIcon: Boolean
    showEmailIcon: Boolean
    showAddressIcon: Boolean
    showWebsiteIcon: Boolean
    
    # Couleurs
    primaryColor: String
    colors: SignatureColorsInput
    
    # Configuration layout
    nameSpacing: Int
    nameAlignment: String
    layout: String
    columnWidths: ColumnWidthsInput
    
    # Images
    photo: String
    photoKey: String
    logo: String
    logoKey: String
    imageSize: Int
    imageShape: String
    logoSize: Int
    
    # Séparateurs
    separatorVerticalWidth: Int
    separatorHorizontalWidth: Int
    
    # Espacements
    spacings: SignatureSpacingsInput
    
    # Typographie
    fontFamily: String
    fontSize: FontSizesInput
  }

  input SignatureColorsInput {
    name: String
    position: String
    company: String
    contact: String
    separatorVertical: String
    separatorHorizontal: String
  }

  input ColumnWidthsInput {
    photo: Int
    content: Int
  }

  input SignatureSpacingsInput {
    global: Int
    photoBottom: Int
    logoBottom: Int
    nameBottom: Int
    positionBottom: Int
    companyBottom: Int
    contactBottom: Int
    phoneToMobile: Int
    mobileToEmail: Int
    emailToWebsite: Int
    websiteToAddress: Int
    separatorTop: Int
    separatorBottom: Int
  }

  input FontSizesInput {
    name: Int
    position: Int
    contact: Int
  }

  input UpdateEmailSignatureInput {
    id: ID!
    signatureName: String
    isDefault: Boolean
    
    # Informations personnelles
    firstName: String
    lastName: String
    position: String
    
    # Informations de contact
    email: String
    phone: String
    mobile: String
    website: String
    address: String
    companyName: String
    
    # Options d'affichage des icônes
    showPhoneIcon: Boolean
    showMobileIcon: Boolean
    showEmailIcon: Boolean
    showAddressIcon: Boolean
    showWebsiteIcon: Boolean
    
    # Couleurs
    primaryColor: String
    colors: SignatureColorsInput
    
    # Configuration layout
    nameSpacing: Int
    nameAlignment: String
    layout: String
    columnWidths: ColumnWidthsInput
    
    # Images
    photo: String
    photoKey: String
    logo: String
    logoKey: String
    imageSize: Int
    imageShape: String
    logoSize: Int
    
    # Séparateurs
    separatorVerticalWidth: Int
    separatorHorizontalWidth: Int
    
    # Espacements
    spacings: SignatureSpacingsInput
    
    # Typographie
    fontFamily: String
    fontSize: FontSizesInput
  }

  extend type Query {
    # Récupérer toutes les signatures de l'utilisateur connecté
    getMyEmailSignatures: [EmailSignature!]!
    
    # Récupérer une signature spécifique
    getEmailSignature(id: ID!): EmailSignature
    
    # Récupérer la signature par défaut de l'utilisateur
    getDefaultEmailSignature: EmailSignature
  }

  extend type Mutation {
    # Créer une nouvelle signature
    createEmailSignature(input: EmailSignatureInput!): EmailSignature!
    
    # Mettre à jour une signature existante
    updateEmailSignature(input: UpdateEmailSignatureInput!): EmailSignature!
    
    # Supprimer une signature
    deleteEmailSignature(id: ID!): Boolean!
    
    # Définir une signature comme par défaut
    setDefaultEmailSignature(id: ID!): EmailSignature!
  }
`;

export default emailSignatureTypeDefs;
