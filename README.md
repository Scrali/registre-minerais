# Registre des minerais

Site de gestion des stocks de minerais d'une organisation : comptes membres validés par un administrateur, lots par qualité, journal des mouvements et lecture automatique des captures d'écran d'inventaire par Claude.

- **Hébergement** : GitHub Pages (gratuit)
- **Comptes et base de données** : Supabase (offre gratuite)
- **Lecture des captures** : API Claude (payante, à l'usage), appelée depuis une fonction Supabase pour que la clé reste secrète

Fonctionnement technique détaillé (architecture, données, sécurité) : [`docs/FONCTIONNEMENT.md`](docs/FONCTIONNEMENT.md).

## Mise en route (une seule fois, environ 15 minutes)

### 1. Créer le projet Supabase

1. Crée un compte sur [supabase.com](https://supabase.com), puis un projet (offre **Free**, région Europe).
2. Ouvre **SQL Editor** > **New query**, colle tout le contenu de [`supabase/schema.sql`](supabase/schema.sql), puis clique sur **Run**.
   Fais ensuite de même avec [`supabase/migrations/002_base_de_donnees.sql`](supabase/migrations/002_base_de_donnees.sql) (fusion et annulation, pour l'onglet Base de données), puis [`supabase/migrations/003_image_ressource.sql`](supabase/migrations/003_image_ressource.sql) (image du caillou de chaque ressource), puis [`supabase/migrations/004_lieux_et_reinitialisation.sql`](supabase/migrations/004_lieux_et_reinitialisation.sql) (lieux de stockage et réinitialisation), puis [`supabase/migrations/005_references_multiples.sql`](supabase/migrations/005_references_multiples.sql) (plusieurs images de référence par minerai).
3. Dans **Authentication** > **Sign In / Providers** > **Email**, désactive **Confirm email**.
   L'offre gratuite n'envoie que quelques e-mails par heure, et la validation des comptes par un administrateur remplace déjà cette confirmation.
4. Dans **Authentication** > **URL Configuration**, mets l'adresse du site GitHub Pages dans **Site URL** et dans **Redirect URLs** (nécessaire pour « Mot de passe oublié »).

### 2. Brancher la lecture des captures

1. Crée une clé API sur [console.anthropic.com](https://console.anthropic.com) (**API Keys**). Fixe une limite de dépense mensuelle dans **Billing** > **Limits**.
2. Dans Supabase, **Edge Functions** > **Deploy a new function** > **Via Editor**, nomme-la exactement `analyze-capture`, colle le contenu de [`supabase/functions/analyze-capture/index.ts`](supabase/functions/analyze-capture/index.ts), puis déploie.
3. Dans **Edge Functions** > **Secrets**, ajoute `ANTHROPIC_API_KEY` avec ta clé.
4. Dans **Edge Functions** > `analyze-capture` > **Settings**, décoche **Verify JWT with legacy secret** puis **Save changes**.
   Les projets récents signent les connexions avec une nouvelle clé (ECC) que cette option refuse. La fonction vérifie elle-même que la personne est un membre validé.

Coût indicatif : quelques centimes par capture analysée (modèle Claude Opus 5.5). La saisie manuelle ne coûte rien.

### 3. Relier le site à Supabase

Dans **Project Settings** > **API**, copie **Project URL** et la clé **anon / publishable**, puis colle-les dans [`config.js`](config.js). Ces deux valeurs sont publiques par nature : la sécurité repose sur les règles du fichier `schema.sql`.

### 4. Premier compte

Ouvre le site et crée ton compte : **le premier compte inscrit devient administrateur**. Les comptes suivants restent « en attente » jusqu'à ce qu'un administrateur les valide dans **Membres**.

## Rôles

| Rôle | Peut faire |
|---|---|
| En attente | Rien, attend la validation |
| Membre | Voir et modifier les stocks, analyser des captures |
| Administrateur | Tout ce que fait un membre, plus valider et gérer les comptes |

## Tester en local

```bash
node tools/serve.js
```

Puis ouvre http://localhost:5173.

## À savoir

- Un projet Supabase gratuit se met en pause après une semaine sans aucune visite. Il suffit de le relancer depuis le tableau de bord Supabase.
- Le mode « stock complet » ne remplace que les minerais visibles sur la capture. Les autres ne sont pas effacés.
