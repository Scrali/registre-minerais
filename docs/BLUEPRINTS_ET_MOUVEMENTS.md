# Blueprints Star Citizen et mouvements sécurisés

Ce document couvre deux évolutions du registre :

- la migration `014_mouvements_securises.sql` (anti-doublons, retraits, transferts, annulations) ;
- la migration `015_blueprints.sql` et la fonction Edge `sync-blueprints` (catalogue de l'API Star Citizen Wiki).

L'architecture ne change pas : GitHub Pages, Supabase (Postgres, Auth, RLS, Realtime, Edge Functions).

## 1. Audit du code existant (avant 014)

### Déjà correctement sécurisé

| Point | Où |
|---|---|
| Clé d'idempotence des captures vérifiée côté serveur (`inventory_scans.idempotency_key` unique, résultat d'origine renvoyé) | `apply_scan` (006) |
| Mode « Mettre à jour » = observation : seul l'écart avec le relevé précédent est enregistré, deux captures identiques ne changent rien | `apply_scan` |
| Scan partiel : les lignes absentes ne sont jamais remises à zéro ; « complet » est un choix explicite | `apply_scan` |
| Qualités jamais fusionnées (`quality_key`, `'-'` = inconnue) ; clé de stock membre + lieu + ressource + qualité + unité | `user_stocks` |
| Verrou par (membre, lieu) : deux enregistrements simultanés passent l'un après l'autre | `pg_advisory_xact_lock` |
| Capture plus ancienne que le dernier état : refus (`STALE`) sans confirmation ; inventaire modifié depuis l'aperçu : refus (`STATE_CHANGED`) | `apply_scan` |
| Retrait supérieur au stock refusé, sur la qualité exacte uniquement | `adjust_stock` |
| Stock et mouvement écrits dans la même transaction ; aucune écriture directe (RLS) | `_write_stock` |
| Permissions : son propre inventaire, ou droit `edit_others` dans la même organisation | `_stock_owner` (008) |
| Statistiques : retraits classés en sorties, jamais en production négative | `app.js` (`CAT`) |

### Risques vérifiés (corrigés par 014)

| Risque | Conséquence |
|---|---|
| `adjust_stock` sans clé d'idempotence | Une requête renvoyée par le réseau, ou un double clic qui passe, retirait deux fois (25 → 18 → 11) |
| Aucun transfert atomique | Un transfert = deux saisies séparées, sans lien ; si la seconde échouait, du minerai disparaissait |
| Aucune annulation pour les stocks personnels | `undo_movement` ne gère que l'ancien système ; une erreur ne pouvait être corrigée que par une correction manuelle |
| Unités non normalisées (`scu` ≠ `SCU`) | Une saisie en minuscules créait un deuxième stock pour la même chose |
| Mode « Ajouter » / « Fin de run » : la même capture enregistrée deux fois était seulement signalée | Le même lot pouvait être ajouté deux fois |
| Même clé de capture avec un autre contenu : l'ancien résultat était renvoyé sans contrôle | Une capture corrigée pouvait être ignorée silencieusement |
| Aucun aperçu avant un retrait manuel | Erreur de qualité ou de quantité découverte après coup |
| Baisse déjà constatée par capture, puis retrait déclaré à la main | La même baisse comptée deux fois |
| Quantité à plus de 3 décimales arrondie en silence par `numeric(16,3)` | Écart invisible |
| Mouvement annulé ou transfert encore « classable » | Les statistiques pouvaient devenir incohérentes |

### Limites qui restent (à vérifier en usage réel)

- **Date des captures collées** : la date d'une image collée est celle du collage. Une vieille capture collée tard n'est donc pas reconnue comme ancienne. Le contrôle `STATE_CHANGED` et l'aperçu restent les garde-fous.
- **Case isolée répétée sur deux pages** : elle n'est pas décochée automatiquement, car deux lots identiques peuvent exister. L'aperçu le signale désormais.
- **Concurrence réelle** : les tests tournent sur une seule connexion Postgres (PGlite). Les verrous sont ceux de Postgres et fonctionnent de la même façon sur Supabase, mais la concurrence n'a été simulée qu'en séquence.

## 2. Ce que fait la migration 014

- **Clé d'opération obligatoire** (`operation_id`, UUID créé par le navigateur à l'aperçu) pour `adjust_stock`, `transfer_stock` et `reverse_movement`.
  - Le même envoi renvoie le résultat d'origine (`replayed: true`) et n'applique rien.
  - Une clé réutilisée pour un autre contenu est refusée.
  - Un nouveau retrait volontaire reçoit une nouvelle clé.
- **Aperçu** (`dry_run`) : avant, mouvement, après, et alerte de doublon possible (même stock, même sens, 7 derniers jours).
  - La confirmation envoie `expected_before`. Si le stock a changé entre-temps, l'opération est refusée.
- **Motifs de retrait** : vente, livraison (nouvelle nature `delivery`), consommation, envoi en raffinerie, perte, autre retrait.
  - Un transfert hors de l'organisation exige une note. La correction exige toujours un motif.
- **`transfer_stock`** : le débit et le crédit se font dans la même transaction, reliés par `transfer_id`.
  - Ressource, qualité, unité et quantité sont identiques des deux côtés.
  - Destination : un autre lieu, ou un membre validé de la même organisation.
  - Les verrous sont pris dans un ordre fixe pour éviter tout interblocage.
- **`reverse_movement`** : un mouvement compensatoire est appliqué sur le stock actuel. Les mouvements plus récents sont conservés.
  - L'original est marqué annulé (`undone_at`, `reversed_by_id`) et n'est jamais effacé.
  - Il garde la même nature, donc une production annulée disparaît des statistiques.
  - Un transfert est annulé en entier.
  - L'annulation est refusée si le stock a déjà été utilisé.
  - Un relevé « Mettre à jour » ne s'annule pas : on fait une correction ou un nouveau relevé.
- **`apply_scan`** :
  - unités normalisées ;
  - clé liée au contenu ;
  - en mode ajout, la même image déjà ajoutée est refusée (`DUPLICATE`) sans confirmation explicite ;
  - un lot identique ajouté récemment est signalé, sans blocage.
- **`stock_reconciliation()`** (administrateurs, lecture seule) : pour chaque ligne de stock, compare la quantité à la somme des écarts de ses mouvements, et liste les unités non canoniques. Rien n'est corrigé automatiquement.
- **Sauvegarde** : `archive.user_stocks_avant_014` et `archive.movements_avant_014` (une seule fois).
- Aucune ligne existante n'est modifiée.

## 3. API Star Citizen Wiki : ce qui a été vérifié

Documentation OpenAPI réelle : `GET https://api.star-citizen.wiki/api/openapi` (YAML). Endpoints testés le 6 novembre 2026 :

| Endpoint | Constat |
|---|---|
| `/api/game-versions` | 12 versions ; défaut `4.10.2-LIVE.12881860` |
| `/api/blueprints` | 1 617 blueprints ; `page[size]` ≤ 200 (9 pages) ; `links.next` et `meta.total` fiables. La liste **additionne** les quantités d'une même matière |
| `/api/blueprints/{uuid}` | Détail par emplacement (`requirement_groups`, `tiers`), avec `min_quality` par emplacement ; 1 détail sur 1 617 renvoie 404 |
| `/api/commodities` | Ressources (`uuid` = ressource raffinée) ; `filter[used]=true` disponible |

Structure réelle des recettes (lecture des 1 617 détails) :

- Chaque emplacement (Frame, Emitter…) a `required_count = 1` et une seule option. Il n'y a actuellement aucune recette alternative et un seul palier.
  - Le code gère quand même les choix (plusieurs options), les paliers et les groupes imbriqués, au cas où l'API les introduirait.
- Ressource (`kind: resource`) : la quantité est en SCU (`quantity_scu`). Objet (gemme, `kind: item`) : la quantité est un nombre d'objets (`quantity`).
- Qualité minimale de 0 à 1000 (1 608 emplacements à 0, 495 à 1, 7 entre 800 et 900).
- Le même minerai peut figurer dans deux emplacements avec des qualités différentes (ex. QuikCool : fer 0,16 + fer 0,1 SCU).
- L'`uuid` d'un ingrédient désigne la ressource **raffinée** ; `ore_uuid` désigne le minerai brut.
  - Le champ `link` de la liste pointe parfois vers le minerai brut : il n'est pas utilisé.
- Limites de débit annoncées : seulement sur la recherche (60/min). La fonction reste prudente quand même : 4 requêtes par seconde au plus, une à la fois, avec reprise automatique sur 429 (`Retry-After`), 5xx et erreurs réseau.

## 4. Ce que fait la migration 015

| Table | Rôle |
|---|---|
| `sc_blueprints` | Un blueprint par `uuid` **et** par `key` (aucun doublon). Si l'UUID change pour une même clé, l'ancien est gardé dans `former_uuids`. Un blueprint absent de l'API reçoit `missing_since` ; il n'est jamais supprimé |
| `sc_recipes` | Une ligne par contenu de recette, avec sa version d'apparition et la dernière version vue. Une recette modifiée crée une nouvelle ligne ; l'ancienne passe `is_current = false` avec `superseded_by` |
| `sc_ingredients` | Palier, emplacement, option, matière (`api_uuid`, `ore_uuid`), quantité, unité (`SCU` ou objets), qualité minimale. Une valeur absente reste `NULL` et la recette est marquée incomplète |
| `sc_materials`, `sc_material_map` | Correspondance matière de l'API → ressource du registre. Les suggestions automatiques (même nom, nom français) attendent la validation d'un administrateur ; seules les correspondances validées servent au calcul |
| `member_blueprints` | Blueprints possédés, déclarés par chaque membre, visibles dans son organisation seulement. Un retrait de déclaration garde la ligne |
| `sc_sync_runs`, `sc_sync_errors` | Date, déclencheur, résultat, compteurs et erreurs de chaque synchronisation |

Écriture du catalogue :

- Le catalogue n'est écrit que par la fonction `sync-blueprints`, avec le rôle `service_role`.
- Les clients n'ont que la lecture.
- **Aucune** de ces fonctions ne touche `user_stocks`, `movements` ni `inventory_scans` (vérifié par les tests).

### Fonction Edge `sync-blueprints`

1. **Accès** : l'en-tête `x-sync-secret` sert à la tâche planifiée. Pour un administrateur connecté, la fonction vérifie elle-même le rôle avec `sc_can_sync()`.
2. **Liste complète** : versionnée sur la version par défaut du jeu, avec une empreinte par blueprint.
3. **Détails relus** : seulement pour les blueprints nouveaux ou modifiés. La première synchronisation relit tout, ce qui prend environ 7 minutes en plusieurs appels.
4. **Découpage** : chaque appel travaille environ 100 secondes, puis rend la main. L'appel suivant reprend la même synchronisation.
5. **Une seule à la fois** : deux synchronisations ne tournent jamais en même temps (`lease_until`).
6. **Erreurs** : un détail introuvable est journalisé et les autres continuent (résultat « partiel »). Une panne de la liste fait échouer la synchronisation sans rien modifier.

### Onglet « Blueprints »

- Recherche par objet ou ingrédient, filtre par type, « mes blueprints », « possédés dans l'organisation » et « réalisables ».
- Le détail d'un blueprint affiche :
  - pour chaque emplacement : quantité requise, qualité minimale, ressource du registre, quantité disponible de qualité suffisante et quantité manquante ;
  - le nombre de fabrications possibles ;
  - la case « Je possède ce blueprint ».
- Le calcul (`blueprintlogic.js`) est en lecture seule :
  - 100 cSCU = 1 SCU ; les objets ne sont jamais convertis ;
  - un même lot n'est jamais compté pour deux emplacements ;
  - une qualité inconnue n'est comptée que si aucune qualité minimale n'est demandée ;
  - le résultat est « indéterminé » tant qu'une matière n'a pas de correspondance validée.
- Partie administrateur : validation des correspondances, dernières synchronisations et erreurs, bouton « Synchroniser maintenant ».

## 5. Mise en production (sur accord explicite)

Faire les étapes dans l'ordre :

1. **Sauvegarde** : sur le site actuel, onglet **Base de données** > **Sauvegarde complète (JSON)**. Les migrations font aussi leur propre copie dans `archive`.
2. **SQL Editor** : exécuter `supabase/migrations/014_mouvements_securises.sql`, puis `015_blueprints.sql`. Ces deux migrations sont additives et peuvent être relancées.
3. **Edge Functions** : créer `sync-blueprints` avec le contenu de `supabase/functions/sync-blueprints/index.ts`, puis décocher **Verify JWT with legacy secret**.
4. **Publier le site** : fusionner la branche dans `main` (version `v=25`). L'ancien site ne peut plus déclarer de mouvement après la migration 014, car il n'envoie pas d'identifiant d'opération. Il affiche alors « recharge la page ».
5. **Première synchronisation** : onglet Blueprints > **Synchroniser maintenant** (garder la page ouverte quelques minutes).
6. **Correspondances** : les valider dans l'onglet Blueprints.
7. **Synchronisation quotidienne (facultatif)** :
   - créer le secret `SYNC_SECRET` (Edge Functions > Secrets) et la même valeur dans le Vault ;
   - exécuter `supabase/cron/sync-blueprints.sql`.

## 6. Tests

`npm test` lance 86 tests sur Postgres en mémoire, dont :

- **`tests/movements.test.js`** :
  - retrait 25 − 7 = 18 ;
  - répétition technique sans effet ;
  - nouveau retrait possible ;
  - double clic ;
  - quantité nulle, négative ou trop grande ;
  - mauvaise qualité ;
  - unités ;
  - aperçu et `STATE_CHANGED` ;
  - retrait puis scan à 18 (variation 0) ;
  - scan antérieur au retrait (`STALE`) ;
  - baisse constatée puis retrait (alerte) ;
  - transfert entre villes et entre membres ;
  - transfert interrompu (panne simulée : rien n'est débité) ;
  - retraits concurrents ;
  - annulation d'un mouvement ancien ou d'un transfert ;
  - annulation impossible ;
  - captures en double ;
  - ajout manuel puis capture ;
  - statistiques ;
  - réconciliation ;
  - permissions entre utilisateurs et entre organisations.
- **`tests/blueprints.test.js`** (vraies réponses de l'API dans `tests/fixtures/blueprints-api.json`) :
  - première synchronisation et synchronisation répétée sans doublon ;
  - recette modifiée et traçabilité ;
  - UUID changé ;
  - blueprint retiré ;
  - 429, `Retry-After`, 404, panne réseau ;
  - pagination et reprise ;
  - exécution unique ;
  - recettes alternatives et données manquantes ;
  - correspondances ;
  - sécurité ;
  - blueprints possédés ;
  - inventaires inchangés.
- **`tests/blueprintlogic.test.js`** : calcul des manques.

Vérifications faites en plus des tests automatiques :

- **Synchronisation complète** des 1 617 blueprints réels dans la base de test : 1 616 recettes complètes, aucune donnée manquante ; un détail est absent de l'API (404), il est journalisé.
- **Interface** : le site a été piloté dans un navigateur avec cette base de test. Ont été vérifiés le retrait avec aperçu, le transfert, l'annulation, l'onglet Blueprints, la synchronisation manuelle et l'affichage sur mobile.

Non testé : le déploiement réel sur Supabase (fonction Edge, pg_cron) et de vraies captures du jeu.
