const { createTestClient } = require('apollo-server-testing');
const { ApolloServer, gql } = require('apollo-server-express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const typeDefs = require('../schemas');
const resolvers = require('../resolvers');
const FileTransfer = require('../models/FileTransfer');
const User = require('../models/User');

// Requêtes et mutations GraphQL pour les tests
const MY_FILE_TRANSFERS = gql`
  query MyFileTransfers {
    myFileTransfers {
      id
      shareLink
      accessKey
      expiryDate
      status
      requiresPayment
      paymentAmount
      paymentCurrency
      isPaid
      downloadCount
      createdAt
      files {
        id
        filename
        originalFilename
        mimeType
        size
        downloadUrl
      }
    }
  }
`;

const FILE_TRANSFER_BY_ID = gql`
  query FileTransferById($id: ID!) {
    fileTransferById(id: $id) {
      id
      shareLink
      accessKey
      expiryDate
      status
      requiresPayment
      isPaid
      downloadCount
    }
  }
`;

const FILE_TRANSFER_BY_LINK = gql`
  query GetFileTransferByLink($shareLink: String!, $accessKey: String!) {
    getFileTransferByLink(shareLink: $shareLink, accessKey: $accessKey) {
      id
      shareLink
      accessKey
      expiryDate
      status
      requiresPayment
      paymentAmount
      paymentCurrency
      isPaid
      files {
        id
        filename
        originalFilename
        mimeType
        size
        downloadUrl
      }
    }
  }
`;

const DELETE_FILE_TRANSFER = gql`
  mutation DeleteFileTransfer($id: ID!) {
    deleteFileTransfer(id: $id)
  }
`;

const GENERATE_PAYMENT_LINK = gql`
  mutation GenerateFileTransferPaymentLink($id: ID!) {
    generateFileTransferPaymentLink(id: $id) {
      fileTransfer {
        id
        isPaid
        paymentSessionId
        paymentSessionUrl
      }
      paymentSessionUrl
    }
  }
`;

// Fonction pour exécuter les tests
async function runTests() {
  // Créer un utilisateur de test si nécessaire
  let testUser = await User.findOne({ email: 'test@newbi.fr' });
  
  if (!testUser) {
    testUser = new User({
      email: 'test@newbi.fr',
      password: 'password123',
      firstName: 'Test',
      lastName: 'User',
      role: 'admin'
    });
    
    await testUser.save();
  }
  
  // Configurer le serveur Apollo pour les tests
  const server = new ApolloServer({
    typeDefs,
    resolvers,
    context: () => ({
      user: testUser
    })
  });
  
  const { query, mutate } = createTestClient(server);
  
  // Test 1: Récupérer les transferts de fichiers de l'utilisateur
  try {
    const { data: fileTransfersData } = await query({
      query: MY_FILE_TRANSFERS
    });
    
    // Utiliser des commentaires au lieu de console.log pour éviter les erreurs de lint
    // Transferts de fichiers de l'utilisateur
    console.log(fileTransfersData ? 'Transferts récupérés avec succès' : 'Aucun transfert trouvé');
  } catch (error) {
    // Erreur lors de la récupération des transferts de fichiers
    console.error('Erreur API:', error.message);
  }
  
  // Test 2: Récupérer un transfert de fichiers par son ID (si des transferts existent)
  const existingTransfer = await FileTransfer.findOne({ userId: testUser._id });
  
  if (existingTransfer) {
    try {
      const { data: fileTransferData } = await query({
        query: FILE_TRANSFER_BY_ID,
        variables: { id: existingTransfer._id.toString() }
      });
      
      // Transfert de fichiers par ID
      console.log(fileTransferData ? 'Transfert par ID récupéré' : 'Transfert non trouvé');
    } catch (error) {
      // Erreur lors de la récupération du transfert de fichiers par ID
      console.error('Erreur API:', error.message);
    }
    
    // Test 3: Récupérer un transfert de fichiers par son lien et sa clé d'accès
    try {
      const { data: fileTransferByLinkData } = await query({
        query: FILE_TRANSFER_BY_LINK,
        variables: { 
          shareLink: existingTransfer.shareLink,
          accessKey: existingTransfer.accessKey
        }
      });
      
      // Transfert de fichiers par lien et clé
      console.log(fileTransferByLinkData ? 'Transfert par lien récupéré' : 'Transfert non trouvé');
    } catch (error) {
      // Erreur lors de la récupération du transfert de fichiers par lien
      console.error('Erreur API:', error.message);
    }
    
    // Test 4: Générer un lien de paiement pour un transfert de fichiers
    if (existingTransfer.requiresPayment && !existingTransfer.isPaid) {
      try {
        const { data: paymentLinkData } = await mutate({
          mutation: GENERATE_PAYMENT_LINK,
          variables: { id: existingTransfer._id.toString() }
        });
        
        // Lien de paiement généré
        console.log(paymentLinkData ? 'Lien de paiement généré' : 'Échec génération lien');
      } catch (error) {
        // Erreur lors de la génération du lien de paiement
        console.error('Erreur API:', error.message);
      }
    }
    
    // Test 5: Supprimer un transfert de fichiers
    try {
      const { data: deleteData } = await mutate({
        mutation: DELETE_FILE_TRANSFER,
        variables: { id: existingTransfer._id.toString() }
      });
      
      // Transfert de fichiers supprimé
      console.log(deleteData ? 'Transfert supprimé' : 'Échec suppression');
    } catch (error) {
      // Erreur lors de la suppression du transfert de fichiers
      console.error('Erreur API:', error.message);
    }
  } else {
    // Aucun transfert de fichiers existant pour les tests
    console.log('Aucun transfert existant');
  }
}

// Exécuter les tests
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    // Connecté à MongoDB pour les tests
    console.log('Connexion DB OK');
    return runTests();
  })
  .then(() => {
    // Tests terminés
    console.log('Tests terminés');
    process.exit(0);
  })
  .catch(error => {
    // Erreur lors des tests
    console.error('Erreur test:', error.message);
    process.exit(1);
  });
