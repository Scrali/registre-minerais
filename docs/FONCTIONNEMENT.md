# Registre des minerais — fonctionnement technique

Documentation d'architecture pour les développeurs et administrateurs du projet.

## 1. Vue d'ensemble

Application web **statique**, sans serveur applicatif : tout le back-end est délégué à **Supabase** (Postgres, Auth, Realtime, Edge Functions), et la lecture des captures à l'**API Claude**.

```
 Navigateur (GitHub Pages)                      Supabase (projet « Minerais »)
 ┌──────────────────────────┐   HTTPS + JWT    ┌───────────────────────────────────┐
 │ index.html / app.js /    │ ───────────────▶ │ Auth (email + mot de passe)       │
 │ style.css / config.js    │                  │ PostgREST : SELECT + appels RPC   │
 │ supabase-js 2.45.4       │ ◀─── WebSocket ─ │ Realtime (postgres_changes)       │
 │                          │                  │ Postgres : tables, RLS, fonctions │
 │ redimensionne l'image,   │   POST image     │ Edge Function « analyze-capture » │
 │ découpe les vignettes    │ ───────────────▶ │   (Deno) ──▶ API Claude           │
 └──────────────────────────┘                  └───────────────────────────────────┘
```

- **Hébergement** : GitHub Pages (`.nojekyll`). Les fichiers sont versionnés dans l'URL (`app.js?v=N`) : incrémenter `N` dans `index.html` à chaque mise en ligne pour contourner le cache de 10 minutes de GitHub Pages.
- **`config.js`** : URL du projet et clé publique (anon). Ces valeurs sont **publiques par conception** ; la sécurité repose sur les règles de la base.
- **Clé API Anthropic** : uniquement dans les Secrets Supabase (`ANTHROPIC_API_KEY`), jamais dans le navigateur.

## 2. Authentification et rôles

- Supabase Auth, e-mail et mot de passe. La confirmation par e-mail est désactivée : la validation par un administrateur la remplace.
- Table **`profiles`** (`id`, `pseudo`, `role`, `created_at`), remplie par le trigger `handle_new_user`. **Le premier compte inscrit devient `admin`**, les suivants sont `pending`.

| Rôle | Droits |
|---|---|
| `pending` | aucun accès aux données |
| `member` | lecture, et modification via les fonctions prévues |
| `admin` | droits de membre, plus fusion, annulation, réinitialisation et gestion des comptes |

- Le trigger `guard_profile` réserve les changements de rôle aux admins et interdit de modifier son propre rôle.
- `is_member()` et `is_admin()` servent de garde dans toutes les règles et procédures.

## 3. Modèle de données

### Lot
Un stock est un objet JSONB `qualité → quantité` :
```json
{ "258": 20, "1000": 6, "-": 5 }
```
`"-"` = qualité inconnue. Les clés sont validées entre 0 et 1000.

### Lieux de stockage
```json
places = { "Lorville": {"258": 20}, "Port Tressler": {"300": 4}, "": {...} }
```
`""` = lieu non précisé. **`lots` est toujours le total de tous les lieux** et `qty` la somme de `lots`. Ces deux champs sont recalculés côté serveur à chaque écriture.

### Tables
- **`resources`** : `id`, `name` (unique), `category`, `unit`, `color` (hex), `color_name`, `threshold`, `lots`, `places`, `qty`, `image` (image principale), `refs` (jusqu'à 6 vues supplémentaires, JPEG base64), `updated_at`, `updated_by`.
- **`movements`** (journal, en ajout seul) : `resource_id`, `name`, `unit`, `before`, `after`, `detail`, `mode`, `source`, `note`, `place`, `by`, `at`, plus l'état complet `lots_before/after` et `places_before/after` (ce qui rend l'annulation possible), et `undone_at`, `undone_by`, `undo_of`.
- **`profiles`** (section 2).

## 4. Règles d'écriture

- **RLS** : lecture seule pour les membres. **Aucune écriture directe** sur `resources` ni `movements`.
- Toute modification passe par une fonction Postgres **`SECURITY DEFINER`** (`search_path` fixé, `EXECUTE` révoqué pour `public` et `anon`, accordé à `authenticated`). Chaque fonction vérifie le rôle, verrouille la ligne (`FOR UPDATE`), calcule le nouvel état, puis écrit l'état et le mouvement dans **la même transaction**.

| Fonction | Rôle | Effet |
|---|---|---|
| `apply_lots(id, mode, delta, source, note, patch, place)` | membre | `set` remplace les lots d'un lieu, `add` ajoute, `remove` retire ; `places` remplace tous les lieux (correction). `patch` modifie nom, couleur, unité, seuil. |
| `create_resource(p, source, note)` | membre | Création avec les lots d'un lieu (`lots` + `place`) ou tous les lieux (`places`). |
| `delete_resource(id)` | membre | Suppression, état avant journalisé. |
| `merge_resources(source, cible)` | admin | Addition lieu par lieu, récupération des images, rattachement de l'historique, suppression de la source. |
| `undo_movement(id)` | admin | Écart inverse lieu par lieu et qualité par qualité, sans descendre sous 0. Impossible pour une suppression, une fusion ou une annulation. |
| `set_resource_image`, `add_resource_ref`, `remove_resource_ref` | membre | Images de référence (`data:image/jpeg`, 80 Ko au plus). |
| `reset_registre('REINITIALISER')` | admin | Vide `movements` et `resources`. Comptes conservés. |

**`merge_lots(base, delta, mode)`**, fonction centrale :
- `add` additionne qualité par qualité ;
- `remove` soustrait sans descendre sous 0 ; une sortie sans qualité (`"-"`) **puise d'abord dans les qualités les plus basses** ;
- les lots à 0 sont supprimés.

Le client en contient une copie exacte (`mergeLots`), utilisée uniquement pour l'aperçu.

## 5. Lecture des captures

### Navigateur
1. **Saisie** : jusqu'à 12 images (collage page par page, glisser-déposer, sélection).
2. **Préparation** : redimensionnement à 2000 px maximum, réencodage JPEG qualité 0,9.
3. **Envoi** : 3 analyses en parallèle au plus ; une page en échec se relance seule.
4. **Vignettes** : à partir de `box` (millièmes de l'image), découpe du caillou dans l'image d'origine, rognage du texte de qualité et de l'icône, réduction à 160 px.
5. **Regroupement** par nom normalisé : renommer un lot renomme son groupe sur toutes les pages ; « Séparer » sort un type de caillou du groupe ; un nom corrigé s'applique aux pages suivantes.
6. **Rattachement** (`matchTarget`) à une ressource existante : correspondance exacte, puis partielle.
7. **Aperçu** : total avant et après ; seul le stock du lieu choisi est recalculé.
8. **Enregistrement** : un appel RPC par ressource. La première vignette devient l'image de la ressource si elle n'en a pas.

### Edge Function `analyze-capture` (Deno)
- « Verify JWT with legacy secret » est **désactivé** (le projet signe ses jetons en ECC) : la fonction appelle elle-même `is_member()` avec le jeton de l'utilisateur et renvoie 403 sinon.
- Contrôle du type MIME et de la taille (7 Mo en base64).
- Contexte envoyé : ressources connues et couleurs, **jusqu'à 80 images de référence** (« Référence : Nom (vue i/n) »), la capture, puis les consignes (format `258Q` / `20x`, un élément par case, teintes proches, vues multiples selon l'écran du jeu).
- Modèle `claude-opus-5-5`, repli automatique côté serveur (beta `server-side-fallback`), effort `medium`, **sortie structurée par schéma JSON** :
  ```
  items[]: { name, quality|null, qty, unit, color, hex, by: nom|couleur|inconnu, box[4] }
  ```
- Erreurs (refus, tokens, limite de débit, clé invalide) traduites en français.

## 6. Interface

- **Stocks** : recherche, filtres catégorie et lieu, détail par lieu, qualité moyenne pondérée, étiquettes de lots, jauge de seuil. Le mouvement rapide s'applique au lieu filtré, sinon au lieu unique de la ressource.
- **Journal** : 40 derniers mouvements, en temps réel.
- **Base de données** (admins) : édition directe (format `[Lieu]` puis `258 x 20`, lignes en cours protégées du temps réel), images de référence, fusion avec aperçu, historique paginé par 100 avec annulation, exports CSV Excel (`;`, BOM UTF-8) et JSON, réinitialisation (saisie de `REINITIALISER`, double confirmation, sauvegarde JSON automatique).
- **Temps réel** : un canal sur `resources`, `movements`, `profiles` ; chaque événement recharge la table concernée après 250 ms.
- **Préférence locale** : dernier lieu de capture dans `localStorage`.

## 7. Migrations

À exécuter dans l'ordre dans Supabase > SQL Editor. Toutes peuvent être relancées sans risque.

| Fichier | Contenu |
|---|---|
| `supabase/schema.sql` | tables, rôles, RLS, lots, fonctions de base |
| `migrations/002_base_de_donnees.sql` | état avant/après, fusion, annulation |
| `migrations/003_image_ressource.sql` | image principale |
| `migrations/004_lieux_et_reinitialisation.sql` | lieux de stockage, réinitialisation |
| `migrations/005_references_multiples.sql` | vues de référence multiples |
| `migrations/006_stocks_personnels.sql` | stocks personnels par membre, lieu, qualité et unité ; relevés par comparaison ; anciens stocks non attribués (voir `docs/STOCKS_PERSONNELS.md`) |
| `migrations/007_bibliotheque_images.sql` | bibliothèque d'images de référence (`reference_images`) : jusqu'à 50 images par minerai, classées par écran (inventaire, ascenseur de fret) ; l'analyse en choisit 4 au plus par minerai, en privilégiant l'écran de la capture |

## 8. Sécurité

- **Public** : clé anon et URL du projet ; sans compte validé, elles ne donnent accès à rien.
- **Secret** : clé Anthropic, dans les Secrets Supabase.
- **Défense en profondeur** : RLS en lecture seule, écritures par fonctions qui vérifient le rôle, validation des entrées (qualités, images, longueur des noms de lieu), opérations destructrices réservées aux admins et confirmées deux fois.
- **Audit** : chaque changement de stock produit un mouvement avec son auteur et l'état complet avant et après.

## 9. Coûts et limites connues

- Supabase (offre gratuite) et GitHub Pages sont gratuits. Le projet Supabase **se met en pause après 7 jours sans activité**.
- Chaque page analysée coûte un appel à l'API Claude (quelques centimes) ; les images de référence ajoutent un peu de coût.
- La reconnaissance est probabiliste : positions approximatives, minerais proches parfois confondus. **Un humain valide toujours avant l'enregistrement**, et les images de référence améliorent le résultat.
- Une case visible sur deux captures qui se chevauchent est comptée deux fois : décocher le doublon.
- Pas d'annulation pour une suppression, une fusion ou une réinitialisation : la sauvegarde JSON sert de filet.
- Liste des stations figée dans `app.js` (`GAME_PLACES`) ; tout autre lieu peut être saisi.
- Pas de tests automatisés.
