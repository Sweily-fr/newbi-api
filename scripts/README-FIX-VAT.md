# Script de correction des numéros de TVA

## Problème

Après la mise à jour de la validation des numéros de TVA, certaines factures et devis existants contiennent des numéros de TVA au format invalide, ce qui cause l'erreur :

```
"Le format du numéro de TVA n'est pas valide"
```

## Solution

Ce script de migration corrige automatiquement tous les numéros de TVA invalides dans les factures et devis existants.

## Utilisation

### 1. Backup de la base de données (RECOMMANDÉ)

Avant d'exécuter le script, faites une sauvegarde de votre base de données :

```bash
# Exemple avec mongodump
mongodump --uri="mongodb://localhost:27017/newbi" --out=./backup-before-vat-fix
```

### 2. Exécuter le script

```bash
cd newbi-api
node scripts/fix-vat-numbers.js
```

### 3. Vérifier les résultats

Le script affichera :
- Le nombre de factures/devis corrigés
- Le nombre de factures/devis ignorés (déjà valides)
- Les erreurs éventuelles

Exemple de sortie :

```
🔧 Script de correction des numéros de TVA
==========================================

✅ Connecté à MongoDB

📄 Traitement des factures...
   Trouvé 45 factures
   ✓ Facture INV-001: TVA invalide "FR123" → vidé
   ✓ Facture INV-005: TVA invalide "INVALID" → vidé

   Résumé factures:
   - Corrigées: 2
   - Ignorées (OK): 43
   - Erreurs: 0

📋 Traitement des devis...
   Trouvé 30 devis
   ✓ Devis DEV-003: TVA invalide "FR" → vidé

   Résumé devis:
   - Corrigés: 1
   - Ignorées (OK): 29
   - Erreurs: 0

==========================================
✅ Migration terminée avec succès!

Résumé global:
- Factures corrigées: 2
- Devis corrigés: 1
- Total corrigé: 3
- Total erreurs: 0

🔌 Déconnexion de MongoDB
```

## Que fait le script ?

1. **Connexion à MongoDB** : Se connecte à la base de données
2. **Scan des factures** : Parcourt toutes les factures
3. **Validation** : Vérifie si le numéro de TVA est valide selon le format FR (ex: FR12345678901)
4. **Correction** : Si invalide, vide le champ `vatNumber`
5. **Répétition pour les devis** : Même processus pour les devis
6. **Rapport** : Affiche un résumé des corrections

## Format de TVA valide

Le script valide les numéros de TVA français selon le format :
- **Format** : `FR` suivi de 11 chiffres
- **Exemple valide** : `FR12345678901`
- **Exemples invalides** : `FR123`, `INVALID`, `FR`, etc.

## Après l'exécution

Après avoir exécuté le script :

1. ✅ Les factures et devis avec des numéros de TVA invalides auront ce champ vidé
2. ✅ Plus d'erreur "Le format du numéro de TVA n'est pas valide"
3. ✅ Les utilisateurs peuvent mettre à jour manuellement les numéros de TVA si nécessaire

## Alternative : Correction manuelle

Si vous préférez ne pas utiliser le script, vous pouvez :

1. Identifier les documents problématiques
2. Éditer manuellement chaque facture/devis
3. Corriger ou vider le champ numéro de TVA

Mais le script est **beaucoup plus rapide** et **sûr** pour traiter plusieurs documents.

## Sécurité

- ✅ Le script utilise `validateBeforeSave: false` pour éviter d'autres erreurs de validation
- ✅ Il ne modifie QUE le champ `vatNumber`
- ✅ Il log toutes les modifications
- ✅ Il gère les erreurs individuellement (une erreur n'arrête pas tout le processus)

## Support

Si vous rencontrez des problèmes :
1. Vérifiez que MongoDB est accessible
2. Vérifiez que la variable `MONGODB_URI` est correcte dans `.env`
3. Consultez les logs d'erreur affichés par le script
