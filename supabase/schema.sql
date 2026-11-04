-- Registre des minerais : schéma Supabase
-- À coller en entier dans Supabase > SQL Editor > New query, puis Run.
-- Le premier compte créé devient administrateur ; les suivants attendent sa validation.

create extension if not exists pgcrypto;

-- ---------- Comptes ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  pseudo text not null default '',
  role text not null default 'pending' check (role in ('pending', 'member', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, pseudo, role)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'pseudo'), ''), split_part(new.email, '@', 1)), 40),
    case when exists (select 1 from public.profiles) then 'pending' else 'admin' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('member', 'admin') from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

-- Seul un admin change les rôles, et jamais le sien (évite de perdre le dernier admin).
-- auth.uid() est nul dans le SQL Editor : le propriétaire du projet peut toujours corriger à la main.
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.role is distinct from old.role then
    if not public.is_admin() then raise exception 'Seul un administrateur peut changer un rôle.'; end if;
    if new.id = auth.uid() then raise exception 'Tu ne peux pas changer ton propre rôle.'; end if;
  end if;
  new.pseudo := left(trim(new.pseudo), 40);
  return new;
end $$;

drop trigger if exists guard_profile on public.profiles;
create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

alter table public.profiles enable row level security;
drop policy if exists "profils lisibles" on public.profiles;
create policy "profils lisibles" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_member());
drop policy if exists "profil modifiable" on public.profiles;
create policy "profil modifiable" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- ---------- Stocks ----------
-- lots : { "258": 20, "1000": 6, "-": 5 }  clé = qualité (0-1000) ou "-" si inconnue, valeur = quantité
create table if not exists public.resources (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  category text not null default '',
  unit text not null default '',
  color text not null default '',
  color_name text not null default '',
  threshold numeric not null default 0,
  lots jsonb not null default '{}'::jsonb,
  qty numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id) on delete set null
);
create unique index if not exists resources_name_key on public.resources (lower(name));

-- Pas de clé étrangère vers resources : le journal garde la trace des ressources supprimées.
create table if not exists public.movements (
  id bigint generated always as identity primary key,
  resource_id uuid,
  name text not null,
  unit text not null default '',
  before numeric not null default 0,
  after numeric not null default 0,
  detail text not null default '',
  mode text not null,
  source text not null default 'manuel',
  note text not null default '',
  by uuid references public.profiles (id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists movements_at_idx on public.movements (at desc);

alter table public.resources enable row level security;
alter table public.movements enable row level security;
drop policy if exists "stocks lisibles" on public.resources;
create policy "stocks lisibles" on public.resources for select to authenticated using (public.is_member());
drop policy if exists "journal lisible" on public.movements;
create policy "journal lisible" on public.movements for select to authenticated using (public.is_member());
-- Aucune écriture directe : tout passe par les fonctions ci-dessous, qui verrouillent la ligne
-- et écrivent le journal dans la même transaction.

-- ---------- Calcul des lots ----------
create or replace function public.lot_order(k text) returns numeric
language sql immutable as $$ select case when k = '-' then -1 else k::numeric end $$;

create or replace function public.sum_lots(l jsonb) returns numeric
language sql immutable as $$ select coalesce(sum(value::numeric), 0) from jsonb_each_text(coalesce(l, '{}'::jsonb)) $$;

create or replace function public.lots_text(l jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(case when key = '-' then 'Q?' else 'Q' || key end || ' ×' || value, ', '
                             order by public.lot_order(key) desc), '')
  from jsonb_each_text(coalesce(l, '{}'::jsonb))
$$;

create or replace function public.merge_lots(base jsonb, delta jsonb, mode text) returns jsonb
language plpgsql immutable as $$
declare
  o jsonb := case when mode = 'set' then '{}'::jsonb else coalesce(base, '{}'::jsonb) end;
  k text; v numeric; left_ numeric; kk text; cur numeric; t numeric;
begin
  for k, v in select key, value::numeric from jsonb_each_text(coalesce(delta, '{}'::jsonb)) loop
    if k <> '-' and (k !~ '^\d{1,4}$' or k::int > 1000) then raise exception 'Qualité invalide : %', k; end if;
    if v is null or v <= 0 then continue; end if;
    if mode in ('set', 'add') then
      o := jsonb_set(o, array[k], to_jsonb(coalesce((o ->> k)::numeric, 0) + v));
    elsif k <> '-' then
      o := jsonb_set(o, array[k], to_jsonb(greatest(0, coalesce((o ->> k)::numeric, 0) - v)));
    else
      -- sortie sans qualité précisée : on puise d'abord dans la plus basse qualité
      left_ := v;
      for kk in select key from jsonb_each_text(o) order by public.lot_order(key) loop
        exit when left_ <= 0;
        cur := (o ->> kk)::numeric; t := least(left_, cur);
        o := jsonb_set(o, array[kk], to_jsonb(cur - t)); left_ := left_ - t;
      end loop;
    end if;
  end loop;
  select coalesce(jsonb_object_agg(key, value::numeric), '{}'::jsonb) into o
    from jsonb_each_text(o) where value::numeric > 0;
  return o;
end $$;

-- ---------- Actions ----------
create or replace function public.apply_lots(
  p_id uuid, p_mode text, p_delta jsonb,
  p_source text default 'manuel', p_note text default '', p_patch jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources; new_lots jsonb; new_name text; new_unit text;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if p_mode not in ('set', 'add', 'remove') then raise exception 'Mode invalide.'; end if;
  select * into r from public.resources where id = p_id for update;
  if not found then raise exception 'Ressource introuvable.'; end if;
  new_lots := public.merge_lots(r.lots, p_delta, p_mode);
  new_name := coalesce(nullif(trim(p_patch ->> 'name'), ''), r.name);
  new_unit := coalesce(p_patch ->> 'unit', r.unit);
  update public.resources set
    lots = new_lots,
    qty = public.sum_lots(new_lots),
    name = new_name,
    unit = new_unit,
    category = coalesce(p_patch ->> 'category', category),
    color = coalesce(p_patch ->> 'color', color),
    color_name = coalesce(p_patch ->> 'color_name', color_name),
    threshold = coalesce((p_patch ->> 'threshold')::numeric, threshold),
    updated_at = now(), updated_by = auth.uid()
  where id = p_id;
  if new_lots is distinct from r.lots then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by)
    values (p_id, new_name, new_unit, r.qty, public.sum_lots(new_lots), public.lots_text(p_delta),
            p_mode, coalesce(p_source, 'manuel'), coalesce(p_note, ''), auth.uid());
  end if;
end $$;

create or replace function public.create_resource(p jsonb, p_source text default 'manuel', p_note text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare l jsonb; new_id uuid;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  l := public.merge_lots('{}'::jsonb, p -> 'lots', 'set');
  insert into public.resources (name, category, unit, color, color_name, threshold, lots, qty, updated_by)
  values (trim(p ->> 'name'), coalesce(p ->> 'category', ''), coalesce(p ->> 'unit', ''),
          coalesce(p ->> 'color', ''), coalesce(p ->> 'color_name', ''),
          coalesce((p ->> 'threshold')::numeric, 0), l, public.sum_lots(l), auth.uid())
  returning id into new_id;
  if public.sum_lots(l) > 0 then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by)
    values (new_id, trim(p ->> 'name'), coalesce(p ->> 'unit', ''), 0, public.sum_lots(l), public.lots_text(l),
            'create', coalesce(p_source, 'manuel'), coalesce(p_note, ''), auth.uid());
  end if;
  return new_id;
exception when unique_violation then
  raise exception 'Une ressource porte déjà ce nom.';
end $$;

create or replace function public.delete_resource(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  delete from public.resources where id = p_id returning * into r;
  if found then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, by)
    values (r.id, r.name, r.unit, r.qty, 0, public.lots_text(r.lots), 'delete', 'manuel', auth.uid());
  end if;
end $$;

revoke execute on function public.apply_lots(uuid, text, jsonb, text, text, jsonb) from public, anon;
revoke execute on function public.create_resource(jsonb, text, text) from public, anon;
revoke execute on function public.delete_resource(uuid) from public, anon;
grant execute on function public.apply_lots(uuid, text, jsonb, text, text, jsonb) to authenticated;
grant execute on function public.create_resource(jsonb, text, text) to authenticated;
grant execute on function public.delete_resource(uuid) to authenticated;

-- ---------- Temps réel ----------
do $$
begin
  begin alter publication supabase_realtime add table public.resources; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.movements; exception when duplicate_object then null; end;
  begin alter publication supabase_realtime add table public.profiles; exception when duplicate_object then null; end;
end $$;
