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
    
    # Réseaux sociaux
    socialNetworks: SocialNetworks
    socialColors: SocialColors
    customSocialIcons: CustomSocialIcons
    
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
    orientation: String
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
    detailedSpacing: Boolean!
    
    # Typographie
    fontFamily: String!
    fontSize: FontSizes!
    typography: DetailedTypography!
    
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
    logoToSocial: Int!
    verticalSeparatorLeft: Int!
    verticalSeparatorRight: Int!
  }

  type SocialNetworks {
    facebook: String
    instagram: String
    linkedin: String
    x: String
  }

  type SocialColors {
    facebook: String
    instagram: String
    linkedin: String
    x: String
  }

  type CustomSocialIcons {
    facebook: String
    instagram: String
    linkedin: String
    x: String
  }

  type TypographyField {
    fontFamily: String!
    fontSize: Int!
    color: String!
    fontWeight: String!
    fontStyle: String
    textDecoration: String
  }

  type DetailedTypography {
    fullName: TypographyField!
    position: TypographyField!
    company: TypographyField!
    email: TypographyField!
    phone: TypographyField!
    mobile: TypographyField!
    website: TypographyField!
    address: TypographyField!
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
    
    # Réseaux sociaux
    socialNetworks: SocialNetworksInput
    socialColors: SocialColorsInput
    customSocialIcons: CustomSocialIconsInput
    
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
    orientation: String
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
    detailedSpacing: Boolean
    
    # Typographie
    fontFamily: String
    fontSize: FontSizesInput
    typography: DetailedTypographyInput
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
    logoToSocial: Int
    verticalSeparatorLeft: Int
    verticalSeparatorRight: Int
  }

  input FontSizesInput {
    name: Int
    position: Int
    contact: Int
  }

  input SocialNetworksInput {
    facebook: String
    instagram: String
    linkedin: String
    x: String
  }

  input SocialColorsInput {
    facebook: String
    instagram: String
    linkedin: String
    x: String
  }

  input CustomSocialIconsInput {
    facebook: String
    instagram: String
    linkedin: String
    x: String
  }

  input TypographyFieldInput {
    fontFamily: String
    fontSize: Int
    color: String
    fontWeight: String
    fontStyle: String
    textDecoration: String
  }

  input DetailedTypographyInput {
    fullName: TypographyFieldInput
    position: TypographyFieldInput
    company: TypographyFieldInput
    email: TypographyFieldInput
    phone: TypographyFieldInput
    mobile: TypographyFieldInput
    website: TypographyFieldInput
    address: TypographyFieldInput
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
    
    # Réseaux sociaux
    socialNetworks: SocialNetworksInput
    socialColors: SocialColorsInput
    customSocialIcons: CustomSocialIconsInput
    
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
    orientation: String
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
    detailedSpacing: Boolean
    
    # Typographie
    fontFamily: String
    fontSize: FontSizesInput
    typography: DetailedTypographyInput
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
