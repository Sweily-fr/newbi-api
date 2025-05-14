// Script temporaire pour mettre à jour le statut de vérification d'email de l'utilisateur
const { MongoClient } = require('mongodb');

async function updateUserVerification() {
  // Connexion à MongoDB
  const client = new MongoClient('mongodb://localhost:27017/invoice-app');
  
  try {
    await client.connect();
    console.log('Connecté à MongoDB');
    
    const db = client.db('invoice-app');
    const usersCollection = db.collection('users');
    
    // Mettre à jour le champ isEmailVerified à true
    const result = await usersCollection.updateOne(
      { email: 'sofiane.mtimet6@gmail.com' },
      { $set: { isEmailVerified: true } }
    );
    
    if (result.modifiedCount === 1) {
      console.log('Le champ isEmailVerified a été mis à jour avec succès');
    } else {
      console.log('Aucune modification n\'a été effectuée');
    }
    
    // Vérifier que la mise à jour a bien été effectuée
    const updatedUser = await usersCollection.findOne({ email: 'sofiane.mtimet6@gmail.com' });
    console.log('Statut de vérification d\'email:', updatedUser.isEmailVerified);
    
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await client.close();
    console.log('Déconnecté de MongoDB');
  }
}

// Exécuter la fonction
updateUserVerification();
