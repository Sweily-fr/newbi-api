# Notifications de Paiement pour Transferts de Fichiers

## Vue d'ensemble

Ce système envoie automatiquement un email de notification à l'expéditeur d'un transfert de fichiers lorsqu'un client paie pour télécharger les fichiers partagés.

## Fonctionnement

### 1. Flux de Paiement

```
Client accède au lien de partage
    ↓
Client clique sur "Payer pour télécharger"
    ↓
Stripe traite le paiement
    ↓
Webhook Stripe déclenché (checkout.session.completed)
    ↓
Système crée un AccessGrant pour le client
    ↓
Système marque le FileTransfer comme payé
    ↓
🆕 Système envoie un email à l'expéditeur
```

### 2. Déclenchement de la Notification

La notification est envoyée dans la fonction `handleCheckoutSessionCompleted` du webhook Stripe :

- **Événement déclencheur** : `checkout.session.completed`
- **Condition** : Paiement réussi pour un transfert de fichiers avec `isPaymentRequired: true`
- **Destinataire** : L'utilisateur qui a créé le transfert (FileTransfer.userId)

### 3. Contenu de l'Email

L'email de notification contient :

- **Sujet** : `💰 Paiement reçu pour votre transfert de fichiers - [MONTANT][DEVISE]`
- **Informations du paiement** :
  - Email du client qui a payé
  - Montant payé et devise
  - Date et heure du paiement
  - ID du transfert
- **Liste des fichiers** téléchargés avec leurs tailles
- **Lien** vers le tableau de bord des transferts

## Configuration Requise

### Variables d'Environnement

```bash
# Configuration SMTP (obligatoire)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password

# URL du frontend (pour les liens dans l'email)
FRONTEND_URL=https://your-domain.com

# Email d'expédition
FROM_EMAIL=contact@your-domain.com
```

### Webhook Stripe

Le webhook doit être configuré pour écouter l'événement :
- `checkout.session.completed`

## Gestion des Erreurs

### Erreurs d'Email Non Bloquantes

Si l'envoi de l'email échoue :
- Le webhook Stripe continue son traitement normal
- L'erreur est loggée mais ne fait pas échouer le paiement
- Le client peut toujours accéder aux fichiers

### Logs de Débogage

```javascript
// Succès
logger.info('✅ Email de notification envoyé à l\'expéditeur', {
  senderEmail: sender.email,
  transferId: transferId
});

// Échec d'envoi
logger.warn('⚠️ Échec envoi email de notification à l\'expéditeur', {
  senderEmail: sender.email,
  transferId: transferId
});

// Expéditeur non trouvé
logger.warn('⚠️ Expéditeur non trouvé ou email manquant', {
  userId: fileTransfer.userId,
  transferId: transferId
});
```

## Test de la Fonctionnalité

### Test Manuel

```bash
# Exécuter le script de test
node src/tests/test-file-transfer-notification.js
```

### Test avec Webhook Réel

1. Créer un transfert de fichiers avec paiement requis
2. Effectuer un paiement test via Stripe
3. Vérifier les logs du webhook
4. Vérifier la réception de l'email

## Sécurité et Bonnes Pratiques

### Protection des Données

- L'email ne contient pas d'informations sensibles de paiement
- Seules les métadonnées du transfert sont incluses
- Les liens pointent vers des pages sécurisées

### Performance

- L'envoi d'email est asynchrone et n'impacte pas le traitement du paiement
- Les erreurs d'email n'affectent pas la fonctionnalité principale
- Timeout approprié pour éviter les blocages

### Monitoring

Surveiller les métriques suivantes :
- Taux de succès d'envoi d'emails
- Temps de traitement des webhooks
- Erreurs SMTP récurrentes

## Dépannage

### Email Non Reçu

1. **Vérifier les logs** : Rechercher les messages de succès/échec
2. **Configuration SMTP** : Tester la connectivité SMTP
3. **Spam/Indésirables** : Vérifier les dossiers de spam
4. **Email expéditeur** : Vérifier que l'utilisateur a un email valide

### Webhook Non Déclenché

1. **Configuration Stripe** : Vérifier l'URL et les événements
2. **Authentification** : Vérifier le secret du webhook
3. **Logs Stripe** : Consulter le dashboard Stripe pour les erreurs

## Évolutions Futures

### Améliorations Possibles

- **Templates personnalisables** : Permettre aux utilisateurs de personnaliser l'email
- **Notifications multiples** : Support pour plusieurs destinataires
- **Statistiques** : Tableau de bord des notifications envoyées
- **Retry automatique** : Nouvelle tentative en cas d'échec d'envoi

### Intégrations

- **Webhooks sortants** : Permettre aux utilisateurs de configurer leurs propres webhooks
- **Slack/Discord** : Notifications sur d'autres plateformes
- **SMS** : Notifications par SMS pour les paiements importants
