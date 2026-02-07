# Architecture - newbi-api

Backend GraphQL API pour la plateforme Newbi SaaS.

## Stack Technique

| Technologie | Version | Usage |
|-------------|---------|-------|
| Node.js | ES Modules | Runtime |
| Express | 4.x | Serveur HTTP |
| Apollo Server | 3.12 | GraphQL |
| MongoDB | Mongoose | Base de données |
| Redis | ioredis | Cache & PubSub |
| BullMQ | - | Job queues |

**Port** : 4000

---

## Structure des Dossiers

```
newbi-api/
├── src/
│   ├── server.js              # Point d'entrée principal
│   ├── config/                # Configuration (Redis, etc.)
│   ├── schemas/               # Schémas GraphQL (.graphql)
│   ├── resolvers/             # Resolvers GraphQL (49 fichiers)
│   ├── models/                # Modèles Mongoose (43+ modèles)
│   ├── services/              # Logique métier (31+ services)
│   ├── middlewares/           # Auth & RBAC
│   ├── routes/                # Endpoints REST (webhooks, banking)
│   ├── jobs/                  # Background jobs (cleanup)
│   ├── cron/                  # Tâches planifiées
│   ├── queues/                # BullMQ queues
│   ├── emails/                # Templates React Email
│   └── utils/                 # Utilitaires
├── scripts/                   # Scripts de déploiement
├── logs/                      # Logs Winston (rotating)
├── Makefile                   # Commandes de déploiement
└── .env.example               # Variables d'environnement
```

---

## Couche GraphQL

### Schémas (57 fichiers .graphql)

**Emplacement** : `src/schemas/`

| Catégorie | Fichiers |
|-----------|----------|
| **Base** | `types/base.graphql`, `types/scalars.graphql`, `types/enums.graphql` |
| **Core** | `user.graphql`, `invoice.graphql`, `quote.graphql`, `creditNote.graphql`, `client.graphql`, `expense.graphql`, `product.graphql` |
| **Banking** | `banking.graphql`, `reconciliation.graphql`, `transaction.graphql` |
| **Fichiers** | `fileTransfer.graphql`, `sharedDocument.graphql`, `chunkUpload.graphql`, `chunkUploadR2.graphql` |
| **Email** | `emailReminder.graphql`, `emailSettings.graphql`, `smtpSettings.graphql` |
| **OCR** | `ocr.graphql`, `importedInvoice.graphql` |
| **CRM** | `crmEmailAutomation.graphql`, `clientList.graphql` |
| **Intégrations** | `stripeConnect.graphql`, `partner.graphql` |

### Resolvers (49 fichiers)

**Emplacement** : `src/resolvers/`

**Index** : `resolvers/index.js` fusionne tous les resolvers via `@graphql-tools/merge`

**Principaux resolvers** :
- `user.js`, `invoice.js`, `quote.js`, `creditNote.js`, `client.js`, `expense.js`, `product.js`
- `banking.js`, `reconciliationResolvers.js`
- `fileTransfer.js`, `sharedDocument.js`
- `ocr.js`, `importedInvoice.js`
- `partner.js`, `stripeConnectResolvers.js`

---

## Modèles de Données (MongoDB)

**Emplacement** : `src/models/`

### Entités Core

| Modèle | Description |
|--------|-------------|
| `User.js` | Comptes utilisateurs avec abonnement |
| `Invoice.js` | Factures avec items et suivi de statut |
| `Quote.js` | Devis/propositions |
| `CreditNote.js` | Avoirs |
| `Client.js` | Informations clients avec champs custom |
| `Product.js` | Catalogue produits/services |
| `Expense.js` | Suivi des dépenses avec OCR |
| `Transaction.js` | Transactions bancaires |
| `Event.js` | Logs d'activité |

### Fonctionnalités Avancées

| Modèle | Description |
|--------|-------------|
| `FileTransfer.js` | Transferts de fichiers (expiration, accès) |
| `SharedDocument.js` / `SharedFolder.js` | Partage de documents |
| `OcrDocument.js` / `OcrUsage.js` | Traitement OCR & quotas |
| `AccountBanking.js` | Connexions bancaires |
| `StripeConnectAccount.js` | Comptes Stripe Connect |
| `CrmEmailAutomation.js` | Automatisations email CRM |
| `Notification.js` | Notifications utilisateurs |

### Sous-schémas (`models/schemas/`)

`address.js`, `bankDetails.js`, `client.js`, `companyInfo.js`, `item.js`, `shipping.js`

---

## Services & Logique Métier

**Emplacement** : `src/services/`

### OCR (Multi-Provider avec Fallback)

```
hybridOcrService.js (orchestrateur)
    ├── claudeVisionOcrService.js    # Principal (Anthropic API)
    ├── mindeeOcrService.js          # Fallback 1 (250 pages/mois)
    ├── googleDocumentAIService.js   # Fallback 2 (1000 pages/mois)
    ├── mistralOcrService.js         # Fallback 3
    └── tesseractOcrService.js       # Fallback local
```

### Banking (Multi-Provider)

```
banking/
├── BankingService.js              # Service façade
├── BankingCacheService.js         # Cache transactions
├── BankingProviderFactory.js      # Factory pattern
└── providers/
    ├── BridgeProvider.js          # Bridge API (banques FR)
    ├── GoCardlessProvider.js      # GoCardless (UK/EU)
    └── MockProvider.js            # Dev/test
```

### Autres Services

| Service | Fonction |
|---------|----------|
| `emailService.js` | Envoi SMTP (Nodemailer) |
| `emailReminderService.js` | Relances automatiques |
| `crmEmailAutomationService.js` | Campagnes email CRM |
| `cloudflareService.js` | Stockage R2 |
| `stripeConnectService.js` | Paiements marketplace |
| `financialAnalysisService.js` | Analyses financières |
| `notificationService.js` | Gestion notifications |

---

## Middlewares & Authentification

**Emplacement** : `src/middlewares/`

| Middleware | Fonction |
|------------|----------|
| `better-auth-jwt.js` | Validation JWT avec JWKS |
| `better-auth.js` | Authentification session |
| `rbac.js` | Contrôle d'accès par rôle |
| `company-info-guard.js` | Protection données entreprise |

### Flux d'Authentification

```
Request → Authorization Header → JWT Validation (JWKS)
                                       ↓
                              Context GraphQL avec user
                                       ↓
                              RBAC vérifie permissions
```

---

## Routes REST

**Emplacement** : `src/routes/`

| Route | Endpoint | Usage |
|-------|----------|-------|
| `webhook.js` | `/webhook` | Webhooks Stripe |
| `banking.js` | `/banking` | Opérations bancaires |
| `banking-connect.js` | `/banking-connect` | Connexion comptes |
| `banking-sync.js` | `/banking-sync` | Sync transactions |
| `fileTransferAuth.js` | `/api/transfers` | Auth transferts |
| `fileDownload.js` | `/api/files` | Téléchargement fichiers |
| `sharedDocumentDownload.js` | `/api/shared-documents` | ZIP documents partagés |
| `reconciliation.js` | `/reconciliation` | Rapprochement bancaire |

---

## Jobs & Tâches Planifiées

### Cron Jobs (`src/cron/`)

| Job | Schedule | Fonction |
|-----|----------|----------|
| `invoiceReminderCron.js` | `0 * * * *` (chaque heure) | Relances factures |
| `crmEmailAutomationCron.js` | Variable | Automatisations CRM |

### Background Jobs (`src/jobs/`)

| Job | Schedule | Fonction |
|-----|----------|----------|
| `cleanupExpiredFiles.js` | `0 3 * * *` (3h UTC) | Supprime transferts expirés |
| `cleanupOrphanChunks.js` | `0 */6 * * *` (6h) | Nettoie chunks abandonnés |

### BullMQ Queues (`src/queues/`)

- `reminderQueue.js` - Queue pour relances factures

---

## Intégrations Externes

| Service | Usage | Configuration |
|---------|-------|---------------|
| **Stripe** | Paiements, abonnements, Connect | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| **Bridge API** | Connexions bancaires FR | `BRIDGE_CLIENT_ID`, `BRIDGE_CLIENT_SECRET` |
| **Cloudflare R2** | Stockage fichiers (principal) | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |
| **AWS S3** | Stockage (fallback) | `AWS_*` |
| **Anthropic** | OCR Claude Vision | `ANTHROPIC_API_KEY` |
| **Mindee** | OCR (backup) | `MINDEE_API_KEY` |
| **Google Document AI** | OCR (backup) | `GOOGLE_CLOUD_PROJECT_ID` |
| **Redis** | Cache, PubSub, queues | `REDIS_URL` ou `REDIS_HOST` |
| **Resend** | Emails transactionnels | Via SMTP |

---

## Configuration Environnement

**Fichiers** : `.env`, `.env.staging`, `.env.production`

```bash
# Core
MONGODB_URI=mongodb://...
PORT=4000
NODE_ENV=development|staging|production

# Auth
JWT_SECRET=...
BETTER_AUTH_URL=...

# Stripe
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...

# Banking
BANKING_PROVIDER=mock|bridge|gocardless
BRIDGE_CLIENT_ID=...
BRIDGE_CLIENT_SECRET=...

# Storage
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_API_URL=...

# OCR
OCR_PROVIDER=claude-vision|mindee|google-document-ai
ANTHROPIC_API_KEY=...

# Email
SMTP_HOST=...
SMTP_PORT=...
FROM_EMAIL=...

# Redis
REDIS_URL=... (ou REDIS_HOST, REDIS_PORT)
```

---

## Flux de Données Principaux

### Création de Facture

```
Client GraphQL → createInvoice mutation
                        ↓
              Resolver valide et calcule totaux
                        ↓
              Mongoose crée document Invoice
                        ↓
              Event créé pour audit
                        ↓
              Retour facture avec numéro généré
```

### Synchronisation Bancaire

```
Webhook Bridge → /banking/webhook
                      ↓
            Vérification signature
                      ↓
            BridgeProvider parse transactions
                      ↓
            Sauvegarde Transaction model
                      ↓
            GraphQL Subscription notifie client
```

### Traitement OCR

```
Upload image → hybridOcrService.js
                     ↓
            Essai Claude Vision (principal)
                     ↓
            Fallback Mindee si échec
                     ↓
            Fallback Google Document AI
                     ↓
            Cache résultat (ocrCacheService)
                     ↓
            Mise à jour quota (UserOcrQuota)
```

---

## Système de Relances Automatiques de Factures

### Architecture

```
Cron (toutes les heures)
    ↓
invoiceReminderCron.js → Trouve les workspaces avec relances activées
    ↓
reminderQueue.js (BullMQ) → Queue les jobs de relance
    ↓
invoiceReminderService.js → Détermine quelles factures relancer
    ↓
emailReminderService.js → Envoie via SMTP (Nodemailer)
    ↓
InvoiceReminderLog → Audit trail
```

### Fichiers Clés

| Fichier | Rôle |
|---------|------|
| `src/cron/invoiceReminderCron.js` | Cron job (`0 * * * *` = chaque heure) |
| `src/queues/reminderQueue.js` | Queue BullMQ (5 workers, rate limit 10/s) |
| `src/services/invoiceReminderService.js` | Logique métier (1ère/2ème relance) |
| `src/services/emailReminderService.js` | Envoi SMTP + génération PDF |
| `src/emails/invoice-reminder.jsx` | Template React Email |
| `src/models/InvoiceReminderSettings.js` | Configuration par workspace |
| `src/models/InvoiceReminderLog.js` | Historique des relances |

### Configuration Workspace

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `enabled` | Activer/désactiver les relances | `false` |
| `firstReminderDays` | Jours après échéance pour 1ère relance | `7` |
| `secondReminderDays` | Jours après échéance pour 2ème relance | `14` |
| `reminderHour` | Heure d'envoi (0-23) | `9` |
| `excludedClientIds` | Liste des clients exclus | `[]` |
| `firstReminderSubject` | Sujet email 1ère relance | Template par défaut |
| `secondReminderSubject` | Sujet email 2ème relance | Template par défaut |
| `firstReminderBody` | Corps email 1ère relance | Template par défaut |
| `secondReminderBody` | Corps email 2ème relance | Template par défaut |

### Variables de Template

Les templates de relance supportent les variables suivantes :

- `{invoiceNumber}` — Numéro de la facture
- `{clientName}` — Nom du client
- `{totalAmount}` — Montant total TTC
- `{dueDate}` — Date d'échéance
- `{companyName}` — Nom de l'entreprise émettrice

### Flux de Relance

```
Facture impayée + date échéance dépassée
    ↓
Vérification : workspace.enabled && !client.excluded
    ↓
Si aucune relance → 1ère relance après firstReminderDays
    ↓
Si 1 relance → 2ème relance après secondReminderDays
    ↓
Email envoyé + InvoiceReminderLog créé
```

---

## Logging & Monitoring

**Framework** : Winston avec rotation quotidienne

**Fichiers** :
- `logs/combined.log` - Tous les logs
- `logs/error.log` - Erreurs uniquement

**Niveau** : `debug` (dev) / `info` (prod)

---

## Déploiement

```bash
# Production
make deploy

# Staging
make deploy-staging
```

**Process** : rsync + PM2 reload

---

## Patterns Architecturaux

1. **Multi-Provider Strategy** : OCR, Banking, Storage avec fallback automatique
2. **Event-Driven** : Subscriptions GraphQL via Redis PubSub
3. **Multi-Tenant** : Isolation par `workspaceId` et `organizationId`
4. **Graceful Degradation** : Fallback in-memory si Redis indisponible
5. **Chunked Uploads** : Support fichiers jusqu'à 10GB
