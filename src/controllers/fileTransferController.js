const path = require('path');
const fs = require('fs');
const FileTransfer = require('../models/FileTransfer');
const { createZipArchive } = require('../utils/fileTransferUtils');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Webhook Stripe pour les paiements
exports.handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  
  let event;
  
  try {
    // Vérifier la signature du webhook
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Erreur de signature du webhook Stripe:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  // Gérer l'événement de paiement réussi
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    try {
      // Récupérer les métadonnées
      const { fileTransferId } = session.metadata;
      
      // Mettre à jour le transfert de fichiers
      const fileTransfer = await FileTransfer.findById(fileTransferId);
      
      if (fileTransfer) {
        await fileTransfer.markAsPaid(session.id);
        // Webhook Stripe reçu pour le transfert de fichiers
      } else {
        // Transfert de fichiers non trouvé
      }
    } catch (error) {
      // Erreur lors du traitement du paiement
    }
  }
  
  // Répondre pour confirmer la réception
  res.status(200).json({ received: true });
};

// Télécharger un fichier individuel
exports.downloadFile = async (req, res) => {
  try {
    const { shareLink, accessKey, fileId } = req.params;
    
    // Vérifier le transfert de fichiers
    const fileTransfer = await FileTransfer.findOne({ 
      shareLink,
      accessKey,
      status: 'active'
    });
    
    if (!fileTransfer) {
      return res.status(404).send('Transfert de fichiers non trouvé ou expiré');
    }
    
    // Vérifier si le transfert est accessible
    if (!fileTransfer.isAccessible()) {
      return res.status(403).send('Accès refusé. Le paiement est requis ou le transfert a expiré.');
    }
    
    // Trouver le fichier demandé
    const file = fileTransfer.files.find(f => f._id.toString() === fileId);
    
    if (!file) {
      return res.status(404).send('Fichier non trouvé');
    }
    
    // Construire le chemin du fichier
    const filePath = path.join(process.cwd(), 'public', file.filePath);
    
    // Vérifier si le fichier existe
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('Fichier non trouvé sur le serveur');
    }
    
    // Incrémenter le compteur de téléchargements
    await fileTransfer.incrementDownloadCount();
    
    // Envoyer le fichier
    res.download(filePath, file.originalName);
  } catch (error) {
    console.error('Erreur lors du téléchargement du fichier:', error);
    res.status(500).send('Une erreur est survenue lors du téléchargement du fichier');
  }
};

// Télécharger tous les fichiers en tant qu'archive ZIP
exports.downloadAllFiles = async (req, res) => {
  try {
    const { shareLink, accessKey } = req.params;
    
    // Vérifier le transfert de fichiers
    const fileTransfer = await FileTransfer.findOne({ 
      shareLink,
      accessKey,
      status: 'active'
    });
    
    if (!fileTransfer) {
      return res.status(404).send('Transfert de fichiers non trouvé ou expiré');
    }
    
    // Vérifier si le transfert est accessible
    if (!fileTransfer.isAccessible()) {
      return res.status(403).send('Accès refusé. Le paiement est requis ou le transfert a expiré.');
    }
    
    // Créer une archive ZIP des fichiers
    const archivePath = await createZipArchive(fileTransfer.files, fileTransfer.userId);
    
    // Construire le chemin de l'archive
    const fullArchivePath = path.join(process.cwd(), 'public', archivePath);
    
    // Vérifier si l'archive existe
    if (!fs.existsSync(fullArchivePath)) {
      return res.status(500).send('Erreur lors de la création de l\'archive');
    }
    
    // Incrémenter le compteur de téléchargements
    await fileTransfer.incrementDownloadCount();
    
    // Envoyer l'archive
    res.download(fullArchivePath, `files-${Date.now()}.zip`, (err) => {
      if (err) {
        console.error('Erreur lors de l\'envoi de l\'archive:', err);
      } else {
        // Supprimer l'archive après le téléchargement (optionnel)
        setTimeout(() => {
          fs.unlink(fullArchivePath, (err) => {
            if (err) console.error('Erreur lors de la suppression de l\'archive temporaire:', err);
          });
        }, 60000); // Attendre 1 minute avant de supprimer
      }
    });
  } catch (error) {
    console.error('Erreur lors du téléchargement des fichiers:', error);
    res.status(500).send('Une erreur est survenue lors du téléchargement des fichiers');
  }
};

// Valider un paiement
exports.validatePayment = async (req, res) => {
  try {
    const { shareLink, accessKey, sessionId } = req.query;
    
    if (!sessionId) {
      return res.status(400).send('ID de session manquant');
    }
    
    // Vérifier la session de paiement
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    
    if (session.payment_status !== 'paid') {
      return res.status(400).send('Le paiement n\'a pas été effectué');
    }
    
    // Vérifier le transfert de fichiers
    const fileTransfer = await FileTransfer.findOne({ 
      shareLink,
      accessKey,
      status: 'active',
      isPaymentRequired: true
    });
    
    if (!fileTransfer) {
      return res.status(404).send('Transfert de fichiers non trouvé');
    }
    
    // Marquer comme payé si ce n'est pas déjà fait
    if (!fileTransfer.isPaid) {
      await fileTransfer.markAsPaid(sessionId);
    }
    
    // Rediriger vers la page de téléchargement
    res.redirect(`/file-transfer/download?share=${shareLink}&key=${accessKey}`);
  } catch (error) {
    console.error('Erreur lors de la validation du paiement:', error);
    res.status(500).send('Une erreur est survenue lors de la validation du paiement');
  }
};
