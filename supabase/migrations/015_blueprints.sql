-- Registre des minerais : catalogue des blueprints Star Citizen (API Star Citizen Wiki) et comparaison avec les stocks.
-- À exécuter APRÈS 014, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
--
-- Migration ADDITIVE : elle ne crée que de nouvelles tables et fonctions. Aucune table existante n'est modifiée,
-- et la synchronisation ne touche JAMAIS aux inventaires (user_stocks, movements, inventory_scans).
--
--  sc_game_versions     versions du jeu vues dans l'API
--  sc_blueprints        un blueprint par UUID de l'API (clé « BP_CRAFT_… » unique aussi : jamais de doublon)
--  sc_recipes           recettes successives d'un blueprint ; une recette modifiée crée une NOUVELLE ligne,
--                       l'ancienne reste (is_current = false, superseded_by) : traçabilité complète
--  sc_ingredients       ingrédients d'une recette : palier, emplacement, option, matière, quantité, unité, qualité minimale
--  sc_materials         matières citées par l'API (UUID de ressource raffinée, d'objet, de minerai brut)
--  sc_material_map      correspondance matière API -> ressource du registre ; seules les correspondances CONFIRMÉES
--                       par un administrateur servent au calcul (les suggestions automatiques attendent sa validation)
--  member_blueprints    blueprints réellement possédés, déclarés par chaque membre (séparés du catalogue public)
--  sc_sync_runs / sc_sync_errors   journal des synchronisations et de leurs erreurs
--
-- Écriture du catalogue : uniquement par la fonction Edge « sync-blueprints » (rôle service_role).
-- Lecture : membres validés. Erreurs détaillées : administrateurs.

-- ---------- 1. Tables ----------
create table if not exists public.sc_game_versions (
  code text primary key,
  channel text,
  released_at timestamptz,
  is_default boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.sc_blueprints (
  id bigint generated always as identity primary key,
  uuid uuid not null unique,
  key text not null unique,
  former_uuids uuid[] not null default '{}',          -- si l'API change l'UUID d'une même clé
  output_name text not null default '',
  output_uuid uuid,
  output_class text,
  output_type text,
  output_type_label text,
  output_grade text,
  category_uuid uuid,
  craft_time_seconds integer,
  is_available_by_default boolean,
  web_url text,
  game_version text,                                   -- dernière version du jeu où l'API le fournit
  first_seen_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  missing_since timestamptz,                           -- absent de la dernière liste complète (jamais supprimé)
  list_hash_seen text,                                 -- empreinte de la ligne dans la dernière liste
  list_hash_done text,                                 -- empreinte pour laquelle la recette a été lue en détail
  detail_fetched_at timestamptz,
  current_recipe_id bigint
);
create index if not exists sc_blueprints_name_idx on public.sc_blueprints (lower(output_name));

create table if not exists public.sc_recipes (
  id bigint generated always as identity primary key,
  blueprint_id bigint not null references public.sc_blueprints (id) on delete restrict,
  content_hash text not null,
  game_version text,                                   -- version où cette recette est apparue
  last_seen_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_current boolean not null default true,
  superseded_at timestamptz,
  superseded_by bigint references public.sc_recipes (id) on delete set null,
  tier_count integer not null default 1,
  complete boolean not null default true,              -- false : l'API ne fournit pas tout (quantité, matière…)
  issues text[] not null default '{}',
  craft_time_seconds integer,
  raw jsonb not null,                                  -- extrait brut de l'API (paliers et emplacements), pour audit
  constraint sc_recipes_hash unique (blueprint_id, content_hash)
);
create unique index if not exists sc_recipes_one_current on public.sc_recipes (blueprint_id) where is_current;

create table if not exists public.sc_ingredients (
  id bigint generated always as identity primary key,
  recipe_id bigint not null references public.sc_recipes (id) on delete restrict,
  tier_index integer not null default 0,
  slot_key text not null,                              -- emplacement (ex. FRAME), chemin « A/B » si imbriqué
  slot_name text not null default '',
  slot_position integer not null,
  required_count integer,                              -- nombre d'options à fournir dans cet emplacement
  option_count integer not null default 1,             -- > required_count : recette alternative (au choix)
  option_index integer not null default 0,
  kind text not null check (kind in ('resource', 'item')),
  api_uuid uuid,
  ore_uuid uuid,
  name text not null default '',
  quantity numeric,                                    -- NULL si l'API ne la fournit pas (jamais inventée)
  unit text not null default '' check (unit in ('', 'SCU')),   -- '' = objets
  min_quality integer check (min_quality between 0 and 1000),  -- NULL si non fournie
  constraint sc_ingredients_slot unique (recipe_id, tier_index, slot_position, option_index)
);
create index if not exists sc_ingredients_uuid_idx on public.sc_ingredients (api_uuid);

create table if not exists public.sc_materials (
  api_uuid uuid primary key,
  kind text not null check (kind in ('resource', 'item', 'ore')),
  name text not null,
  refined_uuid uuid,                                   -- pour un minerai brut : la ressource raffinée correspondante
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.sc_material_map (
  api_uuid uuid primary key references public.sc_materials (api_uuid) on delete restrict,
  resource_id uuid references public.resources (id) on delete set null,
  status text not null check (status in ('suggested', 'confirmed', 'rejected', 'unmatched')),
  method text not null default 'auto' check (method in ('auto', 'manual')),
  confidence numeric(3, 2),
  reason text not null default '',
  suggested_at timestamptz not null default now(),
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz
);
-- Une ressource du registre ne correspond qu'à une seule matière confirmée.
create unique index if not exists sc_material_map_one_resource on public.sc_material_map (resource_id) where status = 'confirmed';

create table if not exists public.member_blueprints (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete restrict,
  blueprint_id bigint not null references public.sc_blueprints (id) on delete restrict,
  note text not null default '' check (length(note) <= 200),
  declared_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz,                              -- retiré : la ligne reste (historique)
  constraint member_blueprints_key unique (user_id, blueprint_id)
);

create table if not exists public.sc_sync_runs (
  id bigint generated always as identity primary key,
  trigger text not null check (trigger in ('manual', 'cron')),
  requested_by uuid references public.profiles (id) on delete set null,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  lease_until timestamptz,                             -- une invocation de la fonction Edge travaille jusqu'à cette heure
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'error')),
  phase text not null default 'list' check (phase in ('list', 'details', 'done')),
  force boolean not null default false,
  game_version text,
  pending uuid[] not null default '{}',
  failed uuid[] not null default '{}',
  stats jsonb not null default '{}'::jsonb,
  error text
);
create unique index if not exists sc_sync_one_running on public.sc_sync_runs ((true)) where status = 'running';

create table if not exists public.sc_sync_errors (
  id bigint generated always as identity primary key,
  run_id bigint references public.sc_sync_runs (id) on delete cascade,
  at timestamptz not null default now(),
  context text not null default '',
  blueprint_uuid uuid,
  message text not null
);
create index if not exists sc_sync_errors_run_idx on public.sc_sync_errors (run_id, at desc);

-- ---------- 2. Lecture (RLS) ; aucune écriture directe ----------
create or replace function public.same_org(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and (p_user = auth.uid() or public.is_owner() or exists (
    select 1 from public.profiles me, public.profiles o
    where me.id = auth.uid() and o.id = p_user and me.org_id is not null and o.org_id = me.org_id))
$$;

do $$
declare t text;
begin
  foreach t in array array['sc_game_versions', 'sc_blueprints', 'sc_recipes', 'sc_ingredients', 'sc_materials',
                           'sc_material_map', 'member_blueprints', 'sc_sync_runs', 'sc_sync_errors'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "lecture" on public.%I', t);
  end loop;
end $$;
create policy "lecture" on public.sc_game_versions for select to authenticated using (public.is_member());
create policy "lecture" on public.sc_blueprints for select to authenticated using (public.is_member());
create policy "lecture" on public.sc_recipes for select to authenticated using (public.is_member());
create policy "lecture" on public.sc_ingredients for select to authenticated using (public.is_member());
create policy "lecture" on public.sc_materials for select to authenticated using (public.is_member());
create policy "lecture" on public.sc_material_map for select to authenticated using (public.is_member());
create policy "lecture" on public.member_blueprints for select to authenticated using (public.same_org(user_id));
create policy "lecture" on public.sc_sync_runs for select to authenticated using (public.is_member());
create policy "lecture" on public.sc_sync_errors for select to authenticated using (public.is_admin());

-- ---------- 3. Lecture d'une recette de l'API ----------
-- Un emplacement (groupe) contient une ou plusieurs options (ressource ou objet). Si l'API fournit des paliers (tiers),
-- chaque palier est lu ; sinon requirement_groups sert de palier 0. Un groupe imbriqué devient « parent/enfant ».
-- Rien n'est complété : une quantité, une qualité ou une matière absente reste NULL et la recette est marquée incomplète.
create or replace function public._sc_parse_recipe(d jsonb) returns jsonb
language plpgsql immutable as $$
declare tiers jsonb; t jsonb; ti integer; rows jsonb := '[]'::jsonb; issues text[] := '{}'; pos integer;
        stack jsonb; cur jsonb; c jsonb; oi integer; n integer; leaves jsonb; path text; nm text; q jsonb; k text;
        ores jsonb;
begin
  -- Les paliers ne donnent pas l'UUID du minerai brut : on le reprend de requirement_groups (même matière).
  select coalesce(jsonb_object_agg(rch ->> 'uuid', rch ->> 'ore_uuid'), '{}'::jsonb) into ores
  from jsonb_array_elements(case when jsonb_typeof(d -> 'requirement_groups') = 'array' then d -> 'requirement_groups' else '[]'::jsonb end) rg,
       jsonb_array_elements(case when jsonb_typeof(rg -> 'children') = 'array' then rg -> 'children' else '[]'::jsonb end) rch
  where nullif(rch ->> 'ore_uuid', '') is not null and nullif(rch ->> 'uuid', '') is not null;
  if jsonb_typeof(d -> 'tiers') = 'array' and jsonb_array_length(d -> 'tiers') > 0 then
    tiers := d -> 'tiers';
  elsif jsonb_typeof(d -> 'requirement_groups') = 'array' then
    tiers := jsonb_build_array(jsonb_build_object('tier_index', 0, 'requirements',
               jsonb_build_object('kind', 'root', 'children', d -> 'requirement_groups')));
  else
    return jsonb_build_object('rows', '[]'::jsonb, 'issues', array['Aucune recette fournie par l''API'], 'tiers', 0);
  end if;
  for t in select value from jsonb_array_elements(tiers) loop
    ti := coalesce((t ->> 'tier_index')::int, 0);
    pos := 0;
    -- Pile de groupes à parcourir : {node, path}
    stack := '[]'::jsonb;
    for c in select value from jsonb_array_elements(coalesce(t -> 'requirements' -> 'children', '[]'::jsonb)) loop
      stack := stack || jsonb_build_array(jsonb_build_object('node', c, 'path', coalesce(c ->> 'key', c ->> 'name', 'SLOT')));
    end loop;
    while jsonb_array_length(stack) > 0 loop
      cur := stack -> 0; stack := stack - 0;
      path := cur ->> 'path';
      if coalesce(cur -> 'node' ->> 'kind', '') in ('resource', 'item') then
        -- Feuille directement sous la racine : emplacement à une seule option.
        leaves := jsonb_build_array(cur -> 'node');
        nm := coalesce(cur -> 'node' ->> 'name', '');
        n := null;
      elsif coalesce(cur -> 'node' ->> 'kind', '') = 'group' then
        leaves := '[]'::jsonb;
        for c in select value from jsonb_array_elements(coalesce(cur -> 'node' -> 'children', '[]'::jsonb)) loop
          if c ->> 'kind' = 'group' then
            stack := stack || jsonb_build_array(jsonb_build_object('node', c, 'path', path || '/' || coalesce(c ->> 'key', c ->> 'name', 'SLOT')));
          else
            leaves := leaves || jsonb_build_array(c);
          end if;
        end loop;
        nm := coalesce(cur -> 'node' ->> 'name', '');
        n := nullif(cur -> 'node' ->> 'required_count', '')::int;
        if jsonb_array_length(leaves) = 0 then continue; end if;
      else
        issues := issues || ('Élément de type inconnu « ' || coalesce(cur -> 'node' ->> 'kind', '?') || ' » dans ' || path);
        continue;
      end if;
      oi := 0;
      for c in select value from jsonb_array_elements(leaves) loop
        k := c ->> 'kind';
        if k not in ('resource', 'item') then
          issues := issues || ('Option de type inconnu « ' || coalesce(k, '?') || ' » dans ' || path);
          continue;
        end if;
        q := case when k = 'resource' then c -> 'quantity_scu' else c -> 'quantity' end;
        if q is null or jsonb_typeof(q) <> 'number' then
          issues := issues || ('Quantité non fournie : ' || coalesce(c ->> 'name', '?') || ' (' || path || ')');
        end if;
        if c -> 'min_quality' is null or jsonb_typeof(c -> 'min_quality') <> 'number' then
          issues := issues || ('Qualité minimale non fournie : ' || coalesce(c ->> 'name', '?') || ' (' || path || ')');
        end if;
        if nullif(c ->> 'uuid', '') is null then
          issues := issues || ('Matière sans identifiant : ' || coalesce(c ->> 'name', '?') || ' (' || path || ')');
        end if;
        rows := rows || jsonb_build_array(jsonb_build_object(
          'tier_index', ti, 'slot_key', path, 'slot_name', nm, 'slot_position', pos,
          'required_count', n, 'option_count', jsonb_array_length(leaves), 'option_index', oi,
          'kind', k, 'api_uuid', nullif(c ->> 'uuid', ''), 'ore_uuid', coalesce(nullif(c ->> 'ore_uuid', ''), ores ->> (c ->> 'uuid')),
          'name', coalesce(c ->> 'name', ''),
          'quantity', case when jsonb_typeof(q) = 'number' then q end,
          'unit', case when k = 'resource' then 'SCU' else '' end,
          'min_quality', case when jsonb_typeof(c -> 'min_quality') = 'number' then c -> 'min_quality' end));
        oi := oi + 1;
      end loop;
      pos := pos + 1;
    end loop;
  end loop;
  if jsonb_array_length(rows) = 0 and cardinality(issues) = 0 then issues := array['Recette vide dans l''API']; end if;
  return jsonb_build_object('rows', rows, 'issues', issues, 'tiers', jsonb_array_length(tiers));
end $$;

-- Empreinte du contenu d'une recette (indépendante de l'ordre des clés JSON).
create or replace function public._sc_recipe_hash(p_rows jsonb, p_craft integer) returns text
language sql immutable as $$
  select md5(coalesce(p_craft::text, '') || '#' || coalesce(string_agg(
    concat_ws('|', r ->> 'tier_index', r ->> 'slot_position', r ->> 'slot_key', r ->> 'required_count', r ->> 'option_count',
              r ->> 'option_index', r ->> 'kind', r ->> 'api_uuid', r ->> 'quantity', r ->> 'unit', r ->> 'min_quality'),
    ';' order by (r ->> 'tier_index')::int, (r ->> 'slot_position')::int, (r ->> 'option_index')::int), ''))
  from jsonb_array_elements(p_rows) r
$$;

-- Nom comparable : sans accents, casse, ponctuation ni suffixe « (Ore) » / « (Raw) ».
create or replace function public._sc_norm(p text) returns text
language sql immutable as $$
  select public.place_slug(regexp_replace(coalesce(p, ''), '\s*[\(\[](ore|raw|brut|minerai|m)[\)\]]\s*$', '', 'i'))
$$;

-- Noms français courants (le registre est souvent rempli en français).
create or replace function public._sc_fr(p text) returns text
language sql immutable as $$
  select case public._sc_norm(p)
    when 'gold' then 'or' when 'iron' then 'fer' when 'copper' then 'cuivre' when 'aluminum' then 'aluminium'
    when 'tin' then 'etain' when 'titanium' then 'titane' when 'tungsten' then 'tungstene' when 'corundum' then 'corindon'
    when 'beryl' then 'beryl' when 'quartz' then 'quartz' when 'silicon' then 'silicium' when 'pressurizedice' then 'glacepressurisee'
    when 'quantainium' then 'quantanium'
    else null end
$$;

-- Suggestion de correspondance pour une matière (jamais confirmée automatiquement).
create or replace function public._sc_suggest(p_uuid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.sc_materials; r uuid; v_conf numeric; v_reason text; n integer;
begin
  select * into m from public.sc_materials where api_uuid = p_uuid;
  if not found then return; end if;
  if exists (select 1 from public.sc_material_map where api_uuid = p_uuid and status in ('confirmed', 'rejected')) then return; end if;
  -- Même nom (sans accents ni casse) ; un minerai brut ne correspond qu'à une ressource nommée « … (Ore) » ou « … brut ».
  select count(*), min(id::text)::uuid into n, r from public.resources x
  where public._sc_norm(x.name) = public._sc_norm(m.name)
    and (m.kind <> 'ore') = (x.name !~* '[\(\[](ore|raw|brut|minerai)[\)\]]\s*$|\mbrut\M');
  if n = 1 then v_conf := 0.9; v_reason := 'Même nom';
  else
    select count(*), min(id::text)::uuid into n, r from public.resources x
    where public._sc_fr(m.name) is not null and public._sc_norm(x.name) = public._sc_fr(m.name)
      and (m.kind <> 'ore') = (x.name !~* '[\(\[](ore|raw|brut|minerai)[\)\]]\s*$|\mbrut\M');
    if n = 1 then v_conf := 0.7; v_reason := 'Nom français équivalent'; else r := null; end if;
  end if;
  insert into public.sc_material_map (api_uuid, resource_id, status, method, confidence, reason)
  values (p_uuid, r, case when r is null then 'unmatched' else 'suggested' end, 'auto', v_conf,
          coalesce(v_reason, case when n > 1 then 'Plusieurs ressources possibles' else 'Aucune ressource du registre' end))
  on conflict (api_uuid) do update set resource_id = excluded.resource_id, status = excluded.status, method = 'auto',
    confidence = excluded.confidence, reason = excluded.reason, suggested_at = now()
  where public.sc_material_map.status in ('suggested', 'unmatched');
end $$;

-- ---------- 4. Synchronisation (rôle service_role, appelée par la fonction Edge) ----------
-- Démarre une synchronisation, ou reprend celle en cours (une seule à la fois).
-- p_trigger 'cron' : ne démarre rien si une synchronisation réussie date de moins de 20 h.
create or replace function public.sc_sync_begin(p_trigger text, p_user uuid default null, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.sc_sync_runs; last_ok timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('sc_sync', 0));
  if p_trigger not in ('manual', 'cron') then raise exception 'Déclencheur inconnu.'; end if;
  select * into r from public.sc_sync_runs where status = 'running';
  if found then
    -- Une autre invocation travaille encore : jamais deux synchronisations en parallèle.
    if r.lease_until > now() then
      return jsonb_build_object('run_id', r.id, 'busy', true, 'phase', r.phase, 'pending', cardinality(r.pending));
    end if;
    if r.started_at < now() - interval '1 day' then
      update public.sc_sync_runs set status = 'error', finished_at = now(), error = 'Interrompue (plus de 24 h)' where id = r.id;
    else
      update public.sc_sync_runs set heartbeat_at = now(), lease_until = now() + interval '170 seconds' where id = r.id;
      return jsonb_build_object('run_id', r.id, 'resumed', true, 'phase', r.phase, 'game_version', r.game_version,
                                'pending', to_jsonb(r.pending), 'force', r.force);
    end if;
  end if;
  if p_trigger = 'cron' then
    select max(finished_at) into last_ok from public.sc_sync_runs where status in ('success', 'partial');
    if last_ok > now() - interval '20 hours' then return jsonb_build_object('nothing_to_do', true, 'last_success', last_ok); end if;
  else
    if exists (select 1 from public.sc_sync_runs where trigger = 'manual' and started_at > now() - interval '2 minutes') then
      raise exception 'Une synchronisation vient d''être lancée : patiente deux minutes.';
    end if;
  end if;
  insert into public.sc_sync_runs (trigger, requested_by, force, lease_until)
  values (p_trigger, p_user, coalesce(p_force, false), now() + interval '170 seconds') returning * into r;
  return jsonb_build_object('run_id', r.id, 'resumed', false, 'phase', 'list', 'pending', '[]'::jsonb, 'force', r.force);
end $$;

-- Liste complète des blueprints (données réduites + empreinte calculée par la fonction Edge).
-- p = { game_version, versions: [...], total, items: [{ uuid, key, hash, output_name, output_uuid, output_class, output_type,
--       output_type_label, output_grade, category_uuid, craft_time_seconds, is_available_by_default, web_url, game_version }] }
-- Renvoie la liste des UUID dont la recette doit être relue en détail.
create or replace function public.sc_sync_list(p_run bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.sc_sync_runs; it jsonb; b public.sc_blueprints; v_uuid uuid; v_pending uuid[] := '{}'; v_new integer := 0;
        v_seen uuid[] := '{}'; v_total integer; v_missing integer := 0; v_moved integer := 0; v jsonb;
begin
  select * into r from public.sc_sync_runs where id = p_run for update;
  if not found or r.status <> 'running' then raise exception 'Synchronisation introuvable ou terminée.'; end if;
  for v in select value from jsonb_array_elements(coalesce(p -> 'versions', '[]'::jsonb)) loop
    insert into public.sc_game_versions (code, channel, released_at, is_default)
    values (v ->> 'code', v ->> 'channel', nullif(v ->> 'released_at', '')::timestamptz, coalesce((v ->> 'is_default')::boolean, false))
    on conflict (code) do update set channel = excluded.channel, released_at = excluded.released_at,
      is_default = excluded.is_default, last_seen_at = now();
  end loop;
  if exists (select 1 from jsonb_array_elements(coalesce(p -> 'versions', '[]'::jsonb)) x where (x ->> 'is_default')::boolean) then
    update public.sc_game_versions set is_default = false
    where is_default and code not in (select x ->> 'code' from jsonb_array_elements(p -> 'versions') x where (x ->> 'is_default')::boolean);
  end if;

  for it in select value from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) loop
    v_uuid := nullif(it ->> 'uuid', '')::uuid;
    if v_uuid is null or nullif(it ->> 'key', '') is null or nullif(it ->> 'hash', '') is null then
      insert into public.sc_sync_errors (run_id, context, message) values (p_run, 'liste', 'Ligne sans UUID, clé ou empreinte : ' || left(it::text, 200));
      continue;
    end if;
    if v_uuid = any (v_seen) then continue; end if;   -- même blueprint deux fois dans la liste : ignoré
    v_seen := v_seen || v_uuid;
    select * into b from public.sc_blueprints where uuid = v_uuid for update;
    if not found then
      -- Même clé, nouvel UUID : c'est le même blueprint (pas de doublon), l'ancien UUID est conservé.
      select * into b from public.sc_blueprints where key = it ->> 'key' for update;
      if found then
        update public.sc_blueprints set former_uuids = array_append(former_uuids, uuid), uuid = v_uuid where id = b.id;
        insert into public.sc_sync_errors (run_id, context, blueprint_uuid, message)
        values (p_run, 'liste', v_uuid, 'UUID modifié par l''API pour ' || b.key || ' (ancien : ' || b.uuid || ')');
        v_moved := v_moved + 1;
      else
        insert into public.sc_blueprints (uuid, key, first_seen_version) values (v_uuid, it ->> 'key', it ->> 'game_version')
        returning * into b;
        v_new := v_new + 1;
      end if;
    end if;
    update public.sc_blueprints set
      key = it ->> 'key',
      output_name = left(coalesce(it ->> 'output_name', ''), 200),
      output_uuid = nullif(it ->> 'output_uuid', '')::uuid,
      output_class = it ->> 'output_class', output_type = it ->> 'output_type', output_type_label = it ->> 'output_type_label',
      output_grade = it ->> 'output_grade', category_uuid = nullif(it ->> 'category_uuid', '')::uuid,
      craft_time_seconds = nullif(it ->> 'craft_time_seconds', '')::int,
      is_available_by_default = nullif(it ->> 'is_available_by_default', '')::boolean,
      web_url = it ->> 'web_url', game_version = it ->> 'game_version',
      last_seen_at = now(), missing_since = null, list_hash_seen = it ->> 'hash'
    where id = b.id;
    if r.force or b.current_recipe_id is null or b.list_hash_done is distinct from (it ->> 'hash') then
      v_pending := v_pending || v_uuid;
    end if;
  end loop;

  -- Liste complète : les blueprints absents sont marqués (jamais supprimés : des membres peuvent les posséder).
  v_total := nullif(p ->> 'total', '')::int;
  if v_total is not null and v_total = cardinality(v_seen) then
    update public.sc_blueprints set missing_since = coalesce(missing_since, now()) where not (uuid = any (v_seen));
    get diagnostics v_missing = row_count;
  elsif v_total is not null then
    insert into public.sc_sync_errors (run_id, context, message)
    values (p_run, 'liste', format('Liste incomplète : %s blueprints reçus sur %s annoncés ; aucun n''est marqué absent.', cardinality(v_seen), v_total));
  end if;

  update public.sc_sync_runs set phase = 'details', pending = v_pending, game_version = p ->> 'game_version', heartbeat_at = now(), lease_until = now() + interval '170 seconds',
    stats = stats || jsonb_build_object('listed', cardinality(v_seen), 'new', v_new, 'uuid_changed', v_moved,
                                        'missing', v_missing, 'to_fetch', cardinality(v_pending))
  where id = p_run;
  return jsonb_build_object('pending', to_jsonb(v_pending));
end $$;

-- Enregistre une recette lue en détail (renvoie 'new', 'same' ou 'changed').
create or replace function public._sc_ingest_detail(p_run bigint, d jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare b public.sc_blueprints; parsed jsonb; v_hash text; cur public.sc_recipes; v_id bigint; x jsonb; v_res text;
        v_craft integer := nullif(d ->> 'craft_time_seconds', '')::int; v_ver text := d ->> 'game_version'; v_issues text[];
begin
  select * into b from public.sc_blueprints where uuid = (d ->> 'uuid')::uuid for update;
  if not found then raise exception 'Blueprint % absent de la liste.', d ->> 'uuid'; end if;
  if nullif(d ->> 'key', '') is not null and d ->> 'key' <> b.key then
    raise exception 'Clé différente dans le détail (% / %).', d ->> 'key', b.key;
  end if;
  parsed := public._sc_parse_recipe(d);
  v_issues := array(select jsonb_array_elements_text(parsed -> 'issues'));
  v_hash := public._sc_recipe_hash(parsed -> 'rows', v_craft);
  select * into cur from public.sc_recipes where blueprint_id = b.id and is_current;
  if found and cur.content_hash = v_hash then
    update public.sc_recipes set last_seen_version = v_ver, last_seen_at = now() where id = cur.id;
    v_res := 'same';
  else
    -- Recette déjà connue (retour à une ancienne version) : elle redevient courante, sans doublon.
    select id into v_id from public.sc_recipes where blueprint_id = b.id and content_hash = v_hash;
    if cur.id is not null then
      update public.sc_recipes set is_current = false, superseded_at = now() where id = cur.id;
    end if;
    if v_id is null then
      insert into public.sc_recipes (blueprint_id, content_hash, game_version, last_seen_version, tier_count, complete, issues,
                                     craft_time_seconds, raw)
      values (b.id, v_hash, v_ver, v_ver, coalesce((parsed ->> 'tiers')::int, 1), cardinality(v_issues) = 0, v_issues, v_craft,
              jsonb_build_object('tiers', d -> 'tiers', 'requirement_groups', d -> 'requirement_groups'))
      returning id into v_id;
      insert into public.sc_ingredients (recipe_id, tier_index, slot_key, slot_name, slot_position, required_count, option_count,
                                         option_index, kind, api_uuid, ore_uuid, name, quantity, unit, min_quality)
      select v_id, (e ->> 'tier_index')::int, left(e ->> 'slot_key', 120), left(e ->> 'slot_name', 120), (e ->> 'slot_position')::int,
             nullif(e ->> 'required_count', '')::int, (e ->> 'option_count')::int, (e ->> 'option_index')::int, e ->> 'kind',
             nullif(e ->> 'api_uuid', '')::uuid, nullif(e ->> 'ore_uuid', '')::uuid, left(e ->> 'name', 120),
             nullif(e ->> 'quantity', '')::numeric, e ->> 'unit', nullif(e ->> 'min_quality', '')::numeric::int
      from jsonb_array_elements(parsed -> 'rows') e;
    else
      update public.sc_recipes set is_current = true, superseded_at = null, superseded_by = null, last_seen_version = v_ver,
        last_seen_at = now() where id = v_id;
    end if;
    if cur.id is not null then update public.sc_recipes set superseded_by = v_id where id = cur.id; end if;
    update public.sc_blueprints set current_recipe_id = v_id where id = b.id;
    v_res := case when cur.id is null then 'new' else 'changed' end;
  end if;
  -- Matières citées : ressource raffinée ou objet, et minerai brut associé.
  for x in select value from jsonb_array_elements(parsed -> 'rows') loop
    if nullif(x ->> 'api_uuid', '') is not null then
      insert into public.sc_materials (api_uuid, kind, name) values ((x ->> 'api_uuid')::uuid, x ->> 'kind', x ->> 'name')
      on conflict (api_uuid) do update set name = excluded.name, last_seen_at = now();
      perform public._sc_suggest((x ->> 'api_uuid')::uuid);
    end if;
    if nullif(x ->> 'ore_uuid', '') is not null then
      insert into public.sc_materials (api_uuid, kind, name, refined_uuid)
      values ((x ->> 'ore_uuid')::uuid, 'ore', (x ->> 'name') || ' (Ore)', nullif(x ->> 'api_uuid', '')::uuid)
      on conflict (api_uuid) do update set last_seen_at = now();
      perform public._sc_suggest((x ->> 'ore_uuid')::uuid);
    end if;
  end loop;
  update public.sc_blueprints set detail_fetched_at = now(), list_hash_done = list_hash_seen,
    craft_time_seconds = coalesce(v_craft, craft_time_seconds) where id = b.id;
  return v_res;
end $$;

-- Lot de recettes lues en détail. p = { details: [...], failed: [{ uuid, message }] }
-- Chaque recette est enregistrée séparément : une erreur sur l'une est journalisée sans bloquer les autres.
create or replace function public.sc_sync_details(p_run bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.sc_sync_runs; d jsonb; v text; v_done uuid[] := '{}'; v_failed uuid[] := '{}'; c jsonb := '{}'::jsonb;
begin
  select * into r from public.sc_sync_runs where id = p_run for update;
  if not found or r.status <> 'running' then raise exception 'Synchronisation introuvable ou terminée.'; end if;
  for d in select value from jsonb_array_elements(coalesce(p -> 'details', '[]'::jsonb)) loop
    begin
      v := public._sc_ingest_detail(p_run, d);
      c := jsonb_set(c, array[v], to_jsonb(coalesce((c ->> v)::int, 0) + 1));
      v_done := v_done || (d ->> 'uuid')::uuid;
    exception when others then
      insert into public.sc_sync_errors (run_id, context, blueprint_uuid, message)
      values (p_run, 'détail', nullif(d ->> 'uuid', '')::uuid, left(sqlerrm, 500));
      v_failed := v_failed || nullif(d ->> 'uuid', '')::uuid;
    end;
  end loop;
  for d in select value from jsonb_array_elements(coalesce(p -> 'failed', '[]'::jsonb)) loop
    insert into public.sc_sync_errors (run_id, context, blueprint_uuid, message)
    values (p_run, 'API', nullif(d ->> 'uuid', '')::uuid, left(coalesce(d ->> 'message', 'Erreur'), 500));
    v_failed := v_failed || nullif(d ->> 'uuid', '')::uuid;
  end loop;
  update public.sc_sync_runs set
    pending = array(select u from unnest(pending) u where not (u = any (v_done)) and not (u = any (v_failed))),
    failed = array(select distinct u from unnest(failed || v_failed) u where u is not null),
    heartbeat_at = now(), lease_until = now() + interval '170 seconds',
    stats = stats || jsonb_build_object(
      'new_recipes', coalesce((stats ->> 'new_recipes')::int, 0) + coalesce((c ->> 'new')::int, 0),
      'changed_recipes', coalesce((stats ->> 'changed_recipes')::int, 0) + coalesce((c ->> 'changed')::int, 0),
      'unchanged_recipes', coalesce((stats ->> 'unchanged_recipes')::int, 0) + coalesce((c ->> 'same')::int, 0))
  where id = p_run returning * into r;
  return jsonb_build_object('pending', to_jsonb(r.pending), 'failed', cardinality(r.failed));
end $$;

create or replace function public.sc_sync_finish(p_run bigint, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.sc_sync_runs; n integer;
begin
  select * into r from public.sc_sync_runs where id = p_run for update;
  if not found or r.status <> 'running' then raise exception 'Synchronisation introuvable ou terminée.'; end if;
  if p_error is not null then
    insert into public.sc_sync_errors (run_id, context, message) values (p_run, 'synchronisation', left(p_error, 500));
  end if;
  select count(*) into n from public.sc_sync_errors where run_id = p_run;
  update public.sc_sync_runs set finished_at = now(), phase = 'done', error = left(p_error, 500), lease_until = null,
    status = case when p_error is not null and r.phase = 'list' then 'error'
                  when p_error is not null or cardinality(r.failed) > 0 or cardinality(r.pending) > 0 or n > 0 then 'partial'
                  else 'success' end,
    stats = stats || jsonb_build_object('errors', n)
  where id = p_run returning * into r;
  return to_jsonb(r) - 'pending';
end $$;

-- Fin d'une invocation sans avoir tout traité : la suivante pourra reprendre aussitôt.
create or replace function public.sc_sync_release(p_run bigint) returns void
language sql security definer set search_path = public as $$
  update public.sc_sync_runs set lease_until = null, heartbeat_at = now() where id = p_run and status = 'running'
$$;

-- Contrôle d'accès pour un déclenchement manuel (appelé avec le jeton de l'utilisateur).
create or replace function public.sc_can_sync() returns boolean
language sql stable security definer set search_path = public as $$ select public.is_admin() $$;

-- ---------- 5. Correspondances (administrateurs) ----------
-- p_action : 'confirm' (avec p_resource), 'reject', 'reset' (revenir à la suggestion automatique).
create or replace function public.sc_set_material_map(p_uuid uuid, p_action text, p_resource uuid default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if not exists (select 1 from public.sc_materials where api_uuid = p_uuid) then raise exception 'Matière introuvable.'; end if;
  if p_action = 'confirm' then
    if p_resource is null or not exists (select 1 from public.resources where id = p_resource) then
      raise exception 'Choisis la ressource du registre correspondante.';
    end if;
    if exists (select 1 from public.sc_material_map where resource_id = p_resource and status = 'confirmed' and api_uuid <> p_uuid) then
      raise exception 'Cette ressource correspond déjà à une autre matière.';
    end if;
    insert into public.sc_material_map (api_uuid, resource_id, status, method, confidence, reason, decided_by, decided_at)
    values (p_uuid, p_resource, 'confirmed', 'manual', 1, 'Validé', auth.uid(), now())
    on conflict (api_uuid) do update set resource_id = p_resource, status = 'confirmed', method = 'manual', confidence = 1,
      reason = 'Validé', decided_by = auth.uid(), decided_at = now();
  elsif p_action = 'reject' then
    insert into public.sc_material_map (api_uuid, resource_id, status, method, reason, decided_by, decided_at)
    values (p_uuid, null, 'rejected', 'manual', 'Aucune ressource du registre', auth.uid(), now())
    on conflict (api_uuid) do update set resource_id = null, status = 'rejected', method = 'manual',
      reason = 'Aucune ressource du registre', decided_by = auth.uid(), decided_at = now();
  elsif p_action = 'reset' then
    update public.sc_material_map set status = 'unmatched', resource_id = null, decided_by = auth.uid(), decided_at = now()
    where api_uuid = p_uuid;
    perform public._sc_suggest(p_uuid);
  else
    raise exception 'Action inconnue.';
  end if;
end $$;

-- Recalcule les suggestions (ex. après l'ajout d'une ressource au catalogue). Les décisions ne changent pas.
create or replace function public.sc_refresh_suggestions() returns integer
language plpgsql security definer set search_path = public as $$
declare m record; n integer := 0;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  for m in select api_uuid from public.sc_materials loop perform public._sc_suggest(m.api_uuid); n := n + 1; end loop;
  return n;
end $$;

-- ---------- 6. Blueprints possédés (déclaration par chaque membre) ----------
create or replace function public.set_member_blueprint(p_blueprint bigint, p_owned boolean, p_note text default '',
                                                       p_owner uuid default null) returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_owner := public._stock_owner(p_owner);
  if not exists (select 1 from public.sc_blueprints where id = p_blueprint) then raise exception 'Blueprint introuvable.'; end if;
  if p_owned then
    insert into public.member_blueprints (user_id, blueprint_id, note, declared_by)
    values (v_owner, p_blueprint, left(coalesce(trim(p_note), ''), 200), auth.uid())
    on conflict (user_id, blueprint_id) do update set removed_at = null, note = excluded.note, declared_by = auth.uid(), updated_at = now();
  else
    update public.member_blueprints set removed_at = now(), declared_by = auth.uid(), updated_at = now()
    where user_id = v_owner and blueprint_id = p_blueprint and removed_at is null;
  end if;
end $$;

-- ---------- 7. Droits ----------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
revoke all on public.sc_game_versions, public.sc_blueprints, public.sc_recipes, public.sc_ingredients, public.sc_materials,
  public.sc_material_map, public.member_blueprints, public.sc_sync_runs, public.sc_sync_errors from anon;
grant select on public.sc_game_versions, public.sc_blueprints, public.sc_recipes, public.sc_ingredients, public.sc_materials,
  public.sc_material_map, public.member_blueprints, public.sc_sync_runs, public.sc_sync_errors to authenticated;
do $$
declare f text;
begin
  foreach f in array array['_sc_parse_recipe(jsonb)', '_sc_recipe_hash(jsonb, integer)', '_sc_suggest(uuid)',
    '_sc_ingest_detail(bigint, jsonb)', 'sc_sync_begin(text, uuid, boolean)', 'sc_sync_list(bigint, jsonb)',
    'sc_sync_details(bigint, jsonb)', 'sc_sync_finish(bigint, text)', 'sc_sync_release(bigint)'] loop
    execute 'revoke execute on function public.' || f || ' from public, anon, authenticated';
  end loop;
  foreach f in array array['sc_sync_begin(text, uuid, boolean)', 'sc_sync_list(bigint, jsonb)',
    'sc_sync_details(bigint, jsonb)', 'sc_sync_finish(bigint, text)', 'sc_sync_release(bigint)'] loop
    execute 'grant execute on function public.' || f || ' to service_role';
  end loop;
  foreach f in array array['sc_can_sync()', 'sc_set_material_map(uuid, text, uuid)', 'sc_refresh_suggestions()',
    'set_member_blueprint(bigint, boolean, text, uuid)', 'same_org(uuid)'] loop
    execute 'revoke execute on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
grant usage on schema public to service_role;
grant select, insert, update on public.sc_game_versions, public.sc_blueprints, public.sc_recipes, public.sc_ingredients,
  public.sc_materials, public.sc_material_map, public.sc_sync_runs, public.sc_sync_errors to service_role;

do $$ begin
  begin alter publication supabase_realtime add table public.sc_sync_runs; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.member_blueprints; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.sc_material_map; exception when duplicate_object then null; end;
end $$;
