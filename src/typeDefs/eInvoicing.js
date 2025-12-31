import { gql } from "apollo-server-express";

const eInvoicingTypeDefs = gql`
  # === E-INVOICING TYPES ===

  """
  Paramètres de facturation électronique d'une organisation
  """
  type EInvoicingSettings {
    eInvoicingEnabled: Boolean!
    superPdpConfigured: Boolean!
    superPdpWebhookConfigured: Boolean!
    superPdpClientId: String
    superPdpEnvironment: String
    eInvoicingActivatedAt: String
  }

  """
  Statistiques e-invoicing d'une organisation
  """
  type EInvoicingStats {
    NOT_SENT: Int!
    PENDING_VALIDATION: Int!
    VALIDATED: Int!
    SENT_TO_RECIPIENT: Int!
    RECEIVED: Int!
    ACCEPTED: Int!
    REJECTED: Int!
    PAID: Int!
    ERROR: Int!
    totalSent: Int!
    successRate: Float!
  }

  """
  Résultat d'une opération e-invoicing
  """
  type EInvoicingResult {
    success: Boolean!
    message: String
    settings: EInvoicingSettings
  }

  """
  Résultat du test de connexion SuperPDP
  """
  type SuperPdpConnectionResult {
    success: Boolean!
    message: String
    profile: String
  }

  """
  Résultat de l'envoi d'une facture à SuperPDP
  """
  type SendInvoiceResult {
    success: Boolean!
    message: String
    superPdpInvoiceId: String
    status: String
  }

  """
  Résultat de la vérification d'un destinataire
  """
  type RecipientCheckResult {
    success: Boolean!
    canReceiveEInvoices: Boolean!
    pdpName: String
    pdpId: String
    peppolId: String
    error: String
  }

  # === QUERIES ===

  extend type Query {
    """
    Récupérer les paramètres e-invoicing d'une organisation
    """
    eInvoicingSettings(workspaceId: ID!): EInvoicingSettings!

    """
    Récupérer les statistiques e-invoicing d'une organisation
    """
    eInvoicingStats(workspaceId: ID!): EInvoicingStats!
  }

  # === MUTATIONS ===

  extend type Mutation {
    """
    Activer la facturation électronique pour une organisation
    """
    enableEInvoicing(workspaceId: ID!, environment: String): EInvoicingResult!

    """
    Désactiver la facturation électronique pour une organisation
    """
    disableEInvoicing(workspaceId: ID!): EInvoicingResult!

    """
    Tester la connexion à SuperPDP
    """
    testSuperPdpConnection(workspaceId: ID!): SuperPdpConnectionResult!

    """
    Renvoyer une facture à SuperPDP (en cas d'erreur précédente)
    """
    resendInvoiceToSuperPdp(
      workspaceId: ID!
      invoiceId: ID!
    ): SendInvoiceResult!

    """
    Vérifier si un destinataire peut recevoir des factures électroniques
    """
    checkRecipientEInvoicing(
      workspaceId: ID!
      siret: String!
    ): RecipientCheckResult!
  }
`;

export default eInvoicingTypeDefs;
