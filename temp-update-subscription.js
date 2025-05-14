// Script temporaire pour mettre à jour les champs de souscription de l'utilisateur
const { MongoClient } = require('mongodb');

async function updateUserSubscription() {
  // Connexion à MongoDB
  const client = new MongoClient('mongodb://localhost:27017/invoice-app');
  
  try {
    await client.connect();
    console.log('Connecté à MongoDB');
    
    const db = client.db('invoice-app');
    const usersCollection = db.collection('users');
    
    // Mettre à jour les champs licence et trial à true dans l'objet subscription
    const result = await usersCollection.updateOne(
      { email: 'sofiane.mtimet6@gmail.com' },
      { $set: { 
        'subscription.licence': true,
        'subscription.trial': true
      }}
    );
    
    if (result.modifiedCount === 1) {
      console.log('Les champs de souscription ont été mis à jour avec succès');
    } else {
      console.log('Aucune modification n\'a été effectuée');
    }
    
    // Vérifier que la mise à jour a bien été effectuée
    const updatedUser = await usersCollection.findOne({ email: 'sofiane.mtimet6@gmail.com' });
    console.log('Statut de souscription:', updatedUser.subscription);
    
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await client.close();
    console.log('Déconnecté de MongoDB');
  }
}

// Exécuter la fonction
updateUserSubscription();
