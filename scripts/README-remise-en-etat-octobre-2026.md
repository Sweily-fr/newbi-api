# Remise en état des données, octobre 2026

Cette fiche explique comment lancer, sur le serveur de production, les scripts
qui remettent en état les données enregistrées avant les corrections de calcul
d'octobre 2026 :

1. `backfill-purchase-invoice-ocr-metadata.js` : montant et devise du
   justificatif (`ocrMetadata`) des factures d'achat ;
2. `recompute-credit-note-totals.js` : totaux enregistrés des avoirs (frais de
   port de la facture d'origine, remise globale) ;
3. `recompute-invoice-totals.js` : totaux enregistrés des factures (remise
   globale en pourcentage appliquée aussi aux frais de port) et leur PDF
   Factur-X archivé ;
4. `recompute-quote-purchase-order-totals.js` : totaux enregistrés des devis et
   bons de commande (frais de port, remise globale) ;
5. `rearchive-modified-invoices.js` : PDF archivé des factures modifiées après
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
|       | facture d'une autre cause : ignorée avec `--port-remise`              |
| `⚠️`  | point à vérifier à la main                                            |
| `?`   | avoir dont la facture d'origine est introuvable : ignoré              |
|       | facture aux totaux incalculables (ligne incomplète) : ignorée         |
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

ls scripts/recompute-credit-note-totals.js scripts/recompute-invoice-totals.js scripts/rearchive-modified-invoices.js
grep -c "computeDocumentTotals" src/resolvers/creditNote.js   # au moins 1
grep -c "computeDocumentTotals" src/resolvers/invoice.js      # au moins 1
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
  est faux (facture avec port et remise en pourcentage d'avant le 10/10) :
  l'étape 3 le corrige, et son aperçu refait ce contrôle avec le nouveau
  total. Rien n'est bloqué, mais à regarder dans l'appli.

Écriture :

```bash
NODE_ENV=production node scripts/recompute-credit-note-totals.js --apply
```

Retour arrière :

```bash
NODE_ENV=production node scripts/recompute-credit-note-totals.js --restore backups/remise-en-etat/avoirs-totaux-<date>.json
NODE_ENV=production node scripts/recompute-credit-note-totals.js --restore backups/remise-en-etat/avoirs-totaux-<date>.json --apply
```

## 3. Factures : totaux enregistrés et PDF Factur-X

Avant la correction du 10/10/2026, une facture avec frais de port et remise
globale en pourcentage était enregistrée avec une remise appliquée aussi au
port. Son PDF affichait le bon montant (il calcule à partir des lignes), mais
pas les totaux enregistrés, que lisent le XML Factur-X, le paiement en ligne,
le rapprochement, le plafond des avoirs et les statistiques. Le script
recalcule les totaux de chaque facture avec le calcul actuel de l'API et ne
réécrit que celles qui diffèrent au centime.

Les brouillons sont corrigés aussi : l'enregistrement d'une facture ne
recalcule pas ses totaux, et « Créer la facture » depuis le panneau latéral
finalise un brouillon tel quel. Ils n'ont ni PDF archivé ni paiement.

Une facture transmise en facturation électronique n'est **jamais** modifiée :
elle apparaît avec `🔒` et son écart. Elle se corrige par un avoir.

Le script ne touche ni aux paiements, ni aux rapprochements, ni aux avoirs :
il les affiche sous chaque facture et signale (`⚠️`) ceux que le nouveau total
rendrait incohérents.

Lancer cette étape **après les avoirs** (étape 2) : son contrôle des avoirs
utilise leurs montants corrigés.

Aperçu :

```bash
NODE_ENV=production node scripts/recompute-invoice-totals.js | tee ~/remise-factures-totaux-apercu.txt
```

À relire :

- chaque ligne `·` donne le numéro de la facture, son statut, son espace,
  chaque total « avant → après » et l'écart TTC. La raison est entre
  crochets : `[port + remise globale en %]` est le cas corrigé le 10/10.
  `[autre]` ou `[totaux absents]` méritent un coup d'oeil : ouvrir la facture
  dans l'appli, le total de son PDF doit être la valeur « après ». En cas de
  doute, `--port-remise` ne traite que le cas du 10/10 (les autres sont listés
  avec `⏸`) ;
- sous chaque facture :
  - `paiement :` les transactions rapprochées (ou le paiement par carte, ou
    « marquée payée » sans montant) et l'état « payée / partiellement payée »
    avec l'ancien et le nouveau total ;
  - `avoirs :` les avoirs liés, leur somme et la couverture de la facture ;
  - `archive :` le PDF Factur-X à régénérer (son XML porte les anciens
    totaux) ;
- les lignes `⚠️ paiement` : la facture a été réglée de l'ancien montant
  (virement rapproché, ou carte qui débite le total enregistré) ; avec le
  nouveau total il reste quelques centimes ou euros à encaisser. La facture
  reste « Payée » dans l'appli : c'est à décider avec le client ;
- les lignes `⚠️ avoirs` : un avoir total à l'ancien montant ne couvrirait
  plus toute la facture, ou la somme des avoirs dépasserait le nouveau total ;
- les lignes `🔒` : factures transmises, à corriger par un avoir si l'écart le
  justifie ;
- le bilan à la fin : nombre de factures à corriger (dont brouillons),
  transmises, alertes et archives à régénérer.

Écriture avec régénération des PDF archivés (`--rearchive`, même mécanisme
que l'étape 5 : génération par www.newbi.fr, copie locale de l'ancien PDF,
date de modification inchangée). D'abord une organisation, prise dans
l'aperçu (`espace <id>`), à vérifier dans l'appli : total de la facture,
aperçu et bouton PDF à jour. Le script affiche l'adresse qui génère les PDF :
elle doit être `https://www.newbi.fr`.

```bash
NODE_ENV=production node scripts/recompute-invoice-totals.js --workspace <id> --apply --rearchive
```

Puis tout le reste, détaché (pause de 2 s entre deux PDF, `--delay <ms>`) :

```bash
nohup env NODE_ENV=production node scripts/recompute-invoice-totals.js --apply --rearchive > ~/remise-factures-totaux.log 2>&1 < /dev/null &
tail -f ~/remise-factures-totaux.log
```

Chaque lancement avec `--apply` a sa sauvegarde, dont le chemin est affiché à
la fin. **Archives restées à régénérer** (lancement sans `--rearchive`, ou
échecs de génération) : l'étape 5 ne les retrouverait pas (la correction ne
change pas la date de modification). Les reprendre depuis la sauvegarde du
lancement, la commande exacte est affichée à la fin du journal :

```bash
NODE_ENV=production node scripts/recompute-invoice-totals.js --reprendre backups/remise-en-etat/factures-totaux-<date>.json
NODE_ENV=production node scripts/recompute-invoice-totals.js --reprendre backups/remise-en-etat/factures-totaux-<date>.json --apply
```

Une facture modifiée dans l'appli depuis la correction n'est pas reprise :
l'API a déjà régénéré son PDF.

Retour arrière (remet les totaux d'avant et, pour les factures réarchivées,
l'ancienne archive, plus l'ancien PDF quand il avait été écrasé) :

```bash
NODE_ENV=production node scripts/recompute-invoice-totals.js --restore backups/remise-en-etat/factures-totaux-<date>.json
NODE_ENV=production node scripts/recompute-invoice-totals.js --restore backups/remise-en-etat/factures-totaux-<date>.json --apply
```

## 4. Devis et bons de commande : totaux enregistrés

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

## 5. Factures modifiées après leur archivage : nouveau PDF

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

Les factures dont l'étape 3 a corrigé les totaux n'y figurent pas (sauf si
elles avaient été modifiées après leur archivage) : leur PDF se régénère par
l'étape 3 (`--rearchive` ou `--reprendre`).

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

## 6. Après coup

Garder les sauvegardes quelques semaines. Pour en avoir une copie sur le Mac :

```bash
scp -i ~/.ssh/vps_key -r joaquim@51.91.254.74:~/api.newbi.fr/backups/remise-en-etat ~/Desktop/remise-en-etat-octobre-2026
```

## Hors périmètre

- Les factures **transmises en facturation électronique** gardent leurs
  totaux et leur archive (lignes `🔒` de l'étape 3) : un écart se corrige par
  un avoir, au cas par cas.
- Les **paiements, rapprochements et avoirs** ne sont jamais modifiés : les
  lignes `⚠️` de l'étape 3 se traitent à la main, dans l'appli.
