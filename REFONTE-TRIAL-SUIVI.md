# REFONTE TRIAL / ABONNEMENT — Document de suivi vivant

> Document de référence du chantier. **À mettre à jour à chaque avancée** : début d'un lot, tâche terminée, décision prise, blocage rencontré.

**Date de création** : 2026-05-25
**Dernière mise à jour** : 2026-05-25
**Pilote** : (à renseigner)
**Statut global** : 🟧 Lot 7 — code livré, rollout opérationnel piloté côté utilisateur

---

## 1. OBJECTIF DE LA REFONTE

Passer d'un trial **Stripe avec carte bancaire obligatoire** (1 mois) à un **trial libre de 14 jours sans CB**, géré côté application.

**Aujourd'hui** :

- Le user s'inscrit → DOIT renseigner CB → 1 mois trial Stripe → prélèvement automatique
- Si arrêt de paiement → lecture seule (gating déjà en place)

**Demain** :

- Le user s'inscrit SANS CB → accès complet immédiat pendant 14 jours
- À J14 sans souscription → bascule en lecture seule (même mécanisme qu'aujourd'hui)
- Souscription possible à tout moment via Stripe (qui ne sert plus qu'au paiement réel)

**Documents de référence** :

- Audit complet (9000 mots, 9 sections A-I) — produit le 2026-05-25
- Audit ciblé 3 points (`/create-workspace`, `complete-onboarding`, webhookController) — produit le 2026-05-25

---

## 2. LES 16 DÉCISIONS DE CADRAGE (FIGÉES)

> Ces décisions sont **figées**. Ne pas les rouvrir sans raison forte (nouveau bloquant technique, retour utilisateur critique).

### Bloc Produit

| #     | Décision                                                              | Justification                                                                     |
| ----- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **1** | Re-trial des users résiliés → **NON**                                 | Anti-abus. Cohorte B (canceled/expired) reste en lecture seule comme aujourd'hui. |
| **2** | Trials multi-org → **1 trial par organisation**                       | Cohérent avec le modèle existant (trial porté par Organization, pas par User).    |
| **3** | Saisie SIRET au signup → **OBLIGATOIRE avant accès dashboard**        | Conserve la qualité des données entreprise. Reste dans le flow signup.            |
| **4** | Choix du plan à l'inscription → **RETIRÉ**                            | Devient CTA "Souscrire" depuis le dashboard. Réduit la friction au signup.        |
| **5** | Page `/onboarding/success` → **transformée en welcome screen simple** | Sans logique Stripe (plus de polling `verify-checkout-session`).                  |
| **6** | Bannière trial dans le dashboard → **affichée à partir de J-3**       | Cohérent avec l'email `customer.subscription.trial_will_end` existant.            |
| **7** | Email à J0 (expiration trial) → **OUI**                               | Ton incitatif et rassurant (rappel des données conservées en lecture seule).      |

### Bloc Technique

| #      | Décision                                                                  | Justification                                                                                                                                                                                                                    |
| ------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **8**  | Vérification email avant dashboard → **GARDER non vérifié**               | ⚠️ Point de vigilance abus — à surveiller post-lancement.                                                                                                                                                                        |
| **9**  | Hébergement du cron → **PM2 dans newbi-api**                              | Cohérent avec l'infra existante.                                                                                                                                                                                                 |
| **10** | Route souscription post-trial → **route dédiée `/api/billing/subscribe`** | Sépare clairement "checkout depuis trial" de "checkout depuis signup" (qui disparaît).                                                                                                                                           |
| **11** | Champ `stripeTrialActive` → **FORMALISER**                                | Le déclarer dans le schéma `additionalFields` Better Auth (aujourd'hui shadow).                                                                                                                                                  |
| **12** | Divergence `past_due` back/front → **NORMALISER**                         | Aligner backend (qui accepte) et frontend (qui refuse) sur la même règle.                                                                                                                                                        |
| **13** | Faille `requirePermission` (~5 mutations) → **CORRIGER**                  | Vérifier chaque mutation qui utilise `requirePermission` et ajouter le check sub si pertinent.                                                                                                                                   |
| **14** | TTL session 30j / cookieCache 5min → **GARDER, ne pas toucher**           | Standard industrie, déjà validé. Hors scope.                                                                                                                                                                                     |
| **15** | `pending_org_data` au déploiement → **script de nettoyage (Lot 6)**       | Collection devenue inutile (org créée au signup).                                                                                                                                                                                |
| **16** | Trial sur org additionnelle (`/create-workspace`) → **NON**               | Seule la 1ʳᵉ org d'un user bénéficie du trial ; org additionnelles = paiement immédiat. ⚠️ **Implique un cas particulier** : la création d'org doit distinguer "1ʳᵉ org → trial app" vs "org additionnelle → paiement immédiat". |

---

## 3. ÉTAT D'AVANCEMENT DES 7 LOTS

> Légende : ⬜ À faire — 🟧 En cours — ✅ Terminé — ⛔ Bloqué

### Vue d'ensemble

| Lot | Intitulé                     | Effort          | Statut | Démarré le | Terminé le           |
| --- | ---------------------------- | --------------- | ------ | ---------- | -------------------- |
| 1   | Préparation & infrastructure | 2-3j            | ✅     | 2026-05-25 | 2026-05-25           |
| 2   | Gating frontend              | 2j              | ✅     | 2026-05-25 | 2026-05-25           |
| 3   | ⭐ Création d'org au signup  | 3-4j            | ✅     | 2026-05-25 | 2026-05-25           |
| 4   | Cron & notifications trial   | 2j              | ✅     | 2026-05-25 | 2026-05-25           |
| 5   | Adaptation Stripe            | 2-3j            | ✅     | 2026-05-25 | 2026-05-25           |
| 6   | Migration & cleanup          | 1-2j            | ✅     | 2026-05-25 | 2026-05-25           |
| 7   | Rollout & monitoring         | parallèle Lot 6 | 🟧     | 2026-05-25 | — (rollout en cours) |

**Total estimé** : 12-18 jours-dev.

---

### Lot 1 — Préparation & infrastructure ✅

**Objectif** : poser les fondations (feature flag, gating backend qui reconnaît le trial app) avant tout changement de flow.

- [x] Ajouter feature flag `ENABLE_APP_TRIAL` (env var + helper) — `newbi-api/src/utils/featureFlags.js`, `newbiv2/src/lib/feature-flags.js`
- [x] Créer la fonction utilitaire `isTrialAppActive(org)` exportée côté back ET côté front (source unique de vérité) — `newbi-api/src/utils/trialApp.js`, `newbiv2/src/lib/trial-app.js`
- [ ] Formaliser `stripeTrialActive` dans le schéma `additionalFields` de l'Organization (`newbiv2/src/lib/auth-plugins.js:1664-1684`) — décision #11 → **déplacé au Lot 5 (Adaptation Stripe)** car proche du reste des modifs `auth-plugins.js`
- [x] Adapter `newbiv2/app/api/organizations/[id]/subscription/route.js` pour exposer `trialEndDate, isTrialActive, stripeTrialActive, trialStartDate, hasUsedTrial`
- [x] Adapter `newbi-api/src/middlewares/rbac.js` (`checkSubscriptionActive`) — check trial AVANT check Stripe, derrière feature flag, avec cache LRU 30s dédié + `invalidateTrialCache()` exporté
- [x] Adapter `newbiv2/src/lib/security/require-active-subscription.js` idem
- [x] Ajouter tests unitaires sur `checkSubscriptionActive` — 19/19 tests, couvrant flag ON/OFF, trial actif/expiré, combinaisons Stripe, cache (`newbi-api/__tests__/middleware/checkSubscriptionActive.test.js`)

---

### Lot 2 — Gating frontend ✅

**Objectif** : étendre la chaîne front (layout + hooks + UI) pour reconnaître le trial app, sans encore changer le flow signup.

- [x] Adapter `newbiv2/src/hooks/useSubscriptionAccess.js` (extension `isReadOnly`, ajout `isTrialApp`, `trialDaysRemaining` basé sur trialEndDate)
- [x] Adapter `newbiv2/src/hooks/useDashboardLayoutSimple.js` — `isActive()` accepte trial app actif ; fetch initial conserve les données quand `appTrialEnabled && isTrialActive && trialEndDate>now` ; fallback cache localStorage idem
- [x] Adapter `newbiv2/app/dashboard/layout.jsx` (`hasValidSubscription`) — check trial AVANT check Stripe, gated par `isAppTrialEnabled()` server-side. **Non-régression critique testée** : si le flag est OFF, aucun lookup org → comportement strictement identique.
- [x] Adapter UI settings : `facturation-section.jsx` early-return adapté pour trial app sans Stripe customer (copy "Aucun abonnement actif — essai gratuit en cours" + CTA "Souscrire") ; `subscription-section.jsx` bouton "Résilier" caché si pas de `stripeSubscriptionId` ; `pricing-modal.jsx` déjà résistant
- [x] Créer **bannière trial** `newbiv2/src/components/trial-banner.jsx` (décision #6 — visibilité J-3 → J0 uniquement, copy adaptée jours restants, CTA "Souscrire" pour owner)
- [x] Bannière montée dans `newbiv2/app/dashboard/dashboard-client-layout.jsx` sous le `SubscriptionReadOnlyBanner`
- [x] Exposer `appTrialEnabled` dans l'API `/api/organizations/[id]/subscription` pour le gating client-side (le flag serveur est mirroré dans la réponse)
- [x] Tests : 10 tests hook `useSubscriptionAccess` (flag ON/OFF, trial actif/expiré, non-régression Stripe-active) + 10 tests `TrialBanner` (décision #6 J-7/J-4/J-3/J-2/J-1/J0, CTA owner/non-owner) + 7 tests étendus `require-active-subscription` (flag ON/OFF, fallback DB)
- [ ] Normaliser le statut `past_due` entre back et front — décision #12 → **déplacé au Lot 5** pour cohérence avec les modifs Stripe
- [ ] Adapter `/api/organizations/[id]/complete-onboarding` pour reconnaître le trial app-managed → **déplacé au Lot 3** (cohérent avec la création d'org au signup)

---

### Lot 3 — ⭐ Création d'org au signup ✅

**Objectif** : cœur de la refonte. Créer l'organisation immédiatement au signup avec un trial app, sans passer par Stripe.

- [x] Refactor `newbiv2/src/lib/org-creation.js` : `subscriptionInfo` désormais optionnel ; nouveaux paramètres `appTrialDays` (durée trial en jours) et `markOnboardingComplete` (default true) ; branche 4b "App-managed trial" qui pose `isTrialActive/trialStartDate/trialEndDate/hasUsedTrial/stripeTrialActive: false` quand `appTrialDays` est fourni sans `subscriptionInfo`
- [x] Modifier `newbiv2/src/lib/auth.js` (`databaseHooks.user.create.after`) : quand `isAppTrialEnabled()` est `true` et que l'utilisateur n'est pas invité, appelle `createOrganizationWithSubscription({ appTrialDays: 14, markOnboardingComplete: false })` après avoir marqué `onboardingStep: "workspace"` → org placeholder + member + trial 14j créés immédiatement. Quand le flag est OFF, ce bloc est totalement ignoré (rollback garanti).
- [x] Simplifier `newbiv2/app/auth/signup/page.jsx` : `handleWorkspaceSubmit` branche selon `appTrialEnabled` — flag ON ⇒ `updateOnboardingStep("completed", data)` puis `router.replace("/dashboard")` ; flag OFF ⇒ flow historique inchangé (passe à "plan").
- [x] Conserver la vue `workspace` (saisie SIRET — décision #3) inchangée
- [x] Ajuster `newbiv2/src/lib/onboarding.js` (`ALLOWED_TRANSITIONS`) : `workspace → completed` désormais valide (raccourci app-trial)
- [x] Ajuster `newbiv2/src/lib/schemas/onboarding-step.js` : ajout de `"completed"` dans l'enum ; la garde feature-flag est dans la route
- [x] Modifier `newbiv2/app/api/onboarding/step/route.js` : rejette `step: "completed"` quand `isAppTrialEnabled()` est `false` (non-régression du flow historique) ; quand `true`, applique les `data` workspace à l'org placeholder, set user `onboardingStep: completed, hasSeenOnboarding: true` et `$unset onboardingData` dans un seul update atomique
- [x] Créer `newbiv2/app/api/feature-flags/route.js` (GET) qui expose `{ appTrialEnabled }` (sans auth) pour le gating client-side du signup
- [x] **Décision #16** — `newbiv2/app/api/create-org-subscription/route.js` : quand flag ON ET l'utilisateur a déjà au moins un member dans une autre org → `trial_period_days: 0` (paiement immédiat, pas de trial Stripe sur les org additionnelles). Flag OFF ou première org ⇒ 30 jours inchangés.
- [x] **Décision #16 défensive** — `org-creation.js` branche app-trial : si l'user a déjà une autre org avec `hasUsedTrial: true`, le trial n'est **pas** ré-octroyé même si `appTrialDays` est fourni (anti-abus)
- [x] Adapter `newbiv2/app/api/organizations/[organizationId]/complete-onboarding/route.js` : reconnaît le trial app actif comme accès valide (sans régression flag OFF)
- [x] **Conserver l'ancien flow derrière le feature flag** `ENABLE_APP_TRIAL` pour rollback — toutes les modifications sont gated
- [x] Tests : 3 nouveaux tests `org-creation` (appTrialDays branche, décision #16 défensive, markOnboardingComplete=false), 18 tests `onboarding.js` (transitions + getOnboardingStep + parseOnboardingData), 3 tests `/api/feature-flags`, total **24 nouveaux tests**, zéro régression sur l'existant
- [ ] Transformer `newbiv2/app/onboarding/success/page.jsx` en welcome screen simple (décision #5) → **déplacé au Lot 5** (cohérent avec la refonte du flow Stripe success)

---

### Lot 4 — Cron & notifications trial ✅

**Objectif** : automatiser la fin du trial et les emails.

- [x] Créer `newbi-api/src/cron/trialCleanupCron.js` (cron quotidien sous PM2 — décision #9) — `cron.schedule("5 9 * * *", ...)` Europe/Paris, démarré dans `server.js` derrière `instanceId === 0` ET `isAppTrialEnabled()`
- [x] Logique J0 : parcourt orgs avec `isTrialActive: true && stripeTrialActive !== true && trialEndDate <= now`, met `isTrialActive: false`, **invalide `_trialCache`** via `invalidateTrialCache(orgId)` exporté du `rbac.js` (Lot 1)
- [x] ⚠️ Filtre `stripeTrialActive: { $ne: true }` dans les 2 cursors — orgs avec trial Stripe legacy intactes (vigilance point figée)
- [x] Logique J-3 : orgs où `trialEndDate ∈ (now, now+3j]` ET `trialEndingEmailSentAt: { $exists: false }` → marqueur posé, puis email envoyé (mark-first-send-second pour anti-doublon)
- [x] Email `sendTrialEndingEmail` (J-3) — créé dans `newbi-api/src/utils/trialEmails.js` (nouveau, SMTP via nodemailer, HTML inline minimal + CTA "Choisir un plan" vers `/dashboard/parametres/abonnement`)
- [x] Email `sendTrialEndedEmail` (J0) — créé dans le même module (décision #7 : ton incitatif et rassurant, mentionne explicitement que les données restent "en sécurité et consultables")
- [x] Anti-doublon emails via 2 champs sur Organization : `trialEndingEmailSentAt` (Date, J-3) et `trialEndedEmailSentAt` (Date, J0). Posés AVANT l'envoi (résistant aux crashs mid-loop).
- [x] Idempotence : J0 update est idempotent (`isTrialActive: false` reposable sans effet) ; les emails sont gated par les marqueurs ; la requête J-3 utilise `$exists: false` pour exclure les orgs déjà notifiées
- [x] Tests : 7 tests vitest dans `newbi-api/__tests__/cron/trialCleanupCron.test.js` couvrant : flag OFF inerte (2 tests), J0 expiration (flip + cache + email), J0 anti-doublon (sentAt déjà posé → pas d'email), J-3 reminder (mark + send), no-db défensif. Suite complète newbi-api → **551/553** ✅ (2 skips préexistants, zéro régression).
- **Note technique** : la cache rbac est in-memory par instance PM2. Le cron tourne sur instance #0 ; les autres instances voient l'expiration au runtime via la requête org elle-même (qui retourne `isTrialActive: false`) car `_trialCache` n'est utilisé que pour éviter une re-query, pas comme source unique de vérité. Le délai d'invalidation cross-instance est au pire de 30s (TTL du cache).

---

### Lot 5 — Adaptation Stripe ✅

**Objectif** : Stripe devient l'outil de paiement réel uniquement, plus du tout responsable du trial.

- [x] Créer route dédiée `newbiv2/app/api/billing/subscribe/route.js` (décision #10) — souscription depuis le dashboard. Refuse 404 quand flag OFF (route réservée au flow app-trial). Auth + ownership (owner/admin) + Stripe checkout direct, `trial_period_days: 0`, `isNewOrganization: false`, success_url `/dashboard?subscription_success=true`. Crée le customer Stripe si absent.
- [x] Simplifier `newbiv2/app/api/create-org-subscription/route.js` : `trialDays = isAppTrialEnabled() ? 0 : 30` (couvre décision #16 ET nouveau flow). `custom_text.submit.message` adapté quand pas de trial. Import `ObjectId` supprimé (plus utilisé).
- [x] Adapter `newbiv2/src/lib/auth-plugins.js` :
  - [x] **Déduplication manquante** ajoutée sur `customer.subscription.updated` (alignée avec les autres handlers)
  - [x] Branche `isNewOrganization === "true"` conservée (toujours utilisée par `/create-workspace` — décision #16 garantit `trial_period_days: 0` à l'amont). La logique existante du webhook flip déjà `isTrialActive: false, hasUsedTrial: true, stripeTrialActive: false` quand `subscription.status === "active"` (l.673-703).
  - [x] **Décision #11 (formaliser `stripeTrialActive`)** : le champ est désormais déclaré officiellement dans `additionalFields` de l'organization (avant : champ "shadow" écrit en runtime sans déclaration). Ajout également de `trialEndingEmailSentAt` et `trialEndedEmailSentAt` (markers du cron Lot 4).
  - [x] Handler `customer.subscription.trial_will_end` conservé tel quel — devient un no-op pour le nouveau flow (plus de Stripe trial), reste fonctionnel pour les anciens users avec trial Stripe legacy.
- [x] **Décision #12 (normaliser `past_due`)** : alignement vers "accept past_due comme actif avec bannière warning" (cohérent avec rbac.js).
  - `newbiv2/app/dashboard/layout.jsx` (`hasValidSubscription`) : accepte `past_due`
  - `newbiv2/src/hooks/useDashboardLayoutSimple.js` (`isActive()` runtime + cache localStorage) : accepte `past_due`
  - `newbiv2/src/lib/security/require-active-subscription.js` (REST Next.js) : accepte `past_due`
  - Test `__tests__/security/require-active-subscription.test.js` mis à jour ("throws 402" → "accepts past_due")
  - Test `__tests__/hooks/use-subscription-access.test.js` : nouveau test pour confirmer `isReadOnly: false` + `isGracePeriod: true`
- [x] **Décision #5 (`/onboarding/success` welcome screen simple)** : branche flag ON / absence de `session_id` dans `useEffect.completeOnboarding` → skip du polling Stripe, refresh session client + `authClient.organization.setActive`, puis affichage direct des étapes welcome → invite → theme. Flow legacy (avec `session_id`) intact.
- [x] Tests : 8 tests pour `/api/billing/subscribe` (404 flag OFF, 401 unauth, 400 no-org / invalid body, 403 non-member / non-owner, 200 happy path avec checkout URL + assertions metadata, 200 avec création du customer Stripe). Suite complète newbiv2 → **1271/1274** ✅, newbi-api → **551/553** ✅. Zéro régression.
- [ ] Supprimer/simplifier `newbiv2/app/api/verify-checkout-session/route.js` → **non touché** (encore utilisé par le flow legacy quand `session_id` présent). Reviendra dans le cleanup du Lot 6.
- [ ] Code mort identifié par l'audit (`getCheckoutSessionParams`, `STRIPE_FIRST_YEAR_DISCOUNT_COUPON_ID`, etc.) → **traité au Lot 6** (cleanup global).
- [ ] Faille `requirePermission` (~5 mutations sans check sub) — décision #13 → **non traitée ce Lot** (hors du périmètre Stripe direct ; à inclure dans le Lot 6 cleanup).

---

### Lot 6 — Migration & cleanup ✅

**Objectif** : aligner les utilisateurs existants, sécuriser la décision #13, et supprimer le code mort certain.

- [x] **Script `newbi-api/src/scripts/migrate-trial-app.js`** — pose `hasUsedTrial: true, isTrialActive: false` sur toutes les orgs existantes sans `hasUsedTrial`. Idempotent (`{ $exists: false }` filter), dry-run par défaut, `--apply` pour exécuter, log un échantillon avant commit. **Cohortes A et B intactes** côté Stripe (aucun champ Stripe touché).
- [x] **Script `newbi-api/src/scripts/cleanup-pending-org-data.js`** (décision #15) — supprime les docs `pending_org_data` plus vieux qu'une fenêtre de sécurité (défaut 24h via `--age=<h>`). Dry-run par défaut, `--apply` pour exécuter. Préserve les checkouts en cours.
- [x] **Décision #13** — `requirePermission` corrigé sur les 4 mutations identifiées (audit confirmé `markInvoiceAsPaid`/`approveInvoice` SONT déjà gated via `requireWrite` dans le vrai `invoice.js` ; l'exemple `invoice-rbac-example.js` n'est pas câblé) :
  - **`expense.js:addExpenseFile`** → wrapping `requireActiveSubscription` (write DB)
  - **`expense.js:updateExpenseOCRMetadata`** → wrapping `requireActiveSubscription` (write DB)
  - **`expense.js:processExpenseFileOCR`** → wrapping `requireActiveSubscription({ failClosed: true })` (OCR consomme un service externe payant Mindee/Tesseract — cohérent avec les autres OCR/banking)
  - **`emailSignature.js:setDefaultEmailSignature`** → wrapping `requireActiveSubscription` (write DB)
  - Pattern utilisé : `requirePermission(resource, action)(requireActiveSubscription(resolver))`. L'ordre des wrappers est important : `requirePermission`→`withRBAC` enrichit d'abord le contexte (workspaceId), puis `requireActiveSubscription` lit ce contexte pour son check sub.
- [x] **Code mort supprimé** (certain à 100%) :
  - `getCheckoutSessionParams` (`auth-plugins.js:240-291`) — callback Better Auth pour `auth.subscription.upgrade()` jamais appelé (0 caller vérifié par grep). Remplacé par un commentaire qui documente le retrait + indique que `STRIPE_FIRST_YEAR_DISCOUNT_COUPON_ID` peut être retiré du `.env`.
  - `STRIPE_FIRST_YEAR_DISCOUNT_COUPON_ID` — référence unique supprimée avec la fonction ci-dessus.
- [x] Tests : suite newbi-api → **551/553** ✅, suite newbiv2 → **1271/1274** ✅, zéro régression.
- [ ] **À traiter au Lot 7** (post-rollout, après suppression du feature flag) :
  - `newbiv2/app/api/verify-checkout-session/route.js` — encore utilisé par le flow legacy (flag OFF). À supprimer après que le legacy soit retiré.
  - `newbiv2/app/api/webhooks/stripe/route.js` — vestige sans effet (redirige vers `/api/auth/stripe/webhook`).
  - `newbiv2/app/api/stripe/connect/disconnect/route.js` — stub vide.
  - Mise à jour des tests E2E Playwright (signup flow change majeur).
- [ ] **NE PAS supprimer** : `newbi-api/src/controllers/webhookController.js` (régression commissions partner, sujet séparé — chantier "lancement programme partenaire", voir section 4 du suivi).

---

### Lot 7 — Rollout & monitoring 🟧

**Statut** : code livré (monitoring + scripts), rollout opérationnel piloté côté utilisateur.

**Code livré (Partie A — Monitoring & observabilité)** :

- `newbi-api/src/cron/trialCleanupCron.js` → heartbeat persistant dans `_health` (clé `trialCleanupCron`). À chaque run le cron écrit `lastRunAt, lastRunDurationMs, lastSummary { expired, reminded, errors }, runCount`. Best-effort : un échec d'écriture n'interrompt pas le cron (2 tests dédiés).
- `newbi-api/src/scripts/print-trial-metrics.js` → CLI ops. Affiche : heartbeat cron, trials actifs, J-3 candidates, expirés aujourd'hui, total `hasUsedTrial`, orgs converties (trial → Stripe sub), taux de conversion, emails J-3 / J0 envoyés aujourd'hui. Mode `--json` pour scraping/monitoring.
- `newbi-api/src/scripts/rollback-trial-app.js` → safety valve pour rollback dur. Convertit les orgs en trial app vers l'état "trial consommé, lecture seule" + email de courtoisie. Dry-run par défaut, `--apply` + `--no-email` disponibles. Idempotent.

**Code livré (Partie B — Préparation cleanup post-rollout)** :

- Voir [Plan de rollout § 5](#plan-de-rollout-operationnel-lot-7) pour la liste exacte du code à retirer une fois le rollout stable (verify-checkout-session, vestiges Stripe, vues legacy du signup, le feature flag lui-même).

**Tests** :

- 9/9 sur le cron (heartbeat happy path + heartbeat failure non-bloquant)
- Suite complète newbi-api → **553/555** ✅ (2 skips préexistants, zéro régression)

---

## Plan de rollout opérationnel (Lot 7)

> Ce plan est **opérationnel** : il liste exactement ce que le pilote doit faire, dans l'ordre, pour activer la refonte en production.

### 0. Pré-requis avant tout rollout

- [ ] Les Lots 1-6 sont mergés en `main` et le code tourne en staging avec `ENABLE_APP_TRIAL=false` (config par défaut).
- [ ] Un environnement de staging avec un dataset proche prod est disponible.
- [ ] **Sujet partner commissions** (régression historique, voir section 4 « Prérequis ») : un go/no-go a été pris séparément. Il n'est PAS un bloquant pour ce rollout.

### 1. Étape staging (J-2 à J-1 du rollout)

1. Sur staging, passer `ENABLE_APP_TRIAL=true` dans `newbi-api/.env.staging` ET `newbiv2/.env.staging` (les deux côtés).
2. Redémarrer les deux services. Vérifier au boot : `[trialCleanupCron] scheduled daily at 09:05 Europe/Paris` (sinon le cron est OFF).
3. **Tests fonctionnels** :
   - [ ] Créer un nouveau compte (email/password ET OAuth Google) → vérifier qu'une org placeholder est créée, qu'un trial 14j est posé, et que `/onboarding/success` enchaîne welcome → invite → theme.
   - [ ] Le badge de l'org-switcher affiche **« Essai · 14j »** (couleur indigo), pas « Expiré ».
   - [ ] Créer une facture, un client, etc. → fonctionne en trial.
   - [ ] Souscrire un plan via Settings → Abonnement (avec ngrok ou Stripe CLI pour le webhook). Vérifier au retour : `subscriptionStatus: "active"`, le badge devient « PRO », `isTrialActive` passe à `false`, `hasUsedTrial: true`.
   - [ ] **NON-RÉGRESSION CRITIQUE** : se connecter avec un compte de staging déjà en sub Stripe `active` AVANT le passage du flag → vérifier qu'il atterrit normalement sur le dashboard, n'est PAS redirigé vers signup. Confirmer dans les logs `[Dashboard Layout] Abonnement valide pour org active`.
   - [ ] Forcer l'expiration d'un trial en staging (ex: `db.organization.updateOne({ _id }, { $set: { trialEndDate: new Date(0).toISOString() } })`), lancer le cron manuellement (`node -e "import('./src/cron/trialCleanupCron.js').then(m => m.runTrialCleanup())"`), vérifier que l'org passe `isTrialActive: false` et que l'email J0 est envoyé.
4. Lancer `node src/scripts/print-trial-metrics.js` en staging et vérifier que les compteurs sont cohérents (heartbeat cron, active trials, conversion).
5. Si tout est vert : **GO** pour le rollout en production. Sinon, corriger en staging d'abord.

### 2. Migration pré-production

> ⚠️ À exécuter en production AVANT de basculer le flag, pendant une fenêtre de faible trafic.

1. **Backup MongoDB de production** (la consigne projet l'impose toujours avant migration).
2. **Migration des orgs existantes** (pose `hasUsedTrial: true, isTrialActive: false`) :
   ```bash
   cd newbi-api
   # Dry-run
   node src/scripts/migrate-trial-app.js
   # Vérifier le sample affiché, puis :
   node src/scripts/migrate-trial-app.js --apply
   ```
3. **Cleanup `pending_org_data`** (décision #15) :
   ```bash
   cd newbi-api
   # Dry-run par défaut : compte les docs > 24h
   node src/scripts/cleanup-pending-org-data.js
   # Si OK :
   node src/scripts/cleanup-pending-org-data.js --apply
   ```
4. Vérifier que la suite de tests CI est toujours verte sur `main` post-migration (la migration n'est qu'en données — le code est inchangé).

### 3. Activation du feature flag — décision sur la stratégie

Le flag actuel est **booléen global** (`ENABLE_APP_TRIAL=true|false`). Deux options possibles :

#### Option A — Bascule globale ON/OFF (RECOMMANDÉE)

**Pourquoi** : la refonte a été développée avec un filet de sécurité solide (`lastFetchOk`, scripts de rollback, gating fail-open, déduplication webhooks). Les tests couvrent 1822 cas. Une bascule globale est acceptable pour une SaaS de taille moyenne.

**Comment** :

1. Passer `ENABLE_APP_TRIAL=true` dans les `.env.production` (les DEUX services).
2. `pm2 reload` les deux services.
3. Vérifier dans les logs que le cron démarre : `[trialCleanupCron] scheduled daily at 09:05 Europe/Paris`.
4. Surveiller les 24-48 premières heures (voir § 4).

#### Option B — Rollout par pourcentage (si plus de prudence est requise)

**Quand l'envisager** : si une cohorte critique d'utilisateurs (gros clients) doit être protégée d'un éventuel souci pendant la première semaine.

**Modification requise** (NON DÉVELOPPÉE dans ce Lot — à scoper séparément si nécessaire) :

- Remplacer `ENABLE_APP_TRIAL` (boolean) par `APP_TRIAL_PERCENT` (0-100)
- `isAppTrialEnabled(userId)` devient `hash(userId) % 100 < APP_TRIAL_PERCENT`
- ⚠️ Conséquence : le check côté serveur devient stable mais doit toujours utiliser le même `userId` → le flag devient _user-scoped_. La logique cron (qui ne connaît pas le user) devient plus complexe.
- Coût estimé : ~1-2j de dev + tests. À déclencher uniquement si Option A est jugée trop risquée.

**Recommandation** : commencer en Option A. Si un incident survient, le rollback (§ 5) reste rapide.

### 4. Surveillance post-bascule (J0 à J+7)

À vérifier quotidiennement la première semaine :

| Métrique               | Comment vérifier                                                                      | Seuil d'alerte                      |
| ---------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| Cron tourne            | `node src/scripts/print-trial-metrics.js` — section « Cron last run » doit être < 25h | > 25h sans run                      |
| Trials créés           | Compteur `activeTrials` croît avec les nouveaux signups                               | Stable malgré nouveaux signups      |
| Emails J-3/J0          | Lignes `[TrialEmails] J-3 reminder sent`/`J0 ended email sent` dans les logs          | Erreurs SMTP répétées               |
| Taux d'erreur GraphQL  | Mutations `SUBSCRIPTION_READ_ONLY` côté backend                                       | Pic anormal (>10% nouveaux signups) |
| Erreurs webhook Stripe | Logs `[STRIPE WEBHOOK] Erreur`                                                        | Pic                                 |
| Conversion 7j          | `convertedFromTrial / hasUsedTrial` après la première semaine de trials terminés      | À mesurer, pas de baseline          |

### 5. Procédure de rollback (en cas d'incident critique)

#### Rollback rapide (< 5 minutes)

1. Passer `ENABLE_APP_TRIAL=false` dans les `.env.production`.
2. `pm2 reload` les deux services.
3. ⚠️ **Conséquence immédiate** : les utilisateurs **déjà créés en trial app** (entre le moment où le flag a été ON et maintenant) sont **lockés** par défaut — le gating ne reconnaît plus leurs champs trial quand le flag est OFF.

#### Étape obligatoire post-rollback : déverrouiller les trial users

Exécuter le script de rollback préparé :

```bash
cd newbi-api
# Dry-run : compte les orgs concernées
node src/scripts/rollback-trial-app.js
# Sample affiché → vérifier l'ordre de grandeur
node src/scripts/rollback-trial-app.js --apply
```

Effet :

- Toutes les orgs en trial app sont passées en état « trial consommé, lecture seule » (cohérent avec l'ancienne cohorte B).
- Un email J0 (« essai terminé, données en sécurité ») est envoyé à chaque owner avec un CTA pour souscrire via le flow legacy.
- Idempotent (relançable sans dégât).
- `--no-email` pour un rollback silencieux.

À partir de là, les anciens trial users peuvent souscrire normalement via `/api/create-org-subscription` (legacy actif quand flag OFF).

#### Recommandation si rollback prolongé (> 24h)

Si la décision de rollback est définitive (la refonte est annulée), il faut envisager :

- soit un re-développement (le code legacy reste actif),
- soit un nettoyage du code refonte (les Lots 1-6 sont retirés).
  Cette décision est hors scope opérationnel — déclencher un nouveau chantier.

### 6. Cleanup post-rollout (à exécuter après J+30 stable)

> ⚠️ À NE PAS exécuter tant que le rollout n'a pas tourné 30+ jours sans incident majeur. Le code legacy doit rester opérationnel le temps qu'un rollback soit théoriquement possible.

Liste exhaustive du code à retirer une fois le rollout stable :

#### Newbiv2 — fichiers à supprimer

- [ ] `newbiv2/app/api/verify-checkout-session/route.js` — la page `/onboarding/success` ne fera plus de polling Stripe (la branche legacy est déjà la seule à l'appeler, et le legacy disparaît).
- [ ] `newbiv2/app/api/webhooks/stripe/route.js` — vestige sans effet.
- [ ] `newbiv2/app/api/stripe/connect/disconnect/route.js` — stub vide.
- [ ] Vues `plan` et `recap` dans `newbiv2/app/auth/signup/page.jsx` — branche `if (appTrialEnabled)` devient la seule branche.
- [ ] Les `subscription_data.trial_period_days` fallback de 30 jours dans `create-org-subscription` — retirer la condition, garder uniquement `trial_period_days: 0` ou omission.

#### Newbi-api — fichiers à supprimer

- [ ] (rien d'urgent — `webhookController.js` reste pour le sujet partner commissions, voir § 4)

#### Feature flag lui-même

- [ ] `newbi-api/src/utils/featureFlags.js` — supprimer la fonction `isAppTrialEnabled` (ou la rendre `() => true` pour transition)
- [ ] `newbiv2/src/lib/feature-flags.js` — idem
- [ ] `newbiv2/app/api/feature-flags/route.js` — supprimer
- [ ] Toutes les utilisations de `isAppTrialEnabled()` dans le code → simplifier les branches (garder uniquement la branche flag-ON)
- [ ] La variable `ENABLE_APP_TRIAL` dans les `.env.*` peut être retirée

#### Tests

- [ ] Tests sur le scénario flag OFF (legacy) : retirer ou marquer comme historique
- [ ] **Tests E2E Playwright** : mettre à jour pour le nouveau flow signup. Pas encore touchés au Lot 7 (les E2E existants couvrent l'ancien flow ; ils seront cassés une fois le legacy retiré).

#### Doc

- [ ] Mettre à jour `CLAUDE.md` pour refléter le nouveau flow par défaut.
- [ ] Le fichier `REFONTE-TRIAL-SUIVI.md` peut être archivé dans `docs/archives/` une fois le chantier clôturé.

#### Critère pour exécuter ce cleanup

30 jours consécutifs sans :

- aucun rollback déclenché
- aucune erreur critique tracée aux logs `[trialCleanupCron]` ou `[STRIPE WEBHOOK]`
- un taux de conversion trial → payant mesuré et accepté par produit

**Objectif** : déploiement progressif sous feature flag avec métriques.

- [ ] Déployer en staging avec feature flag OFF → smoke test
- [ ] Activer feature flag pour 1% des nouveaux signups → monitorer 48h
- [ ] Étendre à 10%, 50%, 100% selon métriques (taux conversion trial→payant, erreurs)
- [ ] Métriques à surveiller :
  - Taux de signup complet (vs abandon)
  - Taux de conversion trial → souscription payante (vs ancien flow)
  - Taux d'erreur sur les mutations gated (`SUBSCRIPTION_READ_ONLY` côté API)
  - Volume d'appels au fallback `/api/organizations/[id]/complete-onboarding`
- [ ] Retirer le feature flag et le code de l'ancien flow après 30 jours stables

---

## 4. PRÉREQUIS / CHANTIERS LIÉS

### 🚨 Régression commissions partenaires (chantier SÉPARÉ)

**Identifié dans l'audit ciblé** : depuis ~février 2026, plus aucune `PartnerCommission` n'est créée automatiquement à un paiement Stripe. La logique (`webhookController.js:421-535`) est orpheline depuis la migration vers Better Auth Stripe.

**Décision** : reportée au **lancement du programme partenaire** (pas maintenant, mais ne pas oublier).

**Quand ce chantier sera lancé** :

1. Porter `handleInvoicePaymentSucceeded` depuis `newbi-api/src/controllers/webhookController.js:421-535` dans le case `invoice.paid` du plugin Better Auth Stripe (`newbiv2/src/lib/auth-plugins.js:1067-1262`)
2. Conserver les paliers `COMMISSION_TIERS` (Bronze/Argent/Or/Platine — 20/25/30/50 %)
3. Script de rattrapage rétroactif des commissions perdues
4. Communication aux partenaires affectés
5. Supprimer `webhookController.js` après remédiation (cf. Lot 6)

**⚠️ Note pour la refonte** : `auth-plugins.js` (modifié par les Lots 1 et 5 de cette refonte) devra **plus tard** accueillir la logique commission. En garder conscience pendant la refonte pour ne pas re-rater l'intégration plus tard.

### Autres points d'audit I.3 (intégrés dans les lots)

- **`/create-workspace` est VIVANT** (flow multi-org) → traité dans le **Lot 3** avec la règle de la décision #16
- **`/api/organizations/[id]/complete-onboarding`** est un fallback VIVANT → adapter `hasActiveSubscription` pour reconnaître le trial app-managed → traité dans le **Lot 2**

---

## 5. POINTS DE VIGILANCE

> Risques transverses à garder en tête tout au long du chantier.

### Sécurité / abus

- ⚠️ **Email non vérifié = risque d'abus de trial** → surveiller après lancement (multi-comptes pour cumuler trials)
- `hasUsedTrial` à `true` dans **TOUS les chemins** (création d'org ET souscription Stripe) — barrière anti-réabus
- Tampering MongoDB direct hors scope (risque existant pour tout flag DB)

### Risques techniques critiques

- ⚠️ **Tester `dashboard/layout.jsx` en STAGING avec dataset proche de la production** : un `hasValidSubscription` mal étendu redirigerait les users actifs vers le signup → **bug critique business**
- Le cron de cleanup trial **ne doit PAS** toucher les orgs avec `stripeTrialActive: true` (anciens trials Stripe encore actifs)
- **Invalidation explicite du cache** (LRU 30s back + 5min front) à l'activation/désactivation du trial
- **Race condition trial→sub** : si `customer.subscription.created` arrive avant le cron, `hasUsedTrial: true` doit être posé dans les deux chemins (cohérence)
- **Branche `isNewOrganization` du webhook** : à supprimer du fallback `verify-checkout-session` aussi, sinon double création possible

### Rollout

- **Feature flag `ENABLE_APP_TRIAL`** pour rollout progressif et rollback rapide
- **Coexistence des deux flows** pendant 2-4 semaines (les anciens users avec sub Stripe doivent continuer à fonctionner)

### Migration users existants

- **Cohortes A (actifs) et B (canceled/expired) → ne rien toucher** (risque zéro, décision #1)
- Le code doit accepter **simultanément** "ancienne logique sub Stripe" ET "nouvelle logique trial app" pendant la transition
- Pas de breaking change sur la collection `subscription` (rendre nullable plutôt que renommer)

### Cas limites à soigner

- Trial expiré pendant une session active (saisie facture en cours) → modale `SubscriptionBlockedDialog` se déclenche via Apollo error link (déjà en place)
- Trial expire entre deux requêtes → ancien cache 5min peut afficher "actif" temporairement, l'error link reprend le contrôle
- Suppression de compte pendant trial (DeletionRequest grâce 30j) → comportement à clarifier produit le cas échéant
- Invités (`isInvitedUser: true`) héritent du trial de l'org (logique existante `auth.js:102-135` à conserver)

---

## 6. JOURNAL D'AVANCEMENT

> Format : `[YYYY-MM-DD] — Auteur — Ce qui a été fait`. Ajouter au sommet (plus récent d'abord).

### [2026-05-25] — Lot 7 — Code livré (rollout en attente d'activation)

- **Monitoring** : heartbeat persisté dans `_health` (clé `trialCleanupCron`) à chaque run du cron (best-effort, n'interrompt pas le cron). `lastRunAt`, `lastRunDurationMs`, `lastSummary {expired, reminded, errors}`, `runCount`.
- **Script ops `print-trial-metrics.js`** : CLI lisant Mongo, sortie humaine ou `--json`. Affiche cron heartbeat, trials actifs, J-3 candidates, expirés aujourd'hui, `hasUsedTrial`, orgs converties, taux de conversion, emails J-3/J0 envoyés aujourd'hui.
- **Script rollback `rollback-trial-app.js`** : safety valve pour rollback dur. Convertit les orgs trial app actifs vers l'état legacy (`isTrialActive: false`, `hasUsedTrial: true`), envoie un email J0 (best-effort, `--no-email` possible). Dry-run par défaut. Idempotent.
- **Plan de rollout opérationnel** détaillé dans la section « Lot 7 — Rollout & monitoring » de ce document : pré-requis, staging, migration, activation (option A ON/OFF recommandée vs option B par pourcentage), surveillance J0-J+7, rollback < 5min, cleanup post-rollout à J+30.
- **Procédure de rollback documentée** : flag OFF → `pm2 reload` → exécution obligatoire du `rollback-trial-app.js --apply` pour déverrouiller les trial users (sinon ils restent lockés car le gating ne reconnaît plus les champs trial quand le flag est OFF).
- **Cleanup post-rollout listé** (à exécuter UNIQUEMENT après 30 jours stables) : verify-checkout-session, vestiges Stripe, vues legacy du signup, le feature flag lui-même, tests E2E à reécrire.
- **Tests** : 2 nouveaux tests sur le heartbeat (write happy path + write failure non-bloquante). Suite complète newbi-api → **553/555** ✅. Aucune régression sur 1800+ tests.
- **Chantier de développement clôturé.** Le rollout opérationnel reste piloté côté utilisateur : staging → migration → activation → surveillance → cleanup.

### [2026-05-25] — Lot 6 terminé (migration + #13 + cleanup)

- **Migration script** `newbi-api/src/scripts/migrate-trial-app.js` créé. Stamp `hasUsedTrial: true + isTrialActive: false` sur les orgs existantes. Dry-run par défaut, `--apply` pour commit. Aucune autre modification — cohortes A (Stripe active) et B (canceled/expired) intactes. Idempotent.
- **Cleanup script** `newbi-api/src/scripts/cleanup-pending-org-data.js` créé. Supprime les docs `pending_org_data` plus vieux qu'une fenêtre de sécurité (défaut 24h, `--age=<h>` pour ajuster). Préserve les checkouts en cours. Dry-run par défaut.
- **Décision #13 — faille `requirePermission` corrigée** : 4 mutations identifiées + wrapping `requireActiveSubscription` ajouté :
  - `expense.js:addExpenseFile` (write)
  - `expense.js:updateExpenseOCRMetadata` (write)
  - `expense.js:processExpenseFileOCR` (write + OCR payant → `failClosed: true`)
  - `emailSignature.js:setDefaultEmailSignature` (write)
  - Pattern : `requirePermission(resource, action)(requireActiveSubscription(resolver))`. L'audit avait aussi mentionné `markInvoiceAsPaid`/`approveInvoice` — confirmé : ces deux mutations sont dans `invoice-rbac-example.js` (jamais câblé dans `resolvers/index.js`) ; les versions réelles dans `invoice.js` utilisent déjà `requireWrite` (qui inclut le check sub). Donc aucun risque sur les factures.
- **Code mort supprimé** (certain à 100%) :
  - `getCheckoutSessionParams` (auth-plugins.js l.240-291) — callback Better Auth jamais appelé (vérifié : 0 caller dans le repo). Le bloc complet remplacé par un commentaire de traçabilité.
  - `STRIPE_FIRST_YEAR_DISCOUNT_COUPON_ID` (référence unique enlevée avec la fonction ci-dessus). L'env var peut être retirée de `.env`.
- **Reports au Lot 7** (post-rollout) : suppression de `verify-checkout-session`, `app/api/webhooks/stripe/route.js`, `app/api/stripe/connect/disconnect/route.js`, mise à jour des tests E2E Playwright.
- **À NE PAS toucher** : `webhookController.js` (régression commissions partner) — chantier séparé.
- **Tests** : suite newbi-api → **551/553** ✅, suite newbiv2 → **1271/1274** ✅. Zéro régression sur 1800+ tests. Smoke import de `expense.js` et `emailSignature.js` OK (vérifie la structure des wrappers).

### [2026-05-25] — Hotfix Lot 5 — Stripe rejette `trial_period_days: 0`

- Erreur runtime observée au settings modal → souscription via `create-org-subscription` : `StripeAPIError: The minimum number of trial period days is 1.`
- **Cause** : Stripe refuse `trial_period_days: 0` (minimum 1 jour). Pour signifier "pas de trial" il faut **OMETTRE** le champ entièrement.
- **Correctif** :
  - `app/api/create-org-subscription/route.js` : `...(trialDays > 0 ? { trial_period_days: trialDays } : {})` (spread conditionnel)
  - `app/api/billing/subscribe/route.js` : champ retiré du `subscription_data` (pas de trial = pas le champ)
  - Test `billing-subscribe.test.js` mis à jour : `toBeUndefined()` au lieu de `toBe(0)`
- Suite complète newbiv2 → **1271/1274** ✅, zéro régression.

### [2026-05-25] — Lot 5 terminé (adaptation Stripe + décisions #5, #11, #12)

- **Route `/api/billing/subscribe`** créée (décision #10) — endpoint dédié aux users en trial app qui souscrivent à un plan payant. Refuse 404 quand flag OFF (force l'usage du legacy `create-org-subscription`). Gating ownership (owner/admin), `trial_period_days: 0`, `isNewOrganization: false`, success_url direct vers le dashboard sans détour `/onboarding/success`.
- **`create-org-subscription` adapté** — `trialDays = isAppTrialEnabled() ? 0 : 30`. Flag ON ⇒ aucun trial Stripe (toutes les voies : main signup déjà bypassé, `/create-workspace` paie immédiat). Flag OFF ⇒ 30 jours legacy strictement préservés. Custom text du checkout adapté.
- **Webhooks Stripe** (`auth-plugins.js`) — déduplication ajoutée sur `customer.subscription.updated` (alignée avec les autres handlers). Branche `isNewOrganization` conservée (utilisée par `/create-workspace` ; le trial app ne se déclenche pas grâce au `trial_period_days: 0` en amont). Le flip `isTrialActive: false, hasUsedTrial: true, stripeTrialActive: false` est déjà géré par le webhook au passage `trialing → active` (logique existante respectée).
- **Décision #11 (`stripeTrialActive` formalisé)** — champ désormais déclaré dans `additionalFields` de l'organization (avant : "shadow"). Ajout également des marqueurs anti-doublon `trialEndingEmailSentAt`/`trialEndedEmailSentAt` du cron Lot 4 (avec `input: false` car écrits par le backend uniquement).
- **Décision #12 (`past_due` normalisé)** — convergence vers "actif + bannière warning" (cohérent avec rbac.js depuis le Lot 1) : `dashboard/layout.jsx hasValidSubscription`, `useDashboardLayoutSimple isActive()`, `useDashboardLayoutSimple` cache localStorage, et `require-active-subscription.js` (REST Next.js) acceptent maintenant `past_due`. Test legacy "throws 402 for past_due" remplacé par "accepts past_due (grace period)". Nouveau test `useSubscriptionAccess` valide `isReadOnly: false + isGracePeriod: true`.
- **Décision #5 (`/onboarding/success` welcome screen)** — quand `session_id` absent (nouveau flow app-trial, signup post-Lot 3), la page skip le polling Stripe, refresh la session client (`authClient.getSession({ cache: "no-store" })`) + `setActive` sur la première org disponible, puis affiche directement welcome → invite → theme. Flow legacy avec `session_id` intact.
- **Tests** : 8 nouveaux tests pour `/api/billing/subscribe` (flag OFF, auth, body, ownership, happy path, customer creation). Tests existants mis à jour pour décision #12 (`require-active-subscription.test.js`, `use-subscription-access.test.js`). Suite complète newbiv2 → **1271/1274** ✅ ; newbi-api → **551/553** ✅. Zéro régression sur 1800+ tests.
- **Reports au Lot 6** : suppression de `verify-checkout-session` (encore utilisé en chemin legacy), code mort `getCheckoutSessionParams` / `STRIPE_FIRST_YEAR_DISCOUNT_COUPON_ID`, décision #13 (`requirePermission` sans check sub) — tous regroupés dans le cleanup global du Lot 6.

### [2026-05-25] — Lot 4 terminé (cron + emails)

- **Cron quotidien** `newbi-api/src/cron/trialCleanupCron.js` — `cron.schedule("5 9 * * *", …)` Europe/Paris, lancé via `startTrialCleanupCron()` dans `server.js` derrière le guard `instanceId === 0` ET la double garde `isAppTrialEnabled()` (gate au boot dans le starter + gate au runtime dans `runTrialCleanup`). Flag OFF ⇒ le starter retourne `null` (aucun task scheduling), `runTrialCleanup` court-circuite avec `{ skipped: true }`.
- **Logique J0 (expiration)** — cursor sur `organization` filtré par `isTrialActive: true && stripeTrialActive !== true && trialEndDate <= now`. Pour chaque org : update `isTrialActive: false` (+ marker `trialEndedEmailSentAt` si pas déjà posé), `invalidateTrialCache(orgId)` (depuis le `rbac.js` du Lot 1), puis envoi email J0 si nouveau. **Filtre `stripeTrialActive: { $ne: true }`** garantit que les anciens trials Stripe sont totalement ignorés (vigilance point figée).
- **Logique J-3 (rappel)** — cursor sur orgs avec `trialEndDate ∈ (now, now+3j]` ET `trialEndingEmailSentAt: { $exists: false }`. Stratégie mark-first-send-second : le marqueur `trialEndingEmailSentAt` est posé AVANT l'envoi → un crash mid-loop ne cause pas de double envoi à la prochaine exécution.
- **Emails** `newbi-api/src/utils/trialEmails.js` — `sendTrialEndingEmail({ to, orgName, daysRemaining })` et `sendTrialEndedEmail({ to, orgName })`. Templates HTML inline (system-ui font, palette #5b50fe brand) + CTA "Choisir un plan" vers `/dashboard/parametres/abonnement`. Texte du J0 conforme à la décision #7 (incitatif rassurant, mentionne "données en sécurité et consultables", lecture seule conservée).
- **Anti-doublon double couche** : (1) marqueurs `trialEndingEmailSentAt` / `trialEndedEmailSentAt` posés en DB avant l'envoi ; (2) filtres dans les cursors Mongo (`$exists: false` pour J-3 ; check `!!org.trialEndedEmailSentAt` pour J0). Un cron relancé plusieurs fois la même journée ne génère AUCUN doublon d'email.
- **Cache rbac** — `invalidateTrialCache(orgId.toString())` appelé après chaque flip. Note technique : la cache étant in-memory par instance PM2, le cron qui tourne sur instance #0 n'invalide que cette instance. Les autres voient l'expiration via la requête org elle-même (30s TTL au pire pour expiration de leur cache local).
- **Tests** : 7 tests vitest (`newbi-api/__tests__/cron/trialCleanupCron.test.js`) couvrant flag OFF (run + start), J0 happy path (flip + cache + email + marker), J0 stripe-trial exemption (filtre Mongo), J0 anti-doublon (`trialEndedEmailSentAt` déjà posé → pas d'email), J-3 reminder (mark + send), no-db défensif. Tous passent. Suite complète newbi-api → **551/553** ✅ (2 skips préexistants, zéro régression).
- **Pas de changement nécessaire dans newbiv2** : tout vit côté backend, l'UI continue de lire le statut via les hooks existants (Lots 1-3) qui détectent l'expiration immédiatement (date past + `isTrialActive: false`).

### [2026-05-25] — Lot 3 — Bug 3 RÉEL identifié + corrigé (badge org-switcher)

- **Cause racine confirmée par analyse code** (l'observation runtime du user a permis de comprendre que le gating fonctionne — seul un composant d'affichage ment) :
  - Le badge "Expiré" est dans **`src/components/organization-switcher-header.jsx:289-303`** et l.345-371 (la dropdown). `SubscriptionExpiredBadgeHeader` est bien orphelin comme dit précédemment — la fausse piste venait de là.
  - Source de données : **`/api/organization/list-with-order`** qui retourne `subscriptionStatus` (un mapping binaire `active`/`expired`/`none` issu uniquement de la collection `subscription` Stripe).
  - Cette route ignorait totalement les champs trial app sur l'org (`isTrialActive` / `trialEndDate`). Pour un user trial-app sans Stripe sub → `subscriptionStatus: "none"` → badge tombait dans la branche `else` qui affiche "Expiré".
  - Le badge avait une logique binaire (`=== "active"` → PRO, sinon → Expiré), ne connaissait pas l'état trial.
- **Pourquoi le gating fonctionnait** : les boutons permission utilisent `useSubscriptionAccess` (adapté Lots 2 + 3) qui reconnaît `isTrialApp`. Le badge utilisait un chemin de données différent non adapté.
- **Correctifs** :
  - `app/api/organization/list-with-order/route.js` : derrière `isAppTrialEnabled()`, lorsque la sub Stripe est absente ou non-active et que `isTrialAppActive(org)` est vrai → `subscriptionStatus: "trialing"` + expose `trialEndDate` dans le payload. Flag OFF = behavior tristate `active|expired|none` strictement inchangé.
  - `src/components/organization-switcher-header.jsx` : badge tristate (PRO / **Essai · Xj** / Expiré). État Essai en couleur indigo brand (#5b50fe) avec compte à rebours basé sur `trialEndDate`. Patch appliqué aux 2 emplacements (badge header trigger + chaque item dropdown). `targetHasSubscription` (lors du switch d'org) accepte aussi `"trialing"`.
- **Tests** : 5 nouveaux tests pour la route (`__tests__/api/organization-list-with-order.test.js`) couvrant : flag OFF retourne "none" (legacy), flag ON + trial actif = "trialing" + trialEndDate, trial expiré = "none", Stripe wins on conflict (avec trialEndDate suppressed), Stripe canceled expired = "expired". Suite complète newbiv2 → **1262/1265** ✅ (3 skips préexistants, zéro régression).
- **Test runtime non exécuté dans cette session** (pas de dev server lancé). La correction repose sur l'analyse code exhaustive et la validation unitaire. La confirmation runtime côté utilisateur est nécessaire pour valider le rendu visuel du badge "Essai · Xj".
- **Filet de sécurité `lastFetchOk` du correctif précédent** : conservé. Il ne ciblait pas la bonne cause mais reste utile comme défense en profondeur contre les vrais échecs de fetch.
- **Logs `[Subscription Fetch]` retirés** (cause identifiée, instrumentation n'est plus nécessaire). Suite complète toujours à 1262/1265 ✅.

### [2026-05-25] — Lot 3 — Correctifs Bugs 1, 2, 3

- **Bug 1 (étapes onboarding manquantes)** — `app/auth/signup/page.jsx` : `router.replace("/dashboard")` remplacé par `router.replace("/onboarding/success")` dans la branche `if (appTrialEnabled)`. La page `/onboarding/success` (welcome → invite → theme) fonctionne déjà sans `session_id` Stripe (early-return l.125-128). Le nouveau flow reprend ainsi les 3 étapes UI manquantes avant le dashboard.
- **Bug 2 (org "Mon entreprise")** — `app/api/onboarding/step/route.js` : `orgPatch` (branche `targetStep === "completed" && isAppTrialEnabled()`) inclut désormais le champ `name` (Better Auth natif, lu par l'org-switcher) en plus de `companyName` (Newbi additional). L'org affiche maintenant le vrai nom de l'entreprise choisie au workspace step.
- **Bug 3 (statut "expiré" affiché à tort)** — 3 actions :
  - **Refresh session client** dans `signup/page.jsx` (branche flag ON) : `authClient.getSession({ fetchOptions: { cache: "no-store" } })` après le workspace submit, avant le redirect. Évite que le cookieCache de 5 min (`auth.js:80-83`) serve une session sans le nouvel `activeOrganizationId`.
  - **Instrumentation diagnostique** dans `useDashboardLayoutSimple` : logs `[Subscription Fetch]` (orgId fetched, session orgId, HTTP status, `appTrialEnabled`, `isTrialActive`, `trialEndDate`) pour observer le comportement réel en production. À retirer une fois la cause racine confirmée par observation runtime.
  - **Filet de sécurité "échec de fetch ≠ expiré"** : nouveau state `lastFetchOk` dans `useDashboardLayoutSimple` (default `true`, flippé à `false` sur réponse non-ok ou exception réseau). Exposé via `useSubscription()`. `useSubscriptionAccess` n'évalue le verdict "isReadOnly" qu'à condition de `lastFetchOk !== false` — un échec de fetch n'affiche plus la bannière rouge "expiré".
- **Tests** : 2 nouveaux cas dans `__tests__/hooks/use-subscription-access.test.js` couvrant le filet de sécurité (fetch failure + no sub → no readOnly ; Stripe-active reste full access). Suite complète newbiv2 → **1257/1260** ✅ (3 skips préexistants, zéro régression).
- **À faire en suivi** : confirmer la cause racine du Bug 3 par observation runtime (logs `[Subscription Fetch]`), puis retirer les logs temporaires. Le filet de sécurité reste en place quelle que soit la cause confirmée.

### [2026-05-25] — Lot 3 terminé ⭐ (cœur de la refonte)

- **`org-creation.js`** : signature étendue avec `appTrialDays` (number|null) et `markOnboardingComplete` (boolean, default true). Nouvelle branche 4b "App-managed trial" qui pose les 5 champs trial sur l'org sans toucher à la collection `subscription`. Branche existante (Stripe) inchangée → backward-compatible.
- **`auth.js` databaseHooks.user.create.after** : nouveau bloc gated par `isAppTrialEnabled()` qui crée immédiatement org placeholder ("Mon entreprise") + member + trial 14j pour tout nouvel user non-invité. La branche invité reste strictement inchangée. Quand flag OFF : code totalement ignoré ⇒ flow historique conservé.
- **Workspace step submit** : `signup/page.jsx` détecte `appTrialEnabled` (via `/api/feature-flags`) et choisit dynamiquement la transition : flag ON ⇒ `workspace → completed` direct + redirect /dashboard ; flag OFF ⇒ `workspace → plan` (flow historique 3 étapes).
- **Onboarding transitions** : `workspace → completed` ajoutée comme transition valide ; la garde feature-flag est appliquée dans `/api/onboarding/step/route.js` (refuse "completed" quand flag OFF → non-régression).
- **`/api/onboarding/step`** : nouveau chemin gated qui applique les `data` workspace à l'org placeholder (companyName, SIRET, adresse) puis marque le user completed en un update atomique.
- **`/api/feature-flags`** : nouvelle route GET (sans auth) qui expose `{ appTrialEnabled }` au signup page client.
- **Décision #16 enforcement (multi-org)** :
  - **À l'entrée** `/api/create-org-subscription` : quand flag ON et user a déjà au moins un member, `trial_period_days = 0` (paiement immédiat sur l'org additionnelle).
  - **Défense en profondeur** `org-creation.js` branche app-trial : si user a une autre org `hasUsedTrial: true`, pas de re-trial même si `appTrialDays` fourni.
- **`/api/organizations/[id]/complete-onboarding`** : `hasActiveSubscription` reconnaît le trial app actif (lookup organization derrière `isAppTrialEnabled()`).
- **Tests** : 24 nouveaux tests passent (3 org-creation appTrialDays / décision #16 / markOnboardingComplete, 18 onboarding.js, 3 feature-flags). Suite complète newbiv2 → **1255/1258** ✅ (3 skips préexistants). Suite newbi-api → **544/546** ✅ (2 skips). Zéro régression sur 1799 tests existants.
- **Décision #5** (page `/onboarding/success` → welcome screen simple) → déplacée au Lot 5 (cohérence avec la refonte Stripe).
- **Garantie rollback** : `ENABLE_APP_TRIAL=false` (défaut) → tout le Lot 3 est neutralisé. Le flow d'inscription (signup → workspace → plan → recap → Stripe Checkout → webhook → /onboarding/success) fonctionne strictement comme avant.

### [2026-05-25] — Lot 2 terminé

- API `/api/organizations/[id]/subscription` expose maintenant `appTrialEnabled` (mirror du flag serveur) pour gating client-side
- `useDashboardLayoutSimple` : `isActive()` retourne true sur trial app actif ; le fetch initial conserve les données quand trial actif (au lieu de mettre `subscription = null`) ; le cache localStorage de chargement reconnaît aussi les payloads avec `appTrialEnabled === true`
- `useSubscriptionAccess` : nouvelle source `isTrialApp` (`appTrialEnabled && isTrialActive && trialEndDate > now`) ; `isReadOnly` court-circuité quand `isTrialApp` ; `trialDaysRemaining` calculé sur `trialEndDate`
- `dashboard/layout.jsx` : `hasValidSubscription` étendu — query `organization` derrière `isAppTrialEnabled()`, fallback transparent vers le check sub Stripe existant ; **un user en sub Stripe `active` ne déclenche AUCUNE query supplémentaire et n'est jamais redirigé** (testé)
- Nouveau composant `src/components/trial-banner.jsx` — décision #6 respectée à la lettre (J-3 → J0 seulement, jamais avant), copy adaptée jour restant (3 jours → 1 jour → "aujourd'hui"), CTA "Souscrire" owner only
- Banner monté dans `dashboard-client-layout.jsx` sous `SubscriptionReadOnlyBanner`
- UI settings adaptées : `facturation-section` montre "Aucun abonnement actif — essai gratuit en cours" + CTA "Souscrire" pour trial app sans Stripe customer ; `subscription-section` cache le bouton "Résilier" si pas de `stripeSubscriptionId` (le toast.error ne s'affiche plus jamais)
- Tests : 27 nouveaux/étendus, 0 régression. Suite complète newbiv2 → **1231/1234** ✅ (3 skips préexistants)
- **Décision #12** (past_due back/front) → déplacée au Lot 5 (cohérent avec adaptations Stripe)
- **Adaptation `complete-onboarding`** → déplacée au Lot 3 (cohérent avec création d'org au signup)

### [2026-05-25] — Lot 1 terminé

- Feature flag `ENABLE_APP_TRIAL` ajouté (default OFF) côté backend + frontend
- Helper partagé `isTrialAppActive(org)` créé dans les deux projets, logique identique
- `rbac.checkSubscriptionActive` étend la décision d'accès avec un check trial AVANT Stripe (court-circuit). Cache LRU 30s dédié + `invalidateTrialCache(orgId)` exporté. Comportement strictement identique quand le flag est OFF.
- `require-active-subscription` (Next.js) suit la même règle
- Route `/api/organizations/[id]/subscription` expose maintenant `isTrialActive, trialStartDate, trialEndDate, stripeTrialActive, hasUsedTrial` (lookup org en parallèle de la sub)
- 19 tests unitaires écrits et passent (vitest) — couvrent flag ON/OFF, trial actif, trial expiré, combinaisons Stripe, cache, fallback sur erreur DB
- Test suite complète : 544/546 passent (2 skip préexistants), zéro régression
- **Décision #11 (formaliser `stripeTrialActive` dans `auth-plugins.js`)** : déplacée au Lot 5 pour cohérence avec les autres modifs du fichier

### [2026-05-25] — Setup

- Création du document de suivi `REFONTE-TRIAL-SUIVI.md`
- Audit technique complet produit (9000 mots, 9 sections A-I)
- Audit ciblé 3 points produit (régression commissions confirmée)
- 16 décisions de cadrage figées
- Chantier prêt à démarrer sur le Lot 1

---
