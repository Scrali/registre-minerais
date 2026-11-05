# Stocks personnels par membre et par lieu

Évolution du registre : chaque membre possède son propre inventaire dans chaque lieu, les captures mettent à jour ces inventaires **par comparaison** avec le relevé précédent, et l'inventaire global additionne les stocks personnels sans double comptage.

## 1. Ce qui est conservé

- Hébergement statique (GitHub Pages), Supabase (Auth, Postgres, RLS, Realtime), Edge Function `analyze-capture` avec Claude.
- Rôles `pending` / `member` / `admin`, triggers `handle_new_user` et `guard_profile`.
- Catalogue `resources` : noms corrigés, couleurs, image principale et vues de référence (`image`, `refs`).
- Journal `movements` : aucune ligne supprimée ni modifiée ; il reçoit simplement de nouvelles colonnes.
- Capture multi-pages, vignettes, regroupement par type de caillou, bouton « Séparer », images de référence.

## 2. Ce qui change

| Avant | Après |
|---|---|
| Un stock par ressource et par lieu, sans propriétaire (`resources.places`) | Un stock par **membre + lieu + ressource + qualité + unité** (`user_stocks`) |
| Une capture en mode « stock complet » remplaçait le stock, en mode « récolte » l'additionnait | Une capture est toujours une **observation** : on enregistre l'écart avec le relevé précédent |
| Lieu = texte libre | Lieu = table `locations` avec identifiant normalisé (casse, accents, espaces) |
| Total = somme des lots par ressource | Total global = somme des **stocks personnels** ; les anciens stocks restent à part |
| Hausse = « entrée » | Nature explicite : stock initial, production, dépôt, transfert, achat, retrait, vente, raffinage, perte, correction, ou « à classer » |

## 3. Nouveau schéma (migration `006_stocks_personnels.sql`)

```
locations        (id, name, slug UNIQUE, created_at, created_by)
user_stocks      (id, user_id, location_id, resource_id, quality_key, unit, quantity numeric(16,3),
                  updated_at, last_scan_id, version)
                 UNIQUE (user_id, location_id, resource_id, quality_key, unit)
inventory_scans  (id, user_id, author_id, location_id, terminal_type, observed_at, created_at,
                  coverage_status, validation_status, idempotency_key UNIQUE, image_fingerprint[],
                  page_count, note, result)
scan_items       (id, scan_id, resource_id, quality_key, quantity, unit, confidence, image_reference,
                  validation_status)
legacy_stocks    (id, resource_id, resource_name, place_name, location_id, quality_key, quantity,
                  status open|attributed|archived, attributed_to, resolved_by, resolved_at, note)
movements        + owner_id, location_id, quality_key, delta, kind, scan_id, classified_by, classified_at
archive.resources_avant_006, archive.movements_avant_006   (copie de sauvegarde, non exposée)
```

- **Qualité inconnue** : `quality_key = '-'` (jamais NULL), pour que la contrainte d'unicité s'applique.
- **Unités** : `unit` est l'unité affichée par le jeu (`''` pour un nombre d'objets « 20x », `SCU`, `cSCU`…). Aucune conversion : 20 objets et 20 SCU sont deux stocks distincts.
- **Propriétaire** : `user_id` est l'UUID Supabase Auth, déterminé côté serveur par `auth.uid()`. Seul un administrateur peut agir pour un autre membre, et il doit indiquer un motif.
- **Terminaux** : le type d'écran (`inventaire`, `ascenseur_fret`…) est une information du relevé, pas une partie de la clé. Deux écrans qui montrent le même inventaire physique mettent à jour la même ligne. Pour un stock réellement distinct (un hangar, un vaisseau), on crée un lieu distinct (« Lorville — Hangar 3 »).

## 4. Calcul des variations (`apply_scan`)

Pour un relevé `p` (lieu, couverture, lignes observées) :

1. Le propriétaire est `auth.uid()` (ou le membre choisi par un admin). Un compte non validé est refusé.
2. Le lieu est résolu par son identifiant normalisé (`ensure_location`).
3. Verrou transactionnel sur (propriétaire, lieu) : deux enregistrements simultanés du même inventaire passent l'un après l'autre.
4. **Idempotence** : si la clé du relevé existe déjà, le résultat d'origine est renvoyé et rien n'est réappliqué.
5. **Relevé ancien** : si la date de la capture est antérieure au dernier état connu de cet inventaire, l'enregistrement est refusé (`STALE`), sauf confirmation explicite.
6. **État modifié depuis l'aperçu** : l'aperçu renvoie une empreinte de l'inventaire ; si elle a changé au moment d'enregistrer, refus (`STATE_CHANGED`) et nouvel aperçu.
7. Les lignes observées sont regroupées par (ressource, qualité, unité) : plusieurs cases d'un même lot s'additionnent.
8. Pour chaque ligne : stock précédent (verrouillé), écart = observé − précédent.
   - pas de ligne précédente : **stock initial** (jamais compté comme apport) ;
   - écart nul : rien ;
   - écart positif : nature choisie (production, dépôt…) ou « hausse à classer » ;
   - écart négatif : nature choisie (vente, raffinage…) ou « baisse à classer ».
9. **Couverture** : en relevé partiel, les ressources absentes ne changent pas. En inventaire complet (choisi explicitement et confirmé dans l'aperçu), les lignes absentes passent à 0.
10. Écriture du relevé, de ses lignes, des stocks et des mouvements dans **une seule transaction**.

Exemple (Matsu89, Lorville, Quantainium Q258) : 10 → stock initial ; 18 → +8 ; 25 → +7 ; 25 → aucun mouvement ; 20 → −5 « à classer » (ou la nature choisie). Stock final : 20.

`apply_scan(p, true)` fait le même calcul sans rien écrire : c'est l'aperçu affiché avant l'enregistrement.

Autres fonctions : `adjust_stock` (dépôt, retrait, correction avec motif obligatoire), `classify_movement` (préciser après coup une hausse ou une baisse), `resolve_legacy` (rapprochement des anciens stocks, admin).

## 5. Anciens stocks et double comptage

Les anciens stocks n'appartiennent à personne : ils sont **recopiés** dans `legacy_stocks` (statut `open`) et **jamais additionnés** à l'inventaire global. Un administrateur les traite un par un :

- **Attribuer** à un membre : la quantité rejoint son stock avec la nature « ancien stock attribué » (pas un apport) et la ligne passe à `attributed` ;
- **Archiver** si elle est déjà comptée dans un inventaire personnel : la ligne passe à `archived`.

Rien n'est supprimé. `resources.places` reste en place mais n'est plus utilisé.

## 6. Risques et précautions

| Risque | Précaution |
|---|---|
| Perte de données | Migration additive ; copie dans `archive.*` ; sauvegarde JSON depuis le site avant la migration |
| Double comptage ancien / nouveau stock | Anciens stocks dans une zone séparée, hors du total ; rapprochement explicite |
| Capture partielle prise pour un inventaire complet | Partiel par défaut ; « complet » est un choix explicite, et l'aperçu liste les lignes qui passeront à 0 |
| Erreur de lecture de l'IA | Correction avant validation, aperçu des variations, correction après coup avec motif ; l'historique est conservé |
| Cases répétées entre deux pages | Repérage d'une même suite d'au moins 2 cases en fin de page et en début de page suivante ; ces cases sont décochées, l'utilisateur garde la main |
| Site déployé avant la migration | Le site affiche « la base n'est pas encore à jour » au lieu de planter |
| Date de capture | Date du fichier (capture enregistrée) ou du collage : un collage tardif d'une vieille capture n'est pas détecté comme ancien |

## 7. Déploiement

1. Depuis le site actuel, onglet **Base de données** > **Sauvegarde complète (JSON)**.
2. Supabase > SQL Editor : exécuter `supabase/migrations/006_stocks_personnels.sql`.
3. Edge Functions > `analyze-capture` : déployer la nouvelle version (type d'écran, confiance).
4. Publier le site (branche principale).
5. Administrateurs : traiter les « anciens stocks non attribués » dans l'onglet Inventaire global.

## 8. Tests

```bash
npm install
npm test
```

Les tests jouent `schema.sql` puis toutes les migrations sur un vrai Postgres en mémoire (PGlite), avec les mêmes droits que Supabase (RLS active, tous droits de table accordés à `anon` et `authenticated`). Ils couvrent : deux joueurs même minerai même ville ; un joueur deux villes ; deux qualités ; qualité inconnue ; premier relevé ; relevés successifs 10/18/25/25/20 ; relevé répété (idempotence) ; deux terminaux pour un même stock ; relevé partiel et complet ; cases communes entre pages ; retrait ; correction d'une erreur de lecture ; tentative de modifier le stock d'un autre membre (RPC, écriture directe, fonction interne) ; deux relevés simultanés ; relevé ancien ; unités distinctes ; compte en attente ; conservation des données à la migration (relançable) ; absence de double comptage au rapprochement ; fusion de ressources.

Ce qui n'est **pas** testé automatiquement : la reconnaissance sur de vraies captures (pas d'images de référence pour les deux types d'écran) et l'interface, vérifiée à la main avec des données simulées.
