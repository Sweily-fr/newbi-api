# Branch Protection Rules — newbi-api

## Configuration à activer sur GitHub

### Branches protégées : `develop` et `main`

#### Paramètres requis :

- ✅ **Require a pull request before merging**
  - Require approvals : 1 minimum
- ✅ **Require status checks to pass before merging**
  - Status checks requis :
    - `lint`
    - `unit-tests`
    - `integration-tests`
- ✅ **Require branches to be up to date before merging**
- ✅ **Do not allow bypassing the above settings**
- ❌ **Allow force pushes** — Désactivé
- ❌ **Allow deletions** — Désactivé

### Comment configurer

1. Aller dans **Settings** > **Branches** > **Add branch protection rule**
2. Branch name pattern : `main` (puis répéter pour `develop`)
3. Cocher les paramètres ci-dessus
4. Ajouter les status checks par nom exact
5. Sauvegarder

### Workflow de développement

1. Créer une branche `feature/xxx` depuis `develop`
2. Développer et committer
3. Ouvrir une PR vers `develop`
4. CI passe automatiquement (lint + tests unitaires + tests intégration)
5. Review par un pair (1 approbation minimum)
6. Merge dans `develop`
7. Pour la production : PR de `develop` vers `main`
