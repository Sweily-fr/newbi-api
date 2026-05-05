# scripts/

Scripts utilitaires pour l'équipe : migrations, seeds, restauration de
backups, maintenance recurring, outils d'audit. **Pas un dossier de
brouillon** — tout ce qui est ici est censé être réutilisable ou vivre
en archive.

## Conventions

### Pas de credentials hardcodés

Aucun script ne doit contenir d'URI MongoDB, de clé API, de password
ou de token en dur. Toujours :

```js
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("MONGODB_URI environment variable is required");
  process.exit(1);
}
```

Pas de `|| 'mongodb://user:pass@host/db'` en fallback. Pas de URI dans
les commentaires ou dans les README. Si un script a besoin d'un secret
en dev, il vient de `.env` (gitignored), jamais du code source.

### Scripts ad-hoc / perso / dev-only

Si tu écris un script temporaire pour debug une issue précise, valider
un bug, ou faire un one-shot manuel sur ta machine — utilise un préfixe
gitignored :

| Préfixe | Pour quoi |
|---|---|
| `scripts/temp-*` | One-shot temporaires (debug d'un bug, dump rapide, etc.) |
| `scripts/local-*` | Scripts locaux pas destinés à être partagés |
| `scripts/dev-*` | Outillage dev-only (pas prod) |
| `scripts/*.local.js` | Variantes locales d'un script existant |

Ces patterns sont dans `.gitignore` — ils ne seront pas committés
même si tu fais `git add -A`. À supprimer après usage.

**JAMAIS** : créer un `temp-update-password.js` avec un password
hardcodé dedans, même temporairement. Le pattern d'erreur historique
qui a causé le plus de dégâts a été : "je commit ce temp script vite
fait pour le partager, je le supprime tout de suite après". Le `git log`
retient le contenu pour toujours.

### Scripts récurrents

Si un script est partagé avec l'équipe, exécuté plusieurs fois (en CI,
en prod, par n'importe qui) — il vit ici **sans préfixe** ad-hoc, et
**doit être documenté** dans la section ci-dessous. Pour les domaines
volumineux, utiliser un sous-dossier (`scripts/migrations/` existe
déjà).

### Scripts one-shot terminés

Si une migration est faite, son script peut soit :
- rester ici en archive (utile pour comprendre l'historique du schéma),
- ou être supprimé en commit dédié si le cleanup a plus de valeur que
  l'archive.

À discuter au cas par cas. Pas de règle fixe.

---

## Inventaire — scripts récurrents

### Migrations (`scripts/migrations/` + `scripts/migrate-*`)

| Script | Description |
|---|---|
| `migrations/encrypt-pennylane-tokens.js` | Chiffre les `PennylaneAccount.apiToken` legacy au format AES-256-GCM. Idempotent, supporte `--dry-run`. |
| `migrate-add-activity-dates.js` | Ajoute les champs d'activité date sur les modèles concernés. |
| `migrate-encrypt-bank-details.js` | Chiffre les IBAN/BIC `Withdrawal.bankDetails` au format AES-256-GCM. |
| `migrate-hasCompletedTutorial.js` | Backfill du flag `hasCompletedTutorial` sur les users. |
| `migrate-hasSeenOnboarding.js` | Backfill du flag `hasSeenOnboarding` sur les users. |
| `migrate-invoice-client-ids.js` | Migre les références client legacy sur les factures. |
| `migrate-profile-images-to-cloudflare.js` | Migre les images de profil de l'ancien stockage local vers Cloudflare R2. |
| `migrate-subscription-context.js` | Migre la structure `subscription` au nouveau contexte. |
| `migrate-trial-to-organization.js` | Migre les trials user-level vers organization-level. |
| `migrate-user-company-to-organization.js` | Migre `User.company` vers le modèle `Organization`. |
| `migrateVisitorsToUserInvited.js` | Convertit les anciens visitors en `UserInvited`. |
| `fix-transaction-categories.js` | Migration des catégories Bridge → catégories internes. Supporte `--apply` (sinon dry-run). Mal-nommé `fix-*` mais c'est bien une migration. |

### Cleanup (recurring ou one-shot tracé)

| Script | Description |
|---|---|
| `cleanup-comment-fields.js` | Supprime les champs `userName`/`userImage` legacy sur commentaires et activités. |
| `cleanup-expired-trials.js` | Désactive les trials expirés. À lancer périodiquement. |
| `cleanup-user-subscription-fields.js` | Nettoie les champs `subscription` obsolètes côté User après migration vers Organization. |
| `clean-duplicate-drafts.js` | Renomme les brouillons en double pour libérer l'index unique. |
| `clean-empty-assigned-members.js` | Supprime les `assignedMember` vides et backfill `expenseType`. |
| `clean-orphan-commissions.js` | Supprime les commissions dont le `referralId` n'existe plus. |

### Backup / Restore (paire analyse + restauration)

| Script | Description |
|---|---|
| `analyze-backup.js` | Inspecte un backup compressé avant restauration (preview). |
| `analyze-bson-backup.js` | Inspecte un backup BSON `mongodump` avant restauration. |
| `restore-from-backup.js` | Restaure depuis un backup compressé. À utiliser avec analyse préalable. |
| `restore-from-bson-backup.js` | Restaure depuis un backup BSON `mongodump`. |

### Seeds / données de démo

| Script | Description |
|---|---|
| `seed-blog-posts.js` | Insère les articles de blog (consomme `blog-content.js`). |
| `seed-overdue-invoices.js` | Crée des factures en retard pour tester les rappels. |
| `seed-treasury-data.js` | Génère des données de trésorerie pour le dashboard finance. |
| `blog-content.js` | Données source consommées par `seed-blog-posts.js`. |
| `add-demo-documents.js` | Ajoute des documents de démo au compte `demo@newbi.fr`. |

### Trial lifecycle

| Script | Description |
|---|---|
| `activate-trial-all-organizations.js` | Active la période d'essai sur toutes les organisations. |
| `enable-trial-for-existing-users.js` | Active rétroactivement le trial pour les users existants. |
| `trial-maintenance.js` | Maintenance périodique des trials (notifications, expirations). |
| `validate-trial-activation.js` | Valide que les trials récemment activés sont en bon état. |
| `validate-trial-migration.js` | Vérifie l'intégrité après une migration trial. |

### Setup / création initiale

| Script | Description |
|---|---|
| `create-default-client-lists.js` | Crée les listes de clients par défaut sur les organisations. |
| `create-test-transactions.js` | Crée des transactions bancaires de test. |

### Indexes / cache

| Script | Description |
|---|---|
| `drop-old-indexes.js` | Drop des anciens index Mongo plus utilisés. |
| `finalize-cache-migration.js` | Finalise la migration vers le système de cache abonnement. |

### Audit / vérification

| Script | Description |
|---|---|
| `verify-workspace-ids.js` | Vérifie que toutes les collections concernées ont leur `workspaceId`. Supporte `--fix`. |
| `test-rbac-system.js` | Tests manuels du système RBAC (rôles, permissions). À supprimer une fois `__tests__/integration/rbac-matrix.test.js` mergé. |

### Recalcul / corrections de calcul

| Script | Description |
|---|---|
| `recalculate-quote-totals.js` | Force le recalcul des totaux des devis (déclenche le pre-save hook qui calcule `finalTotalVAT`). |
| `add-final-total-vat.js` | Ajoute initialement le champ `finalTotalVAT` sur les anciens devis. |
| `update-user-model-remove-subscription.js` | Retire la structure `subscription` du modèle User après migration. |

### Documentation thématique

| Fichier | Couvre |
|---|---|
| `README-BLOG.md` | Comment seeder les articles de blog. |
| `README-DEMO-DOCUMENTS.md` | Comment ajouter les documents de démo au compte demo. |
| `README-FIX-VAT.md` | Procédure de correction des numéros de TVA. |
| `README-WORKSPACE-VERIFICATION.md` | Procédure de vérification/correction des `workspaceId`. |

---

## Comment lancer un script

Tous les scripts attendent `MONGODB_URI` en variable d'environnement.
Pour les scripts qui en ont besoin :

```bash
MONGODB_URI="mongodb://username:password@host:port/dbname" \
  node scripts/<script-name>.js
```

Pour les scripts qui supportent `--dry-run` ou `--apply` (migrations,
fix-transaction-categories, verify-workspace-ids), utiliser le mode
preview en premier :

```bash
MONGODB_URI="..." node scripts/migrations/encrypt-pennylane-tokens.js --dry-run
# vérifier la sortie, puis :
MONGODB_URI="..." node scripts/migrations/encrypt-pennylane-tokens.js
```

## Pourquoi ces conventions

Cette structure est le résultat d'un audit de sécurité (F-006) qui
avait trouvé 4 mots de passe MongoDB admin de production hardcodés dans
20+ scripts du repo public. Les passwords ont été rotatés en
production, le repo passé en privé, et 36 scripts one-shot supprimés
dans le commit qui introduit ce README. Si tu n'es pas sûr·e qu'un
script ait sa place ici, demande-toi : "est-ce que quelqu'un d'autre
que moi le relancera un jour ?". Si non → préfixe `temp-`/`local-`.
