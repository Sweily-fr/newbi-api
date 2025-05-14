// Script temporaire pour mettre à jour le mot de passe de l'utilisateur avec chiffrement AES-CBC
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const CryptoJS = require('crypto-js');

async function updateUserPassword() {
  // Connexion à MongoDB
  const client = new MongoClient('mongodb://localhost:27017/invoice-app');
  
  try {
    await client.connect();
    console.log('Connecté à MongoDB');
    
    const db = client.db('invoice-app');
    const usersCollection = db.collection('users');
    
    // Mot de passe en clair
    const clearPassword = 'Mama_91322';
    
    // Hachage du mot de passe avec bcrypt pour le stockage en base de données
    // C'est ce que le backend fait après avoir déchiffré le mot de passe envoyé par le frontend
    const hashedPassword = await bcrypt.hash(clearPassword, 10);
    
    // Mettre à jour le mot de passe de l'utilisateur
    const result = await usersCollection.updateOne(
      { email: 'sofiane.mtimet6@gmail.com' },
      { $set: { 
        password: hashedPassword,
        isEmailVerified: true 
      }}
    );
    
    if (result.modifiedCount === 1) {
      console.log('Le mot de passe a été mis à jour avec succès');
    } else {
      console.log('Aucune modification n\'a été effectuée');
    }
    
    // Maintenant, générons le mot de passe chiffré comme le ferait le frontend
    // pour vous montrer comment il devrait être envoyé lors de la connexion
    
    // Clé de chiffrement (la même que dans votre .env)
    const keyRaw = 'newbi-public-key';
    const key = CryptoJS.SHA256(keyRaw); // Clé 256 bits (WordArray)
    
    // Vecteur d'initialisation aléatoire
    const iv = CryptoJS.lib.WordArray.random(16);
    
    // Chiffrer le mot de passe
    const encrypted = CryptoJS.AES.encrypt(clearPassword, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    
    // Convertir IV et texte chiffré en Base64
    const ivStr = CryptoJS.enc.Base64.stringify(iv);
    const cipherTextBase64 = CryptoJS.enc.Base64.stringify(
      encrypted.ciphertext
    );
    
    // Format final: IV:CipherText
    const encryptedPassword = `${ivStr}:${cipherTextBase64}`;
    
    console.log('Mot de passe en clair:', clearPassword);
    console.log('Mot de passe haché (stocké en BDD):', hashedPassword);
    console.log('Mot de passe chiffré (à envoyer depuis le frontend):', encryptedPassword);
    console.log('Pour se connecter, envoyez une mutation GraphQL avec:');
    console.log(JSON.stringify({
      email: 'sofiane.mtimet6@gmail.com',
      password: encryptedPassword,
      rememberMe: true,
      passwordEncrypted: true
    }, null, 2));
    
  } catch (error) {
    console.error('Erreur:', error);
  } finally {
    await client.close();
    console.log('Déconnecté de MongoDB');
  }
}

// Exécuter la fonction
updateUserPassword();
