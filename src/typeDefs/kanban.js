const { gql } = require('apollo-server-express');

const kanbanTypeDefs = gql`
  # Types pour les commentaires
  type Comment {
    id: ID!
    content: String!
    createdBy: User!
    createdAt: DateTime!
  }

  input CommentInput {
    content: String!
  }

  # Types pour les pièces jointes
  type Attachment {
    id: ID!
    name: String!
    url: String!
    type: String!
  }

  input AttachmentInput {
    name: String!
    url: String!
    type: String!
  }

  # Types pour les tâches
  type Task {
    id: ID!
    title: String!
    description: String
    status: String!
    order: Int!
    dueDate: DateTime
    labels: [String]
    assignedTo: User
    comments: [Comment]
    attachments: [Attachment]
    createdBy: User!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input TaskInput {
    title: String!
    description: String
    status: String!
    order: Int
    dueDate: DateTime
    labels: [String]
    assignedTo: ID
    attachments: [AttachmentInput]
  }

  input TaskUpdateInput {
    title: String
    description: String
    status: String
    order: Int
    dueDate: DateTime
    labels: [String]
    assignedTo: ID
  }

  # Types pour les colonnes
  type Column {
    id: ID!
    title: String!
    order: Int!
    tasks: [Task]!
  }

  input ColumnInput {
    title: String!
    order: Int
    tasks: [TaskInput]
  }

  input ColumnUpdateInput {
    title: String
    order: Int
  }

  # Types pour le tableau Kanban
  type KanbanBoard {
    id: ID!
    title: String!
    description: String
    columns: [Column]!
    members: [User]
    createdBy: User!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  input KanbanBoardInput {
    title: String!
    description: String
    members: [ID]
  }

  input KanbanBoardUpdateInput {
    title: String
    description: String
    members: [ID]
  }

  # Pagination pour les tableaux Kanban
  type KanbanBoardsResponse {
    boards: [KanbanBoard]!
    totalCount: Int!
    hasNextPage: Boolean!
  }

  # Étendre les types de requêtes et mutations existants
  extend type Query {
    # Récupérer un tableau Kanban par son ID
    kanbanBoard(id: ID!): KanbanBoard

    # Récupérer tous les tableaux Kanban de l'utilisateur
    kanbanBoards(page: Int, limit: Int): KanbanBoardsResponse

    # Récupérer une tâche spécifique
    kanbanTask(boardId: ID!, taskId: ID!): Task
  }

  extend type Mutation {
    # Créer un nouveau tableau Kanban
    createKanbanBoard(input: KanbanBoardInput!): KanbanBoard!

    # Mettre à jour un tableau Kanban
    updateKanbanBoard(id: ID!, input: KanbanBoardUpdateInput!): KanbanBoard!

    # Supprimer un tableau Kanban
    deleteKanbanBoard(id: ID!): Boolean!

    # Ajouter une colonne à un tableau Kanban
    addKanbanColumn(boardId: ID!, input: ColumnInput!): KanbanBoard!

    # Mettre à jour une colonne
    updateKanbanColumn(boardId: ID!, columnId: ID!, input: ColumnUpdateInput!): KanbanBoard!

    # Supprimer une colonne
    deleteKanbanColumn(boardId: ID!, columnId: ID!): KanbanBoard!

    # Réorganiser les colonnes
    reorderKanbanColumns(boardId: ID!, columnIds: [ID!]!): KanbanBoard!

    # Ajouter une tâche à une colonne
    addKanbanTask(boardId: ID!, columnId: ID!, input: TaskInput!): KanbanBoard!

    # Mettre à jour une tâche
    updateKanbanTask(boardId: ID!, taskId: ID!, input: TaskUpdateInput!): KanbanBoard!

    # Supprimer une tâche
    deleteKanbanTask(boardId: ID!, taskId: ID!): KanbanBoard!

    # Déplacer une tâche entre colonnes
    moveKanbanTask(boardId: ID!, taskId: ID!, sourceColumnId: ID!, targetColumnId: ID!, order: Int!): KanbanBoard!

    # Ajouter un commentaire à une tâche
    addKanbanTaskComment(boardId: ID!, taskId: ID!, input: CommentInput!): Task!

    # Supprimer un commentaire d'une tâche
    deleteKanbanTaskComment(boardId: ID!, taskId: ID!, commentId: ID!): Task!
  }
`;

module.exports = kanbanTypeDefs;
