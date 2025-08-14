import express from 'express';
import crypto from 'crypto';

const router = express.Router();

// Middleware pour capturer le body brut pour la vérification de signature
const rawBodyParser = express.raw({ type: 'application/json' });

// Fonction pour vérifier la signature du webhook Bridge
const verifyBridgeSignature = (payload, signature, secret) => {
  try {
    // Bridge utilise le format "v1=SIGNATURE"
    const actualSignature = signature.startsWith('v1=') ? signature.slice(3) : signature;
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .toUpperCase(); // Bridge utilise des majuscules
    
    console.log('🔐 Vérification signature:');
    console.log('  - Signature reçue:', actualSignature);
    console.log('  - Signature attendue:', expectedSignature);
    console.log('  - Longueurs:', actualSignature.length, 'vs', expectedSignature.length);
    
    // Comparaison simple pour éviter l'erreur de longueur
    return actualSignature.toUpperCase() === expectedSignature;
  } catch (error) {
    console.error('❌ Erreur lors de la vérification de signature:', error);
    return false;
  }
};

// Endpoint webhook Bridge
router.post('/bridge', rawBodyParser, (req, res) => {
  try {
    console.log('🔔 Webhook Bridge reçu !');
    console.log('Headers:', req.headers);
    console.log('Body type:', typeof req.body);
    console.log('Body raw:', req.body);
    
    const signature = req.headers['bridgeapi-signature'];
    const webhookSecret = process.env.BRIDGE_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      console.error('❌ BRIDGE_WEBHOOK_SECRET non configuré');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    
    // Vérifier la signature si elle est présente
    if (signature && webhookSecret) {
      const isValidSignature = verifyBridgeSignature(req.body, signature, webhookSecret);
      if (!isValidSignature) {
        console.error('❌ Signature webhook invalide');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      console.log('✅ Signature webhook valide');
    }
    
    // Parser le JSON selon le type de body
    let payload;
    if (Buffer.isBuffer(req.body)) {
      payload = JSON.parse(req.body.toString());
    } else if (typeof req.body === 'string') {
      payload = JSON.parse(req.body);
    } else {
      // Si c'est déjà un objet, l'utiliser directement
      payload = req.body;
    }
    
    console.log('📦 Payload reçu:', JSON.stringify(payload, null, 2));
    
    // Log des informations importantes
    if (payload.type) {
      console.log(`🎯 Type d'événement: ${payload.type}`);
    }
    
    if (payload.data) {
      console.log('📊 Données:', JSON.stringify(payload.data, null, 2));
    }
    
    if (payload.account) {
      console.log(`🏦 Compte: ${payload.account.name} (${payload.account.id})`);
    }
    
    if (payload.item) {
      console.log(`💳 Item: ${payload.item.id} - ${payload.item.status}`);
    }
    
    // Traitement selon le type d'événement
    switch (payload.type) {
      case 'TEST_EVENT':
        console.log('🧪 Événement de test Bridge reçu avec succès');
        console.log(`🔍 Item ID: ${payload.content?.item_id}`);
        console.log(`🟢 Status: ${payload.content?.status} (${payload.content?.status_code_info})`);
        console.log(`👤 User UUID: ${payload.content?.user_uuid}`);
        break;
      case 'account.connected':
        console.log('✅ Compte connecté avec succès');
        break;
      case 'account.disconnected':
        console.log('❌ Compte déconnecté');
        break;
      case 'item.refreshed':
        console.log('🔄 Données du compte mises à jour');
        break;
      case 'transaction.created':
        console.log('💰 Nouvelle transaction détectée');
        break;
      case 'transaction.updated':
        console.log('📝 Transaction mise à jour');
        break;
      default:
        console.log(`❓ Type d'événement non géré: ${payload.type}`);
    }
    
    // Répondre avec succès
    res.status(200).json({ 
      success: true, 
      message: 'Webhook reçu et traité',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erreur lors du traitement du webhook:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// Endpoint de test pour vérifier que le webhook fonctionne
router.get('/bridge/test', (req, res) => {
  console.log('🧪 Test webhook endpoint appelé');
  res.json({ 
    message: 'Webhook endpoint is working',
    timestamp: new Date().toISOString(),
    webhookUrl: process.env.BRIDGE_WEBHOOK_URL,
    hasSecret: !!process.env.BRIDGE_WEBHOOK_SECRET
  });
});

export default router;
