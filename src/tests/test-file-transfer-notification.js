import { sendFileTransferPaymentNotification } from '../utils/mailer.js';

/**
 * Script de test pour la notification de paiement de transfert de fichiers
 * Ce script teste l'envoi d'email sans avoir besoin d'un vrai webhook Stripe
 */

const testFileTransferNotification = async () => {
  console.log('🧪 Test de la notification de paiement de transfert de fichiers...\n');

  // Données de test simulant un paiement réel
  const testPaymentData = {
    buyerEmail: 'client.test@example.com',
    paidAmount: 25.00,
    currency: 'eur',
    files: [
      {
        originalName: 'document-important.pdf',
        displayName: 'Document Important',
        size: 2048576 // 2MB
      },
      {
        originalName: 'presentation.pptx',
        displayName: 'Présentation Client',
        size: 5242880 // 5MB
      },
      {
        originalName: 'contrat-signe.pdf',
        displayName: 'Contrat Signé',
        size: 1048576 // 1MB
      }
    ],
    transferId: '507f1f77bcf86cd799439011',
    paymentDate: new Date()
  };

  const senderEmail = 'expediteur.test@example.com';

  try {
    console.log('📧 Envoi de l\'email de notification...');
    console.log(`   Expéditeur: ${senderEmail}`);
    console.log(`   Client: ${testPaymentData.buyerEmail}`);
    console.log(`   Montant: ${testPaymentData.paidAmount}${testPaymentData.currency.toUpperCase()}`);
    console.log(`   Fichiers: ${testPaymentData.files.length} fichier(s)`);
    console.log('');

    const result = await sendFileTransferPaymentNotification(senderEmail, testPaymentData);

    if (result) {
      console.log('✅ Email envoyé avec succès !');
      console.log('');
      console.log('📋 Détails de l\'email:');
      console.log(`   - Destinataire: ${senderEmail}`);
      console.log(`   - Sujet: 💰 Paiement reçu pour votre transfert de fichiers - ${testPaymentData.paidAmount}${testPaymentData.currency.toUpperCase()}`);
      console.log(`   - Contenu: Email HTML avec détails du paiement`);
      console.log('');
      console.log('🎯 Le système de notification fonctionne correctement !');
    } else {
      console.log('❌ Échec de l\'envoi de l\'email');
      console.log('Vérifiez la configuration SMTP dans les variables d\'environnement');
    }

  } catch (error) {
    console.error('❌ Erreur lors du test:', error.message);
    console.log('');
    console.log('🔧 Points à vérifier:');
    console.log('   - Configuration SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS)');
    console.log('   - Variable FRONTEND_URL pour les liens dans l\'email');
    console.log('   - Connexion réseau pour l\'envoi d\'emails');
  }
};

// Exécuter le test si le script est lancé directement
if (import.meta.url === `file://${process.argv[1]}`) {
  testFileTransferNotification();
}

export { testFileTransferNotification };
