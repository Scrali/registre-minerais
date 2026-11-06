-- Registre des minerais : synchronisation automatique quotidienne des blueprints.
-- À exécuter UNE FOIS, après la migration 015 et le déploiement de la fonction Edge « sync-blueprints »,
-- dans Supabase > SQL Editor. Ce fichier n'est pas une migration : il programme une tâche (pg_cron + pg_net).
--
-- Avant de l'exécuter :
--  1. Choisis un secret long et aléatoire (ex. généré par un gestionnaire de mots de passe).
--  2. Supabase > Edge Functions > Secrets : ajoute SYNC_SECRET avec cette valeur.
--  3. Supabase > Project Settings > Vault (ou SQL ci-dessous) : enregistre la même valeur sous le nom « sync_blueprints_secret »,
--     et l'URL du projet sous « project_url » (ex. https://abcd.supabase.co).
--        select vault.create_secret('<le secret>', 'sync_blueprints_secret');
--        select vault.create_secret('https://<ton-projet>.supabase.co', 'project_url');
--     Ne colle jamais ce secret ailleurs (ni dans le dépôt, ni dans config.js).
--
-- La tâche s'exécute toutes les 10 minutes entre 03:00 et 04:50 (UTC). La fonction ne lance une nouvelle synchronisation
-- que si la dernière réussie date de plus de 20 heures ; les appels suivants terminent une synchronisation commencée
-- (chaque appel travaille environ 100 secondes). Les autres appels ne font rien.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('sync-blueprints') where exists (select 1 from cron.job where jobname = 'sync-blueprints');

select cron.schedule('sync-blueprints', '*/10 3-4 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sync-blueprints',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'sync_blueprints_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 150000)
$$);

-- Vérifier : select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'sync-blueprints') order by start_time desc limit 5;
-- Arrêter : select cron.unschedule('sync-blueprints');
