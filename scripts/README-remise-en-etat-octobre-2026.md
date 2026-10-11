# Remise en état des données, octobre 2026

Cette fiche explique comment lancer, sur le serveur de production, les scripts
qui remettent en état les données enregistrées avant les corrections de calcul
d'octobre 2026 :

1. `backfill-purchase-invoice-ocr-metadata.js` : montant et devise du
   justificatif (`ocrMetadata`) des factures d'achat ;
2. `recompute-credit-note-totals.js` : totaux enregistrés des avoirs (frais de
   port de la facture d'origine, remise globale) ;
3. `recompute-quote-purchase-order-totals.js` : totaux enregistrés des devis et
   bons de commande (frais de port, remise globale) ;
4. `rearchive-modified-invoices.js` : PDF archivé des factures modifiées après
   leur archivage.

Tous fonctionnent de la même façon :

- sans option, c'est un **aperçu** : le script liste ce qu'il ferait et
  n'écrit rien ;
- avec `--apply`, il écrit. Avant la première écriture, il enregistre une
  **sauvegarde** des valeurs d'avant dans `backups/remise-en-etat/` (le chemin
  exact est affiché à la fin) ;
- `--restore <fichier>` remet les valeurs de cette sauvegarde (aperçu sans
  `--apply`, écriture avec). Un document modifié dans l'appli depuis le script
  est laissé tel quel ;
- `--workspace <id>` limite à une organisation, `--limit <n>` au nombre de
  documents examinés ;
- relancer un script ne refait rien : un document corrigé n'est plus listé ;
- la date de modification des documents (`updatedAt`) ne change pas.

Signes utilisés dans les listes :

| Signe | Sens                                                                  |
| ----- | --------------------------------------------------------------------- |
| `·`   | document à corriger (corrigé avec `--apply`)                          |
| `🔒`  | transmis en facturation électronique : jamais modifié, listé à part   |
| `⏸`   | devis ou bon de commande finalisé : ignoré sans `--include-finalized` |
| `⚠️`  | point à vérifier à la main                                            |
| `?`   | avoir dont la facture d'origine est introuvable : ignoré              |
| `-`   | document modifié entre l'aperçu et l'écriture : laissé tel quel       |

## 0. Avant de commencer

**Les scripts se lancent seulement après la mise en production de la release
qui les contient.** Cette release apporte aussi les corrections de l'API
(totaux des avoirs, réarchivage automatique des factures, verrou
e-facturation). Lancés avant, l'ancien code continuerait de produire des
totaux faux et des archives périmées.

Connexion au serveur et vérification que la release est bien là :

```bash
ssh -i ~/.ssh/vps_key joaquim@51.91.254.74
cd ~/api.newbi.fr
source ~/.nvm/nvm.sh

ls scripts/recompute-credit-note-totals.js scripts/rearchive-modified-invoices.js
grep -c "computeDocumentTotals" src/resolvers/creditNote.js   # au moins 1
grep -c "rearchiveAfterUpdate" src/resolvers/invoice.js        # au moins 1
```

Si un fichier manque ou qu'un compteur vaut 0, la release n'est pas encore en
production : s'arrêter là.

Toutes les commandes suivantes se lancent depuis `~/api.newbi.fr` :
`NODE_ENV=production` y charge `.env.production`. Chaque script affiche au
début la base à laquelle il est connecté : vérifier que c'est la base de
production.

Conseil : garder chaque aperçu dans un fichier pour le relire tranquillement,
en ajoutant `| tee ~/<nom>.txt` à la commande (exemples ci-dessous).

## 1. Factures d'achat : montant du justificatif (`ocrMetadata`)

Remplit `ocrMetadata` des factures d'achat qui ont un justificatif lu par l'OCR
mais aucune métadonnée enregistrée (ligne « Montant sur le justificatif »
absente du tiroir). Rien d'autre n'est touché.

Aperçu :

```bash
NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js | tee ~/remise-ocr-apercu.txt
```

À relire : le nombre de factures « remplissables », et pour quelques-unes le
montant et la devise affichés (ils viennent du justificatif). Les factures
« illisibles » sont laissées telles quelles.

Écriture :

```bash
NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js --apply
```

Retour arrière (remet l'ancien `ocrMetadata`) :

```bash
NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js --restore backups/remise-en-etat/factures-achat-ocr-metadata-<date>.json
NODE_ENV=production node scripts/backfill-purchase-invoice-ocr-metadata.js --restore backups/remise-en-etat/factures-achat-ocr-metadata-<date>.json --apply
```

## 2. Avoirs : totaux enregistrés

Recalcule les totaux de chaque avoir avec le calcul actuel de l'API (frais de
port de la facture d'origine ajoutés, remise globale sur les articles
seulement) et ne réécrit que ceux qui diffèrent au centime. Le PDF des avoirs
n'est pas régénéré : il affichait déjà ces montants.

Un avoir transmis en facturation électronique n'est **jamais** modifié : il
apparaît avec `🔒` et son écart, pour information.

Aperçu :

```bash
NODE_ENV=production node scripts/recompute-credit-note-totals.js | tee ~/remise-avoirs-apercu.txt
```

À relire :

- chaque ligne `·` donne le numéro de l'avoir, sa facture et chaque total
  « avant → après ». La raison est indiquée entre crochets : `[port facturé]`,
  `[remise globale]`. Une ligne sans crochets mérite un coup d'oeil ;
- les lignes `🔒` : avoirs transmis, laissés tels quels ;
- les lignes `⚠️` : la somme des avoirs corrigés dépasserait le TTC enregistré
  de la facture. Souvent parce que le total enregistré de la facture elle-même
  est faux (facture avec port et remise en pourcentage d'avant le 10/10, voir
  « Hors périmètre »). Rien n'est bloqué, mais à regarder dans l'appli.

Écriture :

```bash
NODE_ENV=production node scripts/recompute-credit-note-totals.js --apply
```

Retour arrière :

```bash
NODE_ENV=production node scripts/recompute-credit-note-totals.js --restore backups/remise-en-etat/avoirs-totaux-<date>.json
NODE_ENV=production node scripts/recompute-credit-note-totals.js --restore backups/remise-en-etat/avoirs-totaux-<date>.json --apply
```

## 3. Devis et bons de commande : totaux enregistrés

Recalcule les totaux comme le fait l'enregistrement d'un devis ou d'un bon de
commande aujourd'hui (frais de port compris, remise plafonnée). Sans le
script, chaque document ne serait corrigé qu'à son prochain enregistrement ;
d'ici là les listes et les statistiques gardent les anciens montants.

Documents finalisés (devis en attente, accepté, refusé, importé ; bon de
commande confirmé, validé, en cours, livré, annulé) : ils ont un PDF archivé.
Ce PDF calcule ses totaux à partir des lignes, frais de port compris : il
affiche **déjà** les bons montants. Corriger les totaux enregistrés les aligne
sur le PDF, sans le régénérer. Par prudence, ils sont seulement listés (`⏸`)
tant que `--include-finalized` n'est pas ajouté.

Aperçu :

```bash
NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js | tee ~/remise-devis-bc-apercu.txt
```

À relire : les lignes `·` (brouillons, corrigés avec `--apply`) et les lignes
`⏸` (finalisés). Pour un devis `⏸`, on peut ouvrir son PDF dans l'appli : le
total affiché doit être la valeur « après ».

Écriture, en deux temps :

```bash
# brouillons seulement
NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --apply

# puis, si la liste ⏸ est bonne, les documents finalisés
NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --include-finalized --apply
```

Options en plus : `--type quote` ou `--type purchaseOrder` pour ne traiter
qu'un des deux types (`--limit` s'applique par type).

Retour arrière (une sauvegarde par lancement avec `--apply`) :

```bash
NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --restore backups/remise-en-etat/devis-bc-totaux-<date>.json
NODE_ENV=production node scripts/recompute-quote-purchase-order-totals.js --restore backups/remise-en-etat/devis-bc-totaux-<date>.json --apply
```

## 4. Factures modifiées après leur archivage : nouveau PDF

Avant la correction, une facture en attente ou payée modifiée gardait le PDF
Factur-X de sa finalisation (aperçu, bouton PDF, e-mails et relances sans PDF
joint). Le script régénère l'archive de ces factures avec le même service que
l'API (génération par www.newbi.fr), comme le fait maintenant l'API après
chaque modification.

Sont listées les factures émises dont la date de modification dépasse la date
d'archivage de plus d'une minute (`--marge <secondes>` pour changer). La liste
est **plus large que nécessaire** : un paiement, un envoi par e-mail ou un
rapprochement changent aussi la date de modification. Réarchiver une facture
inchangée redonne le même contenu, cela coûte seulement une génération de PDF.

Une facture transmise en facturation électronique n'est **jamais**
réarchivée (`🔒`) : le document qui fait foi est celui reçu par la
plateforme. Ne pas utiliser `regenerate-archived-pdfs.js` pour ce rattrapage :
il ne fait pas cette exclusion.

Aperçu :

```bash
NODE_ENV=production node scripts/rearchive-modified-invoices.js | tee ~/remise-factures-apercu.txt
```

À relire : le nombre de factures à réarchiver (chaque ligne donne la date
d'archivage et la date de modification) et les lignes `🔒`. Options utiles :
`--avant <date>` ne garde que les factures modifiées avant une date (par
exemple l'heure de la mise en production : après, l'API réarchive toute
seule), `--depuis <date>`, `--workspace <id>`.

Écriture : d'abord trois factures, à vérifier dans l'appli (aperçu et bouton
PDF à jour), puis le reste. Le script affiche l'adresse qui génère les PDF :
elle doit être `https://www.newbi.fr`.

```bash
NODE_ENV=production node scripts/rearchive-modified-invoices.js --limit 3 --apply
```

Pour tout le reste, le traitement peut être long (quelques secondes par
facture, pause de 2 s entre deux). Le lancer détaché, avec le journal dans le
dossier personnel (pas dans `/tmp`) :

```bash
nohup env NODE_ENV=production node scripts/rearchive-modified-invoices.js --apply > ~/remise-factures.log 2>&1 < /dev/null &
tail -f ~/remise-factures.log
```

La fin du journal donne le nombre de factures réarchivées, les échecs (à
relancer simplement : les factures déjà faites ne sont plus listées) et le
chemin de la sauvegarde.

Ce que contient la sauvegarde : les anciens champs d'archive de chaque facture
et, dans le dossier `factures-rearchivage-<date>-pdf/` à côté, une copie de
l'ancien PDF (une facture archivée le même mois garde la même clé de stockage,
la nouvelle archive écrase alors l'ancienne).

Retour arrière (remet l'ancienne archive, et l'ancien PDF quand il avait été
écrasé) :

```bash
NODE_ENV=production node scripts/rearchive-modified-invoices.js --restore backups/remise-en-etat/factures-rearchivage-<date>.json
NODE_ENV=production node scripts/rearchive-modified-invoices.js --restore backups/remise-en-etat/factures-rearchivage-<date>.json --apply
```

## 5. Après coup

Garder les sauvegardes quelques semaines. Pour en avoir une copie sur le Mac :

```bash
scp -i ~/.ssh/vps_key -r joaquim@51.91.254.74:~/api.newbi.fr/backups/remise-en-etat ~/Desktop/remise-en-etat-octobre-2026
```

## Hors périmètre

Aucun script ne touche aux **totaux enregistrés des factures**. Une facture
avec frais de port et remise globale en pourcentage enregistrée (créée ou
modifiée) avant la correction du 10/10/2026 garde un total où la remise
s'appliquait aussi au port, alors que son PDF affiche le bon montant. Ces totaux servent au
paiement, au rapprochement et au XML Factur-X : leur correction demande une
décision à part.
