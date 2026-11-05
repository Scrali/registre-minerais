-- Registre des minerais : stocks personnels par membre, lieu, ressource, qualité et unité.
-- À exécuter APRÈS 005, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
--
-- Migration ADDITIVE : aucune table ni colonne existante n'est supprimée ou modifiée dans son sens.
--  * resources reste le catalogue (noms, couleurs, images de référence).
--  * Les anciens stocks (resources.places), qui n'appartiennent à personne, sont recopiés dans
--    legacy_stocks (« historique non attribué ») et ne sont JAMAIS additionnés aux stocks personnels.
--  * Une copie de sauvegarde de resources et movements est faite dans le schéma archive.
--
-- Clé d'un stock : (user_id, location_id, resource_id, quality_key, unit)
--   quality_key = '0'..'1000' ou '-' (qualité inconnue, valeur explicite : jamais NULL)
--   unit        = unité affichée par le jeu ('' = nombre d'objets « 20x », 'SCU', 'cSCU'…), jamais convertie.

-- ---------- 0. Sauvegarde avant migration (une seule fois) ----------
create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;
do $$ begin
  if to_regclass('archive.resources_avant_006') is null then
    create table archive.resources_avant_006 as select * from public.resources;
    create table archive.movements_avant_006 as select * from public.movements;
  end if;
end $$;

-- ---------- 1. Lieux de stockage ----------
-- Identifiant normalisé : sans accents, casse, espaces ni ponctuation (« New Babbage » = « new-babbage »).
create or replace function public.place_slug(p text) returns text
language sql immutable as $$
  select regexp_replace(lower(translate(coalesce(p, ''),
    'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûüÝýÿŒœÆæ',
    'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyyOoAa')), '[^a-z0-9]+', '', 'g')
$$;

create table if not exists public.locations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  slug text not null unique check (slug <> ''),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null
);

-- ---------- 2. Stocks personnels ----------
create table if not exists public.user_stocks (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete restrict,
  location_id uuid not null references public.locations (id) on delete restrict,
  resource_id uuid not null references public.resources (id) on delete restrict,
  quality_key text not null default '-'
    check (quality_key = '-' or (quality_key ~ '^[0-9]{1,4}$' and quality_key::int <= 1000)),
  unit text not null default '' check (length(unit) <= 20),
  quantity numeric(16, 3) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  last_scan_id bigint,
  version integer not null default 1,
  constraint user_stocks_key unique (user_id, location_id, resource_id, quality_key, unit)
);
create index if not exists user_stocks_loc_idx on public.user_stocks (location_id, resource_id);

-- ---------- 3. Captures (observations d'un inventaire) ----------
create table if not exists public.inventory_scans (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete restrict,   -- propriétaire du stock
  author_id uuid references public.profiles (id) on delete set null,          -- qui a enregistré
  location_id uuid not null references public.locations (id) on delete restrict,
  terminal_type text not null default 'inconnu'
    check (terminal_type in ('inventaire', 'ascenseur_fret', 'autre', 'inconnu')),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  coverage_status text not null check (coverage_status in ('partial', 'complete')),
  validation_status text not null default 'applied' check (validation_status in ('applied', 'rejected')),
  idempotency_key text not null unique,
  image_fingerprint text[] not null default '{}',
  page_count integer not null default 1,
  note text not null default '',
  result jsonb
);
create index if not exists inventory_scans_owner_idx on public.inventory_scans (user_id, location_id, observed_at desc);

create table if not exists public.scan_items (
  id bigint generated always as identity primary key,
  scan_id bigint not null references public.inventory_scans (id) on delete cascade,
  resource_id uuid references public.resources (id) on delete set null,
  quality_key text not null default '-',
  quantity numeric(16, 3) not null check (quantity >= 0),
  unit text not null default '',
  confidence numeric(4, 3),
  image_reference text,
  validation_status text not null default 'accepted' check (validation_status in ('accepted', 'corrected', 'rejected'))
);
create index if not exists scan_items_scan_idx on public.scan_items (scan_id);

-- ---------- 4. Journal : chaque mouvement personnel a un propriétaire, un lieu et une qualité ----------
alter table public.movements add column if not exists owner_id uuid references public.profiles (id) on delete set null;
alter table public.movements add column if not exists location_id uuid references public.locations (id) on delete set null;
alter table public.movements add column if not exists quality_key text;
alter table public.movements add column if not exists delta numeric;
alter table public.movements add column if not exists kind text;
alter table public.movements add column if not exists scan_id bigint;
alter table public.movements add column if not exists classified_by uuid references public.profiles (id) on delete set null;
alter table public.movements add column if not exists classified_at timestamptz;
create index if not exists movements_owner_idx on public.movements (owner_id, location_id, at desc);

-- Nature d'un mouvement personnel.
--   neutre    : initial (premier relevé, jamais compté comme apport), correction, legacy_attribution
--   hausse    : increase (constatée, origine inconnue), deposit, production, transfer_in, purchase
--   baisse    : decrease (constatée, cause inconnue), withdrawal, sale, transfer_out, refining, consumption, loss
create or replace function public.kind_sign(k text) returns integer
language sql immutable as $$
  select case
    when k in ('increase', 'deposit', 'production', 'transfer_in', 'purchase') then 1
    when k in ('decrease', 'withdrawal', 'sale', 'transfer_out', 'refining', 'consumption', 'loss') then -1
    when k in ('initial', 'correction', 'legacy_attribution') then 0
    else null end
$$;

-- ---------- 5. Anciens stocks non attribués ----------
create table if not exists public.legacy_stocks (
  id bigint generated always as identity primary key,
  resource_id uuid references public.resources (id) on delete set null,
  resource_name text not null,
  place_name text not null default '',
  location_id uuid references public.locations (id) on delete set null,
  quality_key text not null,
  quantity numeric(16, 3) not null check (quantity >= 0),
  status text not null default 'open' check (status in ('open', 'attributed', 'archived')),
  attributed_to uuid references public.profiles (id) on delete set null,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  note text not null default '',
  created_at timestamptz not null default now(),
  constraint legacy_stocks_key unique (resource_id, place_name, quality_key)
);

-- Lieux déjà utilisés par l'ancien système.
insert into public.locations (name, slug)
select distinct on (public.place_slug(p.key)) left(trim(p.key), 80), public.place_slug(p.key)
from public.resources r, jsonb_each(r.places) p
where public.place_slug(p.key) <> ''
on conflict (slug) do nothing;

insert into public.legacy_stocks (resource_id, resource_name, place_name, location_id, quality_key, quantity)
select r.id, r.name, p.key, l.id, q.key, q.value::numeric
from public.resources r
cross join lateral jsonb_each(r.places) p
cross join lateral jsonb_each_text(p.value) q
left join public.locations l on l.slug = public.place_slug(p.key) and public.place_slug(p.key) <> ''
where q.value::numeric > 0
on conflict on constraint legacy_stocks_key do nothing;

-- ---------- 6. Lecture : membres validés uniquement ; aucune écriture directe ----------
alter table public.locations enable row level security;
alter table public.user_stocks enable row level security;
alter table public.inventory_scans enable row level security;
alter table public.scan_items enable row level security;
alter table public.legacy_stocks enable row level security;
drop policy if exists "lieux lisibles" on public.locations;
create policy "lieux lisibles" on public.locations for select to authenticated using (public.is_member());
drop policy if exists "stocks perso lisibles" on public.user_stocks;
create policy "stocks perso lisibles" on public.user_stocks for select to authenticated using (public.is_member());
drop policy if exists "captures lisibles" on public.inventory_scans;
create policy "captures lisibles" on public.inventory_scans for select to authenticated using (public.is_member());
drop policy if exists "lignes lisibles" on public.scan_items;
create policy "lignes lisibles" on public.scan_items for select to authenticated using (public.is_member());
drop policy if exists "historique lisible" on public.legacy_stocks;
create policy "historique lisible" on public.legacy_stocks for select to authenticated using (public.is_member());

-- ---------- 7. Fonctions internes ----------
create or replace function public._qkey(p text) returns text
language plpgsql immutable as $$
declare v numeric;
begin
  if p is null or trim(p) in ('', '-') then return '-'; end if;
  begin v := round(trim(p)::numeric); exception when others then raise exception 'Qualité invalide : %', p; end;
  if v < 0 or v > 1000 then raise exception 'Qualité invalide : % (0 à 1000)', p; end if;
  return v::int::text;
end $$;

-- Propriétaire du stock : toujours l'utilisateur connecté, sauf un administrateur qui corrige un membre.
create or replace function public._stock_owner(p_owner uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise.'; end if;
  if p_owner is null or p_owner = auth.uid() then return auth.uid(); end if;
  if not public.is_admin() then raise exception 'Tu ne peux modifier que ton propre inventaire.'; end if;
  if not exists (select 1 from public.profiles where id = p_owner and role in ('member', 'admin')) then
    raise exception 'Membre introuvable.';
  end if;
  return p_owner;
end $$;

-- Lieu existant (même identifiant normalisé) ou nouveau lieu.
create or replace function public.ensure_location(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare s text := public.place_slug(p_name); l uuid;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if s = '' then raise exception 'Choisis un lieu de stockage.'; end if;
  select id into l from public.locations where slug = s;
  if l is null then
    insert into public.locations (name, slug, created_by) values (left(trim(p_name), 80), s, auth.uid())
    on conflict (slug) do nothing returning id into l;
    if l is null then select id into l from public.locations where slug = s; end if;
  end if;
  return l;
end $$;

-- Nature d'un changement : un premier relevé n'est jamais un apport ; la nature demandée doit avoir le bon signe.
create or replace function public._classify(p_exists boolean, p_delta numeric, p_req text, p_mode text) returns text
language plpgsql immutable as $$
begin
  if p_mode = 'scan' and not p_exists then return 'initial'; end if;
  if p_req is not null and p_req <> '' then
    if public.kind_sign(p_req) is null then raise exception 'Nature de mouvement inconnue : %', p_req; end if;
    if public.kind_sign(p_req) = 0 or sign(p_delta) = public.kind_sign(p_req) then return p_req; end if;
  end if;
  return case when p_delta > 0 then 'increase' else 'decrease' end;
end $$;

-- Empreinte de l'état d'un inventaire (joueur + lieu), pour détecter un changement entre l'aperçu et l'enregistrement.
create or replace function public._stock_token(p_owner uuid, p_loc uuid) returns text
language sql stable security definer set search_path = public as $$
  select md5(coalesce(string_agg(id || ':' || version || ':' || quantity, ',' order by id), ''))
  from public.user_stocks where user_id = p_owner and location_id = p_loc
$$;

-- Écrit une ligne de stock et son mouvement (même transaction). Renvoie le changement, ou NULL si rien ne change.
create or replace function public._write_stock(
  p_owner uuid, p_loc uuid, p_res uuid, p_q text, p_unit text, p_new numeric,
  p_kind text, p_mode text, p_note text, p_scan bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur public.user_stocks; r public.resources; v_before numeric := 0; v_delta numeric; v_kind text; v_exists boolean;
begin
  select * into r from public.resources where id = p_res;
  if not found then raise exception 'Ressource introuvable.'; end if;
  if p_new < 0 then raise exception 'Quantité négative impossible.'; end if;
  select * into cur from public.user_stocks
    where user_id = p_owner and location_id = p_loc and resource_id = p_res and quality_key = p_q and unit = p_unit
    for update;
  v_exists := found;
  if v_exists then v_before := cur.quantity; end if;
  if v_exists and p_new = cur.quantity then
    if p_scan is not null then update public.user_stocks set last_scan_id = p_scan where id = cur.id; end if;
    return null;
  end if;
  if not v_exists and p_new = 0 then return null; end if;
  v_delta := p_new - v_before;
  v_kind := public._classify(v_exists, v_delta, p_kind, p_mode);
  if v_exists then
    update public.user_stocks set quantity = p_new, updated_at = now(),
      last_scan_id = coalesce(p_scan, last_scan_id), version = version + 1
    where id = cur.id;
  else
    insert into public.user_stocks (user_id, location_id, resource_id, quality_key, unit, quantity, last_scan_id)
    values (p_owner, p_loc, p_res, p_q, p_unit, p_new, p_scan);
  end if;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                owner_id, location_id, quality_key, delta, kind, scan_id)
  values (p_res, r.name, p_unit, v_before, p_new,
          case when p_q = '-' then 'Q?' else 'Q' || p_q end || ' ' || case when v_delta > 0 then '+' else '' end || v_delta::text,
          p_mode, case when p_scan is null then 'manuel' else 'capture' end, coalesce(p_note, ''), auth.uid(),
          p_owner, p_loc, p_q, v_delta, v_kind, p_scan);
  return jsonb_build_object('resource_id', p_res, 'name', r.name, 'quality_key', p_q, 'unit', p_unit,
    'before', v_before, 'after', p_new, 'delta', v_delta, 'kind', v_kind, 'initial', v_kind = 'initial');
end $$;

-- ---------- 8. Enregistrement d'une capture : comparaison avec l'état précédent ----------
-- p = {
--   idempotency_key, location, owner_id?, terminal_type, observed_at, coverage: 'partial'|'complete',
--   fingerprints: [..], page_count, note, allow_stale?, state_token?,
--   items: [{ resource_id, quality_key, quantity, unit, confidence?, image_reference?, validation_status? }],
--   reasons: { "<resource_id>|<qualité>|<unité>": "sale", ... }, absent_reason?
-- }
-- Une capture est une OBSERVATION du stock : on enregistre l'écart avec l'état précédent, jamais une addition.
-- Avec p_dry_run = true, rien n'est écrit : renvoie l'aperçu des variations.
create or replace function public.apply_scan(p jsonb, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_loc uuid; v_obs timestamptz; v_cov text; v_term text; v_key text; v_last timestamptz;
  v_stale boolean; v_old public.inventory_scans; v_token text; v_scan bigint; v_dup boolean;
  it record; v_prev numeric; v_exists boolean; v_kind text; v_k text; v_ch jsonb;
  v_changes jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_same integer := 0; v_result jsonb; v_name text;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_owner := public._stock_owner(nullif(p ->> 'owner_id', '')::uuid);
  v_loc := public.ensure_location(p ->> 'location');
  v_key := nullif(trim(p ->> 'idempotency_key'), '');
  if v_key is null and not p_dry_run then raise exception 'Clé d''idempotence manquante.'; end if;
  v_obs := coalesce(nullif(p ->> 'observed_at', '')::timestamptz, now());
  if v_obs > now() + interval '5 minutes' then raise exception 'La date de la capture est dans le futur.'; end if;
  v_cov := coalesce(p ->> 'coverage', 'partial');
  if v_cov not in ('partial', 'complete') then raise exception 'Couverture invalide.'; end if;
  v_term := coalesce(nullif(p ->> 'terminal_type', ''), 'inconnu');
  if v_term not in ('inventaire', 'ascenseur_fret', 'autre', 'inconnu') then v_term := 'inconnu'; end if;

  -- Un seul enregistrement à la fois pour un même joueur dans un même lieu.
  if not p_dry_run then
    perform pg_advisory_xact_lock(hashtextextended(v_owner::text || '/' || v_loc::text, 0));
  end if;

  -- Même opération déjà enregistrée : on renvoie le résultat d'origine sans rien réappliquer.
  if v_key is not null then
    select * into v_old from public.inventory_scans where idempotency_key = v_key;
    if found then
      if v_old.user_id <> v_owner or v_old.location_id <> v_loc then
        raise exception 'Clé d''idempotence déjà utilisée pour un autre inventaire.';
      end if;
      return coalesce(v_old.result, '{}'::jsonb) || jsonb_build_object('replayed', true, 'scan_id', v_old.id);
    end if;
  end if;

  -- Capture plus ancienne que le dernier état connu de cet inventaire ?
  select greatest(
    (select max(observed_at) from public.inventory_scans
      where user_id = v_owner and location_id = v_loc and validation_status = 'applied'),
    (select max(at) from public.movements
      where owner_id = v_owner and location_id = v_loc and mode <> 'scan'))
  into v_last;
  v_stale := v_last is not null and v_obs < v_last;
  if v_stale and not p_dry_run and not coalesce((p ->> 'allow_stale')::boolean, false) then
    raise exception 'STALE: cette capture est plus ancienne que le dernier état enregistré pour ce lieu (%). Confirme pour l''appliquer quand même.',
      to_char(v_last at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI');
  end if;

  -- L'inventaire a-t-il changé depuis l'aperçu ?
  v_token := public._stock_token(v_owner, v_loc);
  if not p_dry_run and nullif(p ->> 'state_token', '') is not null and p ->> 'state_token' <> v_token then
    raise exception 'STATE_CHANGED: l''inventaire de ce lieu a changé depuis l''aperçu. Relance l''aperçu avant d''enregistrer.';
  end if;

  select exists (select 1 from public.inventory_scans s
    where s.user_id = v_owner and s.location_id = v_loc and s.validation_status = 'applied'
      and s.image_fingerprint && array(select jsonb_array_elements_text(coalesce(p -> 'fingerprints', '[]'::jsonb))))
  into v_dup;

  if not p_dry_run then
    insert into public.inventory_scans (user_id, author_id, location_id, terminal_type, observed_at, coverage_status,
                                        validation_status, idempotency_key, image_fingerprint, page_count, note)
    values (v_owner, auth.uid(), v_loc, v_term, v_obs, v_cov, 'applied', v_key,
            array(select jsonb_array_elements_text(coalesce(p -> 'fingerprints', '[]'::jsonb))),
            greatest(1, coalesce((p ->> 'page_count')::int, 1)), left(coalesce(p ->> 'note', ''), 300))
    returning id into v_scan;

    insert into public.scan_items (scan_id, resource_id, quality_key, quantity, unit, confidence, image_reference, validation_status)
    select v_scan, nullif(x ->> 'resource_id', '')::uuid, public._qkey(x ->> 'quality_key'), (x ->> 'quantity')::numeric,
           left(coalesce(trim(x ->> 'unit'), ''), 20), nullif(x ->> 'confidence', '')::numeric,
           case when length(x ->> 'image_reference') <= 20000 then x ->> 'image_reference' end,
           coalesce(nullif(x ->> 'validation_status', ''), 'accepted')
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) x;
  end if;

  -- Lignes observées, regroupées par ressource + qualité + unité (plusieurs cases d'un même lot s'additionnent).
  for it in
    select (x ->> 'resource_id')::uuid as res, public._qkey(x ->> 'quality_key') as q,
           left(coalesce(trim(x ->> 'unit'), ''), 20) as unit, sum((x ->> 'quantity')::numeric) as qty
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) x
    where coalesce(x ->> 'validation_status', 'accepted') <> 'rejected'
    group by 1, 2, 3
  loop
    if it.res is null then raise exception 'Chaque ligne doit être rattachée à une ressource du catalogue.'; end if;
    if it.qty is null or it.qty < 0 then raise exception 'Quantité invalide.'; end if;
    v_k := it.res || '|' || it.q || '|' || it.unit;
    v_seen := v_seen || v_k;
    if p_dry_run then
      select quantity into v_prev from public.user_stocks
        where user_id = v_owner and location_id = v_loc and resource_id = it.res and quality_key = it.q and unit = it.unit;
      v_exists := found;
      select name into v_name from public.resources where id = it.res;
      if v_name is null then raise exception 'Ressource introuvable.'; end if;
      if (v_exists and v_prev = it.qty) or (not v_exists and it.qty = 0) then v_same := v_same + 1; continue; end if;
      v_kind := public._classify(v_exists, it.qty - coalesce(v_prev, 0), p -> 'reasons' ->> v_k, 'scan');
      v_ch := jsonb_build_object('resource_id', it.res, 'name', v_name, 'quality_key', it.q, 'unit', it.unit,
        'before', coalesce(v_prev, 0), 'after', it.qty, 'delta', it.qty - coalesce(v_prev, 0), 'kind', v_kind,
        'initial', v_kind = 'initial');
    else
      v_ch := public._write_stock(v_owner, v_loc, it.res, it.q, it.unit, it.qty, p -> 'reasons' ->> v_k, 'scan',
                                  left(coalesce(p ->> 'note', ''), 300), v_scan);
      if v_ch is null then v_same := v_same + 1; continue; end if;
    end if;
    v_changes := v_changes || jsonb_build_array(v_ch);
  end loop;

  -- Inventaire complet validé : ce qui n'apparaît plus est à 0. Capture partielle : on ne touche à rien d'autre.
  if v_cov = 'complete' then
    for it in
      select s.resource_id as res, s.quality_key as q, s.unit, s.quantity as qty, r.name
      from public.user_stocks s join public.resources r on r.id = s.resource_id
      where s.user_id = v_owner and s.location_id = v_loc and s.quantity > 0
        and not ((s.resource_id || '|' || s.quality_key || '|' || s.unit) = any (v_seen))
    loop
      v_k := it.res || '|' || it.q || '|' || it.unit;
      if p_dry_run then
        v_kind := public._classify(true, -it.qty, coalesce(p -> 'reasons' ->> v_k, p ->> 'absent_reason'), 'scan');
        v_ch := jsonb_build_object('resource_id', it.res, 'name', it.name, 'quality_key', it.q, 'unit', it.unit,
          'before', it.qty, 'after', 0, 'delta', -it.qty, 'kind', v_kind, 'initial', false);
      else
        v_ch := public._write_stock(v_owner, v_loc, it.res, it.q, it.unit, 0,
                  coalesce(p -> 'reasons' ->> v_k, p ->> 'absent_reason'), 'scan', left(coalesce(p ->> 'note', ''), 300), v_scan);
      end if;
      v_changes := v_changes || jsonb_build_array(v_ch || jsonb_build_object('absent', true));
    end loop;
  end if;

  v_result := jsonb_build_object(
    'scan_id', v_scan, 'owner_id', v_owner, 'location_id', v_loc, 'coverage', v_cov, 'terminal_type', v_term,
    'stale', v_stale, 'last_state_at', v_last, 'duplicate_images', coalesce(v_dup, false),
    'state_token', case when p_dry_run then v_token else public._stock_token(v_owner, v_loc) end,
    'unchanged', v_same, 'changes', v_changes, 'dry_run', p_dry_run);
  if not p_dry_run then update public.inventory_scans set result = v_result where id = v_scan; end if;
  return v_result;
end $$;

-- ---------- 9. Mouvement manuel (dépôt, retrait) et correction ----------
-- p = { location, resource_id, quality_key, unit, mode: 'add'|'remove'|'set', quantity, kind?, note?, owner_id? }
create or replace function public.adjust_stock(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_loc uuid; v_res uuid; v_q text; v_unit text; v_mode text; v_qty numeric; v_note text;
        v_cur numeric; v_new numeric; v_kind text;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_owner := public._stock_owner(nullif(p ->> 'owner_id', '')::uuid);
  v_loc := public.ensure_location(p ->> 'location');
  v_res := (p ->> 'resource_id')::uuid;
  v_q := public._qkey(p ->> 'quality_key');
  v_unit := left(coalesce(trim(p ->> 'unit'), ''), 20);
  v_mode := p ->> 'mode';
  v_qty := (p ->> 'quantity')::numeric;
  v_note := left(coalesce(trim(p ->> 'note'), ''), 300);
  if v_mode not in ('add', 'remove', 'set') then raise exception 'Mode invalide.'; end if;
  if v_qty is null or v_qty < 0 or (v_mode <> 'set' and v_qty = 0) then raise exception 'Quantité invalide.'; end if;
  if (v_mode = 'set' or v_owner <> auth.uid()) and v_note = '' then
    raise exception 'Indique le motif de la correction.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_owner::text || '/' || v_loc::text, 0));
  select quantity into v_cur from public.user_stocks
    where user_id = v_owner and location_id = v_loc and resource_id = v_res and quality_key = v_q and unit = v_unit;
  v_cur := coalesce(v_cur, 0);
  if v_mode = 'add' then v_new := v_cur + v_qty; v_kind := coalesce(nullif(p ->> 'kind', ''), 'deposit');
  elsif v_mode = 'remove' then
    if v_qty > v_cur then raise exception 'Stock insuffisant : % disponible(s).', v_cur; end if;
    v_new := v_cur - v_qty; v_kind := coalesce(nullif(p ->> 'kind', ''), 'withdrawal');
  else v_new := v_qty; v_kind := 'correction';
  end if;
  if public.kind_sign(v_kind) is null then raise exception 'Nature de mouvement inconnue : %', v_kind; end if;
  if v_mode <> 'set' and public.kind_sign(v_kind) <> (case when v_mode = 'add' then 1 else -1 end) then
    raise exception 'Cette nature ne correspond pas au sens du mouvement.';
  end if;
  return public._write_stock(v_owner, v_loc, v_res, v_q, v_unit, v_new, v_kind,
                             case when v_mode = 'set' then 'correction' else 'stock' end, v_note, null);
end $$;

-- ---------- 10. Classer après coup une hausse ou une baisse d'origine inconnue ----------
create or replace function public.classify_movement(p_id bigint, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.movements;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into m from public.movements where id = p_id for update;
  if not found or m.owner_id is null then raise exception 'Mouvement introuvable.'; end if;
  if m.owner_id <> auth.uid() and not public.is_admin() then raise exception 'Tu ne peux classer que tes propres mouvements.'; end if;
  if public.kind_sign(m.kind) = 0 then raise exception 'Ce mouvement n''est pas à classer.'; end if;
  if public.kind_sign(p_kind) is null or public.kind_sign(p_kind) <> sign(m.delta) then
    raise exception 'Cette nature ne correspond pas au sens du mouvement.';
  end if;
  update public.movements set kind = p_kind, classified_by = auth.uid(), classified_at = now() where id = p_id;
end $$;

-- ---------- 11. Rapprochement des anciens stocks non attribués (administrateurs) ----------
-- attribute : la quantité rejoint le stock personnel d'un membre (nature legacy_attribution, jamais un apport).
-- archive   : déjà comptée ailleurs ou obsolète ; elle sort de la zone « non attribué ». Rien n'est supprimé.
create or replace function public.resolve_legacy(p_id bigint, p_action text, p_owner uuid default null,
                                                 p_location text default null, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare l public.legacy_stocks; v_loc uuid; v_cur numeric; v_ch jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  select * into l from public.legacy_stocks where id = p_id for update;
  if not found then raise exception 'Ligne introuvable.'; end if;
  if l.status <> 'open' then raise exception 'Cette ligne a déjà été traitée.'; end if;
  if p_action = 'archive' then
    update public.legacy_stocks set status = 'archived', resolved_by = auth.uid(), resolved_at = now(),
      note = left(coalesce(p_note, ''), 300) where id = p_id;
    return null;
  elsif p_action <> 'attribute' then raise exception 'Action inconnue.';
  end if;
  if p_owner is null or not exists (select 1 from public.profiles where id = p_owner and role in ('member', 'admin')) then
    raise exception 'Choisis le membre à qui attribuer ce stock.';
  end if;
  if l.resource_id is null then raise exception 'La ressource n''existe plus dans le catalogue.'; end if;
  v_loc := coalesce(l.location_id, public.ensure_location(p_location));
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text || '/' || v_loc::text, 0));
  select quantity into v_cur from public.user_stocks
    where user_id = p_owner and location_id = v_loc and resource_id = l.resource_id and quality_key = l.quality_key and unit = '';
  v_ch := public._write_stock(p_owner, v_loc, l.resource_id, l.quality_key, '', coalesce(v_cur, 0) + l.quantity,
                              'legacy_attribution', 'legacy', coalesce(nullif(p_note, ''), 'Ancien stock attribué'), null);
  update public.legacy_stocks set status = 'attributed', attributed_to = p_owner, resolved_by = auth.uid(),
    resolved_at = now(), location_id = v_loc, note = left(coalesce(p_note, ''), 300) where id = p_id;
  return v_ch;
end $$;

-- ---------- 12. Fonctions existantes adaptées ----------
-- Fusion : les stocks personnels, lignes de capture et anciens stocks suivent la ressource conservée.
create or replace function public.merge_resources(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.resources; t public.resources; np jsonb; k text; v jsonb; new_lots jsonb; nr jsonb; us record;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if p_source = p_target then raise exception 'Choisis deux ressources différentes.'; end if;
  select * into t from public.resources where id = p_target for update;
  select * into s from public.resources where id = p_source for update;
  if t.id is null or s.id is null then raise exception 'Ressource introuvable.'; end if;
  np := t.places;
  for k, v in select key, value from jsonb_each(s.places) loop
    np := jsonb_set(np, array[k], public.merge_lots(coalesce(np -> k, '{}'::jsonb), v, 'add'));
  end loop;
  np := public.clean_places(np);
  new_lots := public.places_total(np);
  nr := t.refs || case when s.image <> '' and t.image <> '' then jsonb_build_array(s.image) else '[]'::jsonb end || s.refs;
  while jsonb_array_length(nr) > 6 loop nr := nr - 0; end loop;
  update public.resources set
    lots = new_lots, places = np, qty = public.sum_lots(new_lots),
    color = case when color = '' then s.color else color end,
    color_name = case when color_name = '' then s.color_name else color_name end,
    image = case when image = '' then s.image else image end,
    refs = nr, updated_at = now(), updated_by = auth.uid()
  where id = p_target;
  -- Stocks personnels : même clé chez la cible -> quantités additionnées, sinon la ligne change de ressource.
  for us in select * from public.user_stocks where resource_id = p_source for update loop
    update public.user_stocks set quantity = quantity + us.quantity, version = version + 1, updated_at = now()
      where user_id = us.user_id and location_id = us.location_id and resource_id = p_target
        and quality_key = us.quality_key and unit = us.unit;
    if found then delete from public.user_stocks where id = us.id;
    else update public.user_stocks set resource_id = p_target, version = version + 1 where id = us.id;
    end if;
  end loop;
  update public.scan_items set resource_id = p_target where resource_id = p_source;
  update public.legacy_stocks set resource_id = p_target, resource_name = t.name where resource_id = p_source;
  update public.movements set resource_id = p_target where resource_id = p_source;
  delete from public.resources where id = p_source;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                lots_before, lots_after, places_before, places_after)
  values (p_target, t.name, t.unit, t.qty, public.sum_lots(new_lots), public.lots_text(s.lots), 'merge', 'admin',
          'Fusion de « ' || s.name || ' »', auth.uid(), t.lots, new_lots, t.places, np);
end $$;

-- Suppression : refusée tant qu'un membre en possède, pour ne jamais perdre un stock personnel.
create or replace function public.delete_resource(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if exists (select 1 from public.user_stocks where resource_id = p_id and quantity > 0) then
    raise exception 'Des membres possèdent encore cette ressource : fusionne-la plutôt que de la supprimer.';
  end if;
  delete from public.user_stocks where resource_id = p_id;
  delete from public.resources where id = p_id returning * into r;
  if found then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, by, lots_before, lots_after)
    values (r.id, r.name, r.unit, r.qty, 0, public.lots_text(r.lots), 'delete', 'manuel', auth.uid(), r.lots, '{}'::jsonb);
  end if;
end $$;

-- Réinitialisation : efface aussi les stocks personnels et les captures. Comptes et lieux conservés.
create or replace function public.reset_registre(p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if p_confirm is distinct from 'REINITIALISER' then raise exception 'Confirmation incorrecte.'; end if;
  delete from public.scan_items where true;
  delete from public.inventory_scans where true;
  delete from public.user_stocks where true;
  delete from public.legacy_stocks where true;
  delete from public.movements where true;
  delete from public.resources where true;
end $$;

-- ---------- 13. Droits ----------
revoke execute on function public._qkey(text) from public, anon, authenticated;
revoke execute on function public._stock_owner(uuid) from public, anon, authenticated;
revoke execute on function public._classify(boolean, numeric, text, text) from public, anon, authenticated;
revoke execute on function public._stock_token(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._write_stock(uuid, uuid, uuid, text, text, numeric, text, text, text, bigint) from public, anon, authenticated;
revoke execute on function public.ensure_location(text) from public, anon;
revoke execute on function public.apply_scan(jsonb, boolean) from public, anon;
revoke execute on function public.adjust_stock(jsonb) from public, anon;
revoke execute on function public.classify_movement(bigint, text) from public, anon;
revoke execute on function public.resolve_legacy(bigint, text, uuid, text, text) from public, anon;
grant execute on function public.ensure_location(text) to authenticated;
grant execute on function public.apply_scan(jsonb, boolean) to authenticated;
grant execute on function public.adjust_stock(jsonb) to authenticated;
grant execute on function public.classify_movement(bigint, text) to authenticated;
grant execute on function public.resolve_legacy(bigint, text, uuid, text, text) to authenticated;

-- ---------- 14. Temps réel ----------
do $$ begin
  begin alter publication supabase_realtime add table public.user_stocks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.legacy_stocks; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.locations; exception when duplicate_object then null; end;
end $$;
