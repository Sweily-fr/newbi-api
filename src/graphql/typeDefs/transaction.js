import { gql } from "apollo-server-express";

// NOTE: Ce fichier est DEPRECATED. Les types sont maintenant définis dans:
// - src/schemas/types/banking.graphql (Transaction type et enums)
// - src/schemas/transaction.graphql (Response types et queries legacy)
// Ce fichier n'est plus chargé par le serveur GraphQL.

const transactionTypeDefs = gql`
  # DEPRECATED - See src/schemas/types/banking.graphql
  # Ce fichier n'est plus utilisé, conservé pour référence historique
`;

export default transactionTypeDefs;
