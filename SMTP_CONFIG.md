# Configuration SMTP pour les rappels par email

## Variables d'environnement requises

Ajoutez ces variables à votre fichier `.env` :

```bash
# Configuration SMTP pour l'envoi d'emails
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre-email@gmail.com
SMTP_PASS=votre-mot-de-passe-app

# URL du frontend pour les liens dans les emails
FRONTEND_URL=http://localhost:3000
```

## Configuration par fournisseur

### Gmail
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre-email@gmail.com
SMTP_PASS=votre-mot-de-passe-app  # Générer un mot de passe d'application
```

### Outlook/Hotmail
```bash
SMTP_HOST=smtp-mail.outlook.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=votre-email@outlook.com
SMTP_PASS=votre-mot-de-passe
```

### SendGrid
```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=votre-api-key-sendgrid
```

### Mailgun
```bash
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=postmaster@votre-domaine.mailgun.org
SMTP_PASS=votre-mot-de-passe-mailgun
```

## Instructions de configuration

### Pour Gmail :
1. Activez la validation en 2 étapes sur votre compte Google
2. Générez un mot de passe d'application :
   - Allez dans Paramètres Google > Sécurité
   - Mots de passe d'application
   - Sélectionnez "Autre" et nommez-le "Newbi Rappels"
   - Utilisez le mot de passe généré dans `SMTP_PASS`

### Pour les autres fournisseurs :
- Consultez la documentation de votre fournisseur SMTP
- Assurez-vous que l'authentification SMTP est activée
- Utilisez les bonnes informations d'identification

## Test de la configuration

Une fois configuré, vous pouvez tester l'envoi d'emails :
1. Allez dans `/dashboard/settings` → onglet "Notifications"
2. Activez les rappels par email
3. Cliquez sur "Envoyer un email de test"

## Sécurité

⚠️ **Important** :
- Ne commitez jamais vos vraies informations d'identification
- Utilisez des mots de passe d'application quand c'est possible
- Considérez l'utilisation de services SMTP dédiés en production
- Gardez vos variables d'environnement sécurisées

## Dépannage

### Email non reçu :
- Vérifiez les dossiers spam/indésirables
- Confirmez que les informations SMTP sont correctes
- Vérifiez les logs du serveur pour les erreurs

### Erreur d'authentification :
- Vérifiez `SMTP_USER` et `SMTP_PASS`
- Pour Gmail, assurez-vous d'utiliser un mot de passe d'application
- Vérifiez que l'authentification SMTP est activée

### Erreur de connexion :
- Vérifiez `SMTP_HOST` et `SMTP_PORT`
- Confirmez la valeur de `SMTP_SECURE` (true pour port 465, false pour 587)
- Vérifiez votre connexion internet et firewall
