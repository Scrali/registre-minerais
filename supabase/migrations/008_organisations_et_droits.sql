-- Registre des minerais : organisations (registres séparés) et droits par membre.
-- À exécuter APRÈS 007, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
-- Ne pas relancer 002 à 007 après celle-ci : elles remettraient d'anciennes versions des fonctions.
--
-- * Chaque membre appartient à UNE organisation (ex. S.A.R.D). Les stocks, captures, mouvements et membres
--   d'une organisation sont invisibles pour les autres. Le catalogue des minerais, les images de référence
--   et les lieux du jeu restent communs (ce sont des données du jeu : plus d'images = meilleure reconnaissance).
-- * Rôles : pending (en attente) / member / admin (administrateur de SON organisation).
--   is_owner : propriétaire du site (crée les organisations, gère tout le monde, fusion et réinitialisation).
-- * Droits d'un membre (un administrateur les a tous) :
--   can_view_global  voir l'inventaire des autres membres de l'organisation
--   can_scan         analyser des captures avec l'IA
--   can_catalog      gérer le catalogue (modifier, supprimer, images principales, retirer les images des autres)
--   can_edit_others  déclarer des mouvements dans l'inventaire d'un autre membre de l'organisation
-- Rien n'est supprimé ; les profils sont sauvegardés dans archive.profiles_avant_008.

-- ---------- 0. Sauvegarde ----------
create schema if not exists archive;
do $$ begin
  if to_regclass('archive.profiles_avant_008') is null then
    create table archive.profiles_avant_008 as select * from public.profiles;
  end if;
end $$;

-- ---------- 1. Organisations et colonnes de profil ----------
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null
);
create unique index if not exists organizations_name_key on public.organizations (lower(trim(name)));

alter table public.profiles add column if not exists org_id uuid references public.organizations (id) on delete set null;
alter table public.profiles add column if not exists is_owner boolean not null default false;
alter table public.profiles add column if not exists can_view_global boolean not null default true;
alter table public.profiles add column if not exists can_scan boolean not null default true;
alter table public.profiles add column if not exists can_catalog boolean not null default false;
alter table public.profiles add column if not exists can_edit_others boolean not null default false;
create index if not exists profiles_org_idx on public.profiles (org_id);

-- Reprise : une première organisation pour les comptes existants ; les administrateurs deviennent propriétaires.
do $$
declare o uuid;
begin
  if not exists (select 1 from public.organizations) and exists (select 1 from public.profiles where role <> 'pending') then
    insert into public.organizations (name) values ('S.A.R.D') returning id into o;
    update public.profiles set org_id = o, can_catalog = true where role <> 'pending' and org_id is null;
  end if;
  if not exists (select 1 from public.profiles where is_owner) then
    update public.profiles set is_owner = true where role = 'admin';
  end if;
end $$;

-- ---------- 2. Qui est qui ----------
create or replace function public.my_org() returns uuid
language sql stable security definer set search_path = public as $$
  select org_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner from public.profiles where id = auth.uid()), false)
$$;

-- Membre validé d'une organisation (ou propriétaire du site).
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner or (role in ('member', 'admin') and org_id is not null)
                   from public.profiles where id = auth.uid()), false)
$$;

-- Administrateur de son organisation (ou propriétaire du site).
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_owner or (role = 'admin' and org_id is not null) from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.has_perm(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select (is_owner or (role in ('member', 'admin') and org_id is not null))
       and (is_owner or role = 'admin' or case p
             when 'view_global' then can_view_global
             when 'scan' then can_scan
             when 'catalog' then can_catalog
             when 'edit_others' then can_edit_others
             else false end)
    from public.profiles where id = auth.uid()), false)
$$;

-- Peut voir le stock de ce membre : le sien, ou celui d'un membre de la même organisation avec le droit « voir ».
create or replace function public.can_see_stock(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and (
    p_user = auth.uid()
    or (public.has_perm('view_global')
        and exists (select 1 from public.profiles me, public.profiles o
                    where me.id = auth.uid() and o.id = p_user and me.org_id is not null and o.org_id = me.org_id)))
$$;

-- ---------- 3. Protection des profils : rôle, organisation et droits ne changent que par set_member ----------
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(current_setting('registre.admin_op', true), '') <> '1' and (
       new.role is distinct from old.role or new.org_id is distinct from old.org_id or new.is_owner is distinct from old.is_owner
       or new.can_view_global is distinct from old.can_view_global or new.can_scan is distinct from old.can_scan
       or new.can_catalog is distinct from old.can_catalog or new.can_edit_others is distinct from old.can_edit_others
       or new.id is distinct from old.id or new.created_at is distinct from old.created_at) then
    raise exception 'Seul un administrateur peut changer un rôle, une organisation ou des droits.';
  end if;
  new.pseudo := left(trim(new.pseudo), 40);
  return new;
end $$;

-- Nouveau compte : en attente, sans organisation. Le tout premier compte devient propriétaire.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, pseudo, role, is_owner)
  values (new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'pseudo'), ''), split_part(new.email, '@', 1)), 40),
    case when first then 'admin' else 'pending' end, first);
  return new;
end $$;

-- ---------- 4. Lecture (RLS) ----------
alter table public.organizations enable row level security;
drop policy if exists "organisations lisibles" on public.organizations;
create policy "organisations lisibles" on public.organizations for select to authenticated using (true);

drop policy if exists "profils lisibles" on public.profiles;
create policy "profils lisibles" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_owner() or (public.is_member() and org_id = public.my_org()));
-- Écriture directe : seulement son propre pseudo (le reste passe par set_member).
drop policy if exists "profil modifiable" on public.profiles;
create policy "profil modifiable" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "stocks perso lisibles" on public.user_stocks;
create policy "stocks perso lisibles" on public.user_stocks for select to authenticated using (public.can_see_stock(user_id));
drop policy if exists "captures lisibles" on public.inventory_scans;
create policy "captures lisibles" on public.inventory_scans for select to authenticated using (public.can_see_stock(user_id));
drop policy if exists "lignes lisibles" on public.scan_items;
create policy "lignes lisibles" on public.scan_items for select to authenticated
  using (exists (select 1 from public.inventory_scans s where s.id = scan_id and public.can_see_stock(s.user_id)));
drop policy if exists "historique lisible" on public.legacy_stocks;
create policy "historique lisible" on public.legacy_stocks for select to authenticated using (public.is_owner());
-- Journal : les mouvements de stock suivent la visibilité du stock ; les changements du catalogue sont communs.
drop policy if exists "journal lisible" on public.movements;
create policy "journal lisible" on public.movements for select to authenticated
  using (case when owner_id is null then public.is_member() else public.can_see_stock(owner_id) end);

-- ---------- 5. Gestion des organisations et des membres ----------
create or replace function public.create_organization(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not public.is_owner() then raise exception 'Réservé au propriétaire du site.'; end if;
  insert into public.organizations (name, created_by) values (trim(p_name), auth.uid()) returning id into v;
  return v;
exception when unique_violation then raise exception 'Cette organisation existe déjà.';
end $$;

create or replace function public.rename_organization(p_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_owner() or (public.is_admin() and public.my_org() = p_id)) then
    raise exception 'Réservé aux administrateurs de cette organisation.';
  end if;
  update public.organizations set name = trim(p_name) where id = p_id;
  if not found then raise exception 'Organisation introuvable.'; end if;
exception when unique_violation then raise exception 'Cette organisation existe déjà.';
end $$;

create or replace function public.delete_organization(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Réservé au propriétaire du site.'; end if;
  if exists (select 1 from public.profiles where org_id = p_id) then
    raise exception 'Cette organisation a encore des membres : déplace-les ou retire-les d''abord.';
  end if;
  delete from public.organizations where id = p_id;
end $$;

-- Un compte en attente choisit l'organisation qu'il veut rejoindre ; un de ses administrateurs le valide.
create or replace function public.request_organization(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'pending') then
    raise exception 'Seul un compte en attente peut choisir son organisation.';
  end if;
  if not exists (select 1 from public.organizations where id = p_org) then raise exception 'Organisation introuvable.'; end if;
  perform set_config('registre.admin_op', '1', true);
  update public.profiles set org_id = p_org where id = auth.uid();
end $$;

-- Rôle, organisation et droits d'un membre.
-- p = { role?, org_id?, can_view_global?, can_scan?, can_catalog?, can_edit_others?, is_owner? }
-- Administrateur d'organisation : seulement les comptes de SON organisation ; « retirer » = role pending + org_id null.
-- Propriétaire : tous les comptes, y compris changer d'organisation et nommer un autre propriétaire.
create or replace function public.set_member(p_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare t public.profiles; v_owner boolean := public.is_owner(); v_org uuid := public.my_org(); v_new_org uuid;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  select * into t from public.profiles where id = p_id for update;
  if not found then raise exception 'Membre introuvable.'; end if;
  if p_id = auth.uid() and (p ? 'role' or p ? 'org_id' or p ? 'is_owner') then
    raise exception 'Tu ne peux pas changer ton propre rôle ni ta propre organisation.';
  end if;
  if not v_owner then
    if t.is_owner then raise exception 'Seul le propriétaire du site peut modifier ce compte.'; end if;
    if t.org_id is distinct from v_org then raise exception 'Ce compte n''est pas dans ton organisation.'; end if;
    if p ? 'is_owner' then raise exception 'Réservé au propriétaire du site.'; end if;
    if p ? 'org_id' and nullif(p ->> 'org_id', '') is not null and (p ->> 'org_id')::uuid <> v_org then
      raise exception 'Tu ne peux pas déplacer un membre vers une autre organisation.';
    end if;
  end if;
  v_new_org := case when p ? 'org_id' then nullif(p ->> 'org_id', '')::uuid else t.org_id end;
  if v_new_org is not null and not exists (select 1 from public.organizations where id = v_new_org) then
    raise exception 'Organisation introuvable.';
  end if;
  if p ? 'role' and p ->> 'role' not in ('pending', 'member', 'admin') then raise exception 'Rôle invalide.'; end if;
  if coalesce(p ->> 'role', t.role) <> 'pending' and v_new_org is null and not coalesce((p ->> 'is_owner')::boolean, t.is_owner) then
    raise exception 'Choisis d''abord une organisation pour ce membre.';
  end if;
  perform set_config('registre.admin_op', '1', true);
  update public.profiles set
    role = coalesce(p ->> 'role', role),
    org_id = v_new_org,
    is_owner = coalesce((p ->> 'is_owner')::boolean, is_owner),
    can_view_global = coalesce((p ->> 'can_view_global')::boolean, can_view_global),
    can_scan = coalesce((p ->> 'can_scan')::boolean, can_scan),
    can_catalog = coalesce((p ->> 'can_catalog')::boolean, can_catalog),
    can_edit_others = coalesce((p ->> 'can_edit_others')::boolean, can_edit_others)
  where id = p_id;
end $$;

-- ---------- 6. Stocks : modifier un autre membre exige le droit et la même organisation ----------
create or replace function public._stock_owner(p_owner uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Connexion requise.'; end if;
  if p_owner is null or p_owner = auth.uid() then return auth.uid(); end if;
  if not public.has_perm('edit_others') then raise exception 'Tu ne peux modifier que ton propre inventaire.'; end if;
  if not exists (select 1 from public.profiles where id = p_owner and role in ('member', 'admin')
                   and org_id is not null and org_id = public.my_org()) then
    raise exception 'Membre introuvable dans ton organisation.';
  end if;
  return p_owner;
end $$;

create or replace function public.classify_movement(p_id bigint, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.movements;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into m from public.movements where id = p_id for update;
  if not found or m.owner_id is null then raise exception 'Mouvement introuvable.'; end if;
  if m.owner_id <> auth.uid() then perform public._stock_owner(m.owner_id); end if;
  if public.kind_sign(m.kind) = 0 then raise exception 'Ce mouvement n''est pas à classer.'; end if;
  if public.kind_sign(p_kind) is null or public.kind_sign(p_kind) <> sign(m.delta) then
    raise exception 'Cette nature ne correspond pas au sens du mouvement.';
  end if;
  update public.movements set kind = p_kind, classified_by = auth.uid(), classified_at = now() where id = p_id;
end $$;

-- Images : retirer celle d'un autre membre exige le droit « catalogue ».
create or replace function public.delete_reference_image(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare ri public.reference_images; r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into ri from public.reference_images where id = p_id for update;
  if not found then raise exception 'Image introuvable.'; end if;
  if ri.added_by is distinct from auth.uid() and not public.has_perm('catalog') then
    raise exception 'Seul l''auteur de l''image ou un gestionnaire du catalogue peut la retirer.';
  end if;
  delete from public.reference_images where id = p_id;
  select * into r from public.resources where id = ri.resource_id for update;
  if r.image = ri.image then
    update public.resources set image = coalesce(
      (select image from public.reference_images where resource_id = r.id order by created_at desc limit 1), '')
    where id = r.id;
  end if;
end $$;

-- ---------- 7. Fonctions existantes protégées par un droit ----------
-- La fonction d'origine est renommée _impl_<nom> (inaccessible aux clients) ; le nom public vérifie le droit puis l'appelle.
do $$
declare f record;
begin
  for f in select * from (values
    ('apply_lots', 'uuid, text, jsonb, text, text, jsonb, text'),
    ('set_resource_image', 'uuid, text, boolean'),
    ('add_resource_ref', 'uuid, text'),
    ('remove_resource_ref', 'uuid, integer'),
    ('delete_resource', 'uuid'),
    ('set_primary_image', 'bigint'),
    ('merge_resources', 'uuid, uuid'),
    ('undo_movement', 'bigint'),
    ('reset_registre', 'text'),
    ('resolve_legacy', 'bigint, text, uuid, text, text')) v(name, args)
  loop
    if to_regprocedure(format('public._impl_%s(%s)', f.name, f.args)) is null then
      execute format('alter function public.%I(%s) rename to %I', f.name, f.args, '_impl_' || f.name);
    end if;
    execute format('revoke execute on function public.%I(%s) from public, anon, authenticated', '_impl_' || f.name, f.args);
  end loop;
end $$;

create or replace function public._need(p text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if p = 'owner' then
    if not public.is_owner() then raise exception 'Réservé au propriétaire du site.'; end if;
  elsif not public.has_perm(p) then
    raise exception 'Tu n''as pas le droit de gérer le catalogue : demande-le à un administrateur.';
  end if;
end $$;

create or replace function public.apply_lots(p_id uuid, p_mode text, p_delta jsonb, p_source text default 'manuel',
  p_note text default '', p_patch jsonb default null, p_place text default '') returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('catalog'); perform public._impl_apply_lots(p_id, p_mode, p_delta, p_source, p_note, p_patch, p_place); end $$;

create or replace function public.set_resource_image(p_id uuid, p_image text, p_replace boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  -- Sans droit catalogue : seulement donner une image à une ressource qui n'en a pas.
  if p_replace then perform public._need('catalog'); end if;
  perform public._impl_set_resource_image(p_id, p_image, p_replace);
end $$;

create or replace function public.add_resource_ref(p_id uuid, p_image text) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._impl_add_resource_ref(p_id, p_image); end $$;

create or replace function public.remove_resource_ref(p_id uuid, p_index integer) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('catalog'); perform public._impl_remove_resource_ref(p_id, p_index); end $$;

create or replace function public.delete_resource(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('catalog'); perform public._impl_delete_resource(p_id); end $$;

create or replace function public.set_primary_image(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('catalog'); perform public._impl_set_primary_image(p_id); end $$;

-- Fusion, annulation, réinitialisation et anciens stocks touchent toutes les organisations : propriétaire seulement.
create or replace function public.merge_resources(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('owner'); perform public._impl_merge_resources(p_source, p_target); end $$;

create or replace function public.undo_movement(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('owner'); perform public._impl_undo_movement(p_id); end $$;

create or replace function public.reset_registre(p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
begin perform public._need('owner'); perform public._impl_reset_registre(p_confirm); end $$;

create or replace function public.resolve_legacy(p_id bigint, p_action text, p_owner uuid default null,
  p_location text default null, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
begin perform public._need('owner'); return public._impl_resolve_legacy(p_id, p_action, p_owner, p_location, p_note); end $$;

-- ---------- 8. Droits d'exécution ----------
revoke execute on function public._need(text) from public, anon, authenticated;
revoke execute on function public.create_organization(text) from public, anon;
revoke execute on function public.rename_organization(uuid, text) from public, anon;
revoke execute on function public.delete_organization(uuid) from public, anon;
revoke execute on function public.request_organization(uuid) from public, anon;
revoke execute on function public.set_member(uuid, jsonb) from public, anon;
revoke execute on function public.has_perm(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;
grant execute on function public.rename_organization(uuid, text) to authenticated;
grant execute on function public.delete_organization(uuid) to authenticated;
grant execute on function public.request_organization(uuid) to authenticated;
grant execute on function public.set_member(uuid, jsonb) to authenticated;
grant execute on function public.has_perm(text) to authenticated;
do $$
declare f text;
begin
  foreach f in array array['apply_lots(uuid, text, jsonb, text, text, jsonb, text)', 'set_resource_image(uuid, text, boolean)',
    'add_resource_ref(uuid, text)', 'remove_resource_ref(uuid, integer)', 'delete_resource(uuid)', 'set_primary_image(bigint)',
    'merge_resources(uuid, uuid)', 'undo_movement(bigint)', 'reset_registre(text)', 'resolve_legacy(bigint, text, uuid, text, text)']
  loop
    execute 'revoke execute on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  begin alter publication supabase_realtime add table public.organizations; exception when duplicate_object then null; end;
end $$;
